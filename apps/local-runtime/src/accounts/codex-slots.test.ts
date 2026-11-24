import { randomUUID } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { POOL_LIMITS } from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CodexSlotStore, defaultCodexHome } from "./codex-slots.js";

const posix = process.platform !== "win32";

let root: string;
let ocw: string;
let codexHome: string;
let store: CodexSlotStore;

beforeEach(() => {
  root = realpathSync(mkdtempSync(join(tmpdir(), "ocw-slots-")));
  ocw = join(root, "ocw");
  codexHome = join(root, "codex");
  mkdirSync(ocw, { mode: 0o700 });
  store = new CodexSlotStore(ocw, { CODEX_HOME: codexHome });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("defaultCodexHome", () => {
  it("is CODEX_HOME when set, else ~/.codex (HOME first)", () => {
    expect(defaultCodexHome({ CODEX_HOME: "/x/codex" })).toBe("/x/codex");
    expect(defaultCodexHome({ HOME: "/h" })).toBe(join("/h", ".codex"));
    expect(defaultCodexHome({})).toBe(join(homedir(), ".codex"));
  });
});

describe("CodexSlotStore (07.18 PD-10)", () => {
  it("create makes a 0700 slot whose sessions link to the default sessions/ (created when missing)", async () => {
    const slot = await store.create({ label: "ana@acme", origin: "server" });
    const dir = store.homeOf(slot.slotId);
    expect(dir).toBe(join(ocw, "accounts", "codex", slot.slotId));
    if (posix) expect(statSync(dir).mode & 0o777).toBe(0o700);
    expect(lstatSync(join(dir, "sessions")).isSymbolicLink()).toBe(true);
    expect(realpathSync(join(dir, "sessions"))).toBe(join(codexHome, "sessions"));
    expect(existsSync(join(codexHome, "sessions"))).toBe(true);
    // No config.toml in the default home: no link.
    expect(existsSync(join(dir, "config.toml"))).toBe(false);
    // auth.json is Codex's own: the store never writes one.
    expect(existsSync(join(dir, "auth.json"))).toBe(false);
  });

  it.runIf(posix)("links config.toml when the default home has one", async () => {
    mkdirSync(codexHome, { recursive: true });
    writeFileSync(join(codexHome, "config.toml"), 'model = "gpt-5"\n');
    const slot = await store.create({ label: "A", origin: "cli" });
    const link = join(store.homeOf(slot.slotId), "config.toml");
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(codexHome, "config.toml"));
    expect(readFileSync(link, "utf8")).toContain("gpt-5");
  });

  it("slots.json (0600) keeps id, label, origin and creation time; list is in creation order", async () => {
    const a = await store.create({ label: "A", origin: "server" });
    const b = await store.create({ label: "B", origin: "cli" });
    const file = join(ocw, "accounts", "codex", "slots.json");
    if (posix) expect(statSync(file).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(file, "utf8")) as { slots: Array<Record<string, unknown>> };
    expect(raw.slots.map((s) => [s.slotId, s.label, s.origin])).toEqual([
      [a.slotId, "A", "server"],
      [b.slotId, "B", "cli"],
    ]);
    expect(typeof raw.slots[0]?.createdAt).toBe("string");
    expect((await store.list()).map((s) => s.label)).toEqual(["A", "B"]);
    // A second store over the same home reads the same slots (the CLI and the daemon share the file).
    const again = new CodexSlotStore(ocw, { CODEX_HOME: codexHome });
    expect((await again.get(b.slotId))?.label).toBe("B");
  });

  it("takes a given slot id; a second create with the same id is refused", async () => {
    const slotId = randomUUID();
    await store.create({ label: "A", origin: "server", slotId });
    await expect(store.create({ label: "A2", origin: "server", slotId })).rejects.toThrow(
      "this account slot already exists",
    );
    expect(await store.list()).toHaveLength(1);
  });

  it(`refuses more than ${POOL_LIMITS.slotsPerDevice} slots`, async () => {
    for (let i = 0; i < POOL_LIMITS.slotsPerDevice; i++)
      await store.create({ label: `S${i}`, origin: "cli" });
    await expect(store.create({ label: "one too many", origin: "cli" })).rejects.toThrow(
      `at most ${POOL_LIMITS.slotsPerDevice} Codex accounts on one device`,
    );
  });

  it("remove unlinks the links, then the directory; the default sessions/ and its files survive", async () => {
    mkdirSync(join(codexHome, "sessions", "2026"), { recursive: true });
    writeFileSync(join(codexHome, "sessions", "2026", "rollout.jsonl"), "{}\n");
    if (posix) writeFileSync(join(codexHome, "config.toml"), "x = 1\n");
    const slot = await store.create({ label: "A", origin: "server" });
    // Codex writes its own auth.json in the slot.
    writeFileSync(join(store.homeOf(slot.slotId), "auth.json"), "{}");
    expect(await store.remove(slot.slotId)).toBe(true);
    expect(existsSync(store.homeOf(slot.slotId))).toBe(false);
    expect(readFileSync(join(codexHome, "sessions", "2026", "rollout.jsonl"), "utf8")).toBe("{}\n");
    if (posix) expect(readFileSync(join(codexHome, "config.toml"), "utf8")).toBe("x = 1\n");
    expect(await store.list()).toEqual([]);
    expect(await store.remove(slot.slotId)).toBe(false);
  });

  it("reports each slot with signedIn from the presence of auth.json, the stored plan and no usage", async () => {
    const a = await store.create({ label: "A", origin: "server" });
    const b = await store.create({ label: "B", origin: "cli" });
    writeFileSync(join(store.homeOf(a.slotId), "auth.json"), "{}");
    await store.setPlan(a.slotId, "plus");
    expect(await store.report()).toEqual([
      { slotId: a.slotId, label: "A", origin: "server", signedIn: true, planType: "plus", usage: null },
      { slotId: b.slotId, label: "B", origin: "cli", signedIn: false, planType: null, usage: null },
    ]);
  });

  it("refuses an id that is not a slot id (no path ever reaches the file system)", async () => {
    expect(() => store.homeOf("../../etc")).toThrow("invalid account slot id");
    await expect(store.create({ label: "A", origin: "cli", slotId: "../x" })).rejects.toThrow(
      "invalid account slot id",
    );
  });
});
