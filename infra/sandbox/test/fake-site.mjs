// Fake sites for the brw smoke (07.8-07): one node:http server on :8080, routed by Host.
//   panel.fake.test  a JavaScript-rendered app that needs a session cookie (/app), a sign-in form (/login: username,
//                    password with a show-password toggle, one-time code), an IdP sign-in (/callback), a download
//                    (/files), and a site-lock page (/lock) whose controls all try to reach evil.fake.test
//   idp.fake.test    /authorize sets its own cookie and redirects back to panel's /callback
//   evil.fake.test   /collect counts hits (the site lock must keep it at 0), /landing is a plain page
//   any host         /__stats: counters only (never a submitted value)
// Submitted credentials are compared and dropped; nothing is logged. Positions of the sign-in fields are fixed, so the
// smoke can click them through takeover input frames and check the screenshot's masks.
import { randomBytes } from "node:crypto";
import http from "node:http";

const PORT = Number(process.env.PORT ?? 8080);
const PANEL = "panel.fake.test:8080";
const IDP = "idp.fake.test:8080";
const EVIL = "evil.fake.test:8080";
const USER = "ana@example.test";
const OTP = "735190";

const stats = { logins: 0, failedLogins: 0, collect: 0, idp: 0, downloads: 0 };
const sessions = new Set();

/** Fixed CSS boxes of the sign-in page (viewport 960×600), shared with the smoke. */
export const LOGIN_LAYOUT = {
  email: { x: 40, y: 120, width: 320, height: 36 },
  password: { x: 40, y: 180, width: 260, height: 36 },
  toggle: { x: 310, y: 180, width: 120, height: 36 },
  otp: { x: 40, y: 240, width: 160, height: 36 },
  submit: { x: 40, y: 300, width: 120, height: 40 },
};

const box = (b) =>
  `position:absolute;left:${b.x}px;top:${b.y}px;width:${b.width}px;height:${b.height}px;box-sizing:border-box`;
const page = (title, body, script = "") =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width">` +
  `<title>${title}</title><style>body{font:16px sans-serif;margin:0;padding:8px 40px;background:#fff;color:#111}` +
  `label{position:absolute;font-size:12px;color:#555}input{font:16px monospace;padding:4px 8px}</style></head>` +
  `<body>${body}${script ? `<script>${script}</script>` : ""}</body></html>`;

function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}
const signedIn = (req) => sessions.has(cookies(req).panel_session);

function newSession(res, extra = {}) {
  const sid = randomBytes(16).toString("hex");
  sessions.add(sid);
  res.writeHead(303, {
    "set-cookie": `panel_session=${sid}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    location: "/app",
    ...extra,
  });
  res.end();
}

const send = (res, status, type, body, headers = {}) => {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store", ...headers });
  res.end(body);
};
const html = (res, body, status = 200) => send(res, status, "text/html; charset=utf-8", body);

function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on("data", (c) => {
      size += c.length;
      if (size <= 65_536) chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
  });
}

// The app renders only from JavaScript: its HTML has no text, so a fetch-only client never sees "Sign in".
const APP_SCRIPT = `
const root = document.getElementById("root");
const layout = () => { document.getElementById("layout").textContent = "Layout: " + (innerWidth < 600 ? "phone" : "desktop"); };
fetch("/api/me").then((r) => r.json()).then((me) => {
  if (me.signedIn) {
    localStorage.setItem("panel_pref", "compact");
    root.innerHTML = '<h1>Welcome</h1><p>Your dashboard is ready.</p><a href="/files">Files</a>';
  } else {
    root.innerHTML = '<h1>Sign in</h1><p><a href="/login">Sign in with a password</a></p>' +
      '<p><a href="http://${IDP}/authorize?return=' + encodeURIComponent("http://${PANEL}/callback") + '">Sign in with IdP</a></p>';
  }
  layout();
});
addEventListener("resize", layout);
`;

const LOGIN_BODY = (error) =>
  `<h1 style="position:absolute;left:40px;top:20px;margin:0">Sign in to Panel</h1>` +
  (error ? `<p style="position:absolute;left:40px;top:64px;color:#b00">Try again</p>` : "") +
  `<form method="post" action="/login" autocomplete="on">` +
  `<label for="email" style="left:40px;top:102px">Email</label>` +
  `<input id="email" name="email" type="email" autocomplete="username" style="${box(LOGIN_LAYOUT.email)}">` +
  `<label for="password" style="left:40px;top:162px">Password</label>` +
  `<input id="password" name="password" type="password" autocomplete="current-password" style="${box(LOGIN_LAYOUT.password)}">` +
  `<button type="button" id="toggle" style="${box(LOGIN_LAYOUT.toggle)}">Show password</button>` +
  `<label for="otp" style="left:40px;top:222px">One-time code</label>` +
  `<input id="otp" name="otp" inputmode="numeric" autocomplete="one-time-code" style="${box(LOGIN_LAYOUT.otp)}">` +
  `<button type="submit" style="${box(LOGIN_LAYOUT.submit)}">Sign in</button></form>`;
const LOGIN_SCRIPT = `
document.getElementById("toggle").addEventListener("click", (e) => {
  const p = document.getElementById("password");
  p.type = p.type === "password" ? "text" : "password";
  e.currentTarget.textContent = p.type === "password" ? "Show password" : "Hide password";
});`;

const LOCK_BODY =
  `<h1>Lock test</h1>` +
  `<p><a id="export" href="http://${EVIL}/collect?via=link">Export</a></p>` +
  `<form method="post" action="http://${EVIL}/collect"><input type="hidden" name="via" value="form">` +
  `<button type="submit">Send</button></form>` +
  `<p><button type="button" onclick="location.href='http://${EVIL}/collect?via=script'">Redirect</button></p>` +
  `<p><button type="button" onclick="window.open('http://${EVIL}/collect?via=popup')">Pop-up</button></p>` +
  `<p><a href="/app">Home</a></p>`;

const REPORT = Buffer.from(
  Array.from({ length: 64 }, (_, i) => `row-${String(i).padStart(3, "0")},value-${(i * 7919) % 1000}\n`).join(
    "",
  ),
);

async function panel(req, res, url) {
  switch (`${req.method} ${url.pathname}`) {
    case "GET /app":
      return html(
        res,
        page(
          "Panel",
          `<main id="root"></main><p id="layout" style="font-size:12px;color:#555"></p>`,
          APP_SCRIPT,
        ),
      );
    case "GET /api/me":
      return send(res, 200, "application/json", JSON.stringify({ signedIn: signedIn(req) }));
    case "GET /login":
      return html(res, page("Sign in - Panel", LOGIN_BODY(url.searchParams.has("error")), LOGIN_SCRIPT));
    case "POST /login": {
      const form = new URLSearchParams(await readBody(req));
      const ok =
        form.get("email") === USER && (form.get("password") ?? "").length > 0 && form.get("otp") === OTP;
      if (!ok) {
        stats.failedLogins += 1;
        res.writeHead(303, { location: "/login?error=1" });
        return res.end();
      }
      stats.logins += 1;
      return newSession(res);
    }
    case "GET /callback":
      if (url.searchParams.get("code") !== "fake-code")
        return html(res, page("Error", "<h1>Bad code</h1>"), 400);
      return newSession(res);
    case "GET /files":
      return html(res, page("Files", `<h1>Files</h1><p><a href="/files/report.csv">Download report</a></p>`));
    case "GET /files/report.csv":
      stats.downloads += 1;
      return send(res, 200, "text/csv", REPORT, {
        "content-disposition": 'attachment; filename="report.csv"',
        "content-length": String(REPORT.length),
      });
    case "GET /lock":
      return html(res, page("Lock test", LOCK_BODY));
    default:
      return html(res, page("Not found", "<h1>Not found</h1>"), 404);
  }
}

function idp(_req, res, url) {
  if (url.pathname !== "/authorize") return html(res, page("Not found", "<h1>Not found</h1>"), 404);
  const back = url.searchParams.get("return") ?? "";
  if (!back.startsWith(`http://${PANEL}/`)) return html(res, page("Error", "<h1>Bad return</h1>"), 400);
  stats.idp += 1;
  res.writeHead(302, {
    "set-cookie": `idp_session=${randomBytes(12).toString("hex")}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`,
    location: `${back}?code=fake-code`,
  });
  return res.end();
}

function evil(_req, res, url) {
  if (url.pathname === "/collect") {
    stats.collect += 1;
    return html(res, page("Collected", "<h1>Collected</h1>"));
  }
  if (url.pathname === "/landing") return html(res, page("Evil landing", "<h1>Evil landing</h1>"));
  return html(res, page("Not found", "<h1>Not found</h1>"), 404);
}

export function createFakeSite() {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://placeholder");
    if (url.pathname === "/__stats") return send(res, 200, "application/json", JSON.stringify(stats));
    const host = (req.headers.host ?? "").toLowerCase();
    if (host === PANEL) return panel(req, res, url);
    if (host === IDP) return idp(req, res, url);
    if (host === EVIL) return evil(req, res, url);
    return html(res, page("Unknown", "<h1>Unknown host</h1>"), 404);
  });
}

if (import.meta.url === `file://${process.argv[1]}`) {
  createFakeSite().listen(PORT, "0.0.0.0");
}
