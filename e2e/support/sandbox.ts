import { execFileSync } from "node:child_process";
import type { APIRequestContext } from "@playwright/test";
import { asSuperuser } from "./superuser";

/**
 * Bot sandbox helpers for the e2e specs and the full-stack proof (07.8-08, P-13). Everything goes through the API or
 * the fake sandboxd's controls; the one exception is the organization switch, which the superuser helper sets until the
 * settings route of 07.8-11 answers (then the helper uses it and never touches the database).
 *
 * `scripts/e2e-isolated.sh` exports `OCW_E2E_SANDBOX=fake` (the in-memory sandboxd the fake server mounts at
 * `/__sandboxd`) or `real` (`--sandbox`: the real broker); the fake's controls exist only in `fake` mode.
 */

type Json = Record<string, unknown>;

async function json<T>(res: { ok(): boolean; status(): number; json(): Promise<unknown> }, what: string) {
  if (!res.ok()) throw new Error(`${what}: HTTP ${res.status()}`);
  return (await res.json()) as T;
}

/** The signed-in admin's organization id. */
export async function organizationOf(api: APIRequestContext): Promise<string> {
  const me = await json<{ organization: { id: string } }>(await api.get("/api/v1/me"), "GET /me");
  return me.organization.id;
}

/**
 * Turns Sandbox & Browser on for the admin's organization. Through `PUT /api/v1/sandbox/settings` once it exists
 * (07.8-11); before that, the superuser helper writes `app.sandbox_policies.enabled` on the guarded e2e database.
 */
export async function enableSandboxOrg(admin: APIRequestContext, enabled = true): Promise<void> {
  const current = await admin.get("/api/v1/sandbox/settings");
  if (current.ok()) {
    const view = (await current.json()) as { settings: { version: number; enabled: boolean } };
    if (view.settings.enabled === enabled) return;
    await json(
      await admin.put("/api/v1/sandbox/settings", {
        data: { expectedVersion: view.settings.version, enabled },
      }),
      "PUT /sandbox/settings",
    );
    return;
  }
  if (current.status() !== 404) throw new Error(`GET /sandbox/settings: HTTP ${current.status()}`);
  const org = await organizationOf(admin);
  await asSuperuser(
    `insert into app.sandbox_policies (organization_id, enabled) values ($1, $2)
       on conflict (organization_id) do update set enabled = excluded.enabled`,
    [org, enabled],
  );
}

/** A bot's own Sandbox / Browser switches, through the capabilities route (the owner or an admin). */
export async function enableBotSandbox(
  owner: APIRequestContext,
  agentId: string,
  switches: { sandbox?: boolean; browser?: boolean } = { sandbox: true },
): Promise<{ sandbox: boolean; browser: boolean }> {
  const view = await json<{ capabilities: { sandbox: boolean; browser: boolean } }>(
    await owner.patch(`/api/v1/agents/${agentId}/capabilities`, { data: switches }),
    "PATCH capabilities",
  );
  return { sandbox: view.capabilities.sandbox, browser: view.capabilities.browser };
}

/** The admins' kill switch (`POST /api/v1/sandbox/kill`): every sandbox and browser of the organization stops. */
export async function killSwitch(admin: APIRequestContext): Promise<Json> {
  return json<Json>(await admin.post("/api/v1/sandbox/kill"), "POST /sandbox/kill");
}

/** Ends the kill (`POST /api/v1/sandbox/resume`). */
export async function resume(admin: APIRequestContext): Promise<Json> {
  return json<Json>(await admin.post("/api/v1/sandbox/resume"), "POST /sandbox/resume");
}

// ---------------------------------------------------------------- the fake sandboxd (default e2e mode)

export interface SandboxTarget {
  orgId: string;
  agentId: string;
}

/**
 * The in-memory sandboxd the fake server mounts at `/__sandboxd` (scripts/e2e-isolated.sh's default mode): seed a
 * bot's files or a browser context, emit an event, read the call counters, take the service down and up. The `/v1` ops
 * use the API's own `OCW_SANDBOX_URL` and `OCW_SANDBOX_TOKEN`; the controls need no token. Refuses the real broker.
 */
export function fakeSandboxd(env: Readonly<Record<string, string | undefined>> = process.env) {
  if (env.OCW_E2E_SANDBOX === "real") {
    throw new Error(
      "fakeSandboxd(): the stack runs the real sandboxd (--sandbox); seed it through the API instead",
    );
  }
  const base = (env.OCW_SANDBOX_URL ?? "").replace(/\/+$/u, "");
  const token = env.OCW_SANDBOX_TOKEN ?? "";
  if (!base.endsWith("/__sandboxd") || token.length < 32) {
    throw new Error(
      "fakeSandboxd(): OCW_SANDBOX_URL/OCW_SANDBOX_TOKEN do not name the fake (scripts/e2e-isolated.sh)",
    );
  }
  const call = async <T = Json>(path: string, body?: unknown): Promise<T> => {
    const res = await fetch(`${base}${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: {
        ...(path.startsWith("/v1/") ? { authorization: `Bearer ${token}` } : {}),
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`fake sandboxd ${path}: HTTP ${res.status} ${text.slice(0, 200)}`);
    return (text ? JSON.parse(text) : {}) as T;
  };
  /**
   * sandboxd holds no default policy (07.8 policy fix): a seed pushes a permissive one at version 0 first. The API's own
   * push (version ≥ 1, the organization's real settings and kill state) always wins over it.
   */
  const seedPolicy = (orgId: string) => {
    const limits = {
      nanoCpus: 1_000_000_000,
      memoryBytes: 1024 ** 3,
      pids: 256,
      diskQuotaBytes: 2 * 1024 ** 3,
      idleStopMs: 900_000,
    };
    return call("/v1/policy", {
      orgId,
      sandboxEgress: "off",
      browserEgress: "off",
      allowHosts: [],
      privateHosts: [],
      limits,
      browserLimits: { ...limits, memoryBytes: 2 * 1024 ** 3, pids: 512, idleStopMs: 300_000 },
      killed: false,
      version: 0,
    });
  };
  return {
    /** Writes a file into the bot's workspace (its sandbox is started first, like a first exec would). */
    async seedFile(target: SandboxTarget, path: string, content: string): Promise<void> {
      await seedPolicy(target.orgId);
      await call("/v1/sandboxes/ensure", { target });
      await call("/v1/files/write", { target, path, content, encoding: "utf8", mode: "overwrite" });
    },
    /**
     * Opens a browser context for the bot, optionally on `url` (`signedIn`: the fake site's session is loaded;
     * `siteLock`: D-13's lock to one host). Returns its id.
     */
    async seedContext(
      target: SandboxTarget,
      opts: { url?: string; signedIn?: boolean; siteLock?: string; contextId?: string } = {},
    ): Promise<string> {
      const contextId = opts.contextId ?? crypto.randomUUID();
      await seedPolicy(target.orgId);
      await call("/v1/browsers/ensure", { target });
      await call("/v1/browsers/contexts/open", {
        target,
        contextId,
        viewport: { width: 960, height: 600 },
        ...(opts.siteLock ? { siteLock: opts.siteLock } : {}),
      });
      if (opts.signedIn) await call("/__control/browser/signed-in", { contextId });
      if (opts.url) await call("/v1/browsers/contexts/navigate", { target, contextId, url: opts.url });
      return contextId;
    },
    /**
     * The fake site of an open page becomes signed in, as a person typing their password in the live view does (07.8-21
     * control; 07.8-26: its frames show the dashboard); `expires` is the session cookie's expiry in unix seconds (default: a session cookie).
     */
    async signedIn(contextId: string, expires?: number): Promise<void> {
      await call("/__control/browser/signed-in", {
        contextId,
        ...(expires !== undefined ? { expires } : {}),
      });
    },
    /** Queues a sandboxd event (`/v1/events`); returns its seq. */
    async emit(event: Json): Promise<number> {
      return (await call<{ seq: number }>("/__control/emit", event)).seq;
    },
    /** A browser event of one context: crashed, closed, focus_sensitive or download. */
    async browserEvent(target: SandboxTarget, contextId: string, event: string): Promise<void> {
      await call("/__control/browser/event", { target, contextId, event });
    },
    /** The next snapshot carries the password sentinel on a redacted node (the API's second pass must refuse it). */
    async leakNextSnapshot(): Promise<void> {
      await call("/__control/browser/leak", {});
    },
    /**
     * What the fake registries serve for one release (07.8-18 controls): `topChanged` republishes the artifact,
     * `depChanged` its dependency, `sha1` gives the dependency sha1-only integrity (refused), `license: null` or a denied
     * license is high risk, `hasInstallScript` medium. A name starting `ocw-missing` is not in any registry.
     */
    async setPackage(
      coords: { source: "npm" | "pypi" | "debian" | "clawhub"; name: string; version: string },
      patch: {
        topChanged?: boolean;
        depChanged?: boolean;
        sha1?: boolean;
        license?: string | null;
        hasInstallScript?: boolean;
        publisher?: string | null;
      },
    ): Promise<void> {
      await call("/__control/packages/set", { ...coords, ...patch });
    },
    /** Call counts per op and organization, and per browser context its flags and input counts (never payloads). */
    stats: () => call<Json>("/__control/stats"),
    down: async () => void (await call("/__control/down", {})),
    up: async () => void (await call("/__control/up", {})),
    reset: async () => void (await call("/__control/reset", {})),
  };
}

// ---------------------------------------------------------------- the real broker's fake sites (--sandbox, 07.8-28)

/** The fake sites' hosts as the organization's private hosts name them (they resolve to a private address). */
export const FAKE_SITE_HOSTS = ["panel.fake.test:8080", "idp.fake.test:8080", "evil.fake.test:8080"] as const;

function dockerOut(args: string[]): string {
  return execFileSync("docker", args, { encoding: "utf8" }).trim();
}

/**
 * Lets the organization's bots reach the fake sites `scripts/e2e-isolated.sh --sandbox` started (07.8-28): their three
 * `host:8080` entries become the organization's private hosts (07.4's list, the one the sandbox policy carries), the
 * sandbox settings are saved once more so the API pushes that policy to sandboxd now, and the egress proxy joins the
 * sites' network (once it exists: a first sandbox or browser start creates it). Real broker only.
 */
export async function useFakeSites(
  admin: APIRequestContext,
  settings: { sandboxEgress?: "off" | "allowlist" | "public"; allowHosts?: string[] } = {},
): Promise<void> {
  const net = process.env.OCW_E2E_FAKE_SITES_NET ?? "";
  if (process.env.OCW_E2E_SANDBOX !== "real" || !net) {
    throw new Error("useFakeSites(): run through scripts/e2e-isolated.sh --sandbox");
  }
  await json(
    await admin.put("/api/v1/keychain/private-hosts", { data: { hosts: [...FAKE_SITE_HOSTS] } }),
    "PUT /keychain/private-hosts",
  );
  const view = await json<{ settings: { version: number } }>(
    await admin.get("/api/v1/sandbox/settings"),
    "GET /sandbox/settings",
  );
  await json(
    await admin.put("/api/v1/sandbox/settings", {
      data: { expectedVersion: view.settings.version, browserEgress: "public", ...settings },
    }),
    "PUT /sandbox/settings",
  );
  connectFakeSites();
}

/**
 * The egress proxy joins the fake sites' network (idempotent). The proxy exists once a first sandbox or browser of the
 * namespace started; before that this throws, so a spec starts one first (any exec does).
 */
export function connectFakeSites(): void {
  const net = process.env.OCW_E2E_FAKE_SITES_NET ?? "";
  const ns = process.env.OCW_E2E_SANDBOX_NAMESPACE ?? "ocw-e2e";
  const proxy = `ocw-egress-${ns}`;
  const attached = dockerOut(["inspect", "-f", "{{json .NetworkSettings.Networks}}", proxy]);
  if (!(JSON.parse(attached) as Record<string, unknown>)[net]) dockerOut(["network", "connect", net, proxy]);
}

/** The fake sites' counters (`/__stats`: logins, collect, …), read inside their container. */
export function fakeSiteStats(): Record<string, number> {
  const site = process.env.OCW_E2E_FAKE_SITE ?? "";
  if (!site) throw new Error("fakeSiteStats(): run through scripts/e2e-isolated.sh --sandbox");
  return JSON.parse(
    dockerOut([
      "exec",
      site,
      "node",
      "-e",
      'fetch("http://127.0.0.1:8080/__stats").then(async (r) => process.stdout.write(await r.text()))',
    ]),
  ) as Record<string, number>;
}
