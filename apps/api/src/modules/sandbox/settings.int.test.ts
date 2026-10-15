import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { sandboxPolicies } from "@ocw/db";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { invite } from "../../testing-workzone";
import { settingsConstraintRefusal } from "./settings";

/**
 * 07.8-11 Task 3 (SBX-03, SBX-01; D-09, D-11, D-12; T-07.8-11-03/04): the organization's Sandbox & Browser settings.
 * `GET|PUT /api/v1/sandbox/settings` (`bot.manage`) with an expected version; each named refusal is a 4xx; every change
 * is audited and pushed to sandboxd as the organization's policy, with 07.4's private hosts; the kill switch pushes
 * `killed` and bumps the version too. Then the capability view's Sandbox and Browser rows (R11).
 *
 * sandboxd is reached through a recording proxy in front of the in-memory fake, so the test reads the policy bodies the
 * API sent (the fake keeps only `killed`).
 */

let s: SandboxStack;
let marta: TestClient;
let recorder: Recorder;

interface Recorder {
  url: string;
  target: string;
  policies: Json[];
  stop(): Promise<void>;
}

/** Forwards every request to the fake and keeps the bodies of `POST /v1/policy`. */
async function startRecorder(): Promise<Recorder> {
  const policies: Json[] = [];
  const rec = { url: "", target: "", policies } as Recorder;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        const body = Buffer.concat(chunks);
        if (req.method === "POST" && req.url === "/v1/policy")
          policies.push(JSON.parse(body.toString("utf8")));
        try {
          const r = await fetch(`${rec.target}${req.url}`, {
            method: req.method,
            headers: {
              authorization: String(req.headers.authorization ?? ""),
              "content-type": String(req.headers["content-type"] ?? "application/json"),
            },
            ...(req.method === "GET" ? {} : { body }),
          });
          const out = Buffer.from(await r.arrayBuffer());
          res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
          res.end(out);
        } catch {
          res.writeHead(502);
          res.end();
        }
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  rec.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rec.stop = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  };
  return rec;
}

const getSettings = (who: TestClient) => who.request("GET", "/api/v1/sandbox/settings") as Promise<Res>;
const putSettings = (who: TestClient, body: Json) =>
  who.request("PUT", "/api/v1/sandbox/settings", body) as Promise<Res>;
const versionOf = async (who: TestClient = s.victor) =>
  (await ok(getSettings(who))).settings.version as number;

const audits = async (action: string, orgId = s.orgA) =>
  (
    await s.su.query(
      "select actor_kind, user_id, metadata from app.audit_events where organization_id = $1 and action = $2 order by occurred_at",
      [orgId, action],
    )
  ).rows as Json[];

const MiB = 1024 * 1024;

beforeAll(async () => {
  recorder = await startRecorder();
  try {
    s = await startSandboxStack({ env: { OCW_SANDBOX_URL: recorder.url } });
  } catch (err) {
    await recorder.stop();
    throw err;
  }
  recorder.target = s.sandboxd.url;
  ({ client: marta } = await invite(s.stack, s.victor, "marta@example.test", "Marta Gil", "lead"));
}, 240_000);

afterAll(async () => {
  try {
    await s?.stop();
  } finally {
    await recorder?.stop();
  }
});

describe("GET /api/v1/sandbox/settings", () => {
  it("without a saved row: the defaults (off), the isolation sandboxd reports and today's usage", async () => {
    const v = await ok(getSettings(s.victor));
    expect(v).toEqual({
      settings: {
        enabled: false,
        sandboxEgress: "allowlist",
        browserEgress: "public",
        allowHosts: [],
        limits: {
          maxSandboxes: 10,
          maxBrowsers: 3,
          cpuMinutesPerDay: 600,
          diskPerBotMb: 2048,
          diskTotalMb: 51200,
        },
        browserSessionMaxDays: 30,
        killed: null,
        version: 0,
        updatedAt: null,
      },
      isolation: {
        status: "ok",
        runtime: "gvisor",
        dockerVersion: "29.8.2",
        running: { sandboxes: 0, browsers: 0 },
        browserSandbox: null,
      },
      usage: { cpuMinutesToday: 0, diskBytesTotal: 0 },
    });
  });

  it("sandboxd down: isolation service_down, the settings still load", async () => {
    s.sandboxd.fake.setDown(true);
    try {
      const v = await ok(getSettings(s.victor));
      expect(v.isolation).toMatchObject({ status: "service_down", runtime: null });
      expect(v.settings.version).toBe(0);
    } finally {
      s.sandboxd.fake.setDown(false);
    }
  });

  it("a member and a lead get 403", async () => {
    for (const who of [s.sam, marta]) {
      expect((await getSettings(who)).status).toBe(403);
      expect((await putSettings(who, { expectedVersion: 0, enabled: true })).status).toBe(403);
    }
  });
});

describe("PUT /api/v1/sandbox/settings: versioned, validated, audited, pushed", () => {
  it("the right version saves, bumps the version, audits the changed fields and pushes one policy with 07.4's private hosts", async () => {
    await ok(
      s.victor.request("PUT", "/api/v1/keychain/private-hosts", { hosts: ["nas.lan"] }) as Promise<Res>,
    );
    const pushed = recorder.policies.length;
    const v = await ok(
      putSettings(s.victor, {
        expectedVersion: 0,
        enabled: true,
        sandboxEgress: "allowlist",
        allowHosts: ["api.example.com", "*.pypi.org", "registry.npmjs.org:443"],
      }),
    );
    expect(v).toMatchObject({
      enabled: true,
      sandboxEgress: "allowlist",
      allowHosts: ["api.example.com", "*.pypi.org", "registry.npmjs.org:443"],
      version: 1,
      killed: null,
    });
    expect(v.updatedAt).toEqual(expect.any(String));
    const rows = await audits("sandbox.settings_updated");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actor_kind: "user",
      user_id: s.victorId,
      metadata: {
        changed: ["enabled", "allowHosts"],
        allowHosts: ["api.example.com", "*.pypi.org", "registry.npmjs.org:443"],
      },
    });
    expect(recorder.policies).toHaveLength(pushed + 1);
    expect(recorder.policies.at(-1)).toEqual({
      orgId: s.orgA,
      sandboxEgress: "allowlist",
      browserEgress: "public",
      allowHosts: ["api.example.com", "*.pypi.org", "registry.npmjs.org:443"],
      privateHosts: ["nas.lan"],
      limits: {
        nanoCpus: 1_000_000_000,
        memoryBytes: 1024 * MiB,
        pids: 256,
        diskQuotaBytes: 2048 * MiB,
        idleStopMs: 15 * 60_000,
      },
      browserLimits: {
        nanoCpus: 1_000_000_000,
        memoryBytes: 2048 * MiB,
        pids: 512,
        diskQuotaBytes: 2048 * MiB,
        idleStopMs: 5 * 60_000,
      },
      killed: false,
      version: 1,
    });
    expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: false });
  });

  it("limits and session days save and reach the pushed policy", async () => {
    const limits = {
      maxSandboxes: 4,
      maxBrowsers: 2,
      cpuMinutesPerDay: 120,
      diskPerBotMb: 512,
      diskTotalMb: 4096,
    };
    const v = await ok(
      putSettings(s.victor, {
        expectedVersion: 1,
        limits,
        browserSessionMaxDays: 7,
        browserEgress: "allowlist",
      }),
    );
    expect(v).toMatchObject({ limits, browserSessionMaxDays: 7, browserEgress: "allowlist", version: 2 });
    expect((await audits("sandbox.settings_updated")).at(-1)?.metadata).toEqual({
      changed: ["browserEgress", "limits", "browserSessionMaxDays"],
    });
    expect(recorder.policies.at(-1)).toMatchObject({
      browserEgress: "allowlist",
      limits: { diskQuotaBytes: 512 * MiB },
    });
  });

  it("a stale version → 409 settings_version_conflict with the current settings; nothing saved or pushed", async () => {
    const pushed = recorder.policies.length;
    const r = await putSettings(s.victor, { expectedVersion: 1, enabled: false });
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("settings_version_conflict");
    expect(r.body?.error?.details?.settings).toMatchObject({ enabled: true, version: 2 });
    expect(await versionOf()).toBe(2);
    expect(recorder.policies).toHaveLength(pushed);
  });

  it("bad hosts → 400 invalid_allow_host; limits out of range → 400 limits_out_of_range; other shapes → validation_error", async () => {
    const hosts65 = Array.from({ length: 65 }, (_, i) => `h${i}.example.com`);
    const cases: Array<[Json, string]> = [
      [{ allowHosts: ["api.example.com/x"] }, "invalid_allow_host"],
      [{ allowHosts: ["https://api.example.com"] }, "invalid_allow_host"],
      [{ allowHosts: ["API.example.com"] }, "invalid_allow_host"],
      [{ allowHosts: hosts65 }, "invalid_allow_host"],
      [
        {
          limits: {
            maxSandboxes: 101,
            maxBrowsers: 3,
            cpuMinutesPerDay: 600,
            diskPerBotMb: 2048,
            diskTotalMb: 51200,
          },
        },
        "limits_out_of_range",
      ],
      [
        {
          limits: {
            maxSandboxes: 10,
            maxBrowsers: 3,
            cpuMinutesPerDay: 600,
            diskPerBotMb: 63,
            diskTotalMb: 51200,
          },
        },
        "limits_out_of_range",
      ],
      [{ browserSessionMaxDays: 91 }, "limits_out_of_range"],
      [{ sandboxEgress: "everything" }, "validation_error"],
      [{ killed: null }, "validation_error"],
      [{}, "validation_error"],
    ];
    for (const [patch, code] of cases) {
      const r = await putSettings(s.victor, { expectedVersion: 2, ...patch });
      expect(r.status, JSON.stringify(patch)).toBe(400);
      expect(codeOf(r), JSON.stringify(patch)).toBe(code);
    }
    expect(await versionOf()).toBe(2);
  });

  it("the database's named checks are the backstop and map to the same codes", async () => {
    const db = s.stack.built.core.db;
    const attempt = async (set: Json) => {
      try {
        await db.withTenant({ organizationId: s.orgA }, (tx) =>
          tx.update(sandboxPolicies).set(set).where(eq(sandboxPolicies.organizationId, s.orgA)),
        );
      } catch (err) {
        return settingsConstraintRefusal(err)?.code;
      }
      return "saved";
    };
    expect(await attempt({ maxSandboxes: 101 })).toBe("limits_out_of_range");
    expect(await attempt({ browserSessionMaxDays: 0 })).toBe("limits_out_of_range");
    expect(await attempt({ egressAllowHosts: Array.from({ length: 65 }, (_, i) => `h${i}.x.org`) })).toBe(
      "invalid_allow_host",
    );
  });

  it("organization B's admin reads and writes organization B only", async () => {
    const b = await ok(getSettings(s.eve));
    expect(b.settings).toMatchObject({ enabled: false, version: 0 });
    const saved = await ok(putSettings(s.eve, { expectedVersion: 0, enabled: true }));
    expect(saved.version).toBe(1);
    expect(recorder.policies.at(-1)?.orgId).toBe(s.orgB);
    expect(await ok(getSettings(s.victor))).toMatchObject({
      settings: { version: 2, limits: { maxSandboxes: 4 } },
    });
  });
});

describe("the kill switch reaches sandboxd and bumps the version (WINDOWS #241)", () => {
  it("kill pushes killed: true; resume pushes killed: false; each bumps the version once", async () => {
    const v0 = await versionOf();
    const killed = await ok(s.victor.request("POST", "/api/v1/sandbox/kill") as Promise<Res>);
    expect(killed.version).toBe(v0 + 1);
    expect(recorder.policies.at(-1)).toMatchObject({ orgId: s.orgA, killed: true });
    expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: true });
    // Idempotent: a second kill changes nothing, but retries the push.
    expect((await ok(s.victor.request("POST", "/api/v1/sandbox/kill") as Promise<Res>)).version).toBe(v0 + 1);
    const resumed = await ok(s.victor.request("POST", "/api/v1/sandbox/resume") as Promise<Res>);
    expect(resumed.version).toBe(v0 + 2);
    expect(recorder.policies.at(-1)).toMatchObject({ orgId: s.orgA, killed: false });
    expect(s.sandboxd.fake.policyOf(s.orgA)).toEqual({ killed: false });
  });
});

describe("the capability view's Sandbox and Browser rows (D-12, R11)", () => {
  const confined = async (who: TestClient, agentId: string) =>
    (await ok(who.request("GET", `/api/v1/agents/${agentId}/capabilities`) as Promise<Res>)).confined as Json;
  let mine: string;

  beforeAll(async () => {
    mine = (await ok(s.sam.request("POST", "/api/v1/agents/personal", {}) as Promise<Res>)).agent
      .id as string;
  });

  it("the organization switch off → org_off; on → available; the bot's own switch is `enabled`", async () => {
    await ok(putSettings(s.victor, { expectedVersion: await versionOf(), enabled: false }));
    expect(await confined(s.victor, s.scoutId)).toEqual({
      sandbox: { enabled: true, available: false, reason: "org_off" },
      browser: { enabled: false, available: false, reason: "org_off" },
    });
    await ok(putSettings(s.victor, { expectedVersion: await versionOf(), enabled: true }));
    expect(await confined(s.victor, s.scoutId)).toEqual({
      sandbox: { enabled: true, available: true, reason: null },
      browser: { enabled: false, available: true, reason: null },
    });
    expect((await confined(s.sam, mine)).sandbox).toEqual({ enabled: false, available: true, reason: null });
  });

  it("the kill switch → killed", async () => {
    await ok(s.victor.request("POST", "/api/v1/sandbox/kill") as Promise<Res>);
    try {
      expect((await confined(s.victor, s.scoutId)).sandbox).toEqual({
        enabled: true,
        available: false,
        reason: "killed",
      });
    } finally {
      await ok(s.victor.request("POST", "/api/v1/sandbox/resume") as Promise<Res>);
    }
  });

  it("the Sandbox module off for the viewer → module_off for that viewer only", async () => {
    const put = (enabled: boolean) =>
      ok(
        s.victor.request("PUT", "/api/v1/module-access", {
          module: "sandbox",
          scopeUnitId: null,
          subject: { kind: "user", userId: s.samId },
          enabled,
        }) as Promise<Res>,
      );
    await put(false);
    try {
      expect(await confined(s.sam, mine)).toEqual({
        sandbox: { enabled: false, available: false, reason: "module_off" },
        browser: { enabled: false, available: true, reason: null },
      });
      expect((await confined(s.victor, s.scoutId)).sandbox.available).toBe(true);
    } finally {
      await put(true);
    }
  });
});
