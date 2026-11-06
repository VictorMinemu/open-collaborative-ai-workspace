import { spawnSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { type APIRequestContext, expect, type Page, test } from "@playwright/test";
import { apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { approvePairingInUi } from "../support/pairing";
import { shareDevice } from "../support/work-zone-projects";
import { ADMIN } from "../tests/env";

/**
 * The web half of the headless Linux server proof (07.12-10, HSR-07, D-08). scripts/headless-server-proof.sh installs
 * the runtime in a clean, pinned Node 24 container from the isolated API, runs `ocw-runtime setup --yes --service none`
 * and hands this spec the link setup printed (PROOF_PAIR_URL) and the container's name (PROOF_CONTAINER). Then:
 *
 *   a. the owner approves the pairing in Settings › Devices, and the container's device comes online with `repo`;
 *   b. the owner shares the device with Sam, and Sam starts a Claude Code session on it from the web and gets the fake
 *      runtime's reply (HSR-06, in a clean Linux);
 *   c. in the container, `ocw-runtime doctor --json` has no fail (pairing, server and daemon ok, the service a warn) and
 *      carries neither the device token nor /home/node (D-05); `ocw-runtime service install` refuses with the
 *      own-supervisor line, since the container has no systemd (D-04);
 *   d. the owner revokes the device.
 *
 * Opt-in only: skipped unless PROOF_PAIR_URL is set, so it never runs outside the script.
 */

test.describe.configure({ mode: "serial" });

const PAIR_URL = process.env.PROOF_PAIR_URL ?? "";
const CONTAINER = process.env.PROOF_CONTAINER ?? "";
const DEVICE = process.env.PROOF_DEVICE_NAME ?? "proof-server";
const PROJECT = process.env.PROOF_PROJECT ?? "repo";
const FACTS = process.env.PROOF_FACTS ?? "";
const HOME_IN = "/home/node";
const RUNTIME = `${HOME_IN}/.local/bin/ocw-runtime`;

/** `docker exec` as the container's user `node`, only into the proof's own container (never another one). */
function inContainer(args: string[]): { status: number | null; stdout: string; stderr: string } {
  expect(CONTAINER, "PROOF_CONTAINER names the proof's container").toMatch(/^ocw-headless-proof-\d+$/);
  const r = spawnSync("docker", ["exec", "-u", "node", "-e", `HOME=${HOME_IN}`, CONTAINER, ...args], {
    encoding: "utf8",
    timeout: 60_000,
  });
  return { status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

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

interface DeviceRow {
  id: string;
  name: string;
  status: string;
  platform?: string;
}

async function onlineDevice(
  adminApi: APIRequestContext,
): Promise<{ deviceId: string; platform?: string } | null> {
  const devices = (await (await adminApi.get("/api/v1/devices")).json()) as { devices: DeviceRow[] };
  const d = devices.devices.find((x) => x.name === DEVICE && x.status === "online");
  if (!d) return null;
  const projects = (await (await adminApi.get("/api/v1/projects")).json()) as {
    projects: Array<{ deviceId: string; name: string; available: boolean }>;
  };
  const ready = projects.projects.some((p) => p.deviceId === d.id && p.name === PROJECT && p.available);
  return ready ? { deviceId: d.id, platform: d.platform } : null;
}

interface DoctorCheck {
  id: string;
  status: "ok" | "warn" | "fail";
  summary: string;
}

test("A clean Linux server becomes a shared Work Zone device from the web", async ({ page, browser }) => {
  test.skip(!PAIR_URL, "run through scripts/headless-server-proof.sh (PROOF_PAIR_URL)");
  test.setTimeout(240_000);
  const facts: string[] = [];
  const adminApi = await apiAs(ADMIN);
  let deviceId: string | null = null;
  let sessionId: string | null = null;
  let sam: Awaited<ReturnType<typeof openAs>> | null = null;

  try {
    // ---- a. the owner approves the link the container's setup printed; the device comes online with its repo
    expect(new URL(PAIR_URL).origin, "setup links to the workspace's web").toBe(new URL(BASE_URL).origin);
    await signIn(page);
    await approvePairingInUi(page, PAIR_URL);
    let found: { deviceId: string; platform?: string } | null = null;
    await expect
      .poll(
        async () => {
          found = await onlineDevice(adminApi);
          return found !== null;
        },
        { timeout: 60_000, intervals: [1_000], message: `${DEVICE} comes online with ${PROJECT}` },
      )
      .toBe(true);
    const online = found as { deviceId: string; platform?: string } | null;
    if (!online) throw new Error(`${DEVICE} did not come online`);
    deviceId = online.deviceId;
    if (online.platform !== undefined) expect(online.platform, "the container reports Linux").toBe("linux");
    await expect(page.getByTestId("pair-connected")).toBeVisible({ timeout: 30_000 });
    facts.push(`device ${DEVICE} online with ${PROJECT} (platform ${online.platform ?? "?"})`);

    // ---- b. shared with Sam, who starts a Claude Code session on it from the web
    const samId = await ensureMember(adminApi, SAM, "developer");
    await shareDevice(adminApi, deviceId, samId, "acceptEdits");
    sam = await openAs(browser, SAM, "proof");
    await sam.page.goto(`${BASE_URL}/work-zone`);
    await sam.page.getByTestId("new-session").click();
    const start = sam.page.getByTestId("new-session-dialog");
    await expect(start).toBeVisible();
    await start.getByTestId("project-option").filter({ hasText: PROJECT }).first().click();
    await start.getByTestId("runtime-claude-code").click();
    await start.getByTestId("new-session-settings-toggle").click();
    await start.getByTestId("mode-acceptEdits").click();
    await start.getByTestId("first-prompt").fill("Add a short CONTRIBUTING guide for new teammates");
    await start.getByTestId("start-session").click();
    await expect(sam.page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/, { timeout: 15_000 });
    sessionId = sam.page.url().split("/").pop() ?? null;
    await expect(sam.page.getByTestId("assistant-message").first()).toContainText("I'll start by reading", {
      timeout: 60_000,
    });
    await expect(sam.page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 60_000,
    });
    facts.push("Sam's Claude Code session on the container: assistant reply, idle");

    // ---- c. the container's doctor and the no-systemd refusal
    const doctor = inContainer([RUNTIME, "doctor", "--json"]);
    expect(doctor.status, `doctor --json exit (stderr: ${doctor.stderr})`).toBe(0);
    const report = JSON.parse(doctor.stdout) as { checks: DoctorCheck[]; counts: Record<string, number> };
    const status = Object.fromEntries(report.checks.map((c) => [c.id, c.status]));
    expect(
      report.checks.filter((c) => c.status === "fail"),
      "no doctor check fails",
    ).toEqual([]);
    expect(status).toMatchObject({ pairing: "ok", server: "ok", daemon: "ok", service: "warn" });
    const token = inContainer(["cat", `${HOME_IN}/.ocw/device-token`]).stdout.trim();
    expect(token.length, "the device token is on disk").toBeGreaterThan(16);
    expect(doctor.stdout.includes(token), "the doctor's JSON carries no device token").toBe(false);
    expect(doctor.stdout.includes(HOME_IN), "the doctor's JSON carries no absolute home path").toBe(false);
    facts.push(
      `doctor --json: ${report.counts.ok} ok, ${report.counts.warn} warn, ${report.counts.fail} fail; ` +
        report.checks.map((c) => `${c.id}=${c.status}`).join(" "),
    );
    facts.push(`doctor service: ${report.checks.find((c) => c.id === "service")?.summary ?? "?"}`);

    const service = inContainer([RUNTIME, "service", "install"]);
    const serviceOut = `${service.stdout}${service.stderr}`;
    expect(service.status, `service install refuses (output: ${serviceOut})`).toBe(1);
    expect(serviceOut).toContain("under your own supervisor");
    facts.push(`service install: exit 1, ${serviceOut.trim().split("\n")[0]}`);
  } finally {
    await sam?.context.close();
    if (sessionId) await adminApi.post(`/api/v1/work-sessions/${sessionId}/archive`, { data: {} });
    // ---- d. the owner revokes the device
    if (deviceId) {
      const res = await adminApi.delete(`/api/v1/devices/${deviceId}`);
      expect(res.ok(), `revoke ${DEVICE}: ${res.status()}`).toBe(true);
      facts.push(`device revoked: HTTP ${res.status()}`);
    }
    if (FACTS) writeFileSync(FACTS, `${facts.join("\n")}\n`);
    await adminApi.dispose();
  }
});
