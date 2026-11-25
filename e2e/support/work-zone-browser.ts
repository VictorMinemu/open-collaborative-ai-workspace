import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, symlinkSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { type APIRequestContext, expect, type Page, type WebSocket as PwWebSocket } from "@playwright/test";

/**
 * The Work Zone browser's e2e support (07.13-22; D-31, PD-18, PD-19): a local site with a login form for the device's
 * real headless shell to open, the env that turns the browser on for a spec's daemon (`startFakeDevice({ browser: true
 * })`), the one-time pre-seed of the pinned browser into a cache (`ocw-runtime browser install`, verified against the
 * pinned sha256, never a hash skip), a tap on the Work Zone live-view socket and the member's own sign-ins.
 *
 * Every daemon gets a browsers root of its own (`<OCW_HOME>/browsers`) whose pinned build is a link into the shared
 * cache: a daemon sweeps the run dirs of `<root>/run` it does not own at start, so two daemons (two specs, or the two
 * CI viewports on Woodpecker's shared cache) never share a root.
 */

const RUNTIME_BIN = join(import.meta.dirname, "..", "..", "apps", "local-runtime", "bin", "ocw-runtime");

/** The Work Zone live view's socket; every other socket is the realtime gateway's or the bots' live view's. */
export const WORK_LIVE_SOCKET = /\/api\/v1\/live\/work-browser\//;

/** Where the fixed login form's fields sit (page CSS pixels of the 960×600 viewport): taps and clicks aim here. */
export const LOGIN_LAYOUT = {
  username: { x: 170, y: 115 },
  password: { x: 170, y: 175 },
} as const;

/** The fixture account a member types on the device's page (never a real account). */
export const FIXTURE_LOGIN = { username: "fixture-user", password: "fixture-Pa55-wz-e2e" } as const;

export interface LoginSite {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** `127.0.0.1:<port>` (`URL.host`, how the agent names the site). */
  host: string;
  url(path: string): string;
  /** The `session` cookie `POST /login` sets; `/account` is signed in for exactly this value. */
  sessionCookie: string;
  /** The fields of the last `POST /login` as the site received them (what the member typed on the device's page). */
  lastLogin(): Readonly<Record<string, string>> | null;
  /** How many times `/account` was served signed in. */
  signedInViews(): number;
  close(): Promise<void>;
}

const page = (title: string, body: string): string =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${title}</title></head><body style="margin:0;font:16px system-ui">${body}</body></html>`;

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(html);
}

/**
 * Starts the fixture site on 127.0.0.1 and a random port: `/` ("Fixture app"), `/login` (a form at `LOGIN_LAYOUT`;
 * its POST sets the `session` cookie and redirects to `/account`) and `/account` ("Signed in as fixture-user" with the
 * cookie, otherwise a 302 to `/login`). Loopback only, no network.
 */
export async function startLoginSite(): Promise<LoginSite> {
  // Built from parts at run time (a per-run value a test can look for, never a literal of the app's).
  const sessionCookie = ["wz", "e2e", "session", randomUUID()].join("-");
  let lastLogin: Record<string, string> | null = null;
  let signedInViews = 0;
  const signedIn = (req: IncomingMessage) =>
    (req.headers.cookie ?? "").split(/;\s*/).includes(`session=${sessionCookie}`);
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    switch (url.pathname) {
      case "/":
        return send(
          res,
          200,
          page("Fixture app", '<h1 style="margin:20px">Fixture app</h1><p style="margin:20px">Welcome.</p>'),
        );
      case "/login":
        if (req.method === "POST") {
          let body = "";
          req.setEncoding("utf8");
          req.on("data", (chunk: string) => {
            if (body.length < 16 * 1024) body += chunk;
          });
          req.on("end", () => {
            lastLogin = Object.fromEntries(new URLSearchParams(body));
            res.writeHead(302, {
              location: "/account",
              "set-cookie": `session=${sessionCookie}; Path=/; HttpOnly; SameSite=Lax`,
              "cache-control": "no-store",
            });
            res.end();
          });
          return;
        }
        return send(
          res,
          200,
          page(
            "Sign in",
            `<form method="post" action="/login" style="margin:0">
  <h1 style="position:absolute;left:20px;top:20px;margin:0;font-size:24px">Sign in to Fixture app</h1>
  <input id="username" name="username" autocomplete="username" aria-label="Username" autofocus
    style="position:absolute;left:20px;top:100px;width:300px;height:30px">
  <input id="password" name="password" type="password" autocomplete="current-password" aria-label="Password"
    style="position:absolute;left:20px;top:160px;width:300px;height:30px">
  <button type="submit" style="position:absolute;left:20px;top:220px">Sign in</button>
</form>`,
          ),
        );
      case "/account":
        if (!signedIn(req)) {
          res.writeHead(302, { location: "/login", "cache-control": "no-store" });
          res.end();
          return;
        }
        signedInViews++;
        return send(res, 200, page("Account", '<h1 style="margin:20px">Signed in as fixture-user</h1>'));
      default:
        return send(res, 404, page("Not found", "<h1>Not found</h1>"));
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const { port } = server.address() as AddressInfo;
  const origin = `http://127.0.0.1:${port}`;
  return {
    origin,
    host: `127.0.0.1:${port}`,
    url: (path) => `${origin}${path}`,
    sessionCookie,
    lastLogin: () => lastLogin,
    signedInViews: () => signedInViews,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

// ---------------------------------------------------------------- the device's browser (PD-18, PD-19)

/** The shared cache of the pinned browser: `OCW_E2E_BROWSERS_DIR` (absolute), else `~/.cache/ocw-e2e-browsers`. */
export function browsersCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.OCW_E2E_BROWSERS_DIR?.trim();
  if (dir && isAbsolute(dir)) return dir;
  return join(homedir(), ".cache", "ocw-e2e-browsers");
}

/** This process runs in a container (`/.dockerenv` or `/run/.containerenv`, as the daemon reads it). */
const inContainer = () => existsSync("/.dockerenv") || existsSync("/run/.containerenv");

/**
 * The daemon env that turns the Work Zone browser on (the device owner's opt-in, `OCW_ALLOW_BROWSER`), with `root` as
 * its browsers root (default: the shared cache) and Chromium's sandbox in `container` mode only when this run is inside
 * a container (PD-18: never an automatic fallback outside one).
 */
export function browserEnv(root: string = browsersCacheDir()): Record<string, string> {
  return {
    OCW_ALLOW_BROWSER: "1",
    OCW_BROWSERS_DIR: root,
    ...(inContainer() ? { OCW_BROWSER_SANDBOX: "container" } : {}),
  };
}

/**
 * A browsers root of a daemon's own under `home`, whose installed builds are links into the shared cache (the build is
 * verified by the daemon itself, as any install: the marker names the pinned version, platform and zip hash).
 */
export function deviceBrowsersRoot(home: string, cache: string = browsersCacheDir()): string {
  const root = join(home, "browsers");
  mkdirSync(root, { recursive: true });
  if (existsSync(cache)) {
    for (const name of readdirSync(cache)) {
      // Builds only: never the cache's lock, its staging dirs or a run dir.
      if (name.startsWith(".") || name === "run") continue;
      symlinkSync(join(cache, name), join(root, name), "dir");
    }
  }
  return root;
}

let preseeded: Promise<void> | null = null;

/**
 * Installs the pinned browser into the shared cache once per worker (`ocw-runtime browser install`: download, sha256
 * against the pins while it streams, extract, rename). A cache that already holds the build answers at once.
 */
export function preseedBrowser(): Promise<void> {
  preseeded ??= new Promise<void>((resolve, reject) => {
    const cache = browsersCacheDir();
    mkdirSync(cache, { recursive: true });
    execFile(
      process.execPath,
      [RUNTIME_BIN, "browser", "install"],
      { env: { ...process.env, OCW_BROWSERS_DIR: cache }, timeout: 10 * 60_000 },
      (err, _stdout, stderr) => {
        if (err) reject(new Error(`ocw-runtime browser install: ${err.message} ${stderr}`.trim()));
        else resolve();
      },
    );
  });
  return preseeded;
}

// ---------------------------------------------------------------- the live view and the member's sign-ins

export interface WorkLiveTap {
  /** Binary (JPEG) frames received on the Work Zone live-view socket(s). */
  binary(): number;
  /** Text frames the page sent on that socket, parsed. */
  sent(): Array<Record<string, unknown>>;
}

/** Records the page's Work Zone live-view traffic from now on (counts and the page's own frames, never a frame's bytes). */
export function tapWorkLive(p: Page): WorkLiveTap {
  let binary = 0;
  const sent: Array<Record<string, unknown>> = [];
  p.on("websocket", (ws: PwWebSocket) => {
    if (!WORK_LIVE_SOCKET.test(ws.url())) return;
    ws.on("framereceived", (f) => {
      if (typeof f.payload !== "string") binary++;
    });
    ws.on("framesent", (f) => {
      if (typeof f.payload !== "string") return;
      try {
        sent.push(JSON.parse(f.payload) as Record<string, unknown>);
      } catch {
        // Not JSON: never expected on the live view.
      }
    });
  });
  return { binary: () => binary, sent: () => sent };
}

export interface WorkSignInJson {
  id: string;
  site: string;
  status: string;
}

/** The member's own Work Zone sign-ins (Settings › Keychain › Work Zone reads the same list). */
export async function workSignInsOf(api: APIRequestContext): Promise<WorkSignInJson[]> {
  const res = await api.get("/api/v1/work-browser/signins");
  expect(res.ok(), `GET /work-browser/signins: ${res.status()}`).toBe(true);
  return ((await res.json()) as { items: WorkSignInJson[] }).items;
}

/** Revokes every Work Zone sign-in of `api`'s member, so a journey (and its retry) starts from its own state. */
export async function clearWorkSignIns(api: APIRequestContext): Promise<void> {
  for (const s of await workSignInsOf(api)) {
    const res = await api.delete(`/api/v1/work-browser/signins/${s.id}`);
    expect([204, 404], `revoke ${s.site}`).toContain(res.status());
  }
}

/** The organization's "Allow the browser in Work Zone sessions" through the API (cleanup; the journey uses the UI). */
export async function setBrowserPolicy(admin: APIRequestContext, allowBrowser: boolean): Promise<void> {
  const res = await admin.put("/api/v1/work-zone-policy", { data: { allowBrowser } });
  expect(res.ok(), `PUT /work-zone-policy allowBrowser=${allowBrowser}: ${res.status()}`).toBe(true);
}
