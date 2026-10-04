// Device enrollment against the API: `POST /api/v1/devices/enroll {code, name, platform}` →
// `{deviceId, organizationId, deviceToken}` (token returned once). Plus a reachability probe.
// The token is handed straight to the config store (safeStorage); it is never logged.

import { z } from "zod";

export const EnrollResponse = z.object({
  deviceId: z.string().min(1),
  organizationId: z.string().min(1).optional(),
  deviceToken: z.string().min(16),
});
export type EnrollResponse = z.infer<typeof EnrollResponse>;

export class EnrollError extends Error {}

type FetchFn = typeof fetch;

function platformOf(p: NodeJS.Platform): "darwin" | "linux" | "win32" {
  return p === "darwin" || p === "win32" ? p : "linux";
}

export async function enrollDevice(
  input: { apiUrl: string; code: string; deviceName: string; platform?: NodeJS.Platform },
  fetchFn: FetchFn = fetch,
  timeoutMs = 15_000,
): Promise<EnrollResponse> {
  let res: Response;
  try {
    res = await fetchFn(`${input.apiUrl}/api/v1/devices/enroll`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({
        code: input.code.trim(),
        name: input.deviceName.trim(),
        platform: platformOf(input.platform ?? process.platform),
      }),
      signal: AbortSignal.timeout(timeoutMs),
      redirect: "error",
    });
  } catch {
    throw new EnrollError(`Could not reach the API at ${input.apiUrl}. Is the server running?`);
  }
  if (
    res.status === 400 ||
    res.status === 404 ||
    res.status === 409 ||
    res.status === 410 ||
    res.status === 422
  ) {
    throw new EnrollError("That pairing code is invalid or has expired. Create a new one in Devices.");
  }
  if (res.status === 429) throw new EnrollError("Too many attempts. Wait a minute and try again.");
  if (!res.ok) throw new EnrollError(`The server could not pair this device (HTTP ${res.status}).`);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new EnrollError("The server returned an unexpected response.");
  }
  const parsed = EnrollResponse.safeParse(body);
  if (!parsed.success) throw new EnrollError("The server returned an unexpected response.");
  return parsed.data;
}

export interface ServerCheck {
  web: boolean;
  api: boolean;
  /** Short reason when something is unreachable. */
  message: string | null;
}

async function reachable(url: string, fetchFn: FetchFn, timeoutMs: number): Promise<Response | null> {
  try {
    return await fetchFn(url, { method: "GET", redirect: "manual", signal: AbortSignal.timeout(timeoutMs) });
  } catch {
    return null;
  }
}

export async function checkServer(
  webUrl: string,
  apiUrl: string,
  fetchFn: FetchFn = fetch,
  timeoutMs = 5000,
): Promise<ServerCheck> {
  const [web, api] = await Promise.all([
    reachable(webUrl, fetchFn, timeoutMs),
    reachable(`${apiUrl}/health`, fetchFn, timeoutMs),
  ]);
  const webOk = web !== null && web.status < 500;
  const apiOk = api?.ok === true;
  let message: string | null = null;
  if (!webOk && !apiOk) message = `Nothing is answering at ${webUrl}. Start the server and try again.`;
  else if (!webOk) message = `The web app at ${webUrl} is not answering.`;
  else if (!apiOk) message = `The API at ${apiUrl} is not answering. Check the API address.`;
  return { web: webOk, api: apiOk, message };
}
