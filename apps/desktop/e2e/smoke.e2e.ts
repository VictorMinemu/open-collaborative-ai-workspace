import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { type ElectronApplication, _electron as electron, expect, type Page, test } from "@playwright/test";

const here = dirname(fileURLToPath(import.meta.url));
const appDir = join(here, "..");
const shots = join(
  appDir,
  "..",
  "..",
  ".planning",
  "phases",
  "01-mvp-0-multiplayer-ai-chat-slice",
  "screenshots",
);
const WEB = process.env.OCW_E2E_BASE_URL ?? "http://localhost:3000";
const ADMIN = {
  email: process.env.OCW_E2E_ADMIN_EMAIL ?? "admin@ocw.test",
  password: process.env.OCW_E2E_ADMIN_PASSWORD ?? "e2e-admin-password-123",
};
const TOKEN = "ocwdt_e2e_fake_token_0123456789";

async function webIsUp(): Promise<boolean> {
  try {
    const res = await fetch(WEB, { redirect: "manual", signal: AbortSignal.timeout(3000) });
    return res.status < 500;
  } catch {
    return false;
  }
}

/** Minimal stand-in for the B3 enrollment API: /health + POST /api/v1/devices/enroll. */
function fakeApi(): Promise<{ server: Server; url: string; enrolls: unknown[] }> {
  const enrolls: unknown[] = [];
  const server = createServer((req, res) => {
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      return res.end(JSON.stringify({ status: "ok" }));
    }
    if (req.method === "POST" && req.url === "/api/v1/devices/enroll") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        const parsed = JSON.parse(body) as { code: string };
        enrolls.push(parsed);
        if (parsed.code !== "DEMO-2026") {
          res.writeHead(404, { "content-type": "application/json" });
          return res.end(JSON.stringify({ error: "invalid code" }));
        }
        res.writeHead(201, { "content-type": "application/json" });
        res.end(
          JSON.stringify({
            deviceId: "0199a000-0000-7000-8000-000000000001",
            organizationId: "0199a000-0000-7000-8000-000000000002",
            deviceToken: TOKEN,
          }),
        );
      });
      return;
    }
    res.writeHead(404).end();
  });
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}`, enrolls });
    }),
  );
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

let app: ElectronApplication;
let api: Awaited<ReturnType<typeof fakeApi>>;
let userData: string;
let ocwHome: string;

test.beforeAll(async () => {
  mkdirSync(shots, { recursive: true });
  api = await fakeApi();
  userData = mkdtempSync(join(tmpdir(), "ocw-desktop-e2e-"));
  // Short path: Unix socket paths are limited to ~104 bytes on macOS.
  ocwHome = realpathSync(mkdtempSync("/tmp/ocwe-"));
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env))
    if (v !== undefined && !k.startsWith("ELECTRON_")) env[k] = v;
  app = await electron.launch({
    args: [appDir],
    cwd: appDir,
    env: { ...env, OCW_DESKTOP_USER_DATA: userData, OCW_HOME: ocwHome, OCW_WEB_URL: WEB },
  });
});

test.afterAll(async () => {
  await app?.close().catch(() => undefined);
  api?.server.close();
  rmSync(userData, { recursive: true, force: true });
  rmSync(ocwHome, { recursive: true, force: true });
});

async function onboardingPage(): Promise<Page> {
  const page = await app.firstWindow();
  await page.waitForSelector("#web-url");
  return page;
}

test("onboarding → pairing → main window, hardened and supervised", async () => {
  const page = await onboardingPage();
  await page.setViewportSize({ width: 560, height: 700 }).catch(() => undefined);

  // Sandboxed, isolated renderer: only the narrow bridge exists.
  const surface = await page.evaluate(() => ({
    bridge: typeof (window as unknown as { ocwOnboarding?: unknown }).ocwOnboarding,
    require: typeof (window as unknown as { require?: unknown }).require,
    process: typeof (window as unknown as { process?: unknown }).process,
  }));
  expect(surface).toEqual({ bridge: "object", require: "undefined", process: "undefined" });

  await expect(page.locator("#web-url")).toHaveValue(WEB);
  await page.waitForTimeout(400);
  await page.screenshot({ path: join(shots, "desktop-onboarding-server.png") });

  // Bad URL is refused with a clear message.
  await page.fill("#web-url", "ftp://example.com");
  await page.click("#server-submit");
  await expect(page.locator("#server-error")).toContainText("http");

  const webUp = await webIsUp();
  test.skip(!webUp, `web app not running at ${WEB}; onboarding render verified only`);

  // Real web app + fake enrollment API (the B3 endpoint may not exist in this worktree yet).
  await page.fill("#web-url", WEB);
  await page.click("summary");
  await page.fill("#api-url", api.url);
  await page.click("#server-submit");
  await expect(page.locator('[data-step="pair"]')).toBeVisible();
  await page.fill("#device-name", "Demo MacBook");
  await page.waitForTimeout(300);
  await page.screenshot({ path: join(shots, "desktop-onboarding-pair.png") });

  await page.fill("#code", "WRONG-1");
  await page.click("#pair-submit");
  await expect(page.locator("#pair-error")).toContainText("invalid or has expired");

  await page.fill("#code", "DEMO-2026");
  await page.click("#pair-submit");
  await expect(page.locator('[data-step="done"]')).toBeVisible();
  await expect(page.locator("#done-title")).toHaveText("Demo MacBook is paired");
  expect(api.enrolls.at(-1)).toEqual({ code: "DEMO-2026", name: "Demo MacBook", platform: process.platform });

  // The token is stored encrypted only, never in plaintext on disk.
  const cfg = readFileSync(join(userData, "desktop.json"), "utf8");
  expect(cfg).not.toContain(TOKEN);
  expect(JSON.parse(cfg).encryptedToken).toBeTruthy();
  expect(existsSync(join(ocwHome, "device-token"))).toBe(false);

  // Daemon supervised on the Unix socket; runtime detection arrives.
  await expect(page.locator('[data-check="runtime"] .state')).not.toHaveText("Starting…", {
    timeout: 30_000,
  });
  await expect(page.locator('[data-check="claude-code"] .state')).not.toHaveText("Checking…", {
    timeout: 30_000,
  });
  await page.waitForTimeout(500);
  await page.screenshot({ path: join(shots, "desktop-onboarding-done.png") });
  expect(existsSync(join(ocwHome, "runtime.sock"))).toBe(true);
  const pid = JSON.parse(readFileSync(join(ocwHome, "desktop-daemon.pid"), "utf8")).pid as number;
  expect(alive(pid)).toBe(true);
  // Token reached the daemon via env, not via a file, and the daemon reports itself paired.
  const status = JSON.parse(
    execFileSync(process.execPath, [join(appDir, "..", "local-runtime", "bin", "ocw-runtime"), "status"], {
      env: { ...process.env, OCW_HOME: ocwHome },
    }).toString(),
  ) as { paired: boolean; serverUrl: string };
  expect(status.paired).toBe(true);
  expect(status.serverUrl).toBe(api.url);

  // Open workspace → main window on the web app with the desktop bridge.
  const mainPromise = app.waitForEvent("window");
  await page.click("#open-workspace");
  const main = await mainPromise;
  await main.waitForLoadState("domcontentloaded");
  await expect(main).toHaveURL(new RegExp(`^${WEB}`));
  const bridge = await main.evaluate(async () => {
    const d = (window as unknown as { ocwDesktop: Record<string, unknown> }).ocwDesktop;
    const status = await (d.status as () => Promise<{ state: string; paired: boolean }>)();
    const projects = await (d.listProjects as () => Promise<unknown[]>)();
    return {
      isDesktop: d.isDesktop,
      keys: Object.keys(d).sort(),
      state: status.state,
      paired: status.paired,
      projects,
    };
  });
  expect(bridge.isDesktop).toBe(true);
  expect(bridge.keys).toEqual(["addProject", "isDesktop", "listProjects", "onStatus", "platform", "status"]);
  expect(bridge.paired).toBe(true);
  expect(["connecting", "online"]).toContain(bridge.state);
  expect(bridge.projects).toEqual([]);

  // Navigation is pinned to the web origin.
  await main.evaluate(() => {
    location.href = "file:///etc/hosts";
  });
  await main.waitForTimeout(500);
  expect(main.url().startsWith(WEB)).toBe(true);

  // Log in and capture the main window.
  if (/\/login/.test(main.url()) || (await main.getByTestId("login-form").count()) > 0) {
    await main.getByLabel("Email").fill(ADMIN.email);
    await main.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await main
      .getByTestId("login-form")
      .getByRole("button", { name: /sign in|log in/i })
      .click();
  }
  await expect(main.getByTestId("app-shell")).toBeVisible({ timeout: 20_000 });
  await main.waitForTimeout(1200);
  await main.screenshot({ path: join(shots, "desktop-main-window.png") });

  // Quit: the daemon's process group is terminated, nothing is orphaned.
  await app.close();
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  expect(existsSync(join(ocwHome, "desktop-daemon.pid"))).toBe(false);
});
