import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir, tmpdir } from "node:os";
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
    if (req.method === "GET" && req.url === "/") {
      // Stand-in web app, used only when the real one is not running.
      res.writeHead(200, { "content-type": "text/html" });
      return res.end("<!doctype html><title>OCW (fake)</title><h1>fake web</h1>");
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

  // Real web app if it is up (else the fake one) + fake enrollment API (B3's endpoint is not in
  // this worktree yet).
  const webUp = await webIsUp();
  const web = webUp ? WEB : api.url;
  await page.fill("#web-url", web);
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
  await expect(main).toHaveURL(new RegExp(`^${web}`));
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
  expect(bridge.keys).toEqual([
    "addProject",
    "chatgptLoopbackAwait",
    "chatgptLoopbackCancel",
    "chatgptLoopbackPrepare",
    "isDesktop",
    "listProjects",
    "onStatus",
    "platform",
    "setBadgeCount",
    "status",
  ]);

  // CHAT-10: the web app sets the dock/taskbar badge through the one validated channel.
  const setBadge = (n: unknown) =>
    main.evaluate(
      (v) =>
        (window as unknown as { ocwDesktop: { setBadgeCount: (n: unknown) => Promise<void> } }).ocwDesktop
          .setBadgeCount(v)
          .then(() => "ok")
          .catch((e: Error) => e.message),
      n,
    );
  expect(await setBadge(3)).toBe("ok");
  if (process.platform === "darwin") expect(await app.evaluate(({ app: a }) => a.getBadgeCount())).toBe(3);
  // Out of range reaches the main process and is refused there (the payload is never echoed).
  expect(await setBadge(100000)).toMatch(/invalid arguments/);
  expect(await setBadge(0)).toBe("ok");
  if (process.platform === "darwin") expect(await app.evaluate(({ app: a }) => a.getBadgeCount())).toBe(0);
  expect(bridge.paired).toBe(true);
  expect(["connecting", "online"]).toContain(bridge.state);
  expect(bridge.projects).toEqual([]);

  // Add project: stub only the native folder picker (main process), then go through the real
  // validation + daemon registration. Web content never sees the absolute path.
  // (Not under OCW_HOME or the app profile: both are refused as projects.)
  const repo = join(realpathSync(mkdtempSync(join(tmpdir(), "ocw-repo-"))), "demo-repo");
  mkdirSync(repo);
  execFileSync("git", ["init", "-q", repo]);
  const pick = async (path: string) =>
    app.evaluate(({ dialog }, p) => {
      dialog.showOpenDialog = (async () => ({
        canceled: false,
        filePaths: [p],
      })) as typeof dialog.showOpenDialog;
    }, path);
  const addProject = () =>
    main.evaluate(() =>
      (window as unknown as { ocwDesktop: { addProject: () => Promise<unknown> } }).ocwDesktop.addProject(),
    );
  await pick(homedir());
  expect(await addProject()).toMatchObject({
    ok: false,
    canceled: false,
    error: expect.stringMatching(/home folder/),
  });
  await pick(repo);
  const added = (await addProject()) as { ok: boolean; project: Record<string, unknown> };
  expect(added).toMatchObject({ ok: true });
  expect(added.project.name).toBe("demo-repo");
  expect(JSON.stringify(added)).not.toContain(repo);
  expect(added).not.toHaveProperty("notice");
  // A folder without git is a project too: registered as it is, with a short note (folder name only).
  const plain = join(dirname(repo), "plain-notes");
  mkdirSync(plain);
  await pick(plain);
  const addedPlain = (await addProject()) as {
    ok: boolean;
    notice?: string;
    project: Record<string, unknown>;
  };
  expect(addedPlain).toMatchObject({
    ok: true,
    project: { name: "plain-notes", defaultBranch: null },
    notice: "plain-notes has no git repository: sessions work; changes and worktrees are off.",
  });
  expect(JSON.stringify(addedPlain)).not.toContain(plain);
  expect(existsSync(join(plain, ".git"))).toBe(false);
  const listed = await main.evaluate(() =>
    (
      window as unknown as { ocwDesktop: { listProjects: () => Promise<unknown[]> } }
    ).ocwDesktop.listProjects(),
  );
  expect(listed).toHaveLength(2);
  expect(JSON.stringify(listed)).not.toContain(repo);

  // Navigation is pinned to the web origin.
  await main.evaluate(() => {
    location.href = "file:///etc/hosts";
  });
  await main.waitForTimeout(500);
  expect(main.url().startsWith(web)).toBe(true);

  // Log in and capture the main window (real web app only).
  if (!webUp) test.info().annotations.push({ type: "note", description: `web not running at ${WEB}` });
  if ((webUp && /\/login/.test(main.url())) || (await main.getByTestId("login-form").count()) > 0) {
    await main.getByLabel("Email").fill(ADMIN.email);
    await main.getByLabel("Password", { exact: true }).fill(ADMIN.password);
    await main
      .getByTestId("login-form")
      .getByRole("button", { name: /sign in|log in/i })
      .click();
  }
  if (webUp) {
    await expect(main.getByTestId("app-shell")).toBeVisible({ timeout: 20_000 });
    await main.waitForTimeout(1200);
    await main.screenshot({ path: join(shots, "desktop-main-window.png") });
  }

  // Quit: the daemon's process group is terminated, nothing is orphaned.
  await app.close();
  await expect.poll(() => alive(pid), { timeout: 10_000 }).toBe(false);
  expect(existsSync(join(ocwHome, "desktop-daemon.pid"))).toBe(false);
});
