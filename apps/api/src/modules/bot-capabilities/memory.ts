import { createHash } from "node:crypto";
import {
  BUILTIN_TOOLS,
  detectSensitive,
  MAX_TOOL_CALLS_PER_TURN,
  MEMORY_LIMITS,
  MEMORY_ROOT_FILE,
  type MemoryFile,
  type MemoryItem,
  type TurnMemoryFile,
} from "@ocw/contracts";
import { agentTurns, type Tx, withSavepoint } from "@ocw/db";
import { and, eq, lt, sql } from "drizzle-orm";
import type { Core } from "../../core";
import { HttpError } from "../../lib/errors";
// Types only: the memory service is injected (memory → agent → chat → bot-capabilities would be a runtime cycle).
import type { MemoryActor, MemoryAudience, MemoryService, ToolScope } from "../memory";
import { AuthzDeniedError, type PermissionService } from "../organization";
import { currentTurnTools } from "./turn-policy";

/**
 * A bot's notes about one human (D-10, BOT-04, SC5), kept since Phase 07.2 (D-02, D-08, MEM-07, ADR-0023) as bullets of
 * that human's private `MEMORY.md` with the bot: the personal memory scope of (bot, human), owner-only in the resolver
 * and in RLS. Written through the cell's own tool `ocw_memory_save` in that human's DM with the bot, read into that
 * human's one-person DM turns, listed and cleared only by that human. Never readable by admins or other members.
 * `app.agent_memories` is no longer read or written (the 07.2-02 backfill moved its notes; the table is kept).
 *
 * Trust: the owner of a note is ALWAYS the human of the stored delivery (`agent_turns.user_id`), never anything the
 * model sends. Untrusted content (web or tool output) taints the turn; a tainted turn can no longer write memory (D-08
 * taint rule). Audits carry lengths and counts, never the text (T-03.1-07-05).
 */

/** Newest notes injected into one turn (`TurnContext.memory` max). */
export const TURN_MEMORY_LIMIT = 50;

export type MemoryRefusal =
  | "unknown_turn"
  | "dm_only"
  | "not_in_turn"
  | "memory_off"
  | "tainted"
  | "cap_reached";

/**
 * `rejected` is not a refusal of the turn: the note itself is never stored (ADR-0023: no secret is ever written to
 * memory, on any path). The route answers it as 400.
 */
export type SaveMemoryResult =
  | { memoryId: string; created: boolean }
  | { refused: MemoryRefusal }
  | { rejected: "secret_detected" };

const ROOT = MEMORY_ROOT_FILE;
const ITEM_TEXT_MAX = 500;

// ---------------------------------------------------------------- bullets of MEMORY.md

/** A note as stored: one top-level Markdown bullet (`- `, `* ` or `+ `) of the private `MEMORY.md`. */
interface Bullet {
  /** 0-based line index in the file. */
  line: number;
  text: string;
  id: string;
}

const BULLET = /^[-*+][ \t]+(.*\S)\s*$/u;

/** One line, as `ocw_memory_save` and the 07.2-02 backfill store it (newlines flattened to one space). */
export const flattenNote = (text: string) => text.trim().replace(/\s*\n\s*/gu, " ");

/**
 * A stable id for a bullet: a UUID (version 8) of (file id, its occurrence among bullets with the same text, the text).
 * Deleting or adding another bullet never changes it; a bullet edited by its owner gets a new one.
 */
function bulletId(fileId: string, occurrence: number, text: string): string {
  const h = createHash("sha256").update(`${fileId}\n${occurrence}\n${text}`, "utf8").digest("hex");
  const variant = ((Number.parseInt(h[16] ?? "0", 16) & 0x3) | 0x8).toString(16);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-8${h.slice(13, 16)}-${variant}${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

export function bulletsOf(fileId: string, content: string): Bullet[] {
  const seen = new Map<string, number>();
  const out: Bullet[] = [];
  content.split("\n").forEach((raw, line) => {
    const m = BULLET.exec(raw);
    if (!m?.[1]) return;
    const text = m[1];
    const occurrence = seen.get(text) ?? 0;
    seen.set(text, occurrence + 1);
    out.push({ line, text, id: bulletId(fileId, occurrence, text) });
  });
  return out;
}

const toItem = (b: Bullet, file: MemoryFile): MemoryItem => ({
  id: b.id,
  text: b.text.slice(0, ITEM_TEXT_MAX),
  // Bullets carry no time of their own: the file's last change.
  createdAt: file.updatedAt,
});

// ---------------------------------------------------------------- the private file

/** The person's own private `MEMORY.md` with this bot, read as that person; null when it does not exist yet. */
async function ownNotes(tx: Tx, memory: MemoryService, agentId: string, userId: string) {
  const ref = await memory.resolveToolScope(tx, { agentId, onBehalfOfUserId: userId, scope: "personal" });
  if (!ref?.id) return null;
  try {
    const file = await memory.readFile(tx, { kind: "user", userId }, { scopeId: ref.id, path: ROOT });
    return { scopeId: ref.id, file };
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) return null;
    throw err;
  }
}

/** Every note this bot keeps about this human, newest first (the last bullets of the file first). */
export async function listMemories(
  tx: Tx,
  memory: MemoryService,
  agentId: string,
  userId: string,
): Promise<MemoryItem[]> {
  const own = await ownNotes(tx, memory, agentId, userId);
  if (!own) return [];
  return bulletsOf(own.file.id, own.file.content)
    .reverse()
    .map((b) => toItem(b, own.file));
}

/**
 * Deletes one note (`memoryId`: that bullet, a new revision of the file) or all of them (the whole private scope is
 * forgotten: files, revisions and proposals, then a fresh `MEMORY.md`). Returns how many notes were deleted. Always the
 * caller's own memory: the resolver and RLS refuse anyone else, admins included.
 */
export async function clearMemories(
  tx: Tx,
  memory: MemoryService,
  agentId: string,
  userId: string,
  memoryId?: string,
): Promise<number> {
  const own = await ownNotes(tx, memory, agentId, userId);
  if (!own) return 0;
  const actor: MemoryActor = { kind: "user", userId };
  const bullets = bulletsOf(own.file.id, own.file.content);
  if (memoryId === undefined) {
    await memory.forgetScope(tx, actor, own.scopeId);
    return bullets.length;
  }
  const target = bullets.find((b) => b.id === memoryId);
  if (!target) return 0;
  const lines = own.file.content.split("\n");
  lines.splice(target.line, 1);
  await memory.writeFile(tx, actor, {
    op: "update",
    fileId: own.file.id,
    content: lines.join("\n"),
    expectedVersion: own.file.version,
  });
  return 1;
}

// ---------------------------------------------------------------- the turn

/** `content` cut to the turn budget (whole code points, UTF-8 bytes), with `truncated` set. */
function forTurn(scopeKind: "personal" | "agent", scopeId: string, file: MemoryFile): TurnMemoryFile {
  const budget = MEMORY_LIMITS.turnFileBytes;
  let content = file.content;
  let truncated = false;
  if (Buffer.byteLength(content, "utf8") > budget) {
    truncated = true;
    let bytes = 0;
    let end = 0;
    for (const ch of content) {
      const n = Buffer.byteLength(ch, "utf8");
      if (bytes + n > budget) break;
      bytes += n;
      end += ch.length;
    }
    content = content.slice(0, end);
  }
  return { scopeKind, scopeId, path: file.path, version: file.version, content, truncated };
}

async function readRoot(tx: Tx, memory: MemoryService, actor: MemoryActor, scopeId: string) {
  try {
    return await memory.readFile(tx, actor, { scopeId, path: ROOT });
  } catch (err) {
    if (err instanceof HttpError && err.statusCode === 404) return null;
    throw err;
  }
}

/**
 * The memory a delivered turn carries (D-02, D-08, MEM-07), decided as the bot acting for the turn's human:
 * - in a one-person DM, the private `MEMORY.md` (its scope is created on that first turn, after the decision) and its
 *   newest `TURN_MEMORY_LIMIT` bullets as `memory` items (oldest first, for `[memory: N]` and older cells);
 * - the bot's own notebook `MEMORY.md` when it exists and every reader of the conversation may read it (the audience
 *   rule); a personal bot's notebook only in its owner's one-person DM.
 * Callers never pass an AI chat (ADR-0019: no memory once shared). Each file is cut to 8 KiB with `truncated`.
 */
export async function loadTurnMemory(
  tx: Tx,
  memory: MemoryService,
  p: {
    agentId: string;
    humanUserId: string;
    oneHumanDm: boolean;
    audience: () => Promise<MemoryAudience>;
  },
): Promise<{ items: MemoryItem[]; files: TurnMemoryFile[] }> {
  const human = p.humanUserId;
  const actor: MemoryActor = { kind: "agent", agentId: p.agentId, onBehalfOfUserId: human };
  const items: MemoryItem[] = [];
  const files: TurnMemoryFile[] = [];
  const only = { userIds: [human], unbounded: false };
  const decide = async (scope: ToolScope, audience: MemoryAudience) =>
    (
      await memory.decideAgentRead(tx, {
        agentId: p.agentId,
        onBehalfOfUserId: human,
        audience,
        scope,
        path: ROOT,
      })
    ).allowed;

  if (p.oneHumanDm) {
    const ref = await memory.resolveToolScope(tx, {
      agentId: p.agentId,
      onBehalfOfUserId: human,
      scope: "personal",
    });
    if (ref && (await decide(ref, only))) {
      const scopeId = await memory.ensureToolScope(tx, human, ref);
      const file = await readRoot(tx, memory, actor, scopeId);
      if (file) {
        files.push(forTurn("personal", scopeId, file));
        items.push(
          ...bulletsOf(file.id, file.content)
            .slice(-TURN_MEMORY_LIMIT)
            .map((b) => toItem(b, file)),
        );
      }
    }
  }

  // The notebook is never created by a turn: only an existing one is offered.
  const notebook = await memory.resolveToolScope(tx, {
    agentId: p.agentId,
    onBehalfOfUserId: human,
    scope: "agent",
  });
  if (notebook?.id && (!notebook.personalLike || p.oneHumanDm)) {
    const audience = p.oneHumanDm ? only : await p.audience();
    if (await decide(notebook, audience)) {
      const file = await readRoot(tx, memory, actor, notebook.id);
      if (file) files.push(forTurn("agent", notebook.id, file));
    }
  }
  return { items, files };
}

// ---------------------------------------------------------------- ocw_memory_save

/**
 * Saves a note for the human of the delivered turn `eventId`. Checks, in order: the turn exists and belongs to this bot
 * (`unknown_turn`), it is a DM (`dm_only`), the turn offered the tool (`not_in_turn`), memory is still effective now
 * (`memory_off`), the note holds no secret (rejected, never stored), then ONE conditional UPDATE of the turn counts the
 * call unless the turn is tainted (`tainted`) or at its tool cap (`cap_reached`). Saves of one owner are serialised
 * (advisory lock), so the dedupe is exact. The note is appended as `- <note>` to the human's private `MEMORY.md` by the
 * bot on behalf of that human (a revision, `memory.file_appended`); a full file (256 KiB) is `cap_reached`. Every
 * outcome is audited without the text.
 */
export async function saveMemory(
  tx: Tx,
  core: Core,
  perms: PermissionService,
  memory: MemoryService,
  p: { eventId: string; agentId: string; text: string },
): Promise<SaveMemoryResult> {
  const text = flattenNote(p.text);
  const chars = p.text.trim().length;
  const [turn] = await tx.select().from(agentTurns).where(eq(agentTurns.eventId, p.eventId));

  const deny = async (reason: MemoryRefusal | "secret_detected") => {
    const known = turn && turn.agentId === p.agentId;
    await core.audit.record(tx, {
      action: "agent.memory_saved",
      resourceType: "agent",
      resourceId: known ? turn.agentId : null,
      result: "denied",
      actorKind: known ? "agent" : "system",
      actorId: known ? turn.agentId : null,
      agentId: known ? turn.agentId : null,
      userId: known ? turn.userId : null,
      clientKind: "agent",
      metadata: { reason, chars },
    });
  };
  const refuse = async (reason: MemoryRefusal): Promise<SaveMemoryResult> => {
    await deny(reason);
    return { refused: reason };
  };

  // Unknown (or another organization's: RLS hides it) or another bot's delivery.
  if (!turn || turn.agentId !== p.agentId) return refuse("unknown_turn");
  if (turn.conversationKind !== "dm") return refuse("dm_only");
  if (!turn.tools.includes(BUILTIN_TOOLS.memorySave)) return refuse("not_in_turn");
  const now = await currentTurnTools(
    tx,
    perms,
    { agentId: turn.agentId, humanUserId: turn.userId, conversationKind: turn.conversationKind },
    core.env,
  );
  if (!now.tools.includes(BUILTIN_TOOLS.memorySave)) return refuse("memory_off");
  if (detectSensitive(text).findings.some((f) => f.severity === "block")) {
    await deny("secret_detected");
    return { rejected: "secret_detected" };
  }

  // Count the call and check the taint in one statement: a web call authorised concurrently on the same
  // turn either lands first (the save is refused) or after (the save already happened before any untrusted
  // content was read).
  const counted = await tx
    .update(agentTurns)
    .set({ toolCalls: sql`${agentTurns.toolCalls} + 1` })
    .where(
      and(
        eq(agentTurns.eventId, turn.eventId),
        eq(agentTurns.tainted, false),
        // 07.16 D-20: after a Work Zone session's output was read, the turn writes no memory (as the claim refuses).
        eq(agentTurns.sessionOutputRead, false),
        lt(agentTurns.toolCalls, MAX_TOOL_CALLS_PER_TURN),
      ),
    )
    .returning({ eventId: agentTurns.eventId });
  if (counted.length === 0) {
    const [after] = await tx
      .select({ tainted: agentTurns.tainted, sessionOutputRead: agentTurns.sessionOutputRead })
      .from(agentTurns)
      .where(eq(agentTurns.eventId, turn.eventId));
    return refuse(after?.tainted || after?.sessionOutputRead ? "tainted" : "cap_reached");
  }

  // The owner is the human the turn was delivered to. Serialise this owner's saves.
  const owner = turn.userId;
  await tx.execute(
    sql`select pg_advisory_xact_lock(hashtextextended(${`memory:${turn.agentId}:${owner}`}, 0))`,
  );
  const actor: MemoryActor = { kind: "agent", agentId: turn.agentId, onBehalfOfUserId: owner };
  const ref = await memory.resolveToolScope(tx, {
    agentId: turn.agentId,
    onBehalfOfUserId: owner,
    scope: "personal",
  });
  if (!ref) return refuse("memory_off");
  const scopeId = await memory.ensureToolScope(tx, owner, ref);

  let memoryId: string;
  let created = false;
  try {
    const existing = await readRoot(tx, memory, actor, scopeId);
    const same = existing && bulletsOf(existing.id, existing.content).some((b) => b.text === text);
    if (existing && same) {
      memoryId = existing.id;
    } else {
      // A savepoint: a refused write (file full, a resolver deny) leaves the counted call and the audit in place.
      const appended = await withSavepoint(
        tx,
        (sp) => memory.appendToFile(sp, actor, { scopeId, path: ROOT, text: `- ${text}` }),
        () => true,
      );
      memoryId = appended.fileId;
      created = true;
    }
  } catch (err) {
    if (err instanceof HttpError && err.code === "memory_file_too_large") return refuse("cap_reached");
    // A rule denying this human or this bot memory (the resolver's 403, or an unreadable scope's 404): memory is off
    // for them; the legacy refusal set is unchanged.
    if (err instanceof AuthzDeniedError || (err instanceof HttpError && err.code === "memory_not_found")) {
      return refuse("memory_off");
    }
    if (err instanceof HttpError && err.code === "secret_detected") {
      await deny("secret_detected");
      return { rejected: "secret_detected" };
    }
    throw err;
  }

  await core.audit.record(tx, {
    action: "agent.memory_saved",
    resourceType: "agent",
    resourceId: turn.agentId,
    actorKind: "agent",
    actorId: turn.agentId,
    agentId: turn.agentId,
    userId: owner,
    clientKind: "agent",
    metadata: { chars, created, conversationId: turn.conversationId },
  });
  return { memoryId, created };
}
