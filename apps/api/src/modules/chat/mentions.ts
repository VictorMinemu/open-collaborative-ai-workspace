import {
  extractMentionHandles,
  isReservedHandle,
  type MessageMention,
  TEAM_MENTION_LIMITS,
} from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import { type PermissionService, unitResource } from "../organization";
import type { Directory } from "./directory";

/**
 * Phase 07.17 (D-07, D-17, PD-13): whether `@handle` may name a team or department, decided by `unitMentionGate`.
 * Without `units` no unit ever resolves (DMs, group DMs, AI chats, display-only directories).
 */
export interface ResolveMentionOptions {
  units?: {
    /** The author (or a bot's turn human) may read this unit: `unit.read`, decided by the resolver beforehand. */
    allowed: (unitId: string) => boolean;
    /** At most this many distinct units, in text order (a bot's message: `TEAM_MENTION_LIMITS.botUnitsPerMessage`). */
    max?: number;
  };
}

/**
 * Server-authoritative mention resolution: `@handle` tokens in the body resolved against the org directory
 * (agents by username, humans by `userHandle`). Client-sent mention arrays are ignored, so a client cannot
 * trigger an agent the text does not address. Unknown handles are dropped, and reserved handles (`@channel`,
 * `@here`, `@everyone`) never resolve to a person or a bot (Pitfall 6): they are broadcasts, decided by chat.
 *
 * Phase 07.17 (PD-13): with `opts.units`, a handle no bot or person holds may name a team or department the gate
 * allows (precedence agents → users → units), capped at `max` distinct units. People and bots are never capped (D-17),
 * and a body without unit handles resolves exactly what it resolved before (P5).
 */
export function resolveMentions(
  body: string,
  dir: Directory,
  opts?: ResolveMentionOptions,
): MessageMention[] {
  const out: MessageMention[] = [];
  const seen = new Set<string>();
  let units = 0;
  for (const handle of extractMentionHandles(body)) {
    if (isReservedHandle(handle)) continue;
    const e = dir.byHandle.get(handle);
    if (e) {
      const key = `${e.kind}:${e.id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ kind: e.kind, id: e.id });
      continue;
    }
    if (!opts?.units) continue;
    const u = dir.unitsByHandle?.get(handle);
    if (!u || !opts.units.allowed(u.id)) continue;
    const key = `unit:${u.id}`;
    if (seen.has(key)) continue;
    if (opts.units.max !== undefined && units >= opts.units.max) continue;
    seen.add(key);
    units += 1;
    out.push({ kind: "unit", id: u.id });
  }
  return out;
}

/** Conversation kinds of a post: a `thread` conversation counts as a channel post only under a channel. */
export interface UnitMentionGateInput {
  body: string;
  dir: Directory;
  conversationKind: string;
  /** The parent conversation's kind (a `thread` conversation); null otherwise. */
  parentKind?: string | null;
  /** The human whose `unit.read` decides: the author, or a bot's turn human (`onBehalfOfUserId`); null = no units. */
  humanUserId: string | null;
  /** A bot's message: at most `TEAM_MENTION_LIMITS.botUnitsPerMessage` distinct units (D-17). */
  agentAuthor: boolean;
}

/**
 * Phase 07.17 (D-07, D-17, D-18, PD-13): the unit options of one post. Units resolve only on channel posts (top-level,
 * thread replies, board cards: a `channel` conversation, or a `thread` one whose parent is a channel), never in DMs,
 * group DMs, AI chats or Work Zone conversations. The human must hold `unit.read` on each unit, decided by the resolver
 * only for the units the body names under a handle no bot or person holds. No human (a bot post outside a turn) = no
 * units. A bot's message keeps at most three units; its person mentions are untouched.
 */
export async function unitMentionGate(
  tx: Tx,
  perms: Pick<PermissionService, "decide">,
  p: UnitMentionGateInput,
): Promise<ResolveMentionOptions | undefined> {
  const channelPost =
    p.conversationKind === "channel" || (p.conversationKind === "thread" && p.parentKind === "channel");
  if (!channelPost || !p.humanUserId || !p.dir.unitsByHandle) return undefined;
  const allowed = new Set<string>();
  for (const handle of extractMentionHandles(p.body)) {
    if (isReservedHandle(handle) || p.dir.byHandle.has(handle)) continue;
    const unit = p.dir.unitsByHandle.get(handle);
    if (!unit || allowed.has(unit.id)) continue;
    const d = await perms.decide(
      tx,
      { kind: "user", userId: p.humanUserId },
      "unit.read",
      unitResource(unit),
    );
    if (d.allowed) allowed.add(unit.id);
  }
  return {
    units: {
      allowed: (id) => allowed.has(id),
      ...(p.agentAuthor ? { max: TEAM_MENTION_LIMITS.botUnitsPerMessage } : {}),
    },
  };
}
