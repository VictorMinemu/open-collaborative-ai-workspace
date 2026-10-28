"use client";

import { Button } from "@/components/ui/button";

/**
 * The Work Zone sidebar's onboarding (Phase 07.10-05, D-08, UI-SPEC § 9): in place of the department sections while the
 * viewer belongs to no team project. One quiet line (no card, border or icon, not dismissible); it goes away by itself
 * once a project exists. A person who may create somewhere (`viewerCan.create`) gets the way to do it.
 */
export function OnboardingLine({ canCreate, onCreate }: { canCreate: boolean; onCreate: () => void }) {
  return (
    <p data-testid="onboarding-line" className="px-2.5 py-1 text-[12px] text-muted-foreground leading-4">
      {canCreate ? (
        <>
          Share sessions with your team →{" "}
          <Button
            type="button"
            variant="link"
            size="sm"
            onClick={onCreate}
            className="h-auto p-0 align-baseline text-[12px] max-md:min-h-11"
          >
            Create project
          </Button>
        </>
      ) : (
        "Team projects you're added to appear here."
      )}
    </p>
  );
}
