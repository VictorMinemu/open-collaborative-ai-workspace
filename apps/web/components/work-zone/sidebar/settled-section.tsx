"use client";

import type { SettledModel } from "./model";
import { InlineMore, SectionShell } from "./needs-you-section";
import type { RowContext } from "./sections";
import { SettledRow } from "./session-rows";

/**
 * Settled (Phase 07.10-04, D-04, UI-SPEC § 8): the history of the viewer's sidebar scope as a section at the end,
 * collapsed by default and remembered with the others. Its header is the shared section header with the existing
 * `settled-group` / `settled-toggle` ids; its rows are the existing `SettledRow`, 10 then "Show {n} more" /
 * "Show fewer" (`settled-more`, the same `InlineMore` row as Needs you and search: h-7, 12 px; 07.10-07 UI review fix
 * 3). No count pill: history is not news (§ 2).
 */
export function SettledSection({
  model,
  now,
  viewerId,
  openSessionId,
  onToggle,
  onExpand,
}: { model: SettledModel | null } & RowContext) {
  if (!model) return null;
  return (
    <SectionShell
      sectionKey="settled"
      title="Settled"
      collapsed={model.collapsed}
      hidden={0}
      onToggle={onToggle}
      testId="settled-group"
      toggleTestId="settled-toggle"
    >
      {model.rows.map((s) => (
        <li key={s.id}>
          <SettledRow s={s} now={now} active={s.id === openSessionId} viewerId={viewerId} />
        </li>
      ))}
      {model.more > 0 || model.expanded ? (
        <li>
          <InlineMore
            testId="settled-more"
            expanded={model.expanded}
            label={`Show ${model.more} more`}
            controls="wz-list-settled"
            onToggle={() => onExpand("settled")}
          />
        </li>
      ) : null}
    </SectionShell>
  );
}
