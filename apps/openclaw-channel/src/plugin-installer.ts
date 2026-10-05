import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type {
  AgentChannelPluginReport,
  CellApprovedPlugin,
  CellSnapshot,
  DeclaredSurface,
  PluginInstallEvent,
  PluginUninstallEvent,
} from "./agent-channel-protocol.js";
import type { AgentChannelClient } from "./api-client.js";

/**
 * Marketplace executor (03.1-12, D-14; BOT-09). Runs admin-approved `plugin.install.v1` / `plugin.uninstall.v1`
 * inside the cell, one at a time per process:
 *
 *   1. the event must match a row of the last `GET /cell` approved list (one refresh), and its values must be safe
 *      CLI arguments (they are never interpolated into a shell);
 *   2. the artifact is downloaded only from the configured ClawHub origin (no redirects, 50 MB, 60 s) into a private
 *      temp file, and its sha256 (and npm integrity, and ClawHub's digest header) must equal the approved ones;
 *   3. `openclaw plugins install npm-pack:<file> --force --accept-capabilities` (argv array, 120 s) applies it
 *      through the running gateway; OpenClaw's `security.installPolicy` (infra/openclaw/install-policy.mjs) re-hashes
 *      the staged archive and asks the API again before committing — the executor is not the authority;
 *   4. `plugins inspect <id> --runtime --json` must show the approved plugin id, version and integrity (else it is
 *      uninstalled again); hook restrictions are written; what it declares is reported (`POST /plugins/report`) and
 *      the API re-scores it (a refused surface is uninstalled on the API's command);
 *   5. the boot cache `<state>/ocw-plugins.json` lists installed ids for the boot render fallback ONLY (the gateway
 *      can write it, so it is never trusted for an install decision).
 *
 * Every child process gets `CLAWHUB_DISABLE_TELEMETRY=1`. Reports carry classified codes and fixed texts, never CLI
 * output (it holds host paths). Native plugins run in-process with the gateway: that residual risk is documented in
 * ADR-0011 (T-03.1-12-10).
 */

export const OPENCLAW_CLI = "/app/openclaw.mjs";
export const BOOT_CACHE_FILE = "ocw-plugins.json";
export const MAX_ARTIFACT_BYTES = 50 * 1024 * 1024;
const DOWNLOAD_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 120_000;
const INSPECT_TIMEOUT_MS = 60_000;
const UNINSTALL_TIMEOUT_MS = 120_000;
const REPORT_TIMEOUT_MS = 30_000;

/** Values that end up as CLI arguments: never a flag, never a path. */
const PLUGIN_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/iu;
const VERSION = /^[0-9a-z][0-9a-z.+-]{0,63}$/iu;
const PACKAGE = /^(?:@[a-z0-9][a-z0-9._-]{0,100}\/)?[a-z0-9][a-z0-9._-]{0,100}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;

export type CliResult = { code: number | null; stdout: string; stderr: string; timedOut: boolean };
/** Runs `node ...args` without a shell; `args[0]` is the OpenClaw CLI entry (`/app/openclaw.mjs`). */
export type RunCli = (
  args: readonly string[],
  opts: { env: NodeJS.ProcessEnv; timeoutMs: number },
) => Promise<CliResult>;

type Logger = { info?: (m: string) => void; warn?: (m: string) => void; error?: (m: string) => void };

export type PluginInstallerDeps = {
  client: Pick<AgentChannelClient, "reportPlugin">;
  /** The last `GET /cell` snapshot (approved plugins). */
  snapshot: () => CellSnapshot | undefined;
  /** One fresh `GET /cell` when an event is not (yet) in the snapshot. */
  refresh?: () => Promise<CellSnapshot>;
  /** OpenClaw state dir (boot cache location). */
  stateDir: string;
  /** `OCW_CLAWHUB_URL`: the only origin artifacts are downloaded from. */
  clawhubOrigin: string;
  exec?: RunCli;
  fetchImpl?: typeof fetch;
  /** Writes `plugins.entries.<id>.hooks {allowConversationAccess:false, allowPromptInjection:false}`. */
  restrictHooks?: (pluginId: string) => Promise<void>;
  log?: Logger;
  /** Test knobs. */
  maxBytes?: number;
  tmpDir?: string;
  cliPath?: string;
};

const FAILURES = {
  invalid_event: "The install request is malformed.",
  not_approved: "This plugin version is not in the cell's approved list.",
  untrusted_origin: "The artifact is not on the configured ClawHub origin.",
  download_failed: "The artifact could not be downloaded from ClawHub.",
  too_large: "The artifact is larger than 50 MB.",
  digest_mismatch: "The downloaded artifact does not match the approved digest.",
  install_blocked: "OpenClaw's install gate blocked the install.",
  install_gate_failed: "OpenClaw's install gate failed closed.",
  incompatible: "The plugin is not compatible with this OpenClaw version.",
  consent_required: "OpenClaw asked for a capability consent the cell could not give.",
  timeout: "OpenClaw did not finish within the time limit.",
  install_failed: "OpenClaw could not install the plugin.",
  inspect_failed: "The installed plugin could not be inspected, so it was removed again.",
  plugin_mismatch: "The installed plugin is not the approved one, so it was removed again.",
  hook_restriction_failed: "The plugin's hook restrictions could not be applied, so it was removed again.",
  uninstall_failed: "OpenClaw could not uninstall the plugin.",
} as const;
type FailureCode = keyof typeof FAILURES;

class InstallFailure extends Error {
  constructor(readonly code: FailureCode) {
    super(FAILURES[code]);
    this.name = "InstallFailure";
  }
}

/** Maps a failed `plugins install` to a code (never forwards its output). */
export function classifyInstallFailure(r: CliResult): FailureCode {
  if (r.timedOut) return "timeout";
  const out = `${r.stdout}\n${r.stderr}`;
  if (/install policy failed closed/iu.test(out)) return "install_gate_failed";
  if (/blocked by (?:install )?policy|install policy/iu.test(out)) return "install_blocked";
  if (/integrity|sha512|sha256|digest/iu.test(out)) return "digest_mismatch";
  if (/incompatib|requires (?:a )?newer|minHostVersion|pluginApi/iu.test(out)) return "incompatible";
  if (/capabilit/iu.test(out)) return "consent_required";
  return "install_failed";
}

/** `plugins uninstall` of a plugin that is already gone. */
const ALREADY_GONE = /not associated with a tracked package install|plugin not found/iu;

// ---------------------------------------------------------------- declared surface

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && x.length > 0) : [];
const namesOf = (v: unknown, key = "name"): string[] =>
  Array.isArray(v)
    ? v.flatMap((x) => {
        if (typeof x === "string") return x ? [x] : [];
        const r = asRecord(x);
        const n = r?.[key];
        return typeof n === "string" && n ? [n] : [];
      })
    : [];
const canon = (list: string[]) => [...new Set(list)].sort();

/** Contract families that map to their own DeclaredSurface list (the API's `declaredSurfaceOf` does the same). */
const OWN_CONTRACTS = new Set(["tools", "webSearchProviders", "webFetchProviders"]);

/**
 * OpenClaw's `plugins inspect --json` (manifest contracts + runtime registrations) as the API's DeclaredSurface.
 * Families mirror apps/api/src/modules/plugins/clawhub.ts so the API's risk scorer reads both the same way.
 */
export function declaredSurfaceOfInspect(inspect: unknown): DeclaredSurface {
  const root = asRecord(inspect) ?? {};
  const plugin = asRecord(root.plugin) ?? {};
  const contracts = asRecord(plugin.contracts) ?? {};
  const other: string[] = [];
  for (const [family, ids] of Object.entries(contracts)) {
    if (OWN_CONTRACTS.has(family)) continue;
    const list = strings(ids);
    for (const id of list.length > 0 ? list : [""]) other.push(`${family}:${id}`);
  }
  for (const n of strings(plugin.cliBackendIds)) other.push(`cliBackends:${n}`);
  for (const n of [...strings(plugin.cliCommands), ...namesOf(root.cliCommands)])
    other.push(`cliCommands:${n}`);
  for (const n of namesOf(root.gatewayMethods)) other.push(`gatewayMethodDispatch:${n}`);
  const routes = Math.max(
    typeof root.httpRouteCount === "number" ? root.httpRouteCount : 0,
    typeof plugin.httpRoutes === "number" ? plugin.httpRoutes : 0,
  );
  if (routes > 0) other.push(`httpRoutes:${routes}`);
  for (const n of [...strings(plugin.kind), ...(typeof plugin.kind === "string" ? [plugin.kind] : [])]) {
    other.push(`kind:${n}`);
  }
  for (const n of [...strings(plugin.services), ...namesOf(root.services)]) other.push(`services:${n}`);
  for (const n of strings(plugin.gatewayDiscoveryServiceIds)) other.push(`gatewayDiscovery:${n}`);
  const runtimeTools = Array.isArray(root.tools)
    ? root.tools.flatMap((t) => strings(asRecord(t)?.names))
    : [];
  const channelCaps = Array.isArray(root.capabilities)
    ? root.capabilities.flatMap((c) => (asRecord(c)?.kind === "channel" ? strings(asRecord(c)?.ids) : []))
    : [];
  return {
    tools: canon([...strings(contracts.tools), ...strings(plugin.toolNames), ...runtimeTools]),
    hooks: canon([...namesOf(root.typedHooks), ...namesOf(root.customHooks), ...strings(plugin.hookNames)]),
    channels: canon([...strings(plugin.channelIds), ...channelCaps]),
    providers: canon(strings(plugin.providerIds)),
    webSearchProviders: canon([
      ...strings(contracts.webSearchProviders),
      ...strings(plugin.webSearchProviderIds),
    ]),
    webFetchProviders: canon([
      ...strings(contracts.webFetchProviders),
      ...strings(plugin.webFetchProviderIds),
    ]),
    mcpServers: canon(namesOf(root.mcpServers)),
    other: canon(other),
  };
}

// ---------------------------------------------------------------- default CLI runner

/** `execFile(node, args)`: an argv array, never a shell; killed after `timeoutMs`. */
export const defaultRunCli: RunCli = (args, opts) =>
  new Promise((resolve) => {
    execFile(
      process.execPath,
      [...args],
      {
        env: opts.env,
        timeout: opts.timeoutMs,
        killSignal: "SIGKILL",
        maxBuffer: 8 * 1024 * 1024,
        cwd: path.dirname(args[0] ?? process.cwd()),
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        const e = error as (NodeJS.ErrnoException & { killed?: boolean; code?: number | string }) | null;
        resolve({
          code: e ? (typeof e.code === "number" ? e.code : null) : 0,
          stdout: String(stdout),
          stderr: String(stderr),
          timedOut: Boolean(e?.killed),
        });
      },
    );
  });

// ---------------------------------------------------------------- installer

/** One install/uninstall at a time per process, even across plugin module instances (hot reload). */
const QUEUE_KEY = Symbol.for("ocw.openclaw-channel.plugin-installer.queue");
type QueueRegistry = { [QUEUE_KEY]?: Promise<void> };

function serialized<T>(run: () => Promise<T>): Promise<T> {
  const registry = globalThis as QueueRegistry;
  const previous = registry[QUEUE_KEY] ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(run);
  registry[QUEUE_KEY] = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

type CacheEntry = { pluginId: string; packageName: string; version: string };
type BootCache = { version: 1; installed: CacheEntry[]; updatedAt: string };

const safeFileName = (pkg: string, version: string) =>
  `${pkg.replace(/^@/u, "").replace(/[^a-z0-9._-]+/giu, "-")}-${version.replace(/[^a-z0-9._-]+/giu, "-")}.tgz`;

export function createPluginInstaller(deps: PluginInstallerDeps) {
  const log = deps.log ?? {};
  const cliPath = deps.cliPath ?? OPENCLAW_CLI;
  const exec = deps.exec ?? defaultRunCli;
  const fetchImpl = deps.fetchImpl ?? fetch;
  const maxBytes = deps.maxBytes ?? MAX_ARTIFACT_BYTES;
  const cacheFile = path.join(deps.stateDir, BOOT_CACHE_FILE);

  // npm bounds as in infra/openclaw/entrypoint.mjs (the gateway env normally has them already): without registry
  // egress OpenClaw's peer planning would otherwise retry for ~8 minutes. No telemetry to ClawHub, ever.
  const childEnv = (): NodeJS.ProcessEnv => ({
    npm_config_fetch_retries: "1",
    npm_config_fetch_retry_mintimeout: "2000",
    npm_config_fetch_retry_maxtimeout: "5000",
    npm_config_fetch_timeout: "30000",
    ...process.env,
    CLAWHUB_DISABLE_TELEMETRY: "1",
  });
  const run = (args: string[], timeoutMs: number) => exec([cliPath, ...args], { env: childEnv(), timeoutMs });

  async function report(r: AgentChannelPluginReport): Promise<void> {
    try {
      await deps.client.reportPlugin(r, AbortSignal.timeout(REPORT_TIMEOUT_MS));
    } catch (error) {
      log.warn?.(
        `plugin flow ${r.flowId}: report ${r.state} failed (${error instanceof Error ? error.message.slice(0, 120) : "error"})`,
      );
    }
  }

  const failed = (ev: { flowId: string; pluginRowId: string }, code: FailureCode) =>
    report({
      flowId: ev.flowId,
      pluginRowId: ev.pluginRowId,
      state: "failed",
      error: { code, message: FAILURES[code] },
    });

  // ------------------------------------------------------------ boot cache (fallback only, never trusted)

  async function readCache(): Promise<CacheEntry[]> {
    try {
      const raw = JSON.parse(await readFile(cacheFile, "utf8")) as Partial<BootCache>;
      return (Array.isArray(raw.installed) ? raw.installed : []).filter(
        (e): e is CacheEntry => typeof e?.pluginId === "string" && PLUGIN_ID.test(e.pluginId),
      );
    } catch {
      return [];
    }
  }

  async function saveCache(installed: CacheEntry[]): Promise<void> {
    const body: BootCache = { version: 1, installed, updatedAt: new Date().toISOString() };
    const tmp = `${cacheFile}.tmp-${process.pid}`;
    await writeFile(tmp, `${JSON.stringify(body, null, 2)}\n`, { mode: 0o600 });
    await rename(tmp, cacheFile);
  }

  async function cacheInstalled(entry: CacheEntry): Promise<void> {
    const list = (await readCache()).filter((e) => e.pluginId !== entry.pluginId);
    await saveCache([...list, entry]).catch((error: unknown) => {
      log.warn?.(`boot cache not written (${error instanceof Error ? error.message.slice(0, 80) : "error"})`);
    });
  }

  async function cacheRemoved(pluginId: string): Promise<void> {
    const list = await readCache();
    await saveCache(list.filter((e) => e.pluginId !== pluginId)).catch(() => undefined);
  }

  /** Mirrors the API's installed rows into the boot cache (called after every snapshot refresh). */
  async function writeBootCache(): Promise<void> {
    const plugins = deps.snapshot()?.plugins;
    if (!plugins) return; // older API: leave the cache as the executor last wrote it
    const installed = plugins
      .filter((p) => p.status === "installed" && p.pluginId && PLUGIN_ID.test(p.pluginId))
      .map((p) => ({ pluginId: p.pluginId as string, packageName: p.packageName, version: p.version }));
    await saveCache(installed);
  }

  // ------------------------------------------------------------ approval

  async function approvedRow(
    match: (p: CellApprovedPlugin) => boolean,
  ): Promise<CellApprovedPlugin | undefined> {
    const find = (s: CellSnapshot | undefined) => s?.plugins?.find(match);
    const hit = find(deps.snapshot());
    if (hit || !deps.refresh) return hit;
    try {
      return find(await deps.refresh());
    } catch {
      return undefined;
    }
  }

  // ------------------------------------------------------------ download + verify

  async function download(ev: PluginInstallEvent, dir: string, signal: AbortSignal): Promise<string> {
    let url: URL;
    let origin: URL;
    try {
      url = new URL(ev.artifactUrl);
      origin = new URL(deps.clawhubOrigin);
    } catch {
      throw new InstallFailure("untrusted_origin");
    }
    if ((url.protocol !== "https:" && url.protocol !== "http:") || url.origin !== origin.origin) {
      throw new InstallFailure("untrusted_origin");
    }
    let res: Response;
    try {
      res = await fetchImpl(url, {
        redirect: "error",
        headers: { accept: "application/octet-stream" },
        signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      throw new InstallFailure("download_failed");
    }
    if (res.status !== 200 || !res.body) {
      await res.body?.cancel().catch(() => undefined);
      throw new InstallFailure("download_failed");
    }
    const declaredLength = Number(res.headers.get("content-length") ?? "0");
    if (declaredLength > maxBytes) {
      await res.body.cancel().catch(() => undefined);
      throw new InstallFailure("too_large");
    }
    const file = path.join(dir, safeFileName(ev.packageName, ev.version));
    const sha256 = createHash("sha256");
    const sha512 = createHash("sha512");
    const handle = await open(file, "wx", 0o600);
    let size = 0;
    try {
      for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
        size += chunk.byteLength;
        if (size > maxBytes) throw new InstallFailure("too_large");
        sha256.update(chunk);
        sha512.update(chunk);
        await handle.write(chunk);
      }
    } catch (error) {
      if (error instanceof InstallFailure || signal.aborted) throw error;
      throw new InstallFailure("download_failed");
    } finally {
      await handle.close();
    }
    const digest = sha256.digest("hex");
    const header = res.headers.get("x-clawhub-artifact-sha256")?.trim().toLowerCase();
    if (digest !== ev.sha256.toLowerCase() || (header && header !== digest)) {
      throw new InstallFailure("digest_mismatch");
    }
    if (ev.npmIntegrity && ev.npmIntegrity !== `sha512-${sha512.digest("base64")}`) {
      throw new InstallFailure("digest_mismatch");
    }
    return file;
  }

  // ------------------------------------------------------------ inspect

  async function inspect(pluginId: string): Promise<Record<string, unknown> | null> {
    for (const args of [
      ["plugins", "inspect", pluginId, "--runtime", "--json"],
      ["plugins", "inspect", pluginId, "--json"],
    ]) {
      const r = await run(args, INSPECT_TIMEOUT_MS);
      if (r.code !== 0) continue;
      const text = r.stdout.trim();
      for (const candidate of [text, text.slice(text.indexOf("{"), text.lastIndexOf("}") + 1)]) {
        try {
          const parsed = asRecord(JSON.parse(candidate));
          if (parsed && asRecord(parsed.plugin)) return parsed;
        } catch {
          /* try the next shape */
        }
      }
    }
    return null;
  }

  /** The installed plugin is exactly the approved one (id, package, version, npm integrity when both known). */
  function matchesApproval(ev: PluginInstallEvent, data: Record<string, unknown>): boolean {
    const plugin = asRecord(data.plugin) ?? {};
    const install = asRecord(data.install) ?? {};
    const version = plugin.version ?? plugin.packageVersion ?? install.version;
    if (plugin.id !== ev.expectedPluginId || version !== ev.version) return false;
    if (typeof plugin.packageName === "string" && plugin.packageName !== ev.packageName) return false;
    if (typeof install.integrity === "string" && ev.npmIntegrity && install.integrity !== ev.npmIntegrity) {
      return false;
    }
    return true;
  }

  async function removeAgain(pluginId: string): Promise<void> {
    const r = await run(["plugins", "uninstall", pluginId, "--force"], UNINSTALL_TIMEOUT_MS);
    if (r.code !== 0 && !ALREADY_GONE.test(`${r.stdout}\n${r.stderr}`)) {
      log.error?.(`plugin ${pluginId}: could not remove a rejected install (exit ${r.code})`);
    }
    await cacheRemoved(pluginId);
  }

  async function reportInstalled(ev: PluginInstallEvent, pluginId: string, data: Record<string, unknown>) {
    const declared = declaredSurfaceOfInspect(data);
    await report({
      flowId: ev.flowId,
      pluginRowId: ev.pluginRowId,
      state: "installed",
      pluginId,
      version: ev.version,
      declared,
      declaredTools: declared.tools
        .filter((t) => t.length <= 128)
        .slice(0, 100)
        .map((name) => ({ name })),
    });
  }

  // ------------------------------------------------------------ handlers

  async function install(ev: PluginInstallEvent, signal: AbortSignal): Promise<void> {
    const pluginId = ev.expectedPluginId;
    if (
      !pluginId ||
      !PLUGIN_ID.test(pluginId) ||
      !PACKAGE.test(ev.packageName) ||
      !VERSION.test(ev.version) ||
      !SHA256.test(ev.sha256)
    ) {
      log.warn?.(`plugin flow ${ev.flowId}: malformed install event; refused`);
      return failed(ev, "invalid_event");
    }
    const row = await approvedRow(
      (p) =>
        p.pluginRowId === ev.pluginRowId &&
        p.packageName === ev.packageName &&
        p.version === ev.version &&
        p.sha256.toLowerCase() === ev.sha256.toLowerCase() &&
        (p.pluginId === null || p.pluginId === pluginId) &&
        (p.status === "installing" || p.status === "installed"),
    );
    if (!row) {
      log.warn?.(
        `plugin flow ${ev.flowId}: ${ev.packageName}@${ev.version} is not approved for this cell; refused`,
      );
      return failed(ev, "not_approved");
    }

    // Replay of a flow the API already recorded: report what is installed, never reinstall.
    if (row.status === "installed") {
      const data = await inspect(pluginId);
      if (data && matchesApproval(ev, data)) {
        await cacheInstalled({ pluginId, packageName: ev.packageName, version: ev.version });
        return reportInstalled(ev, pluginId, data);
      }
    }

    const dir = await mkdtemp(path.join(deps.tmpDir ?? tmpdir(), "ocw-plugin-"));
    try {
      const file = await download(ev, dir, signal);
      log.info?.(`plugin ${ev.packageName}@${ev.version}: artifact verified; installing through OpenClaw`);
      // Not tied to the account signal: a plugin-instance swap during the install must not kill it half-way
      // (a replayed event then re-reports or reinstalls the same approved artifact).
      const result = await run(
        ["plugins", "install", `npm-pack:${file}`, "--force", "--accept-capabilities"],
        INSTALL_TIMEOUT_MS,
      );
      if (result.code !== 0 || result.timedOut) {
        const code = classifyInstallFailure(result);
        log.warn?.(`plugin ${ev.packageName}@${ev.version}: install failed (${code})`);
        return failed(ev, code);
      }
      const data = await inspect(pluginId);
      if (!data) {
        await removeAgain(pluginId);
        return failed(ev, "inspect_failed");
      }
      if (!matchesApproval(ev, data)) {
        log.warn?.(
          `plugin ${ev.packageName}@${ev.version}: installed plugin does not match the approval; removed`,
        );
        await removeAgain(pluginId);
        return failed(ev, "plugin_mismatch");
      }
      if (deps.restrictHooks) {
        try {
          await deps.restrictHooks(pluginId);
        } catch {
          await removeAgain(pluginId);
          return failed(ev, "hook_restriction_failed");
        }
      }
      await cacheInstalled({ pluginId, packageName: ev.packageName, version: ev.version });
      log.info?.(`plugin ${ev.packageName}@${ev.version} installed as ${pluginId}`);
      await reportInstalled(ev, pluginId, data);
    } catch (error) {
      if (error instanceof InstallFailure) {
        log.warn?.(`plugin ${ev.packageName}@${ev.version}: ${error.code}`);
        return failed(ev, error.code);
      }
      throw error;
    } finally {
      await rm(dir, { recursive: true, force: true }).catch(() => undefined);
    }
  }

  async function uninstall(ev: PluginUninstallEvent): Promise<void> {
    if (!PLUGIN_ID.test(ev.pluginId)) return failed(ev, "invalid_event");
    // A forged event can only remove a plugin, but still: only rows the API is removing (or rejected).
    const row = await approvedRow(
      (p) =>
        p.pluginRowId === ev.pluginRowId &&
        p.pluginId === ev.pluginId &&
        (p.status === "uninstalling" || p.status === "failed"),
    );
    if (!row) return failed(ev, "not_approved");
    const r = await run(["plugins", "uninstall", ev.pluginId, "--force"], UNINSTALL_TIMEOUT_MS);
    if (r.code !== 0 && !ALREADY_GONE.test(`${r.stdout}\n${r.stderr}`)) {
      log.warn?.(`plugin ${ev.pluginId}: uninstall failed (exit ${r.code})`);
      return failed(ev, r.timedOut ? "timeout" : "uninstall_failed");
    }
    await cacheRemoved(ev.pluginId);
    log.info?.(`plugin ${ev.pluginId} uninstalled`);
    await report({
      flowId: ev.flowId,
      pluginRowId: ev.pluginRowId,
      state: "uninstalled",
      pluginId: ev.pluginId,
    });
  }

  return {
    onInstall: (ev: PluginInstallEvent, signal: AbortSignal) => serialized(() => install(ev, signal)),
    onUninstall: (ev: PluginUninstallEvent, _signal: AbortSignal) => serialized(() => uninstall(ev)),
    // Not queued: it runs after every snapshot refresh, and an install itself may refresh the snapshot (a queued
    // write would wait for that install forever). Writes are atomic (rename); the last one wins.
    writeBootCache,
  };
}

export type PluginInstaller = ReturnType<typeof createPluginInstaller>;
