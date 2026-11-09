import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Device, DeviceBotConsentsView } from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { deviceBotConsentKeys, setConsentMutation } from "@/lib/device-bot-consent-queries";
import { BOT_CONSENT_COPY, DeviceBotConsents, showsBotConsents } from "./device-bot-consents";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() } };
});

/**
 * Settings › Devices › Bots (07.16-13, D-03, D-04, D-22, PD-06, PD-20): the device owner (or an admin, on a server)
 * lets a bot run Work Zone sessions there. The API decides who may grant (`viewerCan.grant`) and answers every change
 * with the whole view, which replaces the cache. Static markup in node from cached queries, plus the mutation options.
 */

const DEVICE = "01a11635-d6e7-7c87-9f17-0000000000d1";
const OWNER = "01a11635-d6e7-7c87-9f17-0000000000a1";
const ANA = "01a11635-d6e7-7c87-9f17-0000000000a2";
const ATLAS = "01a11635-d6e7-7c87-9f17-0000000000b1";
const SCOUT = "01a11635-d6e7-7c87-9f17-0000000000b2";
const T = "2026-11-09T09:00:00.000Z";

function device(over: Partial<Device> = {}): Device {
  return {
    id: DEVICE,
    ownerUserId: OWNER,
    ownerName: "Owen",
    name: "Build server",
    platform: "linux",
    status: "online",
    shared: false,
    fullAccessOptIn: false,
    hostKind: "service",
    isolatedServer: false,
    shareMaxMode: "default",
    lastSeenAt: T,
    runtimes: [],
    daemonVersion: "0.9.0",
    projectCount: 1,
    revokedAt: null,
    createdAt: T,
    viewerCan: ["device.update", "device.revoke"],
    ...over,
  };
}

const REQUEST: DeviceBotConsentsView = {
  consents: [],
  requests: [
    {
      agentId: ATLAS,
      displayName: "Atlas",
      handle: "atlas",
      sponsor: { id: ANA, displayName: "Ana" },
      profileUpdatedAt: T,
    },
  ],
  viewerCan: { grant: true },
};

const ALLOWED: DeviceBotConsentsView = {
  consents: [
    {
      agentId: ATLAS,
      displayName: "Atlas",
      handle: "atlas",
      allowFullAccess: false,
      grantedBy: { id: OWNER, displayName: "Owen" },
      grantedAt: T,
    },
  ],
  requests: [],
  viewerCan: { grant: true },
};

const EMPTY: DeviceBotConsentsView = { consents: [], requests: [], viewerCan: { grant: true } };

function client(view: DeviceBotConsentsView): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(deviceBotConsentKeys.consents(DEVICE), view);
  return qc;
}

function render(node: ReactElement, qc: QueryClient): string {
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

/** Every opening tag of an element with `data-testid` = `id`. */
const tagsOf = (html: string, id: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`, "g")) ?? [];

/** The markup inside the first element with `data-testid` = `id`, up to the end of the document. */
const from = (html: string, id: string) => {
  const at = html.indexOf(`data-testid="${id}"`);
  return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1);
};

beforeEach(() => {
  vi.mocked(api.put).mockReset();
  vi.mocked(api.del).mockReset();
});

describe("a bot asks to run sessions on the device (Task 1)", () => {
  it("shows the request first: the bot, who asked, and Allow", () => {
    const html = render(<DeviceBotConsents device={device()} />, client(REQUEST));
    expect(tagsOf(html, "device-bot-consents")).toHaveLength(1);
    expect(text(from(html, "device-bot-consents"))).toContain(BOT_CONSENT_COPY.heading);
    expect(BOT_CONSENT_COPY.heading).toBe("Bots that may run sessions here");
    expect(tagsOf(html, "bot-consent-request")).toHaveLength(1);
    expect(text(from(html, "bot-consent-request"))).toContain("Atlas · asked by Ana");
    expect(tagsOf(html, "bot-consent-allow")).toHaveLength(1);
    expect(text(from(html, "bot-consent-allow"))).toContain("Allow");
    expect(tagsOf(html, "bot-consent-row")).toHaveLength(0);
  });

  it("Allow is one PUT with Full access off; the API's answer replaces the cached view", async () => {
    vi.mocked(api.put).mockResolvedValue(ALLOWED);
    const qc = client(REQUEST);
    await new MutationObserver(qc, setConsentMutation(qc, DEVICE)).mutate({
      agentId: ATLAS,
      allowFullAccess: false,
    });
    expect(api.put).toHaveBeenCalledTimes(1);
    const [path, opts] = vi.mocked(api.put).mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/devices/${DEVICE}/bot-consents/${ATLAS}`);
    expect((opts as { body: unknown }).body).toEqual({ allowFullAccess: false });
    expect(qc.getQueryData(deviceBotConsentKeys.consents(DEVICE))).toEqual(ALLOWED);
    // The block re-renders from that answer: Atlas is now an allowed bot.
    const html = render(<DeviceBotConsents device={device()} />, qc);
    expect(tagsOf(html, "bot-consent-request")).toHaveLength(0);
    expect(tagsOf(html, "bot-consent-row")).toHaveLength(1);
    expect(text(from(html, "bot-consent-row"))).toContain("Atlas");
    expect(text(from(html, "bot-consent-row"))).toContain("Allowed by Owen");
  });

  it("requests come before allowed bots", () => {
    const both: DeviceBotConsentsView = {
      ...ALLOWED,
      requests: [{ ...(REQUEST.requests[0] as DeviceBotConsentsView["requests"][number]), agentId: SCOUT }],
    };
    const html = render(<DeviceBotConsents device={device()} />, client(both));
    expect(html.indexOf('data-testid="bot-consent-request"')).toBeLessThan(
      html.indexOf('data-testid="bot-consent-row"'),
    );
  });

  it("says so when no bot runs sessions on the device", () => {
    const html = render(<DeviceBotConsents device={device()} />, client(EMPTY));
    expect(text(from(html, "device-bot-consents"))).toContain("No bot runs sessions on this device.");
    expect(tagsOf(html, "bot-consent-request")).toHaveLength(0);
    expect(tagsOf(html, "bot-consent-row")).toHaveLength(0);
  });

  it("without the right to grant (the API's viewerCan), the list is read-only", () => {
    const html = render(
      <DeviceBotConsents device={device()} />,
      client({ ...REQUEST, viewerCan: { grant: false } }),
    );
    expect(tagsOf(html, "bot-consent-request")).toHaveLength(1);
    expect(tagsOf(html, "bot-consent-allow")).toHaveLength(0);
    expect(text(html)).toContain(BOT_CONSENT_COPY.readOnly);
  });
});

describe("who sees the block on a device card (Task 1)", () => {
  it("the owner, always; an admin only on a server; nobody else", () => {
    expect(showsBotConsents(device({ hostKind: "desktop" }), true, false)).toBe(true);
    expect(showsBotConsents(device({ hostKind: null }), true, false)).toBe(true);
    expect(showsBotConsents(device({ hostKind: "service" }), false, true)).toBe(true);
    expect(showsBotConsents(device({ hostKind: "desktop" }), false, true)).toBe(false);
    expect(showsBotConsents(device({ hostKind: null }), false, true)).toBe(false);
    expect(showsBotConsents(device({ hostKind: "service" }), false, false)).toBe(false);
  });

  it("DeviceCard renders it after the sharing block, gated by showsBotConsents and work_zone.manage", () => {
    const source = readFileSync(join(__dirname, "devices-settings.tsx"), "utf8");
    expect(source).toContain('useCan("work_zone.manage")');
    const sharing = source.indexOf("<DeviceSharing device={d} />");
    const bots = source.indexOf("<DeviceBotConsents device={d} />");
    expect(sharing).toBeGreaterThan(0);
    expect(bots).toBeGreaterThan(sharing);
    expect(source).toMatch(/showsBotConsents\(d, owned, canManageWorkZone\) \? <DeviceBotConsents device=\{d\} \/>/);
  });
});
