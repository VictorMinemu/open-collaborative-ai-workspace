// The device's browser agent against a real Chromium (07.13-09, D-01, D-04, D-07, D-12, D-35, PD-18, PD-24, A-8): the
// pinned headless shell from the test cache (never Playwright's shared cache, never a download outside CI) and a local
// site on 127.0.0.1. The agent reads a page only through the bots' redaction, and only http(s) pages are ever shown.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BROWSER_HINT, testBrowser, testSandbox } from "../test-browser.js";
import { PASSWORD_CANARY, startTestSite, type TestSite } from "../test-site.js";
import { AgentError, type AgentEvent, type BrowserAgent, createBrowserAgent } from "./ops.js";
import { resolveChromiumSandbox } from "./sandbox.js";

const executable = await testBrowser();
if (!executable) console.warn(TEST_BROWSER_HINT);

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
