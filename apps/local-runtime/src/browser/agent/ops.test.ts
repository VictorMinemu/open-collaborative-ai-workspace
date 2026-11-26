// The device's browser agent against a real Chromium (07.13-09, D-01, D-04, D-07, D-12, D-35, PD-18, PD-24, A-8): the
// pinned headless shell from the test cache (never Playwright's shared cache, never a download outside CI) and a local
// site on 127.0.0.1. The agent reads a page only through the bots' redaction, and only http(s) pages are ever shown.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BROWSER_HINT, testBrowser, testSandbox } from "../test-browser.js";
import { PASSWORD_CANARY, startTestSite, TAKEOVER_LAYOUT, type TestSite } from "../test-site.js";
import {
  AgentError,
  type AgentEvent,
  type BrowserAgent,
  createBrowserAgent,
  launchFailureOf,
  launchOptionsFor,
  metadataResolverRules,
  siteState,
  stateFingerprint,
  urlRefusal,
} from "./ops.js";
import { resolveChromiumSandbox } from "./sandbox.js";

const executable = await testBrowser();
if (!executable) console.warn(TEST_BROWSER_HINT);

/** One target per scheme the browser refuses (A-8): through `open`, a link click and a 302 of the fixture site. */
const REFUSED_SCHEMES: ReadonlyArray<readonly [string, string]> = [
  ["file:", "file:///etc/passwd"],
  ["chrome:", "chrome://version/"],
  ["devtools:", "devtools://devtools/bundled/inspector.html"],
  ["view-source:", "view-source:http://127.0.0.1/"],
  ["data:", "data:text/html,<h1>fixture data page</h1>"],
  ["javascript:", "javascript:document.title='fixture javascript ran'"],
];

/** The ref of the first node with this role and name in a snapshot text. */
function refOf(text: string, role: string, name: string): string {
  const line = text.split("\n").find((l) => l.includes(`] ${role} ${JSON.stringify(name)}`));
  const ref = line?.match(/\[(e\d+)\]/)?.[1];
  if (!ref) throw new Error(`no ${role} ${name} in the snapshot`);
  return ref;
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    if (err instanceof AgentError) return err.code;
    throw err;
  }
  throw new Error("expected a refusal");
}

describe("resolveChromiumSandbox (PD-18)", () => {
  it("keeps the sandbox on unless container mode runs inside a container", () => {
    expect(resolveChromiumSandbox({ configured: "on", inContainer: true })).toBe(true);
    expect(resolveChromiumSandbox({ configured: "on", inContainer: false })).toBe(true);
    // Refused fallback: container mode outside a container keeps the sandbox on.
    expect(resolveChromiumSandbox({ configured: "container", inContainer: false })).toBe(true);
    expect(resolveChromiumSandbox({ configured: "container", inContainer: true })).toBe(false);
  });
});

describe.skipIf(!executable)("createBrowserAgent on a real Chromium", () => {
  let site: TestSite;
  let agent: BrowserAgent;
  const events: AgentEvent[] = [];

  beforeAll(async () => {
    site = await startTestSite();
    agent = createBrowserAgent({
      executablePath: executable as string,
      chromiumSandbox: testSandbox(),
      emit: (e) => events.push(e),
    });
  }, 120_000);

  afterAll(async () => {
    await agent?.close({});
    await site?.close();
  }, 60_000);

  it("refuses every op before a page is open", async () => {
    expect(await refusal(agent.snapshot({}))).toBe("no_context");
  });

  it("opens a local page and reads it through the redacted snapshot", async () => {
    const opened = await agent.open({ url: site.url("/") });
    expect(opened).toEqual({ host: site.host, secure: false, title: "Fixture app", signedIn: false });
    const snap = await agent.snapshot({});
    expect(snap.host).toBe(site.host);
    expect(snap.text).toContain("Fixture heading");
    expect(refOf(snap.text, "button", "Save")).toMatch(/^e\d+$/);
    expect(events).toContainEqual({ event: "navigated", origin: `${site.origin}` });
  }, 90_000);

  it("clicks, selects, presses and scrolls on snapshot refs", async () => {
    await agent.open({ url: site.url("/") });
    let snap = await agent.snapshot({});
    const click = await agent.act({ action: "click", ref: refOf(snap.text, "button", "Save") });
    expect(click).toMatchObject({ navigated: false, download: null, refused: null });
    expect((await agent.snapshot({})).text).toContain("Saved it");

    snap = await agent.snapshot({});
    await agent.act({ action: "select", ref: refOf(snap.text, "combobox", "Color"), option: "Green" });
    expect((await agent.snapshot({})).text).toContain("Picked green");

    snap = await agent.snapshot({});
    const search = refOf(snap.text, "textbox", "Search");
    await agent.act({ action: "type", ref: search, text: "plain words" });
    await agent.act({ action: "press", ref: search, key: "Enter" });
    expect((await agent.snapshot({})).text).toContain("Entered plain words");

    expect(await agent.act({ action: "scroll", direction: "down" })).toMatchObject({ navigated: false });
  }, 90_000);

  it("follows a link click as a navigation", async () => {
    await agent.open({ url: site.url("/") });
    const snap = await agent.snapshot({});
    const res = await agent.act({ action: "click", ref: refOf(snap.text, "link", "Next page") });
    expect(res.navigated).toBe(true);
    expect((await agent.snapshot({})).title).toBe("Next page");
  }, 90_000);

  it("waits for a text that appears later", async () => {
    await agent.open({ url: site.url("/slow") });
    expect(await agent.wait({ for: "text", text: "Late text arrived", ms: 5_000 })).toMatchObject({
      ok: true,
    });
    expect(await agent.wait({ for: "text", text: "never on this page", ms: 600 })).toMatchObject({
      ok: false,
    });
  }, 90_000);

  it("redacts a typed password in snapshots and masks it in screenshots", async () => {
    await agent.open({ url: site.url("/login") });
    const snap = await agent.snapshot({});
    await agent.act({ action: "type", ref: refOf(snap.text, "textbox", "Password"), text: PASSWORD_CANARY });
    const after = await agent.snapshot({});
    expect(after.text).toContain("[redacted]");
    expect(after.text).not.toContain(PASSWORD_CANARY);
    // A text probe is matched against the redacted snapshot: it is not an oracle for the password.
    expect(await agent.wait({ for: "text", text: PASSWORD_CANARY, ms: 300 })).toMatchObject({ ok: false });

    const shot = await agent.screenshot({});
    expect(shot.mimeType).toBe("image/jpeg");
    expect(Buffer.from(shot.data, "base64").subarray(0, 2).toString("hex")).toBe("ffd8");
    expect(shot.masked).toBeGreaterThanOrEqual(1);
    expect(shot.data).not.toContain(Buffer.from(PASSWORD_CANARY).toString("base64"));
  }, 90_000);

  it("submits the login form and lands on the signed-in page", async () => {
    await agent.open({ url: site.url("/login") });
    let snap = await agent.snapshot({});
    await agent.act({ action: "type", ref: refOf(snap.text, "textbox", "Username"), text: "fixture-user" });
    snap = await agent.snapshot({});
    await agent.act({ action: "type", ref: refOf(snap.text, "textbox", "Password"), text: PASSWORD_CANARY });
    snap = await agent.snapshot({});
    const res = await agent.act({ action: "click", ref: refOf(snap.text, "button", "Sign in") });
    expect(res.navigated).toBe(true);
    expect((await agent.snapshot({})).text).toContain("Signed in as fixture-user");
  }, 90_000);

  it("refuses non-http(s) URLs and metadata hosts before navigating; the page stays", async () => {
    await agent.open({ url: site.url("/next") });
    expect(await refusal(agent.open({ url: "file:///etc/passwd" }))).toBe("navigation_refused");
    expect(await refusal(agent.open({ url: "javascript:alert(1)" }))).toBe("navigation_refused");
    expect(await refusal(agent.open({ url: "http://169.254.169.254/" }))).toBe("metadata_refused");
    expect(await refusal(agent.open({ url: "http://metadata.google.internal/" }))).toBe("metadata_refused");
    const snap = await agent.snapshot({});
    expect(snap.host).toBe(site.host);
    expect(snap.title).toBe("Next page");
  }, 90_000);

  it("refuses a redirect to file: and to a metadata host; the page stays on http(s)", async () => {
    await agent.open({ url: site.url("/next") });
    expect(await refusal(agent.open({ url: site.url("/redirect-file") }))).toBe("navigation_refused");
    expect((await agent.snapshot({})).host).toBe(site.host);
    const toMetadata = site.url(
      `/redirect?to=${encodeURIComponent("http://169.254.169.254/latest/meta-data/")}`,
    );
    expect(await refusal(agent.open({ url: toMetadata }))).toBe("metadata_refused");
    expect((await agent.snapshot({})).host).toBe(site.host);
  }, 90_000);

  it("reports its sandbox and Chromium version", async () => {
    const info = await agent.info({});
    expect(info.sandbox).toBe(testSandbox() ? "chromium" : "container");
    expect(info.version).toMatch(/^\d+\.\d+\.\d+\.\d+$/);
  });

  it("closes, and the next open starts again", async () => {
    expect(await agent.close({})).toEqual({ closed: true });
    expect(await refusal(agent.snapshot({}))).toBe("no_context");
    expect(await agent.open({ url: site.url("/next") })).toMatchObject({ title: "Next page" });
  }, 90_000);
});

describe("launch posture (PD-18, P4, D-35)", () => {
  it("passes no debugging port and no profile directory; the sandbox is the resolved one", () => {
    for (const chromiumSandbox of [true, false]) {
      const o = launchOptionsFor({ executablePath: "/b/chrome-headless-shell", chromiumSandbox });
      expect(o).toMatchObject({
        headless: true,
        chromiumSandbox,
        executablePath: "/b/chrome-headless-shell",
      });
      const args = o.args ?? [];
      // Playwright adds the pipe itself; nothing here may open a port or pin a profile outside the run dir.
      expect(args.filter((a) => /^--remote-debugging-(port|address)/.test(a))).toEqual([]);
      expect(args.filter((a) => /^--(user-data|profile)-/.test(a))).toEqual([]);
      expect(args).not.toContain("--no-sandbox");
      expect(args.some((a) => a.startsWith("--proxy-server"))).toBe(false);
    }
  });

  it("maps every metadata host, and its IPv6 spellings, to not found in Chromium's resolver", () => {
    const rules = metadataResolverRules();
    for (const h of [
      "169.254.169.254",
      "[fd00:ec2::254]",
      "metadata.google.internal",
      "[::ffff:a9fe:a9fe]",
      "[64:ff9b::a9fe:a9fe]",
      "100.100.100.200",
      "169.254.170.2",
    ])
      expect(rules).toContain(`MAP ${h} ~NOTFOUND`);
    expect(launchOptionsFor({ executablePath: "/b", chromiumSandbox: true }).args).toContain(
      `--host-resolver-rules=${rules}`,
    );
  });

  it("names a launch failure like brw and never by its message", () => {
    expect(launchFailureOf(new Error("[FATAL:zygote_host_impl_linux.cc] No usable sandbox!"))).toBe(
      "no_usable_sandbox",
    );
    expect(
      launchFailureOf(
        new Error("error while loading shared libraries: libnss3.so: cannot open shared object file"),
      ),
    ).toBe("missing_library");
    expect(launchFailureOf(new Error("Timeout 60000ms exceeded"))).toBe("launch_failed");
    expect(new AgentError("no_usable_sandbox").message).not.toMatch(/zygote|FATAL/);
  });

  it("refuses every scheme but http(s), user info and metadata hosts by URL", () => {
    for (const [, url] of REFUSED_SCHEMES) expect(urlRefusal(url)).toBe("navigation_refused");
    expect(urlRefusal("http://user:pw@127.0.0.1/")).toBe("navigation_refused");
    expect(urlRefusal("http://[::ffff:169.254.169.254]/")).toBe("metadata_refused");
    expect(urlRefusal("http://2852039166/")).toBe("metadata_refused");
    expect(urlRefusal("https://127.0.0.1:8443/x")).toBeNull();
  });
});

describe.skipIf(!executable)("only http(s) pages, one page, no downloads (A-8, PD-24)", () => {
  let site: TestSite;
  let agent: BrowserAgent;

  beforeAll(async () => {
    site = await startTestSite();
    agent = createBrowserAgent({ executablePath: executable as string, chromiumSandbox: testSandbox() });
  }, 120_000);

  afterAll(async () => {
    await agent?.close({});
    await site?.close();
  }, 60_000);

  /** The page is still on the fixture site, over http. */
  async function stillOnSite(): Promise<void> {
    const snap = await agent.snapshot({});
    expect(snap.host).toBe(site.host);
    expect(snap.secure).toBe(false);
  }

  it.each(REFUSED_SCHEMES)(
    "%s: open is refused before navigating",
    async (_scheme, url) => {
      await agent.open({ url: site.url("/next") });
      expect(await refusal(agent.open({ url }))).toBe("navigation_refused");
      await stillOnSite();
    },
    60_000,
  );

  it.each(REFUSED_SCHEMES)(
    "%s: a link click never leaves http(s)",
    async (_scheme, url) => {
      await agent.open({ url: site.url(`/link-file?to=${encodeURIComponent(url)}`) });
      const snap = await agent.snapshot({});
      const res = await agent.act({ action: "click", ref: refOf(snap.text, "link", "Refused link") });
      expect(res.download).toBeNull();
      // Chromium blocks these itself (the route never sees a non-network scheme, A-8); the end state is what counts.
      expect(res.host).toBe(site.host);
      await stillOnSite();
    },
    60_000,
  );

  it.each(REFUSED_SCHEMES)(
    "%s: a 302 to it is refused",
    async (_scheme, url) => {
      await agent.open({ url: site.url("/next") });
      expect(await refusal(agent.open({ url: site.url(`/redirect?to=${encodeURIComponent(url)}`) }))).toBe(
        "navigation_refused",
      );
      await stillOnSite();
    },
    60_000,
  );

  it("a link to a metadata host is refused by the route", async () => {
    await agent.open({
      url: site.url(`/link-file?to=${encodeURIComponent("http://169.254.169.254/latest/")}`),
    });
    const snap = await agent.snapshot({});
    const res = await agent.act({ action: "click", ref: refOf(snap.text, "link", "Refused link") });
    expect(res).toMatchObject({ refused: "metadata_refused", navigated: false });
    await stillOnSite();
  }, 60_000);

  it("closes a window.open pop-up and keeps one page", async () => {
    await agent.open({ url: site.url("/popup") });
    const snap = await agent.snapshot({});
    await agent.act({ action: "click", ref: refOf(snap.text, "button", "Open popup") });
    // The pop-up's http(s) URL is opened in the session's one page instead (brw's single-tab policy).
    let title = "";
    for (let i = 0; i < 40 && title !== "Next page"; i++) {
      title = (await agent.snapshot({})).title;
      if (title !== "Next page") await new Promise((r) => setTimeout(r, 250));
    }
    expect(title).toBe("Next page");
    expect((await agent.info({})).pages).toBe(1);
  }, 60_000);

  it("refuses a download: the act answers ok with no download and the page stays", async () => {
    await agent.open({ url: site.url("/download-page") });
    const snap = await agent.snapshot({});
    const res = await agent.act({ action: "click", ref: refOf(snap.text, "link", "Get the file") });
    expect(res).toMatchObject({ download: null, refused: null });
    expect((await agent.snapshot({})).title).toBe("Download page");
  }, 60_000);
});

// ---------------------------------------------------------------------------- takeover (07.13-15 Task 2)

/** One mouse click at a point, as a person's client sends it. */
const click = (at: { x: number; y: number }) => [
  { type: "mouse", event: "down", x: at.x, y: at.y, button: "left" },
  { type: "mouse", event: "up", x: at.x, y: at.y, button: "left" },
];
const key = (name: string, code = name) => [
  { type: "key", event: "down", key: name, code, modifiers: 0 },
  { type: "key", event: "up", key: name, code, modifiers: 0 },
];

/** The snapshot line of the textbox with this name. */
const fieldLine = (text: string, name: string) =>
  text.split("\n").find((l) => l.includes(`textbox ${JSON.stringify(name)}`)) ?? "";

describe.skipIf(!executable)("takeover input on a real Chromium (07.13-15 Task 2: D-20, PD-14)", () => {
  let site: TestSite;
  let agent: BrowserAgent;
  const events: AgentEvent[] = [];
  const focus = () => events.flatMap((e) => (e.event === "focus" ? [e.sensitive] : []));

  beforeAll(async () => {
    site = await startTestSite();
    agent = createBrowserAgent({
      executablePath: executable as string,
      chromiumSandbox: testSandbox(),
      emit: (e) => events.push(e),
    });
  }, 120_000);

  afterAll(async () => {
    await agent?.close({});
    await site?.close();
  }, 60_000);

  it("refuses input while no takeover is active, and a batch outside 1 to 64 valid events", async () => {
    await agent.open({ url: site.url("/takeover") });
    expect(await refusal(agent.input({ events: click(TAKEOVER_LAYOUT.username) }))).toBe("invalid_request");
    await agent.takeover({ on: true });
    expect(await refusal(agent.input({ events: [] }))).toBe("invalid_request");
    expect(await refusal(agent.input({ events: [{ type: "text", text: "" }] }))).toBe("invalid_request");
    expect(await refusal(agent.input({ events: [{ type: "eval", code: "1" }] }))).toBe("invalid_request");
    const many = Array.from({ length: 65 }, () => ({ type: "text", text: "x" }));
    expect(await refusal(agent.input({ events: many }))).toBe("invalid_request");
    await agent.takeover({ on: false });
  }, 90_000);

  it("applies a person's input through CDP, reports focus without the value, and redacts what they typed", async () => {
    await agent.open({ url: site.url("/takeover") });
    events.length = 0;
    expect(await agent.takeover({ on: true })).toEqual({ active: true });
    // Nothing focused yet: one report that the focus is not sensitive.
    expect(focus()).toEqual([false]);

    await agent.input({ events: click(TAKEOVER_LAYOUT.password) });
    expect(focus().at(-1)).toBe(true);
    await agent.input({ events: click(TAKEOVER_LAYOUT.username) });
    expect(focus().at(-1)).toBe(false);

    const typed = await agent.input({
      events: [
        { type: "text", text: "fixture-user" },
        ...key("Tab"),
        { type: "text", text: PASSWORD_CANARY },
      ],
    });
    expect(typed).toEqual({ applied: 4 });
    expect(focus().at(-1)).toBe(true);
    // Only a boolean leaves: no event names a value, a label or a field.
    expect(JSON.stringify(events)).not.toContain("fixture-user");
    expect(JSON.stringify(events)).not.toContain(PASSWORD_CANARY);

    await agent.takeover({ on: false });
    const snap = await agent.snapshot({});
    expect(fieldLine(snap.text, "Username")).toContain("[redacted]");
    expect(fieldLine(snap.text, "Password")).toContain("[redacted]");
    expect(snap.text).not.toContain("fixture-user");
    expect(snap.text).not.toContain(PASSWORD_CANARY);
    // A text probe is not an oracle for what a person typed either.
    expect(await agent.wait({ for: "text", text: "fixture-user", ms: 300 })).toMatchObject({ ok: false });
    const shot = await agent.screenshot({});
    expect(shot.masked).toBeGreaterThanOrEqual(2);

    // The values did reach the page: the site receives them when the person submits.
    await agent.takeover({ on: true });
    await agent.input({ events: key("Enter") });
    for (let i = 0; i < 40 && !site.lastLogin(); i++) await new Promise((r) => setTimeout(r, 100));
    expect(site.lastLogin()).toMatchObject({ username: "fixture-user", password: PASSWORD_CANARY });
    await agent.takeover({ on: false });
  }, 90_000);

  it("a wheel and a touch reach the page as mouse input", async () => {
    await agent.open({ url: site.url("/") });
    await agent.takeover({ on: true });
    expect(
      await agent.input({
        events: [
          { type: "wheel", x: 100, y: 100, dx: 0, dy: 400 },
          { type: "touch", event: "start", x: 10, y: 10 },
          { type: "touch", event: "end", x: 10, y: 10 },
        ],
      }),
    ).toEqual({ applied: 3 });
    await agent.takeover({ on: false });
  }, 60_000);
});

describe("site states (07.13-19: P-09, PD-15)", () => {
  const cookie = (name: string, domain: string) => ({
    name,
    value: `${name}-value`,
    domain,
    path: "/",
    expires: -1,
    httpOnly: false,
    secure: false,
    sameSite: "Lax" as const,
  });

  it("keeps the site's cookies and origin storage only, in a fixed order, with one fingerprint", () => {
    const state = {
      cookies: [cookie("b", "127.0.0.1"), cookie("idp", "accounts.example.com"), cookie("a", "127.0.0.1")],
      origins: [
        {
          origin: "http://127.0.0.1:3000",
          localStorage: [
            { name: "z", value: "1" },
            { name: "y", value: "2" },
          ],
        },
        { origin: "http://localhost:3000", localStorage: [{ name: "x", value: "3" }] },
      ],
    };
    const kept = siteState("127.0.0.1:3000", state);
    expect(kept.cookies.map((c) => c.name)).toEqual(["a", "b"]);
    expect(kept.origins).toEqual([
      {
        origin: "http://127.0.0.1:3000",
        localStorage: [
          { name: "y", value: "2" },
          { name: "z", value: "1" },
        ],
      },
    ]);
    const reordered = { cookies: [...state.cookies].reverse(), origins: [...state.origins].reverse() };
    expect(stateFingerprint(siteState("127.0.0.1:3000", reordered))).toBe(stateFingerprint(kept));
    expect(stateFingerprint(kept)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe.skipIf(!executable)("sign-in contexts on a real Chromium (07.13-19 Task 3: D-24, D-26)", () => {
  let site: TestSite;
  let agent: BrowserAgent;

  beforeAll(async () => {
    site = await startTestSite();
    agent = createBrowserAgent({ executablePath: executable as string, chromiumSandbox: testSandbox() });
  }, 120_000);

  afterAll(async () => {
    await agent?.close({});
    await site?.close();
  }, 60_000);

  const sealed = () => ({
    cookies: [
      {
        name: "fixture_session",
        value: site.sessionCookie,
        domain: "127.0.0.1",
        path: "/",
        expires: -1,
        httpOnly: true,
        secure: false,
        sameSite: "Lax" as const,
      },
    ],
    origins: [],
  });

  it("opens a member's state in a new locked context; other hosts are blocked until allowed", async () => {
    const other = `http://localhost:${new URL(site.origin).port}/`;
    await agent.open({ url: site.url("/") });
    const opened = await agent.openWithState({
      url: site.url(`/account?away=${encodeURIComponent(other)}`),
      state: sealed(),
      siteHost: site.host,
    });
    expect(opened).toMatchObject({ host: site.host, signedIn: true });
    expect(opened.fingerprint).toMatch(/^[0-9a-f]{64}$/);
    const snap = await agent.snapshot({});
    expect(snap.text).toContain("Signed in as fixture-user");

    const exported = await agent.exportState({ host: site.host });
    expect(exported.state.cookies.map((c) => c.value)).toEqual([site.sessionCookie]);
    expect(exported.fingerprint).toBe(opened.fingerprint);
    expect((await agent.fingerprint({ host: site.host })).fingerprint).toBe(opened.fingerprint);
    // A locked page exports for its own site only.
    expect(await refusal(agent.exportState({ host: "localhost" }))).toBe("invalid_request");

    const act = await agent.act({ action: "click", ref: refOf(snap.text, "link", "Away link") });
    expect(act.blocked).toBe(originOfUrl(other));
    expect((await agent.snapshot({})).text).toContain("Signed in as fixture-user");

    const allowed = await agent.allowCrossSite({ host: new URL(other).host });
    expect(allowed).toMatchObject({ host: new URL(other).host, navigated: true });
    expect((await agent.snapshot({})).text).toContain("Fixture heading");
  }, 60_000);

  it("a plain open after it starts public again; a state for another host is refused", async () => {
    await agent.close({});
    await agent.open({ url: site.url("/account") });
    expect((await agent.snapshot({})).text).toContain("Not signed in");
    expect(
      await refusal(
        agent.openWithState({ url: site.url("/account"), state: sealed(), siteHost: "localhost" }),
      ),
    ).toBe("invalid_request");
  }, 60_000);
});

function originOfUrl(url: string): string {
  const u = new URL(url);
  return `${u.protocol}//${u.hostname}:${u.port || (u.protocol === "https:" ? "443" : "80")}`;
}
