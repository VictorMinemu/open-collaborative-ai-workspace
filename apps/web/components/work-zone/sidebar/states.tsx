"use client";

import { Button } from "@/components/ui/button";

/**
 * The Work Zone sidebar's small state lines (Phase 07.10, UI-SPEC § States), shared by the sessions and the projects
 * requests: one "Try again" and one empty line, so their look cannot drift apart (07.10-07, UI review fix 3).
 */

/**
 * "Try again" after a failed request: a link button in the foreground colour, underlined, never the accent (UI-SPEC
 * Color: the accent list holds only the onboarding link), 44 px tall below 768.
 */
export function RetryButton({
  testId,
  disabled,
  onClick,
}: {
  testId: string;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="link"
      size="sm"
      data-testid={testId}
      disabled={disabled}
      onClick={onClick}
      className="h-auto p-0 text-[12px] text-foreground underline underline-offset-4 max-md:min-h-11"
    >
      Try again
    </Button>
  );
}

/** "No sessions yet." (existing copy) when there is no project, repository or session. */
export function NoSessionsLine() {
  return <p className="px-2.5 text-[12px] text-muted-foreground">No sessions yet.</p>;
}
