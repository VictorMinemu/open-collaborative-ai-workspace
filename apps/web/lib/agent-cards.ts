import { type AgentCard, isAgentCardRoute } from "@ocw/contracts";

/**
 * Pure Agent Card helpers (06-15, AGENT-04, P-11). Realtime events carry a card without the viewer's fields
 * (`following`, `viewerCan`, P-04); REST snapshots and the single-card read carry them. These keep the viewer's fields
 * across live updates and never offer `decide` on a decided card, whatever a cache still says.
 */

type ViewerCan = NonNullable<AgentCard["viewerCan"]>;

/** `viewerCan` without `decide` once the card is decided (the server refuses a second decision anyway). */
function capable(card: Pick<AgentCard, "decision">, viewerCan: ViewerCan | undefined): ViewerCan | undefined {
  if (!viewerCan) return undefined;
  return card.decision ? viewerCan.filter((c) => c !== "decide") : viewerCan;
}

/** `next` (from an update) over `prev` (cached): the update's content, the cached viewer fields when it has none. */
export function mergeCard(prev: AgentCard | undefined, next: AgentCard): AgentCard {
  const own = next.viewerCan !== undefined;
  const viewerCan = capable(next, own ? next.viewerCan : prev?.viewerCan);
  const following = own ? next.following : prev?.following;
  const { viewerCan: _v, following: _f, ...content } = next;
  return {
    ...content,
    ...(following !== undefined ? { following } : {}),
    ...(viewerCan !== undefined ? { viewerCan } : {}),
  };
}

const at = (c: AgentCard) => Date.parse(c.updatedAt) || 0;

/**
 * The card to show: the newer content of the conversation's copy (`fromList`) and the viewer's own read or last
 * action (`fromViewer`, e.g. a decision response that beat its realtime event), with the viewer's fields from
 * `fromViewer` when there is one.
 */
export function shownCard(fromList: AgentCard, fromViewer: AgentCard | undefined): AgentCard {
  if (!fromViewer) return mergeCard(undefined, fromList);
  const newer =
    at(fromViewer) > at(fromList) ||
    (at(fromViewer) === at(fromList) && fromViewer.version > fromList.version)
      ? fromViewer
      : fromList;
  return mergeCard(fromViewer, {
    ...newer,
    following: fromViewer.following ?? fromList.following ?? false,
    viewerCan: fromViewer.viewerCan ?? fromList.viewerCan ?? [],
  });
}

/** The Open target, only when it is an internal app route (the client re-checks `AgentCardRoute`). */
export function openTargetOf(card: Pick<AgentCard, "actions">): string | null {
  const open = card.actions.find((a) => a.kind === "open");
  return open?.kind === "open" && isAgentCardRoute(open.target) ? open.target : null;
}
