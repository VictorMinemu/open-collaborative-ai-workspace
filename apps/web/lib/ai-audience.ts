import type { AiChatGrant, AiChatParticipants, AiParticipant } from "@ocw/contracts";

/**
 * How widely an AI chat is shared, in words (06-12, MULTI-01, D-08): the header chip and the first line of the
 * participants list. Pure. The owner reads it from their grants (names of teams and people); everyone else from the
 * participants the server lists and its `audience` (the grant list is the owner's, P-04).
 */

type Audience = AiChatParticipants["audience"];

const ACCESS: Record<AiParticipant["access"], string> = {
  owner: "Owner",
  chat: "Can chat",
  view: "Can view",
  agent: "Agent",
};

export function accessLabel(access: AiParticipant["access"]): string {
  return ACCESS[access];
}

const RANK = { org: 0, unit: 1, user: 2 } as const;
const widestFirst = (grants: readonly AiChatGrant[]) =>
  [...grants].sort((a, b) => RANK[a.subject.kind] - RANK[b.subject.kind] || a.label.localeCompare(b.label));

const people = (n: number) => `${n} ${n === 1 ? "person" : "people"}`;

/** "Shared with Backend", "Shared with everyone", "Shared with 3 people", "4 people", "You and @backend". */
export function audienceSummary(p: {
  audience: Audience;
  participants: readonly AiParticipant[];
  viewerId: string | null;
  /** The owner's grants (absent for everyone else). */
  grants?: readonly AiChatGrant[] | undefined;
}): string {
  const agents = p.participants.filter((x) => x.kind === "agent");
  const others = p.participants.filter((x) => x.kind === "user" && x.access !== "owner");
  if (p.audience === "organization" || p.grants?.some((g) => g.subject.kind === "org")) {
    return "Shared with everyone";
  }
  if (p.grants && p.grants.length > 0) {
    const [first, ...rest] = widestFirst(p.grants);
    if (!first) return "Shared";
    if (first.subject.kind === "unit")
      return rest.length ? `Shared with ${first.label} +${rest.length}` : `Shared with ${first.label}`;
    return p.grants.length === 1 ? `Shared with ${first.label}` : `Shared with ${people(p.grants.length)}`;
  }
  if (others.length === 0) {
    if (agents.length === 0) return "Only you";
    const [one] = agents;
    return agents.length === 1 && one
      ? `You and @${one.handle ?? one.displayName}`
      : `You and ${agents.length} agents`;
  }
  if (p.audience === "listed" && others.length === 1 && others[0]) {
    return others[0].id === p.viewerId ? "Shared with you" : `Shared with ${others[0].displayName}`;
  }
  // Without the owner's grant list a team's name is unknown: say how many people are in the chat.
  return people(others.length + 1);
}

/** The participants list's scope line. */
export function audienceScope(p: {
  audience: Audience;
  orgName: string;
  grants?: readonly AiChatGrant[] | undefined;
}): string {
  if (p.grants && p.grants.length > 0) {
    const parts = widestFirst(p.grants).map(
      (g) => `${g.label} (${g.level === "chat" ? "Can chat" : "Can view"})`,
    );
    const last = parts.pop();
    return `Shared with ${parts.length ? `${parts.join(", ")} and ${last}` : last}`;
  }
  if (p.audience === "organization") return `Everyone at ${p.orgName} can open this chat`;
  if (p.audience === "units") return "Shared with a team or department: everyone in it can open this chat";
  return "Only the people below can open this chat";
}
