import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type APIRequestContext, type Browser, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { type HeadlessDevice, type HeadlessServer, startHeadlessServer } from "../support/headless-server";
import { approvePairingInUi } from "../support/pairing";
import {
  createTeamProject,
  linkRepo,
  removeTeamProject,
  shareDevice,
  type TeamProject,
} from "../support/work-zone-projects";
import { ADMIN, API_URL } from "./env";

/**
 * Phase 07.12 end-to-end tracer (PD-02, HSR-01, HSR-02, HSR-03, HSR-05, HSR-06): everything an owner does to turn a
 * machine into a shared Work Zone server, on the real API and web with the bundle the API serves. A scratch HOME runs
 * the workspace's own `install.sh` (`curl … | sh`, a fake npm links the workspace's Claude Agent SDK), then
 * `ocw-runtime setup --yes --service none` prints a link the owner approves in Settings › Devices, and the installed
 * daemon (no desktop app, no checkout sources) comes online with its repository. The owner shares the device with Sam
 * and links the repository to a team project Sam belongs to; Sam runs a session through each. The doctor's JSON and
 * `remove-project` close the run. PD-19: scratch HOME and PATH, fake npm, fake runtime, updates off, no service.
 */

test.describe.configure({ mode: "serial" });

const REPO_ROOT = join(import.meta.dirname, "..", "..");
const DEVICE_NAME = "E2E headless";
const PROJECT = "headless-repo";
const TEAM_PROJECT = "Headless team project";
/** `DOCTOR_CHECK_IDS` of apps/local-runtime/src/doctor.ts (the order `--json` readers rely on). */
const DOCTOR_CHECK_IDS = [
  "node",
  "runtime",
  "pairing",
  "server",
  "daemon",
  "service",
  "claude-code",
  "codex",
  "runtimes",
  "git",
  "projects",
  "updates",
  "service-env",
];

interface DoctorJson {
  account: string;
  device: string | null;
  checks: Array<{ id: string; status: "ok" | "warn" | "fail"; summary: string; fix: string | null }>;
  link: string | null;
  counts: { ok: number; warn: number; fail: number };
  checkedAt: string;
}

let adminApi: APIRequestContext;
let samId = "";
let server: HeadlessServer | null = null;
let device: HeadlessDevice | null = null;
let team: TeamProject | null = null;
const sessionIds: string[] = [];

const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

async function signIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("Email").fill(ADMIN.email);
  await page.getByLabel("Password", { exact: true }).fill(ADMIN.password);
  await page
    .getByTestId("login-form")
    .getByRole("button", { name: /sign in|log in/i })
    .click();
  await expect(page).toHaveURL(/\/chat/);
}

/**
 * Sam fills the open New session dialog (Claude Code, Supervised: the cap of a default share), starts the session,
 * allows the one write the fake runtime asks for and waits for its answer; returns the session id.
 */
async function runSamsSession(page: Page, prompt: string): Promise<string> {
  const dialog = page.getByTestId("new-session-dialog");
  await dialog.getByTestId("runtime-claude-code").click();
  await dialog.getByTestId("first-prompt").fill(prompt);
  await dialog.getByTestId("start-session").click();
  await expect(page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/, { timeout: 15_000 });
  const sessionId = page.url().split("/").pop() ?? "";
  sessionIds.push(sessionId);
  await expect(page.getByTestId("assistant-message").first()).toContainText("I'll start by reading", {
    timeout: 30_000,
  });
  const banner = page.getByTestId("approval-banner");
  await expect(banner).toBeVisible({ timeout: 30_000 });
  await expect(banner).toContainText("notes/ocw-change-1.md");
  await banner.getByTestId("approve-once").click();
  await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", { timeout: 30_000 });
  await expect(page.getByTestId("assistant-message").last()).toContainText("Done. I created");
  return sessionId;
}

async function asSam(browser: Browser) {
  return openAs(browser, SAM, "desktop");
}

test.beforeAll(async () => {
  test.skip(test.info().project.name !== "desktop", "one headless device per run: the desktop project only");
  test.setTimeout(180_000);
  // The API serves apps/local-runtime/dist (PD-05) and caches a verified load until it restarts: build it before
  // anything asks for it, as an owner's workspace image does.
  execFileSync(process.execPath, ["apps/local-runtime/scripts/build-bundle.mjs"], {
    cwd: REPO_ROOT,
    stdio: "pipe",
  });
  adminApi = await apiAs(ADMIN);
  samId = await ensureMember(adminApi, SAM, "developer");
});

test.afterAll(async () => {
  if (!adminApi) return;
  for (const id of sessionIds) {
    await adminApi.post(`/api/v1/work-sessions/${id}/archive`, { data: {} }).catch(() => undefined);
  }
  if (team) await removeTeamProject(adminApi, team).catch(() => undefined);
  await server?.stop();
  await adminApi.dispose();
});

test("install.sh from the workspace, setup --yes --service none, approval in the web, the bundled daemon online", async ({
  page,
}) => {
  test.setTimeout(240_000);
  server = await startHeadlessServer(adminApi, { name: DEVICE_NAME, projectName: PROJECT, apiUrl: API_URL });

  // ---- the install: the bundle the API serves, verified, with the SDK beside it from the (fake) npm
  const versionRes = await adminApi.get("/api/v1/runtime/version");
  expect(versionRes.ok(), "GET /api/v1/runtime/version").toBe(true);
  const version = (await versionRes.json()) as { version: string; sha256: string };
  expect(server.installOutput).toContain(
    `Installed ocw-runtime ${version.version} (${version.sha256.slice(0, 12)}).`,
  );
  expect(existsSync(server.shim), "~/.local/bin/ocw-runtime").toBe(true);
  const installed = readFileSync(join(server.ocwHome, "runtime", "current", "ocw-runtime.mjs"));
  expect(sha256(installed)).toBe(version.sha256);
  const record = JSON.parse(readFileSync(join(server.ocwHome, "runtime", "install.json"), "utf8")) as Record<
    string,
    string
  >;
  expect(Object.keys(record).sort()).toEqual(["installedAt", "nodePath", "serverUrl", "sha256", "version"]);
  expect(record).toMatchObject({ serverUrl: API_URL, version: version.version, sha256: version.sha256 });
  const npmCalls = server.npmCalls();
  expect(npmCalls).toHaveLength(1);
  expect(npmCalls[0]).toEqual(
    expect.arrayContaining([
      "install",
      "--prefix",
      "--ignore-scripts",
      expect.stringMatching(/^@anthropic-ai\/claude-agent-sdk@\d+\.\d+\.\d+$/),
    ]),
  );

  // ---- setup prints the link; the owner approves it in Settings › Devices
  const pairingUrl = await server.pairingUrl;
  expect(pairingUrl).toMatch(
    new RegExp(
      `^${BASE_URL.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}/settings/devices\\?pair=[0-9A-Z]{4}-[0-9A-Z]{4}$`,
    ),
  );
  await signIn(page);
  await approvePairingInUi(page, pairingUrl);
  expect(await server.setupDone, `setup's output:\n${server.setupOutput()}`).toBe(0);
  const out = server.setupOutput();
  const steps = [
    `Paired "${DEVICE_NAME}"`,
    `Registered "${PROJECT}"`,
    "No service installed",
    `Settings › Devices: ${BASE_URL}/settings/devices`,
    "Share it with members and teams there.",
  ];
  const at = steps.map((s) => out.indexOf(s));
  expect(
    at.every((i) => i >= 0),
    `setup's output:\n${out}`,
  ).toBe(true);
  expect([...at].sort((a, b) => a - b)).toEqual(at);

  // ---- the installed daemon comes online with its repository
  device = await server.start();
  await page.goto("/settings/devices");
  const card = page.getByTestId("device-card").filter({ hasText: DEVICE_NAME });
  await expect(card).toHaveAttribute("data-status", "online", { timeout: 15_000 });
});

test("the owner shares the device with Sam; Sam runs a session on it from the Work Zone", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  expect(device, "the headless device is online").not.toBeNull();
  if (!device) return;
  await shareDevice(adminApi, device.deviceId, samId);
  const sam = await asSam(browser);
  try {
    await sam.page.goto(`${BASE_URL}/work-zone`);
    await sam.page.getByTestId("new-session").click();
    const dialog = sam.page.getByTestId("new-session-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("project-option").filter({ hasText: PROJECT }).click();
    await runSamsSession(sam.page, "Add a short CONTRIBUTING guide for new teammates");
  } finally {
    await sam.context.close();
  }
});

test("a team project with the device's repository: Sam starts a session from the project", async ({
  browser,
}) => {
  test.setTimeout(120_000);
  expect(device, "the headless device is online").not.toBeNull();
  if (!device) return;
  team = await createTeamProject(adminApi, { name: TEAM_PROJECT, members: [{ userId: samId }] });
  await linkRepo(adminApi, team.unitId, device.projectId);
  const sam = await asSam(browser);
  const samApi = await apiAs(SAM);
  try {
    await sam.page.goto(`${BASE_URL}/work-zone/projects/${team.unitId}`);
    const project = sam.page.getByTestId("project-page");
    await expect(project.getByRole("heading", { level: 1 })).toHaveText(TEAM_PROJECT, { timeout: 30_000 });
    await project.getByTestId("project-new-session").click();
    const dialog = sam.page.getByTestId("new-session-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('[data-testid="project-option"][aria-checked="true"]')).toContainText(
      PROJECT,
    );
    const sessionId = await runSamsSession(sam.page, "Write release notes for the team");
    const res = await samApi.get(`/api/v1/work-sessions/${sessionId}`);
    expect(res.ok(), "Sam reads the session").toBe(true);
    const body = (await res.json()) as { session: { teamProject?: { id: string } | null } };
    expect(body.session.teamProject?.id).toBe(team.unitId);
  } finally {
    await samApi.dispose();
    await sam.context.close();
  }
});

test("doctor --json on the device: pairing, server and daemon ok, no service, nothing secret or absolute", async () => {
  expect(server, "the headless server is installed").not.toBeNull();
  if (!server) return;
  const r = await server.cli(["doctor", "--json"]);
  const report = JSON.parse(r.stdout) as DoctorJson;
  expect(report.checks.map((c) => c.id)).toEqual(DOCTOR_CHECK_IDS);
  const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
  expect(status, r.stdout).toMatchObject({
    runtime: "ok",
    pairing: "ok",
    server: "ok",
    daemon: "ok",
    service: "warn",
    projects: "ok",
  });
  // Exit 1 on any fail (the fake runtimes may count as signed out: `runtimes` is then a fail), else 0.
  expect(r.code).toBe(report.counts.fail > 0 ? 1 : 0);
  expect(report.device).toBe(DEVICE_NAME);
  expect(report.link).toBe(`${BASE_URL}/settings/devices`);
  const token = readFileSync(join(server.ocwHome, "device-token"), "utf8").trim();
  expect(token).toMatch(/^ocwd_/);
  expect(r.stdout).not.toContain(token);
  expect(r.stdout).not.toContain("ocwd_");
  expect(r.stdout).not.toContain(server.home);
  expect(r.stdout).not.toContain(server.root);
  expect(report.checks.find((c) => c.id === "projects")?.summary).toContain(`${PROJECT} (~/`);
});

test("remove-project while the daemon runs: the API stops listing the repository", async () => {
  expect(server && device, "the headless device is online").toBeTruthy();
  if (!server || !device) return;
  const projectId = device.projectId;
  const r = await server.cli(["remove-project", PROJECT]);
  expect(r.code, r.stderr).toBe(0);
  expect(r.stdout).toContain(`Removed "${PROJECT}"`);
  await expect
    .poll(
      async () => {
        const projects = (await (await adminApi.get("/api/v1/projects")).json()) as {
          projects: Array<{ id: string; available: boolean }>;
        };
        return projects.projects.find((p) => p.id === projectId)?.available ?? false;
      },
      { timeout: 30_000, message: `${PROJECT} is removed` },
    )
    .toBe(false);
});
