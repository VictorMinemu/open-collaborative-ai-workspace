// `ocw-runtime enroll`: pair this machine with a workspace using a code from Settings › Devices.
// Writes <OCW_HOME>/runtime.json (server URL, device name) and the device token file (mode 0600).
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

export interface EnrollResult {
  deviceId: string;
  organizationId: string;
  name: string;
  serverUrl: string;
  tokenPath: string;
}

function platformOf(): "darwin" | "linux" | "win32" {
  const p = process.platform;
  if (p === "darwin" || p === "linux" || p === "win32") return p;
  throw new Error(`unsupported platform ${p}`);
}

export async function enroll(opts: EnrollOptions): Promise<EnrollResult> {
  const serverUrl = new URL(opts.serverUrl).toString().replace(/\/$/, "");
  const name = (opts.name?.trim() || hostname().replace(/\.local$/, "")).slice(0, 80);
  const res = await (opts.fetchFn ?? fetch)(`${serverUrl}/api/v1/devices/enroll`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code: opts.code, name, platform: platformOf() }),
  });
  const body = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  if (!res.ok) throw new Error(body?.error?.message ?? `pairing failed (HTTP ${res.status})`);
  const out = EnrollDeviceResponse.parse(body);

  await ensureOcwHome(opts.home);
  const tokenPath = join(opts.home, "device-token");
  const tmp = `${tokenPath}.${process.pid}.tmp`;
  await writeFile(tmp, `${out.deviceToken}\n`, { mode: 0o600 });
  await rename(tmp, tokenPath);
  await chmod(tokenPath, 0o600);

  const configPath = join(opts.home, "runtime.json");
  const existing = await readFile(configPath, "utf8")
    .then((t) => JSON.parse(t) as Record<string, unknown>)
    .catch(() => ({}));
  const config = { ...existing, serverUrl, deviceName: name };
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  await chmod(configPath, 0o600);
  return { deviceId: out.deviceId, organizationId: out.organizationId, name, serverUrl, tokenPath };
}
