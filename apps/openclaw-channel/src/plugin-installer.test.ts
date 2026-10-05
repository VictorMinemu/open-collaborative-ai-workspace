/**
 * Marketplace executor (03.1-12, D-14): `plugin.install.v1` / `plugin.uninstall.v1` against a fake OpenClaw CLI and
 * a fake ClawHub fetch. Proves what runs (argv, env), what never runs (wrong origin, wrong digest, unapproved), what
 * is reported (classified, no CLI output) and what the boot cache holds.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type {
  AgentChannelPluginReport,
  CellApprovedPlugin,
  CellSnapshot,
  PluginInstallEvent,
  PluginUninstallEvent,
} from "./agent-channel-protocol.js";
import { AgentChannelHttpError } from "./api-client.js";
import {
  BOOT_CACHE_FILE,
  type CliResult,
  createPluginInstaller,
  declaredSurfaceOfInspect,
  defaultRunCli,
  OPENCLAW_CLI,
  type RunCli,
  reportPluginViaChild,
} from "./plugin-installer.js";

const ORIGIN = "http://fake-model:18999";
const ARTIFACT = Buffer.from("pretend npm-pack tarball bytes of @ocw-test/echo-plugin 0.1.0");
const SHA = createHash("sha256").update(ARTIFACT).digest("hex");
const INTEGRITY = `sha512-${createHash("sha512").update(ARTIFACT).digest("base64")}`;
const ROW = "0199a000-0000-7000-8000-0000000p0001";
const FLOW = "0199a000-0000-7000-8000-0000000f0001";
const URL_OK = `${ORIGIN}/api/v1/packages/%40ocw-test%2Fecho-plugin/versions/0.1.0/artifact/download`;

/** The real inspect output of the fixture, with the npm integrity of this test's artifact. */
const INSPECT_ECHO = (() => {
  const d = JSON.parse(
    readFileSync(new URL("./testing/fixtures/inspect-ocw-echo.json", import.meta.url), "utf8"),
  );
  d.install.integrity = INTEGRITY;
  return JSON.stringify(d);
})();
const INSPECT_DDG = readFileSync(
  new URL("./testing/fixtures/inspect-duckduckgo.json", import.meta.url),
  "utf8",
);

function event(over: Partial<PluginInstallEvent> = {}): PluginInstallEvent {
  return {
    type: "plugin.install.v1",
    seq: 7,
    flowId: FLOW,
    pluginRowId: ROW,
    packageName: "@ocw-test/echo-plugin",
    version: "0.1.0",
    artifactUrl: URL_OK,
    sha256: SHA,
    npmIntegrity: INTEGRITY,
    expectedPluginId: "ocw-echo",
    mode: "install",
    ...over,
  };
}

function approved(over: Partial<CellApprovedPlugin> = {}): CellApprovedPlugin {
  return {
    pluginRowId: ROW,
    packageName: "@ocw-test/echo-plugin",
    version: "0.1.0",
    sha256: SHA,
    pluginId: "ocw-echo",
    status: "installing",
    ...over,
  };
}

function snapshot(plugins: CellApprovedPlugin[]): CellSnapshot {
  return {
    protocolVersion: 1,
    cellId: "cell-1",
    organizationId: "cell-1",
    topic: "cell:cell-1",
    lastSeq: 7,
    agents: [],
    providers: [],
    plugins,
  };
}

type Call = {
  args: string[];
  env: NodeJS.ProcessEnv;
  timeoutMs: number;
  artifact?: { mode: number; dirMode: number; bytes: Buffer };
};

let stateDir: string;
let calls: Call[];
let reports: AgentChannelPluginReport[];
let fetched: string[];
let snap: CellSnapshot;
let refreshes: number;
/** CLI behaviour per subcommand; `inspect` is the plugin's inspect output once it is installed. */
let cli: {
  install: CliResult;
  uninstall: CliResult;
  inspect: CliResult;
  config: CliResult;
  installsAs: string;
};
/** The modelled OpenClaw: installed plugin ids and `plugins.entries[<id>].hooks` written by `config set`. */
let oc: { installed: Set<string>; hooks: Map<string, Record<string, unknown>>; disabled: Set<string> };
const HOOKS_OFF = '{"allowConversationAccess":false,"allowPromptInjection":false}';
const configSet = (id: string) => [
  OPENCLAW_CLI,
  "config",
  "set",
  `plugins.entries["${id}"].hooks`,
  HOOKS_OFF,
  "--strict-json",
  "--merge",
];
/** Verbs of the recorded CLI calls (`plugins install`, `config set`, …). */
const verbs = () => calls.map((c) => c.args.slice(1, 3).join(" "));

const ok = (stdout = ""): CliResult => ({ code: 0, stdout, stderr: "", timedOut: false });

const runCli: RunCli = async (args, opts) => {
  const call: Call = { args: [...args], env: opts.env, timeoutMs: opts.timeoutMs };
  const spec = args.find((a) => a.startsWith("npm-pack:"));
  if (spec) {
    const file = spec.slice("npm-pack:".length);
    call.artifact = {
      mode: statSync(file).mode & 0o777,
      dirMode: statSync(path.dirname(file)).mode & 0o777,
      bytes: readFileSync(file),
    };
  }
  calls.push(call);
  // args = [<openclaw cli>, "plugins" | "config", <verb>, ...]
  if (args[1] === "config") {
    const id = /^plugins\.entries\["([^"]+)"\]\.hooks$/u.exec(args[3] ?? "")?.[1];
    if (cli.config.code === 0 && id) oc.hooks.set(id, JSON.parse(args[4] ?? "{}"));
    return cli.config;
  }
  if (args[2] === "install") {
    if (cli.install.code === 0) oc.installed.add(cli.installsAs);
    return cli.install;
  }
  if (args[2] === "uninstall") {
    if (cli.uninstall.code === 0) {
      oc.installed.delete(args[3] ?? "");
      oc.disabled.add(args[3] ?? ""); // OpenClaw keeps `enabled: false` after an uninstall
    }
    return cli.uninstall;
  }
  if (args[2] === "enable") {
    oc.disabled.delete(args[3] ?? "");
    return ok();
  }
  if (args[2] === "inspect") {
    const id = args[3] ?? "";
    if (!oc.installed.has(id)) {
      return {
        code: 1,
        stdout: `{"ok":false,"error":{"message":"Plugin not found: ${id}"}}`,
        stderr: "",
        timedOut: false,
      };
    }
    if (cli.inspect.code !== 0) return cli.inspect;
    const data = JSON.parse(cli.inspect.stdout);
    data.policy = { ...data.policy, ...(oc.hooks.get(id) ?? {}) };
    data.plugin = { ...data.plugin, enabled: !oc.disabled.has(id) };
    return ok(JSON.stringify(data));
  }
  return ok();
};

function fetchOf(
  body: Buffer,
  init: { status?: number; headers?: Record<string, string> } = {},
): typeof fetch {
  return (async (input: string | URL | Request) => {
    fetched.push(String(input));
    return new Response(new Uint8Array(body), {
      status: init.status ?? 200,
      headers: { "content-type": "application/octet-stream", ...(init.headers ?? {}) },
    });
  }) as typeof fetch;
}

function installer(over: { fetchImpl?: typeof fetch; maxBytes?: number } = {}) {
  return createPluginInstaller({
    client: {
      async reportPlugin(r) {
        reports.push(structuredClone(r));
      },
    },
    snapshot: () => snap,
    refresh: async () => {
      refreshes++;
      return snap;
    },
    stateDir,
    clawhubOrigin: ORIGIN,
    exec: runCli,
    fetchImpl: over.fetchImpl ?? fetchOf(ARTIFACT, { headers: { "x-clawhub-artifact-sha256": SHA } }),
    ...(over.maxBytes ? { maxBytes: over.maxBytes } : {}),
  });
}

const signal = () => new AbortController().signal;
const cache = () => JSON.parse(readFileSync(path.join(stateDir, BOOT_CACHE_FILE), "utf8"));

beforeEach(() => {
  stateDir = mkdtempSync(path.join(tmpdir(), "ocw-installer-"));
  calls = [];
  reports = [];
  fetched = [];
  refreshes = 0;
  snap = snapshot([approved()]);
  cli = {
    install: ok("Installed plugin: ocw-echo\n"),
    uninstall: ok(),
    inspect: ok(INSPECT_ECHO),
    config: ok(),
    installsAs: "ocw-echo",
  };
  oc = { installed: new Set(), hooks: new Map(), disabled: new Set() };
});

afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
});

describe("plugin.install.v1", () => {
  it("downloads from the ClawHub origin only, verifies, installs once with an argv array and reports the declared tools", async () => {
    await installer().onInstall(event(), signal());
    expect(fetched).toEqual([URL_OK]);

    const install = calls.filter((c) => c.args[2] === "install");
    expect(install).toHaveLength(1);
    const [cliPath, sub, verb, spec, ...flags] = install[0]?.args ?? [];
    expect([cliPath, sub, verb]).toEqual([OPENCLAW_CLI, "plugins", "install"]);
    expect(spec).toMatch(/^npm-pack:\/.+\.tgz$/u);
    expect(flags.sort()).toEqual(["--accept-capabilities", "--force"]);
    // Private temp file with exactly the verified bytes, removed afterwards.
    expect(install[0]?.artifact?.bytes.equals(ARTIFACT)).toBe(true);
    expect(install[0]?.artifact?.mode).toBe(0o600);
    expect(install[0]?.artifact?.dirMode).toBe(0o700);
    expect(existsSync(spec?.slice("npm-pack:".length) ?? "/")).toBe(false);
    expect(install[0]?.timeoutMs).toBe(120_000);

    // Not there yet → hooks off BEFORE the plugin exists → install → inspect with runtime registrations.
    expect(verbs()).toEqual(["plugins inspect", "config set", "plugins install", "plugins inspect"]);
    expect(calls[0]?.args).toEqual([OPENCLAW_CLI, "plugins", "inspect", "ocw-echo", "--json"]);
    expect(calls[1]?.args).toEqual(configSet("ocw-echo"));
    expect(calls[3]?.args).toEqual([OPENCLAW_CLI, "plugins", "inspect", "ocw-echo", "--runtime", "--json"]);
    expect(oc.hooks.get("ocw-echo")).toEqual({ allowConversationAccess: false, allowPromptInjection: false });

    expect(reports).toEqual([
      {
        flowId: FLOW,
        pluginRowId: ROW,
        state: "installed",
        pluginId: "ocw-echo",
        version: "0.1.0",
        declared: {
          tools: ["ocw_echo"],
          hooks: [],
          channels: [],
          providers: [],
          webSearchProviders: [],
          webFetchProviders: [],
          mcpServers: [],
          other: [],
        },
        declaredTools: [{ name: "ocw_echo" }],
      },
    ]);
    expect(cache().installed).toEqual([
      { pluginId: "ocw-echo", packageName: "@ocw-test/echo-plugin", version: "0.1.0" },
    ]);
  });

  it("every child process gets CLAWHUB_DISABLE_TELEMETRY=1 (install, inspect, uninstall)", async () => {
    const inst = installer();
    await inst.onInstall(event(), signal());
    snap = snapshot([approved({ status: "uninstalling" })]);
    await inst.onUninstall(uninstall(), signal());
    expect(calls.length).toBeGreaterThanOrEqual(3);
    for (const c of calls) {
      expect(c.env.CLAWHUB_DISABLE_TELEMETRY).toBe("1");
      // Bounded npm retries (an operator's own setting wins): offline cells never wait minutes per install.
      expect(c.env.npm_config_fetch_retries).toBe(process.env.npm_config_fetch_retries ?? "1");
    }
  });

  it("an artifact URL on another origin → failed untrusted_origin; nothing downloaded or executed", async () => {
    for (const artifactUrl of [
      "https://evil.example/api/v1/packages/x/versions/0.1.0/artifact/download",
      "http://fake-model:18998/api/v1/packages/x/versions/0.1.0/artifact/download",
      "file:///etc/passwd",
    ]) {
      await installer().onInstall(event({ artifactUrl }), signal());
    }
    expect(fetched).toEqual([]);
    expect(calls).toEqual([]);
    expect(reports.map((r) => [r.state, r.error?.code])).toEqual([
      ["failed", "untrusted_origin"],
      ["failed", "untrusted_origin"],
      ["failed", "untrusted_origin"],
    ]);
  });

  it("a digest mismatch (sha256, npm integrity or the ClawHub header) → failed digest_mismatch, no CLI call", async () => {
    const other = Buffer.from("a different tarball");
    await installer({ fetchImpl: fetchOf(other) }).onInstall(event(), signal());
    await installer().onInstall(event({ npmIntegrity: "sha512-AAAA" }), signal());
    await installer({
      fetchImpl: fetchOf(ARTIFACT, { headers: { "x-clawhub-artifact-sha256": "0".repeat(64) } }),
    }).onInstall(event(), signal());
    // Only the read-only "already installed?" check ran: no hooks write, no install.
    expect(verbs().filter((v) => v !== "plugins inspect")).toEqual([]);
    expect(reports.map((r) => [r.state, r.error?.code])).toEqual([
      ["failed", "digest_mismatch"],
      ["failed", "digest_mismatch"],
      ["failed", "digest_mismatch"],
    ]);
    expect(existsSync(path.join(stateDir, BOOT_CACHE_FILE))).toBe(false);
  });

  it("a download over the size cap or a non-200 → failed, no CLI call", async () => {
    await installer({ maxBytes: 10 }).onInstall(event(), signal());
    await installer({ fetchImpl: fetchOf(Buffer.from("nope"), { status: 404 }) }).onInstall(
      event(),
      signal(),
    );
    expect(verbs().filter((v) => v !== "plugins inspect")).toEqual([]);
    expect(reports.map((r) => [r.state, r.error?.code])).toEqual([
      ["failed", "too_large"],
      ["failed", "download_failed"],
    ]);
  });

  it("a CLI refusal → failed with a classified message, never the CLI's output", async () => {
    const stderr =
      "Install blocked by policy\n\n  Plugin: @ocw-test/echo-plugin\n  Reason: not an admin-approved install in flight (not_in_flight)\n  /home/node/.openclaw/secret-path";
    cli.install = { code: 1, stdout: "", stderr, timedOut: false };
    await installer().onInstall(event(), signal());
    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ state: "failed", error: { code: "install_blocked" } });
    expect(reports[0]?.error?.message).not.toContain("/home/node");
    expect(reports[0]?.error?.message).not.toContain("Reason:");
    expect(oc.installed.size).toBe(0);

    reports = [];
    cli.install = { code: null, stdout: "", stderr: "", timedOut: true };
    await installer().onInstall(event(), signal());
    expect(reports[0]).toMatchObject({ state: "failed", error: { code: "timeout" } });

    reports = [];
    cli.install = { code: 1, stdout: "", stderr: "npm ERR! something odd /abs/path", timedOut: false };
    await installer().onInstall(event(), signal());
    expect(reports[0]).toMatchObject({ state: "failed", error: { code: "install_failed" } });
    expect(reports[0]?.error?.message).not.toContain("/abs/path");
  });

  it("an event that is not in the snapshot's approved list → failed not_approved after one refresh; nothing runs", async () => {
    for (const [ev, list] of [
      [event(), [] as CellApprovedPlugin[]],
      [event({ version: "0.2.0" }), [approved()]],
      [event({ sha256: "f".repeat(64) }), [approved()]],
      [event({ packageName: "@ocw-test/other" }), [approved()]],
      [event(), [approved({ status: "uninstalled" })]],
    ] as const) {
      snap = snapshot([...list]);
      await installer().onInstall(ev, signal());
    }
    expect(refreshes).toBe(5);
    expect(fetched).toEqual([]);
    expect(calls).toEqual([]);
    expect(reports.every((r) => r.state === "failed" && r.error?.code === "not_approved")).toBe(true);
    expect(reports).toHaveLength(5);
  });

  it("an event whose values could become CLI flags or paths is refused before anything runs", async () => {
    for (const over of [
      { expectedPluginId: "--evil" },
      { expectedPluginId: null },
      { expectedPluginId: "../x" },
      { version: "--force" },
    ] satisfies Partial<PluginInstallEvent>[]) {
      snap = snapshot([
        approved({ version: over.version ?? "0.1.0", pluginId: over.expectedPluginId ?? null }),
      ]);
      await installer().onInstall(event(over), signal());
    }
    expect(fetched).toEqual([]);
    expect(calls).toEqual([]);
    expect(reports.map((r) => r.error?.code)).toEqual([
      "invalid_event",
      "invalid_event",
      "invalid_event",
      "invalid_event",
    ]);
  });

  it("what got installed is not what was approved (plugin id or version) → uninstalled again, failed plugin_mismatch", async () => {
    cli.inspect = ok(INSPECT_DDG);
    await installer().onInstall(event(), signal());
    expect(verbs()).toEqual([
      "plugins inspect",
      "config set",
      "plugins install",
      "plugins inspect",
      "plugins uninstall",
    ]);
    expect(calls.at(-1)?.args).toEqual([OPENCLAW_CLI, "plugins", "uninstall", "ocw-echo", "--force"]);
    expect(reports).toEqual([
      expect.objectContaining({
        state: "failed",
        error: expect.objectContaining({ code: "plugin_mismatch" }),
      }),
    ]);
  });

  it("a replay finds the approved plugin already installed and restricted: reports it without reinstalling", async () => {
    for (const status of ["installed", "installing"]) {
      snap = snapshot([approved({ status })]);
      oc.installed.add("ocw-echo");
      oc.hooks.set("ocw-echo", JSON.parse(HOOKS_OFF));
      calls = [];
      reports = [];
      await installer().onInstall(event(), signal());
      expect(fetched).toEqual([]);
      expect(verbs()).toEqual(["plugins inspect", "plugins inspect"]);
      expect(reports).toEqual([expect.objectContaining({ state: "installed", pluginId: "ocw-echo" })]);
    }
  });

  it("a plugin found installed without the hook restriction gets it before it is reported", async () => {
    oc.installed.add("ocw-echo");
    await installer().onInstall(event(), signal());
    expect(verbs()).toEqual(["plugins inspect", "config set", "plugins inspect"]);
    expect(reports).toEqual([expect.objectContaining({ state: "installed" })]);
    // If the restriction cannot be written, the plugin is not kept.
    oc.hooks.clear();
    cli.config = { code: 1, stdout: "", stderr: "refused", timedOut: false };
    calls = [];
    reports = [];
    await installer().onInstall(event(), signal());
    expect(verbs()).toEqual(["plugins inspect", "config set", "plugins uninstall"]);
    expect(reports).toEqual([
      expect.objectContaining({
        state: "failed",
        error: expect.objectContaining({ code: "hook_restriction_failed" }),
      }),
    ]);
  });

  it("a hook restriction that cannot be written before the install stops it: nothing is installed", async () => {
    cli.config = { code: 1, stdout: "", stderr: "refused", timedOut: false };
    await installer().onInstall(event(), signal());
    expect(verbs()).toEqual(["plugins inspect", "config set"]);
    expect(reports).toEqual([
      expect.objectContaining({
        state: "failed",
        error: expect.objectContaining({ code: "hook_restriction_failed" }),
      }),
    ]);
  });

  it("an aborted channel instance stops waiting at once; the install finishes and reports, and the replay re-reports", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const slowInstall: RunCli = async (args, opts) => {
      if (args[2] === "install") await gate; // OpenClaw is replacing the plugin generation
      return runCli(args, opts);
    };
    const make = () =>
      createPluginInstaller({
        client: { reportPlugin: async (r) => void reports.push(structuredClone(r)) },
        snapshot: () => snap,
        stateDir,
        clawhubOrigin: ORIGIN,
        exec: slowInstall,
        fetchImpl: fetchOf(ARTIFACT),
      });
    const account = new AbortController();
    const first = make().onInstall(event(), account.signal);
    await new Promise((r) => setTimeout(r, 30));
    // OpenClaw stops our channel to drain it: the handler must return now, not when the install ends.
    account.abort();
    await first;
    expect(reports).toEqual([]);
    // The successor instance replays the (uncommitted) event: it queues behind the running install.
    const replay = make().onInstall(event(), new AbortController().signal);
    release();
    await replay;
    expect(verbs().filter((v) => v === "plugins install")).toHaveLength(1);
    expect(reports.map((r) => r.state)).toEqual(["installed", "installed"]);
  });

  it("installs run one at a time", async () => {
    let active = 0;
    let peak = 0;
    const inst = createPluginInstaller({
      client: { reportPlugin: async (r) => void reports.push(r) },
      snapshot: () => snap,
      stateDir,
      clawhubOrigin: ORIGIN,
      exec: async (args, opts) => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((r) => setTimeout(r, 20));
        active--;
        return runCli(args, opts);
      },
      fetchImpl: fetchOf(ARTIFACT),
    });
    await Promise.all([
      inst.onInstall(event(), signal()),
      inst.onInstall(event({ flowId: "flow-2" }), signal()),
    ]);
    expect(peak).toBe(1);
    expect(reports.filter((r) => r.state === "installed")).toHaveLength(2);
  });
});

function uninstall(over: Partial<PluginUninstallEvent> = {}): PluginUninstallEvent {
  return {
    type: "plugin.uninstall.v1",
    seq: 9,
    flowId: "0199a000-0000-7000-8000-0000000f0009",
    pluginRowId: ROW,
    pluginId: "ocw-echo",
    ...over,
  };
}

describe("plugin.uninstall.v1", () => {
  it("runs `plugins uninstall <id> --force`, reports uninstalled and drops the plugin from the boot cache", async () => {
    const inst = installer();
    await inst.onInstall(event(), signal());
    expect(cache().installed).toHaveLength(1);
    snap = snapshot([approved({ status: "uninstalling" })]);
    calls = [];
    reports = [];
    await inst.onUninstall(uninstall(), signal());
    expect(calls.map((c) => c.args)).toEqual([[OPENCLAW_CLI, "plugins", "uninstall", "ocw-echo", "--force"]]);
    expect(reports).toEqual([
      { flowId: uninstall().flowId, pluginRowId: ROW, state: "uninstalled", pluginId: "ocw-echo" },
    ]);
    expect(cache().installed).toEqual([]);
  });

  it("a plugin that is already gone is reported uninstalled (idempotent)", async () => {
    snap = snapshot([approved({ status: "uninstalling" })]);
    cli.uninstall = {
      code: 1,
      stdout: "",
      stderr: 'Plugin "ocw-echo" is not associated with a tracked package install.',
      timedOut: false,
    };
    await installer().onUninstall(uninstall(), signal());
    expect(reports).toEqual([expect.objectContaining({ state: "uninstalled" })]);
  });

  it("a rejected install (row failed by the API) can be uninstalled; an unknown row or another id cannot", async () => {
    snap = snapshot([approved({ status: "failed" })]);
    await installer().onUninstall(uninstall(), signal());
    expect(reports.at(-1)).toMatchObject({ state: "uninstalled" });
    oc.installed.add("ocw-echo");
    snap = snapshot([approved({ status: "installed" })]);
    await installer().onUninstall(uninstall(), signal());
    snap = snapshot([approved({ status: "uninstalling", pluginId: "other" })]);
    await installer().onUninstall(uninstall(), signal());
    expect(reports.slice(-2).map((r) => [r.state, r.error?.code])).toEqual([
      ["failed", "not_approved"],
      ["failed", "not_approved"],
    ]);
    expect(calls.filter((c) => c.args[2] === "uninstall")).toHaveLength(1);
    // A replay after the flow completed (the API dropped the row) finds nothing to do and reports nothing.
    oc.installed.clear();
    snap = snapshot([]);
    reports = [];
    await installer().onUninstall(uninstall(), signal());
    expect(reports).toEqual([]);
  });

  it("a CLI failure → failed uninstall_failed (classified)", async () => {
    snap = snapshot([approved({ status: "uninstalling" })]);
    cli.uninstall = { code: 1, stdout: "", stderr: "EACCES /home/node/.openclaw/npm", timedOut: false };
    await installer().onUninstall(uninstall(), signal());
    expect(reports).toEqual([
      expect.objectContaining({
        state: "failed",
        error: expect.objectContaining({ code: "uninstall_failed" }),
      }),
    ]);
    expect(reports[0]?.error?.message).not.toContain("/home/node");
  });
});

describe("boot cache and declared surface", () => {
  it("writeBootCache mirrors the API's installed rows (the cache is a boot fallback only)", async () => {
    snap = snapshot([
      approved({ status: "installed" }),
      approved({
        pluginRowId: "row-2",
        packageName: "@openclaw/duckduckgo-plugin",
        version: "2026.9.7",
        pluginId: "duckduckgo",
        status: "installed",
      }),
      approved({ pluginRowId: "row-3", packageName: "@x/y", pluginId: "y", status: "installing" }),
    ]);
    await installer().writeBootCache();
    expect(cache().installed).toEqual([
      { pluginId: "ocw-echo", packageName: "@ocw-test/echo-plugin", version: "0.1.0" },
      { pluginId: "duckduckgo", packageName: "@openclaw/duckduckgo-plugin", version: "2026.9.7" },
    ]);
    expect(statSync(path.join(stateDir, BOOT_CACHE_FILE)).mode & 0o777).toBe(0o600);
  });

  it("maps OpenClaw's inspect output (manifest + runtime registrations) onto the API's declared surface", () => {
    expect(declaredSurfaceOfInspect(JSON.parse(INSPECT_DDG))).toMatchObject({
      tools: [],
      webSearchProviders: ["duckduckgo"],
      other: [],
    });
    const risky = JSON.parse(INSPECT_ECHO);
    risky.plugin.contracts = { tools: ["ocw_echo", "run_shell"], trustedToolPolicies: ["p"] };
    risky.plugin.channelIds = ["relay"];
    risky.typedHooks = [{ name: "before_prompt_build", priority: 1 }];
    risky.gatewayMethods = ["relay.send"];
    risky.httpRouteCount = 2;
    risky.mcpServers = [{ name: "srv", hasStdioTransport: true }];
    expect(declaredSurfaceOfInspect(risky)).toEqual({
      tools: ["ocw_echo", "run_shell"],
      hooks: ["before_prompt_build"],
      channels: ["relay"],
      providers: [],
      webSearchProviders: [],
      webFetchProviders: [],
      mcpServers: ["srv"],
      other: ["gatewayMethodDispatch:relay.send", "httpRoutes:2", "trustedToolPolicies:p"],
    });
  });
});

describe("default CLI runner", () => {
  it("runs `node <cli> ...args` with exactly the given argv and env, no shell, and reports exit and timeout", async () => {
    const cli = path.join(stateDir, "fake-openclaw.mjs");
    writeFileSync(
      cli,
      "console.log(JSON.stringify({ argv: process.argv.slice(2), telemetry: process.env.CLAWHUB_DISABLE_TELEMETRY })); process.exit(process.argv.includes('--fail') ? 3 : 0);\n",
    );
    const ok = await defaultRunCli([cli, "plugins", "install", "npm-pack:/tmp/a b;$(x).tgz", "--force"], {
      env: { PATH: process.env.PATH, CLAWHUB_DISABLE_TELEMETRY: "1" },
      timeoutMs: 10_000,
    });
    expect(ok.code).toBe(0);
    expect(JSON.parse(ok.stdout)).toEqual({
      argv: ["plugins", "install", "npm-pack:/tmp/a b;$(x).tgz", "--force"],
      telemetry: "1",
    });
    const fail = await defaultRunCli([cli, "--fail"], { env: {}, timeoutMs: 10_000 });
    expect(fail).toMatchObject({ code: 3, timedOut: false });
    const slow = path.join(stateDir, "slow.mjs");
    writeFileSync(slow, "setTimeout(() => {}, 10_000);\n");
    expect(await defaultRunCli([slow], { env: {}, timeoutMs: 200 })).toMatchObject({ timedOut: true });
  });
});

describe("reporting after the plugin instance was retired", () => {
  it("a transport failure (retired instance fetch) falls back to the separate report process; an API refusal does not", async () => {
    const fallback: AgentChannelPluginReport[] = [];
    const make = (error: Error) =>
      createPluginInstaller({
        client: {
          async reportPlugin() {
            throw error;
          },
        },
        snapshot: () => snap,
        stateDir,
        clawhubOrigin: ORIGIN,
        exec: runCli,
        fetchImpl: fetchOf(ARTIFACT),
        reportFallback: async (r) => void fallback.push(r),
      });
    await make(new Error("Plugin ocw was reloaded or disabled; use its current tools.")).onInstall(
      event(),
      signal(),
    );
    expect(fallback).toEqual([
      expect.objectContaining({ flowId: FLOW, state: "installed", pluginId: "ocw-echo" }),
    ]);
    fallback.length = 0;
    await make(new AgentChannelHttpError(409, "/plugins/report", "conflict")).onInstall(event(), signal());
    expect(fallback).toEqual([]);
  });

  it("reportPluginViaChild posts the report with the cell token from a child process; non-2xx rejects", async () => {
    const seen: Array<{ url?: string; auth?: string; body: unknown }> = [];
    let status = 200;
    const server = createServer(async (req, res) => {
      let raw = "";
      for await (const c of req) raw += c;
      seen.push({ url: req.url, auth: req.headers.authorization, body: JSON.parse(raw) });
      res.writeHead(status, { "content-type": "application/json" });
      res.end('{"ok":true}');
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
    const r: AgentChannelPluginReport = {
      flowId: FLOW,
      pluginRowId: ROW,
      state: "uninstalled",
      pluginId: "ocw-echo",
    };
    try {
      await reportPluginViaChild(base, "cell-token-xyz", r);
      expect(seen).toEqual([
        { url: "/agent-channel/v1/plugins/report", auth: "Bearer cell-token-xyz", body: r },
      ]);
      status = 409;
      await expect(reportPluginViaChild(base, "cell-token-xyz", r)).rejects.toThrow(/exited with 14/u);
    } finally {
      await new Promise((done) => server.close(done));
    }
  });
});

describe("reinstall after an uninstall", () => {
  it("OpenClaw keeps the plugin disabled after a removal: the executor enables it before reporting it installed", async () => {
    const inst = installer();
    await inst.onInstall(event(), signal());
    snap = snapshot([approved({ status: "uninstalling" })]);
    await inst.onUninstall(uninstall(), signal());
    snap = snapshot([approved({ status: "installing" })]);
    calls = [];
    reports = [];
    await inst.onInstall(event({ flowId: "flow-again" }), signal());
    expect(verbs()).toEqual([
      "plugins inspect",
      "config set",
      "plugins install",
      "plugins inspect",
      "plugins enable",
      "plugins inspect",
    ]);
    expect(calls[4]?.args).toEqual([OPENCLAW_CLI, "plugins", "enable", "ocw-echo", "--accept-capabilities"]);
    expect(reports).toEqual([expect.objectContaining({ flowId: "flow-again", state: "installed" })]);
  });
});
