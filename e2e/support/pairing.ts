import { expect, type Page } from "@playwright/test";

/**
 * Terminal pairing (07.12, RFC 8628 shape) from a test: what a server's `ocw-runtime enroll` does (start, then poll the
 * token route at the answered interval), and the owner's approval in Settings › Devices. Used by headless-pairing.spec
 * (07.12-07) and the server specs of 07.12-09 and 07.12-10. The device code stays in this process: it only ever goes in
 * request bodies to the API, never in a URL or a log line.
 */

/** Anonymous `POST /api/v1/devices/pairings`, like a server that has no token yet. */
export async function startPairing(apiUrl: string, body: StartPairingBody): Promise<StartPairingAnswer> {
  const res = await fetch(`${apiUrl}/api/v1/devices/pairings`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  expect(res.ok, `start pairing: ${res.status} ${text}`).toBe(true);
  const answer = JSON.parse(text) as StartPairingAnswer;
  expect(answer.userCode, "user code shape").toMatch(/^[0-9A-Z]{4}-[0-9A-Z]{4}$/);
  return answer;
}

/** `StartPairingRequest` of `@ocw/contracts` (e2e keeps its own copy: it does not depend on the workspace packages). */
export interface StartPairingBody {
  name: string;
  platform: "darwin" | "linux" | "win32";
  runtimeVersion?: string;
}

/** `StartPairingResponse` of `@ocw/contracts`. */
export interface StartPairingAnswer {
  deviceCode: string;
  userCode: string;
  verificationUri: string;
  verificationUriComplete: string;
  expiresIn: number;
  interval: number;
}

/** The fields of `EnrollDeviceResponse` the specs read. */
export interface PairingToken {
  deviceId: string;
  deviceToken: string;
  name?: string;
  webUrl?: string;
}

export type PollResult = { ok: true; token: PairingToken } | { ok: false; error: string };

/**
 * Polls `POST /api/v1/devices/pairings/token` at `intervalSeconds` (5 s, the answered interval; + 5 s on `slow_down`,
 * RFC 8628 §3.5) until the owner decides: the device token on approval, or the first error other than
 * `authorization_pending` / `slow_down` (`access_denied`, `expired_token`). Fails the test after `timeoutMs`.
 */
export async function pollPairingToken(
  apiUrl: string,
  deviceCode: string,
  { timeoutMs = 60_000, intervalSeconds = 5 }: { timeoutMs?: number; intervalSeconds?: number } = {},
): Promise<PollResult> {
  const deadline = Date.now() + timeoutMs;
  let interval = intervalSeconds;
  for (;;) {
    const res = await fetch(`${apiUrl}/api/v1/devices/pairings/token`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ deviceCode }),
    });
    const json = (await res.json().catch(() => null)) as
      | (PairingToken & { error?: { code?: string } })
      | null;
    if (res.ok && json) return { ok: true, token: json };
    const code = json?.error?.code ?? `http_${res.status}`;
    if (code === "slow_down") interval += 5;
    else if (code !== "authorization_pending" && res.status !== 429) return { ok: false, error: code };
    if (Date.now() + interval * 1000 > deadline) {
      throw new Error(`pairing token: no decision within ${timeoutMs} ms (last answer ${code})`);
    }
    await new Promise((r) => setTimeout(r, interval * 1000));
  }
}

/**
 * The owner's side: opens the link the server printed (`verificationUriComplete`, already signed in), checks the code
 * matches, optionally renames the device and presses Approve. Resolves once the dialog says it waits for the server.
 */
export async function approvePairingInUi(
  page: Page,
  verificationUriComplete: string,
  name?: string,
): Promise<void> {
  await page.goto(verificationUriComplete);
  const dialog = page.getByTestId("pair-approve-dialog");
  const userCode = new URL(verificationUriComplete).searchParams.get("pair") ?? "";
  await expect(dialog.getByTestId("pair-request-code")).toHaveText(userCode, { timeout: 15_000 });
  if (name !== undefined) await dialog.getByTestId("pair-request-name").fill(name);
  await dialog.getByTestId("pair-approve").click();
  await expect(dialog.getByTestId("pair-approved")).toBeVisible();
}
