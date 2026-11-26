// A local site for the Work Zone browser's tests (07.13-09): plain node:http on 127.0.0.1 and a random port, no
// network. It has what the agent's ops and refusals need: a page with a heading, a button, a list and links, a login
// form whose password field is `autocomplete=current-password`, a slow text, redirects and links to every scheme the
// browser refuses, a pop-up and a download. Test-only (imported by *.test.ts files, never by runtime code).

import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSite {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** `127.0.0.1:<port>` as `URL.host` reports it. */
  host: string;
  url(path: string): string;
  /**
   * 07.13-15: the fields of the last `POST /login`, as the site received them. Takeover tests read what a person typed
   * here (through the site, never through the agent).
   */
  lastLogin(): Readonly<Record<string, string>> | null;
  /**
   * 07.13-19: the value of the `fixture_session` cookie `POST /login` sets (a per-site canary, so a test can look for it
   * on disk and in logs). `/account` reads as signed in for exactly this value.
   */
  sessionCookie: string;
  close(): Promise<void>;
}

/** Where the `/takeover` page puts its fields (CSS pixels of the 960×600 viewport): a person's clicks aim here. */
export const TAKEOVER_LAYOUT = {
  username: { x: 170, y: 115 },
  password: { x: 170, y: 175 },
} as const;

/** The password a test types; it must never appear in a snapshot or a frame the agent returns. */
export const PASSWORD_CANARY = "fixture-canary-Pa55w0rd-7f3a";

/** The body of the `/download` attachment (a test looks for it on disk). */
export const DOWNLOAD_MARKER = "ocw-fixture-download-body-5c1e";

const page = (title: string, body: string): string =>
  `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title></head><body>${body}</body></html>`;

const escapeAttr = (v: string): string =>
  v.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

function send(res: ServerResponse, status: number, html: string, headers: Record<string, string> = {}): void {
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    ...headers,
  });
  res.end(html);
}

function signedIn(state: SiteState, req: IncomingMessage): boolean {
  return (req.headers.cookie ?? "").split(/;\s*/).includes(`fixture_session=${state.sessionCookie}`);
}

interface SiteState {
  lastLogin: Record<string, string> | null;
  sessionCookie: string;
}

/** The value of the cookie `/other-site` sets for whatever host it is served on (07.13-19: never exported for another). */
export const OTHER_SITE_COOKIE = "fixture-other-site-cookie-91d2";

function handle(state: SiteState, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  switch (url.pathname) {
    case "/":
      return send(
        res,
        200,
        page(
          "Fixture app",
          `<h1>Fixture heading</h1>
<p>Welcome to the fixture app.</p>
<button type="button" onclick="document.getElementById('status').textContent='Saved it'">Save</button>
<p id="status">Not saved</p>
<label for="color">Color</label>
<select id="color" onchange="document.getElementById('picked').textContent='Picked ' + this.value">
  <option value="red">Red</option><option value="green">Green</option>
</select>
<p id="picked">Picked none</p>
<label for="search">Search</label>
<input id="search" type="text" onkeydown="if (event.key === 'Enter') document.getElementById('entered').textContent='Entered ' + this.value">
<p id="entered">Entered none</p>
<div style="height: 2000px">Tall block</div>
<a href="/next">Next page</a>`,
        ),
      );
    case "/next":
      return send(res, 200, page("Next page", "<h1>The next page</h1>"));
    case "/animate":
      // 07.13-15: a page that repaints on every animation frame, so the screencast always has a new frame.
      return send(
        res,
        200,
        page(
          "Animated page",
          `<h1>Animated page</h1><div id="box" style="width:200px;height:200px"></div>
<script>let n = 0; const box = document.getElementById("box");
(function tick() { n += 1; box.style.background = "hsl(" + (n % 360) + ", 80%, 50%)"; box.textContent = String(n);
requestAnimationFrame(tick); })();</script>`,
        ),
      );
    case "/takeover":
      // 07.13-15: the login form at fixed positions (`TAKEOVER_LAYOUT`), so a person's mouse input can aim at a field.
      return send(
        res,
        200,
        page(
          "Takeover sign in",
          `<form method="post" action="/login" style="margin:0">
  <input id="username" name="username" autocomplete="username" aria-label="Username"
    style="position:absolute;left:20px;top:100px;width:300px;height:30px">
  <input id="password" name="password" type="password" autocomplete="current-password" aria-label="Password"
    style="position:absolute;left:20px;top:160px;width:300px;height:30px">
  <button type="submit" style="position:absolute;left:20px;top:220px">Sign in</button>
</form>`,
        ),
      );
    case "/login":
      if (req.method === "POST") {
        let body = "";
        req.setEncoding("utf8");
        req.on("data", (chunk: string) => {
          if (body.length < 64 * 1024) body += chunk;
        });
        req.on("end", () => {
          state.lastLogin = Object.fromEntries(new URLSearchParams(body));
          res.writeHead(302, {
            location: "/account",
            "set-cookie": `fixture_session=${state.sessionCookie}; Path=/; HttpOnly; SameSite=Lax`,
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
          `<h1>Sign in</h1>
<form method="post" action="/login">
  <label for="username">Username</label><input id="username" name="username" autocomplete="username">
  <label for="password">Password</label><input id="password" name="password" type="password" autocomplete="current-password">
  <button type="submit">Sign in</button>
</form>`,
        ),
      );
    case "/account":
      return send(
        res,
        200,
        page(
          "Account",
          signedIn(state, req)
            ? `<h1>Signed in as fixture-user</h1><a href="${escapeAttr(url.searchParams.get("away") ?? "/")}">Away link</a>`
            : '<h1>Not signed in</h1><a href="/login">Sign in</a>',
        ),
      );
    case "/other-site":
      // 07.13-19: opened on another host name of this server (`localhost:<port>`): a cookie and origin storage that
      // belong to that host only, so a sign-in exported for `127.0.0.1:<port>` must leave both out.
      return send(
        res,
        200,
        page(
          "Other site",
          `<h1>Other site</h1><script>localStorage.setItem("other_site", "${OTHER_SITE_COOKIE}");</script>`,
        ),
        { "set-cookie": `other_site=${OTHER_SITE_COOKIE}; Path=/; SameSite=Lax` },
      );
    case "/big-storage":
      // 07.13-19: origin storage over the 2 MiB sign-in cap (`storageStateMaxBytes`).
      return send(
        res,
        200,
        page(
          "Big storage",
          `<h1>Big storage</h1><script>localStorage.setItem("big", "x".repeat(2200 * 1024));</script>`,
        ),
      );
    case "/slow":
      return send(
        res,
        200,
        page(
          "Slow page",
          `<h1>Slow page</h1><p id="late"></p>
<script>setTimeout(() => { document.getElementById("late").textContent = "Late text arrived"; }, 500);</script>`,
        ),
      );
    case "/redirect-file":
      res.writeHead(302, { location: "file:///etc/passwd" });
      res.end();
      return;
    case "/redirect": {
      // `?to=<url>`: a 302 to any target (a refused scheme, a metadata host).
      res.writeHead(302, { location: url.searchParams.get("to") ?? "/" });
      res.end();
      return;
    }
    case "/link-file": {
      // `?to=<url>`: one link to the target (a refused scheme), clicked by a test.
      const to = url.searchParams.get("to") ?? "file:///etc/passwd";
      return send(
        res,
        200,
        page("Link page", `<h1>Link page</h1><a href="${escapeAttr(to)}">Refused link</a>`),
      );
    }
    case "/popup":
      return send(
        res,
        200,
        page(
          "Popup page",
          `<h1>Popup page</h1><button type="button" onclick="window.open('/next', '_blank')">Open popup</button>`,
        ),
      );
    case "/download-page":
      return send(
        res,
        200,
        page("Download page", '<h1>Download page</h1><a href="/download">Get the file</a>'),
      );
    case "/download":
      res.writeHead(200, {
        "content-type": "application/octet-stream",
        "content-disposition": 'attachment; filename="fixture.bin"',
      });
      res.end(DOWNLOAD_MARKER);
      return;
    default:
      return send(res, 404, page("Not found", "<h1>Not found</h1>"));
  }
}

/** Starts the site on 127.0.0.1 and a random port. */
export async function startTestSite(): Promise<TestSite> {
  const state: SiteState = { lastLogin: null, sessionCookie: `signed-in-${randomUUID()}` };
  const server = createServer((req, res) => handle(state, req, res));
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
    lastLogin: () => state.lastLogin,
    sessionCookie: state.sessionCookie,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
