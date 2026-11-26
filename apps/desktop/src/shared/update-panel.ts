// The onboarding window's update panel (07.13.1, D-09): what to show for the controller's `OnboardingUpdate`.
// Pure and dependency-free (type imports only), so the bundled renderer can import it without zod.

import type { OnboardingUpdate, UpdateActionArgs } from "./ipc";

/** The tray's wording for the same action. */
const CANCEL_LABEL = "Cancel the restart";

export interface UpdatePanel {
  /** The state sentence (announced politely). */
  text?: string;
  /** A fixed sentence about something that did not work, in the warning tone. */
  tone?: "warning";
  /** The release page, already checked in the main process; opened through the window-open guard. */
  link?: { label: string; url: string };
  /** The one action, sent over `ocw-onboarding:update-action`. */
  button?: { label: string; action: UpdateActionArgs; tone: "primary" | "secondary" };
}

/** `null`: nothing to say, the panel stays hidden. */
export function updatePanel(update: OnboardingUpdate | undefined): UpdatePanel | null {
  if (!update) return null;
  switch (update.kind) {
    case "link":
      return { link: { label: update.label, url: update.url } };
    case "progress":
      return { text: update.label };
    case "error":
      return { text: update.label, tone: "warning" };
    case "ready":
      return { button: { label: update.label, action: "restart", tone: "primary" } };
    case "waiting":
      return {
        text: update.label,
        button: { label: CANCEL_LABEL, action: "cancelWait", tone: "secondary" },
      };
    case "move": {
      const button = { label: update.label, action: "moveToApplications", tone: "primary" } as const;
      return update.link ? { link: update.link, button } : { button };
    }
  }
}
