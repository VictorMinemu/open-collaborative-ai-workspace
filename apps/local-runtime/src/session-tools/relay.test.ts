import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  normalizeSessionTitle,
  SESSION_RENAME_REFUSAL_TEXT,
  type SessionRenameFrame,
  type SessionRenameRefusal,
  type SessionToolsGrant,
} from "@ocw/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SessionToolResult } from "../runtime.js";
import { SessionToolRelay } from "./relay.js";
import { renameDescription } from "./tools.js";

const ALLOW: SessionToolsGrant = { rename: true, namingRules: null };
const LOCKED: SessionToolsGrant = { rename: false, namingRules: null };

const refused = (reason: SessionRenameRefusal): SessionToolResult => ({
  content: [{ type: "text", text: SESSION_RENAME_REFUSAL_TEXT[reason] }],
  isError: true,
});

let home: string;
let project: string;
let frames: SessionRenameFrame[];
let relay: SessionToolRelay;
/** What the fake API answers each frame with (null = no answer). */
let answer: (f: SessionRenameFrame) => Parameters<SessionToolRelay["onServerFrame"]>[0]["result"] | null;

beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "ocw-session-tools-")));
  project = join(home, "acme");
  frames = [];
  answer = (f) => ({ ok: true, title: f.title });
  relay = new SessionToolRelay({
    send: (frame) => {
      frames.push(frame);
      const result = answer(frame);
      if (result)
        queueMicrotask(() =>
          relay.onServerFrame({ type: "session.rename.result", requestId: frame.requestId, result }),
        );
      return true;
    },
    rootsFor: () => [project],
    ocwHome: home,
    timeoutMs: 50,
  });
});

afterEach(async () => {
  await relay.stop();
  rmSync(home, { recursive: true, force: true });
});

/** A session with a turn in flight under `grant` (null = the payloads carried no `sessionTools`). */
function inTurn(grant: SessionToolsGrant | null = ALLOW, promptId = "p1"): string {
  const g = grant ?? undefined;
  const sid = randomUUID();
  relay.onPrompt(sid, null, g);
  relay.onPrompt(sid, promptId, g);
  relay.onTurnStarted(sid, promptId);
  return sid;
}

const rename = (sid: string, args: unknown) => relay.forSession(sid).call("rename", args);

describe("SessionToolRelay: the daemon's own checks (07.13.1.1 D-07, PD-11, Pitfall 11)", () => {
  it("outside a turn: no_turn, no frame", async () => {
    const sid = randomUUID();
    relay.onPrompt(sid, null, ALLOW);
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("no_turn"));
    relay.onPrompt(sid, "p1", ALLOW);
    relay.onTurnStarted(sid, "p1");
    relay.onTurnEnded(sid, "p1");
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("no_turn"));
    expect(frames).toEqual([]);
  });

  it("the turn's grant has rename: false → title_locked, no frame", async () => {
    const sid = inTurn(LOCKED);
    expect(relay.forSession(sid).offered).toBe(true);
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("title_locked"));
    expect(frames).toEqual([]);
  });

  it("one rename per turn; a new turn may rename again", async () => {
    const sid = inTurn();
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual({
      content: [{ type: "text", text: 'Renamed the session to "Fix login redirect".' }],
      isError: false,
    });
    expect(await rename(sid, { title: "Fix logout redirect" })).toEqual(refused("already_renamed"));
    expect(frames).toHaveLength(1);
    relay.onTurnEnded(sid, "p1");
    relay.onPrompt(sid, "p2", ALLOW);
    relay.onTurnStarted(sid, "p2");
    expect((await rename(sid, { title: "Fix logout redirect" })).isError).toBe(false);
    expect(frames.map((f) => f.promptId)).toEqual(["p1", "p2"]);
  });

  it("a steer joins the running turn: it keeps the turn's rename", async () => {
    const sid = inTurn();
    await rename(sid, { title: "Fix login redirect" });
    relay.onPrompt(sid, "p1b", ALLOW, { steer: true });
    relay.onTurnStarted(sid, "p1b");
    expect(await rename(sid, { title: "Fix logout redirect" })).toEqual(refused("already_renamed"));
    expect(frames).toHaveLength(1);
  });

  it.each([
    ["an extra key", { title: "Fix login", extra: 1 }],
    ["no title", {}],
    ["a blank title", { title: "   " }],
    ["one word", { title: "Fix" }],
    ["40 characters", { title: "Refactor authentication middleware layer" }],
    ["six words", { title: "Fix the login page redirect loop" }],
    ["a host path", { title: "Fix /Users/ana/app" }],
    ["a token-shaped secret", { title: "Rotate xoxb-1234567890" }],
    ["not an object", "Fix login redirect"],
    ["null", null],
  ])("%s → invalid_title, no frame", async (_label, args) => {
    const sid = inTurn();
    expect(await rename(sid, args)).toEqual(refused("invalid_title"));
    expect(frames).toEqual([]);
  });

  it("a title under the session's project root is refused, never contained and sent", async () => {
    const sid = inTurn();
    expect(await rename(sid, { title: `Fix ${project}/src` })).toEqual(refused("invalid_title"));
    expect(frames).toEqual([]);
  });

  it("the title is normalized before it is sent", async () => {
    const sid = inTurn();
    const raw = "  fix LOGIN redirect. ";
    await rename(sid, { title: raw });
    expect(frames).toHaveLength(1);
    expect(frames[0]?.title).toBe(normalizeSessionTitle(raw));
    expect(frames[0]?.title).not.toBe(raw);
  });

  it("an API already_renamed also marks the turn; another refusal does not", async () => {
    const sid = inTurn();
    answer = () => ({ ok: false, reason: "invalid_title" });
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("invalid_title"));
    answer = () => ({ ok: false, reason: "already_renamed" });
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("already_renamed"));
    answer = (f) => ({ ok: true, title: f.title });
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("already_renamed"));
    expect(frames).toHaveLength(2);
  });

  it("no answer in time, or an offline link → not_available", async () => {
    const sid = inTurn();
    answer = () => null;
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("not_available"));
    // Not marked: a later call in the same turn may try again.
    answer = (f) => ({ ok: true, title: f.title });
    expect((await rename(sid, { title: "Fix login redirect" })).isError).toBe(false);
  });

  it("a session without a grant is not offered and answers not_available; markUnavailable turns it off", async () => {
    const sid = inTurn(null);
    expect(relay.forSession(sid).offered).toBe(false);
    expect(await rename(sid, { title: "Fix login redirect" })).toEqual(refused("not_available"));
    const other = inTurn();
    let changes = 0;
    relay.forSession(other).onChange(() => changes++);
    relay.forSession(other).markUnavailable("shadowed");
    expect(relay.forSession(other).offered).toBe(false);
    expect(changes).toBe(1);
    expect(await rename(other, { title: "Fix login redirect" })).toEqual(refused("not_available"));
    expect(frames).toEqual([]);
  });

  it("description follows the latest grant's rules and onChange fires only when it or offered change", () => {
    const sid = randomUUID();
    const handle = relay.forSession(sid);
    let changes = 0;
    handle.onChange(() => changes++);
    relay.onPrompt(sid, null, ALLOW);
    expect(changes).toBe(1);
    expect(handle.description("rename")).toBe(renameDescription(null));
    relay.onPrompt(sid, "p1", ALLOW);
    expect(changes).toBe(1);
    relay.onPrompt(sid, "p2", { rename: true, namingRules: "Start with the ticket id." });
    expect(changes).toBe(2);
    expect(handle.description("rename")).toBe(renameDescription("Start with the ticket id."));
    relay.onPrompt(sid, "p3", { rename: false, namingRules: "Start with the ticket id." });
    expect(changes).toBe(2);
  });
});

describe("SessionToolRelay: the shim token and the shim entry points (07.13.1.1 PD-08)", () => {
  it("shimTokenFile creates <ocwHome>/run/sessions/<id>/shim-token once (0700 dir, 0600 file)", async () => {
    const sid = inTurn();
    const file = await relay.forSession(sid).shimTokenFile();
    expect(file).toBe(join(home, "run", "sessions", sid, "shim-token"));
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(file)).mode & 0o777).toBe(0o700);
    const token = readFileSync(file, "utf8");
    expect(await relay.forSession(sid).shimTokenFile()).toBe(file);
    expect(readFileSync(file, "utf8")).toBe(token);
  });

  it("endSession removes the session's dir; sweep removes leftovers of sessions not alive", async () => {
    const sid = inTurn();
    const file = await relay.forSession(sid).shimTokenFile();
    await relay.endSession(sid);
    expect(existsSync(dirname(file))).toBe(false);

    const alive = inTurn();
    const aliveFile = await relay.forSession(alive).shimTokenFile();
    const stale = join(home, "run", "sessions", randomUUID());
    mkdirSync(stale, { recursive: true });
    await relay.sweep();
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(aliveFile)).toBe(true);
  });

  it("shimCall: only the session's own token, only rename, else an error result without a frame", async () => {
    const sid = inTurn();
    const token = readFileSync(await relay.forSession(sid).shimTokenFile(), "utf8").trim();
    const other = inTurn();
    const otherToken = readFileSync(await relay.forSession(other).shimTokenFile(), "utf8").trim();
    const args = { title: "Fix login redirect" };
    expect(await relay.shimCall({ session: sid, token: otherToken, tool: "rename", args })).toEqual(
      refused("not_available"),
    );
    expect(await relay.shimCall({ session: randomUUID(), token, tool: "rename", args })).toEqual(
      refused("not_available"),
    );
    expect(await relay.shimCall({ session: sid, token, tool: "delete", args })).toEqual(
      refused("not_available"),
    );
    expect(frames).toEqual([]);
    expect((await relay.shimCall({ session: sid, token, tool: "rename", args })).isError).toBe(false);
    expect(frames).toHaveLength(1);
  });

  it("shimList: one tool whose description is description('rename'); a wrong token is refused", async () => {
    const sid = randomUUID();
    relay.onPrompt(sid, null, { rename: true, namingRules: "Use the ticket id." });
    const token = readFileSync(await relay.forSession(sid).shimTokenFile(), "utf8").trim();
    expect(await relay.shimList({ session: sid, token })).toEqual([
      { name: "rename", description: relay.forSession(sid).description("rename") },
    ]);
    await expect(relay.shimList({ session: sid, token: "0".repeat(64) })).rejects.toThrow("not allowed");
  });
});
