import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { TestClient } from "../../testing";
import { codeOf, type Json, ok, type Res, type SandboxStack, startSandboxStack } from "../../testing-sandbox";
import { invite } from "../../testing-workzone";

/**
 * 07.8-18 (SBX-04; D-03, D-11 F-3; P-12; ADR-0011's model): sandbox packages in the API. An admin with `plugin.manage`
 * reviews a release through sandboxd (the API never fetches a registry), approves exactly that review (the token binds
 * the coordinates, the top digest and the whole tree's hash), and a bot's sandbox gets the package the next time it
 * starts, always from the stored lockfile and tree hash. An upstream change is refused at approval
 * (`package_changed_upstream`) and at install (`tree_changed` / `digest_mismatch` → `changed_upstream`, never retried
 * silently). Every packages route has an organization-B case derived from the authz registry.
 *
 * Tripwire (07.4 lesson, C-01): `globalThis.fetch` is wrapped for the whole file. Anything other than the API and the
 * fake sandboxd reached through it (a registry, a CDN, any host) fails the test in `afterEach`.
 */

type Coords = { source: "npm" | "pypi" | "debian" | "clawhub"; name: string; version: string };
const LEFT_PAD: Coords = { source: "npm", name: "left-pad", version: "1.3.0" };

let s: SandboxStack;
let marta: TestClient;
const globalCalls: string[] = [];

/** Fails when the API (or anything in this process) fetched something other than itself or sandboxd. */
function assertNoGlobalFetch(): void {
  expect(globalCalls).toEqual([]);
}

const review = (who: TestClient, c: Coords = LEFT_PAD) =>
  who.request("POST", "/api/v1/sandbox/packages/review", c) as Promise<Res>;
const approve = (who: TestClient, reviewToken: string, acknowledge?: "install anyway") =>
  who.request("POST", "/api/v1/sandbox/packages", {
    reviewToken,
    ...(acknowledge ? { acknowledge } : {}),
  }) as Promise<Res>;
const list = (who: TestClient) => who.request("GET", "/api/v1/sandbox/packages") as Promise<Res>;
const patch = (who: TestClient, id: string, body: Json) =>
  who.request("PATCH", `/api/v1/sandbox/packages/${id}`, body) as Promise<Res>;
const remove = (who: TestClient, id: string) =>
  who.request("DELETE", `/api/v1/sandbox/packages/${id}`) as Promise<Res>;
const calls = (op: string) => s.sandboxd.stats().calls[op] ?? 0;

const audits = async (orgId: string, action: string) =>
  (
    await s.su.query(
      "select resource_id, actor_kind, agent_id, metadata from app.audit_events where organization_id = $1 and action = $2 order by occurred_at",
      [orgId, action],
    )
  ).rows as Json[];
const packageRow = async (id: string) =>
  (await s.su.query("select * from app.sandbox_packages where id = $1", [id])).rows[0] as Json | undefined;
const installRow = async (agentId: string, packageId: string) =>
  (
    await s.su.query(
      "select status, detail from app.sandbox_package_installs where agent_id = $1 and package_id = $2",
      [agentId, packageId],
    )
  ).rows[0] as Json | undefined;

/** One exec in `agentId`'s sandbox for `who`'s turn in `dm`. */
async function execIn(who: TestClient, dm: string, agentId: string): Promise<Res> {
  const ev = await s.turnOf(who, dm, agentId);
  return s.cell("/sandbox/exec", { eventId: ev.eventId, agentId, argv: ["echo", "hi"] });
}
/** Stops a bot's sandbox, so its next call starts it again (ensure → installs). */
async function stopSandbox(agentId: string, who: TestClient = s.victor): Promise<void> {
  await ok(who.request("POST", `/api/v1/agents/${agentId}/sandbox/stop`) as Promise<Res>);
}
/** The refreshed review a `package_changed_upstream` answer carries. */
const refreshedReview = (r: Res): Json => ((r.body as Json).error as Json).details.review as Json;
/** Reviews and approves `c` as Víctor; returns the approved package. */
async function approved(c: Coords, acknowledge?: "install anyway"): Promise<Json> {
  const r = await ok(review(s.victor, c));
  return ok(approve(s.victor, r.reviewToken as string, acknowledge));
}

beforeAll(async () => {
  s = await startSandboxStack();
  await s.setPolicy({ enabled: true });
  ({ client: marta } = await invite(s.stack, s.victor, "marta@example.test", "Marta Gil", "lead"));
  const allowed = new Set([new URL(s.stack.baseUrl).origin, new URL(s.sandboxd.url).origin]);
  const realFetch = globalThis.fetch;
  vi.stubGlobal("fetch", (input: string | URL | Request, init?: RequestInit) => {
    const href = input instanceof Request ? input.url : String(input);
    let origin = "";
    try {
      origin = new URL(href).origin;
    } catch {
      origin = "";
    }
    if (!allowed.has(origin)) {
      globalCalls.push(href.split("?", 1)[0] ?? href);
      throw new Error("global fetch called: only sandboxd may reach a registry");
    }
    return realFetch(input, init);
  });
}, 240_000);

afterEach(() => {
  assertNoGlobalFetch();
});

afterAll(async () => {
  vi.unstubAllGlobals();
  await s?.stop();
});

describe("tracer: an admin approves a pinned npm package and the bot's sandbox installs it at its next start", () => {
  let pkg: Json;
  let reviewed: Json;

  it("review: sandboxd's facts, the tree hash recomputed by the API, a low risk and a review token; audited", async () => {
    reviewed = await ok(review(s.victor));
    expect(reviewed).toMatchObject({
      source: "npm",
      name: "left-pad",
      version: "1.3.0",
      license: "MIT",
      hasInstallScript: false,
      dependencyCount: 1,
      risk: "low",
      riskReasons: [],
    });
    expect(reviewed.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(reviewed.treeSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(typeof reviewed.reviewToken).toBe("string");
    expect(JSON.stringify(reviewed)).not.toContain("lockfileVersion");
    const [audit] = await audits(s.orgA, "sandbox.package_reviewed");
    expect(audit?.actor_kind).toBe("user");
    expect(audit?.metadata).toEqual({
      source: "npm",
      name: "left-pad",
      version: "1.3.0",
      sha256: reviewed.sha256,
      treeSha256: reviewed.treeSha256,
      dependencyCount: 1,
      risk: "low",
      riskCodes: [],
    });
  });

  it("approve: the pinned row stores the lockfile, the tree hash and the dependency count; audited without the lockfile", async () => {
    pkg = await ok(approve(s.victor, reviewed.reviewToken));
    expect(pkg).toMatchObject({
      source: "npm",
      name: "left-pad",
      version: "1.3.0",
      sha256: reviewed.sha256,
      treeSha256: reviewed.treeSha256,
      dependencyCount: 1,
      risk: "low",
      enabled: true,
      personalAllowed: false,
      installedIn: 0,
      installing: 0,
      failed: 0,
      changedUpstream: false,
      newerVersion: null,
      approvedBy: { id: s.victorId, displayName: "Víctor Ruiz" },
    });
    const row = await packageRow(pkg.id);
    expect(row).toMatchObject({
      status: "approved",
      tree_sha256: reviewed.treeSha256,
      dependency_count: 1,
      review_token: reviewed.reviewToken,
      changed_upstream: false,
    });
    expect(JSON.parse(row?.lockfile).name).toBe("left-pad");
    const [audit] = await audits(s.orgA, "sandbox.package_approved");
    expect(audit?.resource_id).toBe(pkg.id);
    expect(audit?.metadata).toEqual({
      source: "npm",
      name: "left-pad",
      version: "1.3.0",
      sha256: reviewed.sha256,
      treeSha256: reviewed.treeSha256,
      dependencyCount: 1,
      risk: "low",
      riskCodes: [],
      acknowledged: false,
      replaced: null,
    });
    expect(JSON.stringify(await audits(s.orgA, "sandbox.package_approved"))).not.toContain("lockfileVersion");
  });

  it("Scout's next start installs it once, from the stored lockfile and tree hash; a later start does not reinstall", async () => {
    const before = calls("packageInstall");
    const r = await execIn(s.sam, s.samDm, s.scoutId);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(calls("packageInstall")).toBe(before + 1);
    expect(s.sandboxd.fake.packagesOf({ orgId: s.orgA, agentId: s.scoutId })).toEqual([pkg.id]);
    expect(await installRow(s.scoutId, pkg.id)).toEqual({ status: "installed", detail: null });
    const listed = await ok(list(s.victor));
    expect(listed.viewerCan).toEqual({ manage: true });
    expect(listed.items.find((p: Json) => p.id === pkg.id)).toMatchObject({ installedIn: 1, failed: 0 });

    // Running: no start, no install. Stopped and started again: the installs already match, nothing is sent.
    expect((await execIn(s.sam, s.samDm, s.scoutId)).status).toBe(200);
    await stopSandbox(s.scoutId);
    expect((await execIn(s.sam, s.samDm, s.scoutId)).status).toBe(200);
    expect(calls("packageInstall")).toBe(before + 1);
  });

  it("a personal bot gets it only once 'Personal bots' is on", async () => {
    const personal = await ok(s.sam.request("POST", "/api/v1/agents/personal", {}) as Promise<Res>);
    const botId = personal.agent.id as string;
    await s.setBotSandbox(botId, true);
    const dm = personal.dmId as string;
    expect((await execIn(s.sam, dm, botId)).status).toBe(200);
    expect(s.sandboxd.fake.packagesOf({ orgId: s.orgA, agentId: botId })).toEqual([]);
    expect(await installRow(botId, pkg.id)).toBeUndefined();

    expect((await ok(patch(s.victor, pkg.id, { personalAllowed: true }))).personalAllowed).toBe(true);
    await stopSandbox(botId, s.sam);
    expect((await execIn(s.sam, dm, botId)).status).toBe(200);
    expect(s.sandboxd.fake.packagesOf({ orgId: s.orgA, agentId: botId })).toEqual([pkg.id]);
    expect(await installRow(botId, pkg.id)).toEqual({ status: "installed", detail: null });
  });

  it("the same live package again: 409 package_exists; nothing stored", async () => {
    const again = await ok(review(s.victor));
    const r = await approve(s.victor, again.reviewToken);
    expect(r.status).toBe(409);
    expect(codeOf(r)).toBe("package_exists");
    const n = (
      await s.su.query(
        "select count(*)::int as n from app.sandbox_packages where organization_id = $1 and name = 'left-pad'",
        [s.orgA],
      )
    ).rows[0].n;
    expect(n).toBe(1);
  });
});

describe("the review token binds exactly what was reviewed (T-07.8-18-01/02)", () => {
  const IS_EVEN: Coords = { source: "npm", name: "is-even", version: "1.0.0" };

  it("a forged token or one minted in another organization: 409 review_token_invalid", async () => {
    const r = await ok(review(s.victor, IS_EVEN));
    const forged = `${(r.reviewToken as string).slice(0, -2)}xx`;
    const bad = await approve(s.victor, forged);
    expect(bad.status).toBe(409);
    expect(codeOf(bad)).toBe("review_token_invalid");
    const theirs = await ok(review(s.eve, IS_EVEN));
    const cross = await approve(s.victor, theirs.reviewToken);
    expect(cross.status).toBe(409);
    expect(codeOf(cross)).toBe("review_token_invalid");
    expect((await approve(s.victor, "not-a-token")).status).toBe(409);
  });

  it("the top artifact republished after the review: 409 package_changed_upstream with the refreshed review", async () => {
    const r = await ok(review(s.victor, IS_EVEN));
    s.sandboxd.fake.setPackage(IS_EVEN, { topChanged: true });
    const res = await approve(s.victor, r.reviewToken);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("package_changed_upstream");
    const fresh = refreshedReview(res);
    expect(fresh.sha256).not.toBe(r.sha256);
    expect(typeof fresh.reviewToken).toBe("string");
    s.sandboxd.fake.setPackage(IS_EVEN, { topChanged: false });
  });

  it("only a dependency's integrity changed: 409 package_changed_upstream, the refreshed review has the new tree hash", async () => {
    const r = await ok(review(s.victor, IS_EVEN));
    s.sandboxd.fake.setPackage(IS_EVEN, { depChanged: true });
    const res = await approve(s.victor, r.reviewToken);
    expect(res.status).toBe(409);
    expect(codeOf(res)).toBe("package_changed_upstream");
    const fresh = refreshedReview(res);
    expect(fresh.sha256).toBe(r.sha256);
    expect(fresh.treeSha256).not.toBe(r.treeSha256);
    const n = (await s.su.query("select count(*)::int as n from app.sandbox_packages where name = 'is-even'"))
      .rows[0].n;
    expect(n).toBe(0);
    // The refreshed review approves what is there now.
    const p = await ok(approve(s.victor, fresh.reviewToken));
    expect(p.treeSha256).toBe(fresh.treeSha256);
  });

  it("sandboxd reports a tree hash its entries do not have: 503 service_unavailable, nothing stored, no lockfile logged", async () => {
    const LIAR: Coords = { source: "npm", name: "tree-liar", version: "2.0.0" };
    s.sandboxd.fake.setPackage(LIAR, { badTreeHash: true });
    const logsBefore = s.logs.length;
    const r = await review(s.victor, LIAR);
    expect(r.status).toBe(503);
    expect(codeOf(r)).toBe("service_unavailable");
    expect(
      (await s.su.query("select count(*)::int as n from app.sandbox_packages where name = 'tree-liar'"))
        .rows[0].n,
    ).toBe(0);
    const lines = s.logs.slice(logsBefore).join("\n");
    expect(lines).toContain("tree hash");
    expect(lines).toContain("tree-liar");
    expect(lines).not.toContain("lockfileVersion");
    expect(lines).not.toContain("sha512-");
  });
});

describe("a dependency republished after approval (P-12, R12): refused at install, never retried silently", () => {
  const IS_ODD: Coords = { source: "npm", name: "is-odd", version: "3.0.1" };

  it("a new bot's start answers tree_changed: install failed, package changed upstream, exec still runs, audited by code", async () => {
    const pkg = await approved(IS_ODD);
    s.sandboxd.fake.setPackage(IS_ODD, { depChanged: true });
    const courier = await s.newBot("Courier");
    const r = await execIn(s.sam, courier.dm, courier.id);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body?.stdout).toBe("hi\n");
    expect(await installRow(courier.id, pkg.id)).toEqual({ status: "failed", detail: "tree_changed" });
    expect(s.sandboxd.fake.packagesOf({ orgId: s.orgA, agentId: courier.id })).not.toContain(pkg.id);
    expect((await packageRow(pkg.id))?.changed_upstream).toBe(true);
    const listed = (await ok(list(s.victor))).items.find((p: Json) => p.id === pkg.id);
    expect(listed).toMatchObject({ changedUpstream: true, failed: 1 });
    const failed = (await audits(s.orgA, "sandbox.package_install_failed")).filter(
      (a) => a.resource_id === pkg.id && a.agent_id === courier.id,
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.metadata).toEqual({ code: "tree_changed" });

    // The next start does not retry until an admin reviews and approves again.
    const installsBefore = calls("packageInstall");
    await stopSandbox(courier.id);
    expect((await execIn(s.sam, courier.dm, courier.id)).status).toBe(200);
    expect(calls("packageInstall")).toBe(installsBefore);

    // Re-reviewed and re-approved: a new pinned row replaces the old one; the next start installs the new tree.
    const next = await approved(IS_ODD);
    expect(next.id).not.toBe(pkg.id);
    expect(next.changedUpstream).toBe(false);
    expect((await packageRow(pkg.id))?.status).toBe("removed");
    const [replaced] = (await audits(s.orgA, "sandbox.package_approved")).filter(
      (a) => a.resource_id === next.id,
    );
    expect(replaced?.metadata.replaced).toBe(pkg.id);
    await stopSandbox(courier.id);
    expect((await execIn(s.sam, courier.dm, courier.id)).status).toBe(200);
    expect(await installRow(courier.id, next.id)).toEqual({ status: "installed", detail: null });
    expect(await installRow(courier.id, pkg.id)).toBeUndefined();
    expect(s.sandboxd.fake.packagesOf({ orgId: s.orgA, agentId: courier.id })).toContain(next.id);
  });
});

describe("who may manage packages (T-07.8-18-03)", () => {
  it("a member without bot.manage: 403 everywhere; nothing reaches sandboxd", async () => {
    const before = calls("packageReview");
    for (const r of [await review(s.sam), await approve(s.sam, "x"), await list(s.sam)]) {
      expect(r.status).toBe(403);
    }
    expect((await review(marta)).status).toBe(403);
    expect(calls("packageReview")).toBe(before);
  });

  it("an admin denied plugin.manage reads the list (bot.manage) but cannot review, approve, change or remove", async () => {
    const alexId = s.alexId;
    await s.su.query("update app.org_members set role = 'admin' where user_id = $1", [alexId]);
    await s.su.query("update auth.member set role = 'admin' where user_id = $1", [alexId]);
    await ok(
      s.victor.request("POST", "/api/v1/permission-rules", {
        subjectKind: "user",
        subjectId: alexId,
        permission: "plugin.manage",
        effect: "deny",
      }) as Promise<Res>,
    );
    const listed = await ok(list(s.alex));
    expect(listed.viewerCan).toEqual({ manage: false });
    expect(listed.items.length).toBeGreaterThan(0);
    const id = listed.items[0].id as string;
    const before = calls("packageReview");
    expect((await review(s.alex)).status).toBe(403);
    expect((await approve(s.alex, "x")).status).toBe(403);
    expect((await patch(s.alex, id, { enabled: false })).status).toBe(403);
    expect((await remove(s.alex, id)).status).toBe(403);
    expect(calls("packageReview")).toBe(before);
    expect((await packageRow(id))?.enabled).toBe(true);
  });
});

describe("cross-tenant guards derived from the authz registry (P-17, 07.4 #169)", () => {
  it("every registered /sandbox/packages route is covered by an organization-B case", async () => {
    const mine = await approved({ source: "npm", name: "kleur", version: "4.1.5" });
    const cases: Record<string, () => Promise<void>> = {
      "GET /api/v1/sandbox/packages": async () => {
        const b = await ok(list(s.eve));
        expect(b.items.map((p: Json) => p.id)).not.toContain(mine.id);
      },
      "POST /api/v1/sandbox/packages/review": async () => {
        const before = await audits(s.orgA, "sandbox.package_reviewed");
        await ok(review(s.eve, { source: "npm", name: "kleur", version: "4.1.5" }));
        expect(await audits(s.orgA, "sandbox.package_reviewed")).toEqual(before);
      },
      "POST /api/v1/sandbox/packages": async () => {
        // Organization A's review token is not organization B's.
        const theirs = await ok(review(s.victor, { source: "npm", name: "ms", version: "2.1.3" }));
        const r = await approve(s.eve, theirs.reviewToken);
        expect(r.status).toBe(409);
        expect(codeOf(r)).toBe("review_token_invalid");
      },
      "PATCH /api/v1/sandbox/packages/:id": async () => {
        expect((await patch(s.eve, mine.id, { enabled: false })).status).toBe(404);
        expect((await packageRow(mine.id))?.enabled).toBe(true);
      },
      "DELETE /api/v1/sandbox/packages/:id": async () => {
        expect((await remove(s.eve, mine.id)).status).toBe(404);
        expect((await packageRow(mine.id))?.status).toBe("approved");
      },
    };
    const registered = [...s.stack.built.authz.routes.keys()].filter((k) => k.includes("/sandbox/packages"));
    expect(registered.sort()).toEqual(Object.keys(cases).sort());
    for (const [key, run] of Object.entries(cases)) {
      expect(s.stack.built.authz.routes.get(key), key).toBe("user");
      await run();
    }
    expect(
      (
        await s.su.query("select count(*)::int as n from app.sandbox_packages where organization_id = $1", [
          s.orgB,
        ])
      ).rows[0].n,
    ).toBe(0);
  });
});

describe("risk, acknowledgement, switches, update and removal for the four sources (D-03, P-12)", () => {
  const TINY: Coords = { source: "npm", name: "tiny-cli", version: "1.0.0" };
  const scout = () => ({ orgId: s.orgA, agentId: s.scoutId });
  /** Scout starts again (stop, then a call): the packages are synced. */
  async function restartScout(): Promise<void> {
    await stopSandbox(s.scoutId);
    expect((await execIn(s.sam, s.samDm, s.scoutId)).status).toBe(200);
  }

  it("a high risk needs the typed acknowledgement: 400 acknowledgement_required, then approved and audited", async () => {
    const GPL: Coords = { source: "npm", name: "copyleft-tool", version: "2.1.0" };
    s.sandboxd.fake.setPackage(GPL, { license: "GPL-2.0-only" });
    const r = await ok(review(s.victor, GPL));
    expect(r.risk).toBe("high");
    expect(r.riskReasons).toEqual(["Its license (GPL-2.0-only) is not one the workspace allows"]);
    const no = await approve(s.victor, r.reviewToken);
    expect(no.status).toBe(400);
    expect(codeOf(no)).toBe("acknowledgement_required");
    const p = await ok(approve(s.victor, r.reviewToken, "install anyway"));
    expect(p.risk).toBe("high");
    const [audit] = (await audits(s.orgA, "sandbox.package_approved")).filter((a) => a.resource_id === p.id);
    expect(audit?.metadata).toMatchObject({ acknowledged: true, riskCodes: ["license_denied"] });
  });

  it("an install script is at least medium; sha1-only integrity is refused with a reason (403 package_refused)", async () => {
    const SCRIPTED: Coords = { source: "npm", name: "post-hook", version: "1.0.0" };
    s.sandboxd.fake.setPackage(SCRIPTED, { hasInstallScript: true });
    expect((await ok(review(s.victor, SCRIPTED))).risk).toBe("medium");

    const OLD: Coords = { source: "npm", name: "old-lockfile", version: "0.4.0" };
    s.sandboxd.fake.setPackage(OLD, { sha1: true });
    const r = await ok(review(s.victor, OLD));
    expect(r.risk).toBe("refuse");
    expect(r.riskReasons[0]).toContain("sha1");
    const no = await approve(s.victor, r.reviewToken, "install anyway");
    expect(no.status).toBe(403);
    expect(codeOf(no)).toBe("package_refused");
    expect(
      (await s.su.query("select count(*)::int as n from app.sandbox_packages where name = 'old-lockfile'"))
        .rows[0].n,
    ).toBe(0);
  });

  it("switched off: every sandbox drops it at its next start (packageRemove, rows removed); on again: reinstalled", async () => {
    const p = await approved(TINY);
    await restartScout();
    expect(s.sandboxd.fake.packagesOf(scout())).toContain(p.id);
    expect((await ok(patch(s.victor, p.id, { enabled: false }))).enabled).toBe(false);
    const [updated] = (await audits(s.orgA, "sandbox.package_updated")).filter((a) => a.resource_id === p.id);
    expect(updated?.metadata).toEqual({ source: "npm", name: "tiny-cli", version: "1.0.0", enabled: false });
    const removes = calls("packageRemove");
    await restartScout();
    expect(calls("packageRemove")).toBe(removes + 1);
    expect(s.sandboxd.fake.packagesOf(scout())).not.toContain(p.id);
    expect(await installRow(s.scoutId, p.id)).toBeUndefined();
    await ok(patch(s.victor, p.id, { enabled: true }));
    await restartScout();
    expect(await installRow(s.scoutId, p.id)).toEqual({ status: "installed", detail: null });
  });

  it("update to another version: a new review and approval replaces the row; the old one goes at the next start", async () => {
    const [old] = (await ok(list(s.victor))).items.filter((p: Json) => p.name === "tiny-cli");
    const next = await approved({ ...TINY, version: "2.0.0" });
    expect(next.version).toBe("2.0.0");
    expect((await packageRow(old.id))?.status).toBe("removed");
    const [updated] = (await audits(s.orgA, "sandbox.package_updated")).filter(
      (a) => a.resource_id === old.id && a.metadata.replacedBy,
    );
    expect(updated?.metadata.replacedBy).toEqual({ version: "2.0.0" });
    await restartScout();
    expect(s.sandboxd.fake.packagesOf(scout())).toContain(next.id);
    expect(s.sandboxd.fake.packagesOf(scout())).not.toContain(old.id);
    expect(await installRow(s.scoutId, old.id)).toBeUndefined();
  });

  it("removed: status removed, gone from every sandbox at the next start, and the same name may be reviewed again", async () => {
    const [p] = (await ok(list(s.victor))).items.filter((x: Json) => x.name === "tiny-cli");
    expect(await ok(remove(s.victor, p.id))).toEqual({ ok: true });
    expect((await packageRow(p.id))?.status).toBe("removed");
    expect((await audits(s.orgA, "sandbox.package_removed")).map((a) => a.resource_id)).toContain(p.id);
    expect((await ok(list(s.victor))).items.map((x: Json) => x.id)).not.toContain(p.id);
    expect((await remove(s.victor, p.id)).status).toBe(404);
    expect((await patch(s.victor, p.id, { enabled: true })).status).toBe(404);
    await restartScout();
    expect(s.sandboxd.fake.packagesOf(scout())).not.toContain(p.id);
    const again = await approved(TINY);
    expect(again.id).not.toBe(p.id);
  });

  it("Debian and ClawHub go through the same flow; the API never parses registry metadata itself", async () => {
    const deb = await approved({ source: "debian", name: "jq", version: "1.7.1-3" });
    const hub = await approved({ source: "clawhub", name: "notes-skill", version: "1.0.0" });
    expect(deb.dependencyCount).toBe(1);
    expect(hub.dependencyCount).toBe(0);
    await restartScout();
    expect(await installRow(s.scoutId, deb.id)).toEqual({ status: "installed", detail: null });
    expect(await installRow(s.scoutId, hub.id)).toEqual({ status: "installed", detail: null });
  });
});
