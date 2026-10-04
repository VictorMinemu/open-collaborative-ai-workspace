import { type ChildProcess, execFileSync, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
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

test.describe.configure({ mode: "serial" });

test("Work Zone: pair a device, run a session, approve, review changes", async ({ page }, info) => {
  test.setTimeout(180_000);
  const tag = info.project.name === "mobile" ? "390" : "1440";
  const mobile = info.project.name === "mobile";
  const home = mkdtempSync(join(tmpdir(), "ocw-e2e-home-"));
  const repoParent = mkdtempSync(join(tmpdir(), "ocw-e2e-repo-"));
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
      [RUNTIME_BIN, "enroll", "--server", API_URL, "--code", code, "--name", `E2E Mac ${tag}`],
      { env, stdio: "pipe" },
    );
    execFileSync(process.execPath, [RUNTIME_BIN, "add-project", repo], { env, stdio: "pipe" });
    daemon = spawn(process.execPath, [RUNTIME_BIN, "run"], { env, stdio: "ignore" });

    await expect(page.getByTestId("device-paired")).toBeVisible({ timeout: 30_000 });
    await expect(page.getByTestId("device-paired")).toContainText(`E2E Mac ${tag}`);
    await page.getByRole("button", { name: "Done" }).click();
    const card = page.getByTestId("device-card").filter({ hasText: `E2E Mac ${tag}` });
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
    daemon?.kill("SIGTERM");
    // Archive the e2e session so repeated runs do not clutter the demo workspace.
    const sid = /\/work-zone\/([0-9a-f-]{36})/.exec(page.url())?.[1];
    if (sid) {
      await page.request.post(`${API_URL}/api/v1/work-sessions/${sid}/archive`, {
        headers: { origin: new URL(page.url()).origin },
        data: {},
      });
    }
    // Leave the workspace tidy: revoke the e2e device (also proves revocation from the API).
    const devices = (await (await page.request.get(`${API_URL}/api/v1/devices`)).json()) as {
      devices: Array<{ id: string; name: string }>;
    };
    for (const d of devices.devices?.filter((x) => x.name === `E2E Mac ${tag}`) ?? []) {
      await page.request.delete(`${API_URL}/api/v1/devices/${d.id}`, {
        headers: { origin: new URL(page.url()).origin },
      });
    }
    rmSync(home, { recursive: true, force: true });
    rmSync(repoParent, { recursive: true, force: true });
  }
});
