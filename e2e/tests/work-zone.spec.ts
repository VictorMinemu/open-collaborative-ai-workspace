import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type APIRequestContext, expect, type Locator, type Page, test } from "@playwright/test";
import { apiAs, ensureMember, openAs, SAM, userIdOf } from "../support/actors";
import { ADMIN, API_URL, shot } from "./env";

/**
 * Work Zone end to end with the REAL local-runtime daemon process (apps/local-runtime) in fake-runtime mode
 * (OCW_RUNTIME_FAKE=1, so CI needs no Claude/Codex login): pair from Settings › Devices with the CLI, register
 * a scratch repo, start a session from the web, queue a second prompt, approve, see tool cards and the diff.
 */

const RUNTIME_BIN = join(import.meta.dirname, "..", "..", "apps", "local-runtime", "bin", "ocw-runtime");

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

/** True when the toast showing `text` intersects `target` (or either box is missing). */
async function toastCovers(page: Page, text: string, target: Locator): Promise<boolean> {
  const box = (l: Locator) => l.boundingBox({ timeout: 1_000 }).catch(() => null);
  const t = await box(page.locator("[data-sonner-toast]").filter({ hasText: text }));
  const b = await box(target);
  if (!t || !b) return true;
  return t.x < b.x + b.width && b.x < t.x + t.width && t.y < b.y + b.height && b.y < t.y + t.height;
}

test.describe.configure({ mode: "serial" });

test("Work Zone: pair a device, run a session, approve, review changes", async ({ page, browser }, info) => {
  test.setTimeout(180_000);
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const mobile = info.project.name === "mobile";
  const home = mkdtempSync(join(tmpdir(), "ocw-e2e-home-"));
  const repoParent = mkdtempSync(join(tmpdir(), "ocw-e2e-repo-"));
  // A retry gets its own device name, so a device the failed attempt left behind never collides (strict mode).
  const deviceName = `E2E Mac ${tag}${info.retry ? ` retry ${info.retry}` : ""}`;
  const projectName = `acme-web-${tag}`;
  const repo = join(repoParent, projectName);
  mkdirSync(repo);
  writeFileSync(join(repo, "README.md"), "# Acme Web\n\nMarketing site and dashboard.\n");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
  git("init", "-q", "-b", "main");
  git("add", "-A");
  git("-c", "user.email=e2e@ocw.test", "-c", "user.name=E2E", "commit", "-qm", "init");

  const env = { ...process.env, OCW_HOME: home, OCW_RUNTIME_FAKE: "1", OCW_RUNTIME_FAKE_DELAY_MS: "120" };
  let daemon: ChildProcess | null = null;
  let adminApi: APIRequestContext | null = null;
  let samToRestore: string | null = null;
  // Cleanup never throws from `finally` (that would replace the body's error: a stuck click was once reported as a
  // hung cleanup request); its failures fail the test after a passing body.
  const cleanupErrors: unknown[] = [];
  const tidy = async (step: () => Promise<unknown>) => {
    try {
      await step();
    } catch (e) {
      cleanupErrors.push(e);
    }
  };

  try {
    await signIn(page);

    // ---- pair from Settings › Devices with the CLI
    await page.goto("/settings/devices");
    await page.getByTestId("add-device").click();
    const codeEl = page.getByTestId("pairing-code");
    await expect(codeEl).toHaveText(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    const code = (await codeEl.textContent())!.trim();
    await shot(page, `workzone-devices-pairing-${tag}`);

    execFileSync(
      process.execPath,
      [RUNTIME_BIN, "enroll", "--server", API_URL, "--code", code, "--name", deviceName],
      { env, stdio: "pipe" },
    );
    execFileSync(process.execPath, [RUNTIME_BIN, "add-project", repo], { env, stdio: "pipe" });
    daemon = spawn(process.execPath, [RUNTIME_BIN, "run"], { env, stdio: "ignore" });

    await expect(page.getByTestId("device-paired")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("device-paired")).toContainText(deviceName);
    await page.getByRole("button", { name: "Done" }).click();
    const card = page.getByTestId("device-card").filter({ hasText: deviceName });
    await expect(card).toHaveAttribute("data-status", "online");
    await expect(card).toContainText("Claude Code");
    await shot(page, `workzone-devices-${tag}`);

    // ---- new session
    await page.goto("/work-zone");
    await page.getByTestId("new-session").click();
    const dialog = page.getByTestId("new-session-dialog");
    await expect(dialog).toBeVisible();
    await dialog.getByTestId("project-option").filter({ hasText: projectName }).click();
    await dialog.getByTestId("runtime-claude-code").click();
    await dialog.getByTestId("first-prompt").fill("Add a short CONTRIBUTING guide for new teammates");
    await shot(page, `workzone-new-session-${tag}`);
    await dialog.getByTestId("start-session").click();
    await expect(page).toHaveURL(/\/work-zone\/[0-9a-f-]{36}$/);
    const sessionUrl = page.url();

    // ---- the agent reads, then asks before writing; meanwhile a second prompt joins the queue
    const banner = page.getByTestId("approval-banner");
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("notes/ocw-change-1.md");
    await expect(page.getByTestId("tool-card").first()).toContainText("README.md");
    await page.getByTestId("composer").fill("Then add a changelog entry for the guide");
    await page.getByTestId("send-prompt").click();
    await expect(page.getByText("Queued #1")).toBeVisible();
    // The toast never sits on the approval decisions: hovered by the pointer, a toast does not time out, so one
    // over "Allow for session" kept that button unclickable for good.
    await expect.poll(() => toastCovers(page, "Queued #1", banner), { timeout: 5_000 }).toBe(false);
    await shot(page, `workzone-session-approval-${tag}`);

    await banner.getByTestId("approve-once").click();
    await expect(page.getByTestId("approval-line").first()).toHaveAttribute("data-status", "approved");

    // Second prompt runs only after the first completes, then asks again: allow for the whole session.
    await expect(banner).toBeVisible({ timeout: 30_000 });
    await expect(banner).toContainText("notes/ocw-change-2.md");
    await banner.getByTestId("allow-session").click();
    await expect(page.getByTestId("session-view")).toHaveAttribute("data-status", "idle", {
      timeout: 30_000,
    });
    await expect(page.getByTestId("prompt-bubble")).toHaveCount(2);
    await expect(page.getByTestId("assistant-message").last()).toContainText("Done");
    await shot(page, `workzone-session-${tag}`);

    // ---- who is watching (RT-04, 03-03): Sam opens the session; each sees the other in the header
    adminApi = await apiAs(ADMIN);
    const samId = await ensureMember(adminApi, SAM, "developer");
    samToRestore = samId;
    const adminId = await userIdOf(adminApi);
    const viewers = (p: Page) => p.getByTestId("session-header").getByTestId("session-viewers");
    const samOnAdmin = viewers(page).locator(`[data-testid="presence-avatar"][data-user-id="${samId}"]`);
    const sam = await openAs(browser, SAM, info.project.name);
    try {
      await sam.page.goto(sessionUrl);
      await expect(sam.page.getByTestId("session-view")).toBeVisible();
      await expect(samOnAdmin).toHaveAttribute("data-state", "online", { timeout: 3000 });
      await expect(
        viewers(sam.page).locator(`[data-testid="presence-avatar"][data-user-id="${adminId}"]`),
      ).toHaveAttribute("data-state", "online", { timeout: 3000 });
      // Never yourself; Sam is not listed as "not here" while watching.
      await expect(
        viewers(page).locator(`[data-testid="presence-avatar"][data-user-id="${adminId}"]`),
      ).toHaveCount(0);
      await expect(viewers(page).getByTestId("session-participant-absent")).toHaveCount(0);
      await expect(viewers(page).getByTestId("presence-stack")).toHaveAttribute(
        "aria-label",
        "1 watching now",
      );
      // At 390 the stack must not push the header actions off-screen.
      const box = await page.getByRole("button", { name: "Session actions" }).boundingBox();
      expect(box && box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width);
      await shot(page, `workzone-presence-${tag}`);
      await page.emulateMedia({ colorScheme: "dark" });
      await shot(page, `workzone-presence-${tag}-dark`);
      await page.emulateMedia({ colorScheme: "light" });

      // ---- losing access while watching (RT-01, 03-06): the admin makes Sam a standard member, which has no
      // work_session.read; Sam's open session says so within 3 s and its stream has stopped.
      const demote = await adminApi.patch(`/api/v1/members/${samId}/role`, { data: { role: "standard" } });
      expect(demote.ok(), "demote Sam to standard").toBe(true);
      const lost = sam.page.getByTestId("session-access-lost");
      await expect(lost).toBeVisible({ timeout: 3000 });
      await expect(lost).toContainText("You no longer have access to this session");
      await expect(lost.getByRole("link", { name: "Back to Work Zone" })).toBeVisible();
      await expect(sam.page.getByTestId("session-view")).toHaveCount(0);
      // The lost session also leaves Sam's session list (desktop shows the Work Zone sidebar).
      const sessionPath = new URL(sessionUrl).pathname;
      if (!mobile) await expect(sam.page.locator(`a[href="${sessionPath}"]`)).toHaveCount(0);
      await shot(sam.page, `access-lost-session-${tag}`);
      await sam.page.emulateMedia({ colorScheme: "dark" });
      await shot(sam.page, `access-lost-session-${tag}-dark`);
    } finally {
      await sam.context.close();
    }
    // Sam closed the session: gone from the admin's header within 3 s.
    await expect(samOnAdmin).toHaveCount(0, { timeout: 3000 });
    await expect(viewers(page).getByTestId("presence-stack")).toHaveCount(0);

    // ---- changes from the device
    if (mobile) await page.getByTestId("open-changes").click();
    else await page.getByTestId("tab-changes").click();
    await expect(page.getByTestId("changed-file")).toHaveCount(2, { timeout: 20_000 });
    await expect(page.getByTestId("file-diff").first()).toContainText("CONTRIBUTING");
    await shot(page, `workzone-changes-${tag}`);

    // ---- session list
    if (mobile) {
      await page.goto(sessionUrl);
      await page.getByTestId("mobile-nav-trigger").click();
      await expect(page.getByTestId("session-row").first()).toBeVisible();
      await shot(page, `workzone-session-list-${tag}`);
    } else {
      await page.emulateMedia({ colorScheme: "dark" });
      await page.goto(sessionUrl);
      await expect(page.getByTestId("assistant-message").last()).toContainText("Done");
      await shot(page, `workzone-session-dark-${tag}`);
      await page.emulateMedia({ colorScheme: "light" });
    }
  } finally {
    // Every cleanup request has its own short timeout: a cleanup step can never eat the test's budget.
    const CLEANUP_TIMEOUT = 10_000;
    const origin = new URL(page.url()).origin;
    // Sam stays a developer for the next specs and runs, whatever happened above.
    if (adminApi) {
      const api = adminApi;
      if (samToRestore) {
        const sam = samToRestore;
        await tidy(async () => {
          const res = await api.patch(`/api/v1/members/${sam}/role`, {
            data: { role: "developer" },
            timeout: CLEANUP_TIMEOUT,
          });
          expect(res.ok(), "restore Sam to developer").toBe(true);
        });
      }
      await tidy(() => api.dispose());
    }
    daemon?.kill("SIGTERM");
    // Archive the e2e session so repeated runs do not clutter the demo workspace.
    const sid = /\/work-zone\/([0-9a-f-]{36})/.exec(page.url())?.[1];
    if (sid) {
      await tidy(() =>
        page.request.post(`${API_URL}/api/v1/work-sessions/${sid}/archive`, {
          headers: { origin },
          data: {},
          timeout: CLEANUP_TIMEOUT,
        }),
      );
    }
    // Leave the workspace tidy: revoke the e2e device (also proves revocation from the API).
    await tidy(async () => {
      const res = await page.request.get(`${API_URL}/api/v1/devices`, { timeout: CLEANUP_TIMEOUT });
      const { devices } = (await res.json()) as { devices?: Array<{ id: string; name: string }> };
      for (const d of devices?.filter((x) => x.name === deviceName) ?? []) {
        const del = await page.request.delete(`${API_URL}/api/v1/devices/${d.id}`, {
          headers: { origin },
          timeout: CLEANUP_TIMEOUT,
        });
        expect(del.ok(), `revoke ${deviceName}`).toBe(true);
      }
    });
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
  // Reached only when the body passed.
  if (cleanupErrors.length > 0) throw cleanupErrors[0];
});
