// Phase 07.11 (runtime CLI auto-updates, D-04, D-07, D-12, PD-10): the latest version of a runtime CLI on the
// channel its install follows, from the npm registry. The device's only outbound call for this feature; its answer
// is untrusted (bounded body, Zod, version regex) and any failure is `null` (unknown, never "behind").
//
// No host path leaves the device: this module sends only the package name and the dist-tag.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseRuntimeVersion, type RuntimeId, RuntimeVersion, type UpdateChannel } from "@ocw/contracts";
import { z } from "zod";
import type { InstallResolution } from "./install-method.js";

export const DEFAULT_REGISTRY_URL = "https://registry.npmjs.org";
const REGISTRY_TIMEOUT_MS = 4_000;
const REGISTRY_TTL_MS = 60 * 60 * 1000;
const MAX_BODY_BYTES = 64 * 1024;

/** The packages (duplicated from install-method.ts to keep this module free of a runtime import cycle). */
const PACKAGES: Readonly<Record<RuntimeId, string>> = {
  "claude-code": "@anthropic-ai/claude-code",
  codex: "@openai/codex",
};

const DistTagAnswer = z.object({ version: RuntimeVersion });

export interface RegistryClientOptions {
  /** Device env: `OCW_RUNTIME_REGISTRY_URL` points at a mirror (corporate) or a stub (tests). */
  env?: NodeJS.ProcessEnv;
  fetchFn?: typeof fetch;
  now?: () => number;
  timeoutMs?: number;
  ttlMs?: number;
}

/** `OCW_RUNTIME_REGISTRY_URL` when it is an http(s) URL, else the public registry; no trailing slash. */
export function registryBaseUrl(env: NodeJS.ProcessEnv): string {
  const raw = env.OCW_RUNTIME_REGISTRY_URL?.trim();
  if (raw) {
    try {
      const url = new URL(raw);
      if (url.protocol === "https:" || url.protocol === "http:") return url.toString().replace(/\/+$/, "");
    } catch {
      // not a URL: fall back to the public registry
    }
  }
  return DEFAULT_REGISTRY_URL;
}

/** `@scope/name` → `@scope%2Fname` (the registry's own form). */
function encodePackage(pkg: string): string {
  return encodeURIComponent(pkg).replace(/^%40/, "@");
}

async function readCapped(res: Response, max: number): Promise<string | null> {
  const declared = Number(res.headers.get("content-length") ?? "0");
  if (declared > max) {
    await res.body?.cancel();
    return null;
  }
  if (!res.body) return "";
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Latest-version lookups, cached per (package, dist-tag) for an hour; failures are never cached. */
export class RegistryClient {
  private readonly env: NodeJS.ProcessEnv;
  private readonly fetchFn: typeof fetch;
  private readonly now: () => number;
  private readonly timeoutMs: number;
  private readonly ttlMs: number;
  private readonly cache = new Map<string, { version: string; at: number }>();

  constructor(opts: RegistryClientOptions = {}) {
    this.env = opts.env ?? process.env;
    this.fetchFn = opts.fetchFn ?? ((input, init) => fetch(input, init));
    this.now = opts.now ?? Date.now;
    this.timeoutMs = opts.timeoutMs ?? REGISTRY_TIMEOUT_MS;
    this.ttlMs = opts.ttlMs ?? REGISTRY_TTL_MS;
  }

  /** The version `tag` points at for `runtime`'s package, or null (unknown) on any failure. */
  async latest(runtime: RuntimeId, tag: UpdateChannel): Promise<string | null> {
    const pkg = PACKAGES[runtime];
    const key = `${pkg}\u0000${tag}`;
    const hit = this.cache.get(key);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.version;

    const url = `${registryBaseUrl(this.env)}/${encodePackage(pkg)}/${encodeURIComponent(tag)}`;
    try {
      const res = await this.fetchFn(url, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(this.timeoutMs),
      });
      if (!res.ok) {
        await res.body?.cancel();
        return null;
      }
      const text = await readCapped(res, MAX_BODY_BYTES);
      if (text === null) return null;
      const parsed = DistTagAnswer.safeParse(JSON.parse(text));
      if (!parsed.success) return null;
      const version = parseRuntimeVersion(parsed.data.version);
      if (version !== parsed.data.version) return null;
      this.cache.set(key, { version, at: this.now() });
      return version;
    } catch {
      return null;
    }
  }
}

/**
 * The dist-tag the install follows (PD-10, Pitfall 6): Homebrew `claude-code` → `stable` (`claude-code@latest` →
 * `latest`); native Claude → `stable` when `~/.claude/settings.json` says `"autoUpdatesChannel": "stable"`; everything
 * else (npm, Codex) → `latest`. Codex has many prerelease tags, so only `latest` is ever read.
 */
export function channelFor(
  resolution: Pick<InstallResolution, "runtime" | "method" | "brewName">,
  home: string,
): UpdateChannel {
  if (resolution.runtime !== "claude-code") return "latest";
  if (resolution.method === "homebrew_cask")
    return resolution.brewName === "claude-code" ? "stable" : "latest";
  if (resolution.method === "native") return nativeClaudeChannel(home);
  return "latest";
}

/** `autoUpdatesChannel` from `~/.claude/settings.json` (read tolerantly: anything unexpected is `latest`). */
function nativeClaudeChannel(home: string): UpdateChannel {
  try {
    const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8")) as unknown;
    return (settings as { autoUpdatesChannel?: unknown } | null)?.autoUpdatesChannel === "stable"
      ? "stable"
      : "latest";
  } catch {
    return "latest";
  }
}
