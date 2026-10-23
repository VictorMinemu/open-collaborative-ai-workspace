/**
 * The sign-in sentences of the UI-SPEC (Copywriting › Sign-in card › Model-facing sentences), verbatim (07.8). `posted`
 * is the answer of `ocw_browser_signin`; `skipped` is what the card's outcome tells the model in the requester's
 * card-action turn (07.8-21, `cardAction.signIn`); `signedIn` is that turn's instruction once they signed in. A leaf
 * module, so the mention mapper reads them without importing the tools (no import cycle). `expired` delivers no turn
 * (nobody acted, like an approval that expired); the requester sees it on the card.
 */
export const SIGNIN_SENTENCES = {
  posted:
    "I posted a sign-in card for {host}. Tell {requester} in one short sentence that they need to sign in there; don't ask for passwords.",
  skipped:
    "{requester} chose not to sign in to {host}. Don't ask again in this turn; tell them what you can do without it.",
  expired: "No one signed in to {host} in time. Tell {requester} they can ask again.",
  notAllowed: "Signing in only works in {requester}'s private chat with you. Tell them to ask you there.",
  moduleOff: "The browser is turned off for {requester}.",
  signedIn:
    "{requester} signed in to {host} and handed the page back. Continue the task: take a new ocw_browser_snapshot first. Never type or reveal a password.",
} as const;
