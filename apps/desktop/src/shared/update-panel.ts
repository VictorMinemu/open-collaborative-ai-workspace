// The onboarding window's update panel (07.13.1, D-09): what to show for the controller's `OnboardingUpdate`.
// Pure and dependency-free (type imports only), so the bundled renderer can import it without zod.

import type { OnboardingUpdate, UpdateActionArgs } from "./ipc";

export interface UpdatePanel {
  /** The state sentence (announced politely). */
  text?: string;
  /** The release page, already checked in the main process; opened through the window-open guard. */
  link?: { label: string; url: string };
  /** The one action, sent over `ocw-onboarding:update-action`. */
  button?: { label: string; action: UpdateActionArgs; tone: "primary" | "secondary" };
}

/** `null`: nothing to say, the panel stays hidden. */
export function updatePanel(update: OnboardingUpdate | undefined): UpdatePanel | null {
  if (!update) return null;
  switch (update.kind) {
    case "ready":
      return { button: { label: update.label, action: "restart", tone: "primary" } };
    default:
      return null;
  }
}
