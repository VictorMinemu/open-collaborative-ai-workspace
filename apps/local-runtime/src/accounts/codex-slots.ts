// Codex account slots on this device (07.18, D-02, PD-10, P2).
//
// A slot is one ChatGPT account for Codex: the directory `<ocw home>/accounts/codex/<slotId>/` (mode 0700), used as
// that account's `CODEX_HOME`. Its metadata (id, label, origin, creation time and the plan Codex last reported) lives
// in `<ocw home>/accounts/codex/slots.json` (mode 0600), shared by the daemon and `ocw-runtime account`.
//
// Why `sessions` is shared: Codex keeps its rollouts under `CODEX_HOME/sessions`. Every slot's `sessions` is a link to
// the daemon's default Codex home's `sessions/`, so a thread started on the device's own login or on one slot can be
// resumed by an app-server that runs under another slot (the account switch of PD-03). `config.toml` links the default
// one when it exists, so a slot runs with the owner's Codex settings. On win32, `sessions` is a directory junction and
// no config link is made.
//
// `auth.json` is Codex's own: written and refreshed by Codex in the slot's directory. This module never reads, copies
// or writes it; it only checks whether it exists (`signedIn`). No path from here is ever put in a frame: a report
// carries the slot id, the label, the origin, the plan and usage only (P2).

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, symlink, unlink, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { type CodexSlotReport, POOL_LIMITS, SlotId } from "@ocw/contracts";
import { z } from "zod";

/** The Codex home the daemon's own login uses: `CODEX_HOME` when set, else `~/.codex`. */
export function defaultCodexHome(env: NodeJS.ProcessEnv = process.env): string {
  if (env.CODEX_HOME) return resolve(env.CODEX_HOME);
  return join(env.HOME || homedir(), ".codex");
}

export type CodexSlotOrigin = "server" | "cli";

const SlotRecordSchema = z.object({
  slotId: SlotId,
  label: z.string().min(1).max(POOL_LIMITS.labelMax),
  origin: z.enum(["server", "cli"]),
  createdAt: z.string(),
  planType: z.string().max(64).nullable().default(null),
});
export type CodexSlot = z.infer<typeof SlotRecordSchema>;

const SlotsFileSchema = z.object({ slots: z.array(SlotRecordSchema).default([]) });

export const SLOT_EXISTS_MESSAGE = "this account slot already exists";
export const TOO_MANY_SLOTS_MESSAGE = `at most ${POOL_LIMITS.slotsPerDevice} Codex accounts on one device`;
export const INVALID_SLOT_ID_MESSAGE = "invalid account slot id";

function checkSlotId(slotId: string): string {
  if (!SlotId.safeParse(slotId).success) throw new Error(INVALID_SLOT_ID_MESSAGE);
  return slotId;
}

async function exists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}

/** Removes `path` when it is a link (symlink or junction); a missing entry is fine; anything else is refused. */
async function unlinkLink(path: string): Promise<void> {
  const st = await lstat(path).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT") return null;
    throw err;
  });
  if (!st) return;
  // A real directory here would hold history of its own: never deleted with the slot.
  if (!st.isSymbolicLink()) throw new Error("the account slot's shared history is not a link; not removed");
  await unlink(path);
}

export class CodexSlotStore {
  readonly root: string;
  private readonly file: string;
  /** Writes in this process run one after the other (the file is replaced atomically). */
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    ocwHome: string,
    private readonly env: NodeJS.ProcessEnv = process.env,
  ) {
    this.root = join(ocwHome, "accounts", "codex");
    this.file = join(this.root, "slots.json");
  }

  /** The daemon's default Codex home (whose `sessions/` every slot shares). */
  get defaultCodexHome(): string {
    return defaultCodexHome(this.env);
  }

  /** A slot's directory, its `CODEX_HOME`. Device-local only. */
  homeOf(slotId: string): string {
    return join(this.root, checkSlotId(slotId));
  }

  /** Every slot, in creation order (re-read from disk: the CLI may have changed it). */
  async list(): Promise<CodexSlot[]> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    return SlotsFileSchema.parse(JSON.parse(raw)).slots;
  }

  async get(slotId: string): Promise<CodexSlot | undefined> {
    return (await this.list()).find((s) => s.slotId === slotId);
  }

  /** What `accounts.sync` reports: `signedIn` from the presence of the slot's `auth.json`, never its content. */
  async report(): Promise<CodexSlotReport[]> {
    const slots = await this.list();
    return Promise.all(
      slots.map(async (s) => ({
        slotId: s.slotId,
        label: s.label,
        origin: s.origin,
        signedIn: await exists(join(this.homeOf(s.slotId), "auth.json")),
        planType: s.planType,
        usage: null,
      })),
    );
  }

  /**
   * Creates a slot: its 0700 directory, the `sessions` link (the default `sessions/` is created when missing), the
   * `config.toml` link when the default one exists (POSIX only), then its record. A known id or an 11th slot is refused.
   */
  create(input: { label: string; origin: CodexSlotOrigin; slotId?: string }): Promise<CodexSlot> {
    return this.serial(async () => {
      const slotId = checkSlotId(input.slotId ?? randomUUID());
      const slots = await this.list();
      if (slots.some((s) => s.slotId === slotId)) throw new Error(SLOT_EXISTS_MESSAGE);
      if (slots.length >= POOL_LIMITS.slotsPerDevice) throw new Error(TOO_MANY_SLOTS_MESSAGE);
      const label = input.label.trim().slice(0, POOL_LIMITS.labelMax);
      if (!label) throw new Error("an account slot needs a label");
      await this.ensureRoot();
      const dir = this.homeOf(slotId);
      await mkdir(dir, { mode: 0o700 });
      try {
        const base = this.defaultCodexHome;
        const sessions = join(base, "sessions");
        await mkdir(sessions, { recursive: true, mode: 0o700 });
        if (process.platform === "win32") {
          await symlink(sessions, join(dir, "sessions"), "junction");
        } else {
          await symlink(sessions, join(dir, "sessions"));
          const config = join(base, "config.toml");
          if (await exists(config)) await symlink(config, join(dir, "config.toml"));
        }
        const slot: CodexSlot = {
          slotId,
          label,
          origin: input.origin,
          createdAt: new Date().toISOString(),
          planType: null,
        };
        await this.save([...slots, slot]);
        return slot;
      } catch (err) {
        await this.removeDir(dir).catch(() => undefined);
        throw err;
      }
    });
  }

  /** Records the plan Codex reported for a slot (after its sign-in). */
  setPlan(slotId: string, planType: string | null): Promise<void> {
    return this.serial(async () => {
      const slots = await this.list();
      const slot = slots.find((s) => s.slotId === slotId);
      if (!slot) return;
      slot.planType = planType === null ? null : planType.slice(0, 64);
      await this.save(slots);
    });
  }

  /**
   * Removes a slot: both links are unlinked first (the shared `sessions/` and `config.toml` are never followed), then
   * the directory (with Codex's `auth.json`), then its record. False when the slot is unknown.
   */
  remove(slotId: string): Promise<boolean> {
    return this.serial(async () => {
      const dir = this.homeOf(slotId);
      const slots = await this.list();
      const known = slots.some((s) => s.slotId === slotId);
      const onDisk = await lstat(dir).then(
        () => true,
        () => false,
      );
      if (!known && !onDisk) return false;
      if (onDisk) await this.removeDir(dir);
      if (known) await this.save(slots.filter((s) => s.slotId !== slotId));
      return true;
    });
  }

  private async removeDir(dir: string): Promise<void> {
    await unlinkLink(join(dir, "sessions"));
    await unlinkLink(join(dir, "config.toml"));
    await rm(dir, { recursive: true, force: true });
  }

  private async ensureRoot(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
  }

  private async save(slots: CodexSlot[]): Promise<void> {
    await this.ensureRoot();
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    await writeFile(tmp, `${JSON.stringify({ slots }, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, this.file);
  }

  private serial<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.chain.then(fn, fn);
    this.chain = run.catch(() => undefined);
    return run;
  }
}
