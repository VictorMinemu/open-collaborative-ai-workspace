// A local site for the Work Zone browser's tests (07.13-09): plain node:http on 127.0.0.1 and a random port, no
// network. It has what the agent's ops and refusals need: a page with a heading, a button, a list and links, a login
// form whose password field is `autocomplete=current-password`, a slow text, redirects and links to every scheme the
// browser refuses, a pop-up and a download. Test-only (imported by *.test.ts files, never by runtime code).

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface TestSite {
  /** `http://127.0.0.1:<port>` */
  origin: string;
  /** `127.0.0.1:<port>` as `URL.host` reports it. */
  host: string;
  url(path: string): string;
  close(): Promise<void>;
}

/** The schemes the browser refuses, with a target for each (links, redirects and `open`). */
export const REFUSED_SCHEME_URLS: Readonly<Record<string, string>> = {
  "file:": "file:///etc/passwd",
  "chrome:": "chrome://version/",
  "devtools:": "devtools://devtools/bundled/inspector.html",
  "view-source:": "view-source:http://127.0.0.1/",
  "data:": "data:text/html,<h1>fixture data page</h1>",
  "javascript:": "javascript:document.title='fixture javascript ran'",
};

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

function signedIn(req: IncomingMessage): boolean {
  return /(?:^|;\s*)fixture_session=signed-in(?:;|$)/.test(req.headers.cookie ?? "");
}

function handle(req: IncomingMessage, res: ServerResponse) {
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
    case "/login":
      if (req.method === "POST") {
        res.writeHead(302, {
          location: "/account",
          "set-cookie": "fixture_session=signed-in; Path=/; HttpOnly; SameSite=Lax",
          "cache-control": "no-store",
        });
        res.end();
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
          signedIn(req)
            ? "<h1>Signed in as fixture-user</h1>"
            : '<h1>Not signed in</h1><a href="/login">Sign in</a>',
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
  const server = createServer(handle);
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
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
