import type { Page, Request } from "@playwright/test";

/**
 * The bodies of the responses the page loads from now on whose request matches `match`, for "a secret never comes
 * back to the page" checks. Read on `requestfinished` only: a body that never finishes (its fetch was torn down by a
 * navigation, or the page went away) is never awaited. Reading it from the `response` event instead waits forever on
 * such a body: 07.5-15 hit it in connectors-journey, and Woodpecker pipeline 60 in connectors.spec (desktop, 240 s
 * timeout twice), where `goto` left fetches of the previous page half-received. A body that did not finish never
 * reached the page's code either, so the check loses nothing.
 */
export function finishedBodies(page: Page, match: (request: Request) => boolean): () => Promise<string[]> {
  const bodies: Array<Promise<string>> = [];
  page.on("requestfinished", (request) => {
    if (!match(request)) return;
    bodies.push(
      request
        .response()
        .then((r) => r?.text() ?? "")
        .catch(() => ""),
    );
  });
  return () => Promise.all(bodies);
}

/** Requests to the API (`/api/` or `/api/v1/` in the URL). */
export const apiRequests =
  (prefix = "/api/v1/") =>
  (request: Request) =>
    request.url().includes(prefix);
