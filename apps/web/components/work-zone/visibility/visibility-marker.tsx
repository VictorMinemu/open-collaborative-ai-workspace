"use client";

import { FolderKanban, Lock, type LucideIcon, Users } from "lucide-react";
import { Tooltip } from "@/components/ui/tooltip";
import { type LabelledSession, type MarkerKind, sessionLabels } from "@/lib/session-visibility";

type MarkedSession = LabelledSession;

const ICON: Record<Exclude<MarkerKind, "none">, LucideIcon> = {
  lock: Lock,
  users: Users,
  project: FolderKanban,
};

/**
 * The sidebar marker (Phase 07.9, UI-SPEC Surface 2, D-07): nothing when the session follows its project's default
 * (N2); otherwise one muted 12 px icon with a tooltip on desktop pointers. No text and no colour (N5). The icon is
 * hidden from assistive tech: the row link carries the meaning through `VisibilitySrSuffix`. The API decides whether
 * the session differs (`differsFromDefault`); this only picks the icon.
 */
export function VisibilityMarker({
  session,
  viewerId,
}: {
  session: MarkedSession;
  viewerId: string | null | undefined;
}) {
  const labels = sessionLabels(session, viewerId);
  if (labels.marker === "none") return null;
  const Icon = ICON[labels.marker];
  return (
    <Tooltip content={labels.tooltip}>
      <span data-testid="visibility-marker" data-kind={labels.marker} className="inline-flex shrink-0">
        <Icon aria-hidden className="size-3 shrink-0 text-muted-foreground/80" />
      </span>
    </Tooltip>
  );
}

/** The row link's screen-reader suffix (", only visible to you"); nothing on the default. */
export function VisibilitySrSuffix({
  session,
  viewerId,
}: {
  session: MarkedSession;
  viewerId: string | null | undefined;
}) {
  const { srSuffix } = sessionLabels(session, viewerId);
  return srSuffix ? <span className="sr-only">{srSuffix}</span> : null;
}
