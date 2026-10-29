// `ocw-runtime enroll`: pair this machine with a workspace.
//   - with `--code`: the typed code from Settings › Devices (`POST /api/v1/devices/enroll`), unchanged since 03;
//   - without it: terminal pairing by device code (07.12, D-03), see `pair.ts`.
// Both paths persist through `saveEnrollment`: <OCW_HOME>/device-token (0600, atomic) and runtime.json (0600: server
// URL, device name and, since 07.12 (PD-09), the device id, the web origin and whom it was paired with).
// The token is never printed or logged.

import { chmod, readFile, rename, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { join } from "node:path";
import { EnrollDeviceResponse } from "@ocw/contracts";
import { ensureOcwHome } from "./config.js";

export interface EnrollOptions {
  home: string;
  serverUrl: string;
  code: string;
  name?: string;
  fetchFn?: typeof fetch;
}

/** Whom the device was paired with (RESEARCH Pitfall 3: the server admin sees who controls it). */
export interface PairedWith {
  organization: string;
  owner: string;
  at: string;
}

export interface EnrollResult {
  deviceId: string;
  organizationId: string;
  name: string;
  serverUrl: string;
  tokenPath: string;
  /** The workspace's web origin, when the API sent it (07.12): `<webUrl>/settings/devices`. */
  webUrl?: string;
  /** The organization and owner, when the API sent both (07.12). */
  pairedWith?: PairedWith;
}

export function platformOf(): "darwin" | "linux" | "win32" {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new Error(`unsupported platform ${p}`);
}

/** The server URL without a trailing slash; a path prefix (a reverse proxy under `/ocw`) is kept. */
export function normalizeServerUrl(serverUrl: string): string {
  return new URL(serverUrl).toString().replace(/\/$/, "");
}

/** The proposed device name: the one given, else the hostname without `.local`; at most 80 characters. */
export function proposedDeviceName(name?: string): string {
  return (name?.trim() || hostname().replace(/\.local$/, "")).slice(0, 80);
}

/** The error message of an API answer (`{ error: { message } }`), else a generic line with the HTTP status. */
export function apiErrorMessage(body: unknown, status: number, what: string): string {
  const message = (body as { error?: { message?: unknown } } | null)?.error?.message;
  return typeof message === "string" && message.trim() ? message : `${what} failed (HTTP ${status})`;
}

export async function enroll(opts: EnrollOptions): Promise<EnrollResult> {
  const serverUrl = normalizeServerUrl(opts.serverUrl);
  const name = proposedDeviceName(opts.name);
  const res = await (opts.fetchFn ?? fetch)(`${serverUrl}/api/v1/devices/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: opts.code, name, platform: platformOf() }),
  });
  const body = (await res.json().catch(() => null)) as unknown;
  if (!res.ok) throw new Error(apiErrorMessage(body, res.status, "pairing"));
  return saveEnrollment(opts.home, EnrollDeviceResponse.parse(body), serverUrl, name);
}

/**
 * Persists an enroll answer (typed code or device code): the token file (0600, written atomically) and runtime.json
 * (0600, other keys kept). `deviceName` is the name the API stored (the approver may have changed it), else `name`.
 * `deviceId` is always written; `webUrl` and `pairedWith` are written when the answer carries them and dropped
 * otherwise, so a re-pairing never keeps the previous workspace's owner.
 */
export async function saveEnrollment(
  home: string,
  response: EnrollDeviceResponse,
  serverUrl: string,
  name: string,
): Promise<EnrollResult> {
  const server = normalizeServerUrl(serverUrl);
  const deviceName = response.name ?? name;
  const pairedWith: PairedWith | undefined =
    response.organizationName !== undefined && response.ownerName !== undefined
      ? { organization: response.organizationName, owner: response.ownerName, at: new Date().toISOString() }
      : undefined;

  await ensureOcwHome(home);
  const tokenPath = join(home, "device-token");
  await writeAtomic(tokenPath, `${response.deviceToken}\n`);

  const configPath = join(home, "runtime.json");
  const existing = await readFile(configPath, "utf8")
    .then((t) => JSON.parse(t) as unknown)
    .catch(() => ({}));
  const kept =
    typeof existing === "object" && existing !== null && !Array.isArray(existing)
      ? { ...(existing as Record<string, unknown>) }
      : {};
  delete kept.webUrl;
  delete kept.pairedWith;
  const config = {
    ...kept,
    serverUrl: server,
    deviceName,
    deviceId: response.deviceId,
    ...(response.webUrl ? { webUrl: response.webUrl } : {}),
    ...(pairedWith ? { pairedWith } : {}),
  };
  await writeAtomic(configPath, `${JSON.stringify(config, null, 2)}\n`);

  return {
    deviceId: response.deviceId,
    organizationId: response.organizationId,
    name: deviceName,
    serverUrl: server,
    tokenPath,
    ...(response.webUrl ? { webUrl: response.webUrl } : {}),
    ...(pairedWith ? { pairedWith } : {}),
  };
}

async function writeAtomic(path: string, text: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tmp, text, { mode: 0o600 });
  await rename(tmp, path);
  await chmod(path, 0o600);
}
