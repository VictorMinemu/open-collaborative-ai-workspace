import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Device, DeviceBotConsentsView } from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import {
  deviceBotConsentKeys,
  revokeConsentMutation,
  setConsentMutation,
} from "@/lib/device-bot-consent-queries";
import {
  BOT_CONSENT_COPY,
  DeviceBotConsents,
  RevokeConsentButton,
  showsBotConsents,
} from "./device-bot-consents";
import { DeviceFacts } from "./devices-settings";

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
    expect(source).toMatch(
      /showsBotConsents\(d, owned, canManageWorkZone\) \? <DeviceBotConsents device=\{d\} \/>/,
    );
  });
});

// ---------------------------------------------------------------- Task 2: per-bot Full access, revoke, isolated server

/** The opening tag of the Full access checkbox of the allowed bot `agentId`. */
const fullAccessBox = (html: string, agentId: string) =>
  html.match(
    new RegExp(`<input[^>]*data-testid="bot-consent-full-access"[^>]*data-agent-id="${agentId}"[^>]*>`),
  )?.[0] ?? "";

describe("per-bot Full access (Task 2)", () => {
  it("is disabled with its reason while Full access is off on the device", () => {
    const html = render(<DeviceBotConsents device={device({ fullAccessOptIn: false })} />, client(ALLOWED));
    const row = text(from(html, "bot-consent-row"));
    expect(row).toContain(BOT_CONSENT_COPY.fullAccess);
    expect(BOT_CONSENT_COPY.fullAccess).toBe("Allow Full access for this bot");
    expect(row).toContain("Full access is off on this device");
    const box = fullAccessBox(html, ATLAS);
    expect(box).toContain('type="checkbox"');
    expect(box).toMatch(/\sdisabled=""/);
  });

  it("is enabled when the device opted in; checking it is one PUT with Full access on", async () => {
    const html = render(<DeviceBotConsents device={device({ fullAccessOptIn: true })} />, client(ALLOWED));
    const box = fullAccessBox(html, ATLAS);
    expect(box).toContain('type="checkbox"');
    expect(box).not.toMatch(/\sdisabled=""/);
    expect(text(from(html, "bot-consent-row"))).not.toContain("Full access is off on this device");

    const on: DeviceBotConsentsView = {
      ...ALLOWED,
      consents: ALLOWED.consents.map((c) => ({ ...c, allowFullAccess: true })),
    };
    vi.mocked(api.put).mockResolvedValue(on);
    const qc = client(ALLOWED);
    await new MutationObserver(qc, setConsentMutation(qc, DEVICE)).mutate({
      agentId: ATLAS,
      allowFullAccess: true,
    });
    const [path, opts] = vi.mocked(api.put).mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/devices/${DEVICE}/bot-consents/${ATLAS}`);
    expect((opts as { body: unknown }).body).toEqual({ allowFullAccess: true });
    const after = render(<DeviceBotConsents device={device({ fullAccessOptIn: true })} />, qc);
    expect(fullAccessBox(after, ATLAS)).toMatch(/\schecked=""/);
  });

  it("never changes the device's own opt-in: the checkbox only sends the bot's consent", () => {
    const source = readFileSync(join(__dirname, "device-bot-consents.tsx"), "utf8");
    expect(source).not.toContain("useUpdateDevice");
    expect(source).not.toContain("fullAccessOptIn:");
  });
});

describe("revoke (Task 2)", () => {
  it("asks once: Revoke, then Confirm revoke", () => {
    const qc = new QueryClient();
    const idle = render(
      <RevokeConsentButton name="Atlas" confirming={false} pending={false} onClick={() => {}} />,
      qc,
    );
    expect(text(idle)).toBe("Revoke");
    expect(tagsOf(idle, "bot-consent-revoke")[0]).toContain('aria-label="Revoke Atlas"');
    const confirming = render(
      <RevokeConsentButton name="Atlas" confirming pending={false} onClick={() => {}} />,
      qc,
    );
    expect(text(confirming)).toBe("Confirm revoke");
    expect(tagsOf(confirming, "bot-consent-revoke")[0]).toContain('aria-label="Confirm revoke Atlas"');
  });

  it("every allowed bot has Revoke for whoever may grant, and none without the right", () => {
    expect(
      tagsOf(render(<DeviceBotConsents device={device()} />, client(ALLOWED)), "bot-consent-revoke"),
    ).toHaveLength(1);
    const readOnly = render(
      <DeviceBotConsents device={device()} />,
      client({ ...ALLOWED, viewerCan: { grant: false } }),
    );
    expect(tagsOf(readOnly, "bot-consent-revoke")).toHaveLength(0);
    expect(fullAccessBox(readOnly, ATLAS)).toMatch(/\sdisabled=""/);
  });

  it("is one DELETE; the row moves out with the API's answer", async () => {
    vi.mocked(api.del).mockResolvedValue(EMPTY);
    const qc = client(ALLOWED);
    await new MutationObserver(qc, revokeConsentMutation(qc, DEVICE)).mutate(ATLAS);
    expect(api.del).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.del).mock.calls[0]?.[0]).toBe(`/api/v1/devices/${DEVICE}/bot-consents/${ATLAS}`);
    const html = render(<DeviceBotConsents device={device()} />, qc);
    expect(tagsOf(html, "bot-consent-row")).toHaveLength(0);
    expect(text(html)).toContain(BOT_CONSENT_COPY.empty);
  });
});

describe("the Isolated server fact (Task 2)", () => {
  const facts = (d: Device) => render(<DeviceFacts device={d} owned />, new QueryClient());

  it("on a server marked isolated: On, and what it allows", () => {
    const html = facts(device({ hostKind: "service", isolatedServer: true }));
    const tag = tagsOf(html, "device-isolated-server")[0] ?? "";
    expect(tag).toContain('data-enabled="true"');
    const row = text(from(html, "device-isolated-server"));
    expect(row).toContain("Isolated server");
    expect(row).toContain("Set on the device");
    expect(row).toContain("On — bots that read outside content may run Full access sessions here");
    expect(row).not.toContain("ocw-runtime isolated-server on");
  });

  it("on a server not marked: Off, and the command to mark it on the server", () => {
    const html = facts(device({ hostKind: "service", isolatedServer: false }));
    expect(tagsOf(html, "device-isolated-server")[0]).toContain('data-enabled="false"');
    const row = text(from(html, "device-isolated-server"));
    expect(row).toContain("Off");
    expect(row).toContain("ocw-runtime isolated-server on");
  });

  it("is absent on a desktop device, and on one that has not said what it is", () => {
    expect(
      tagsOf(facts(device({ hostKind: "desktop", isolatedServer: true })), "device-isolated-server"),
    ).toHaveLength(0);
    expect(tagsOf(facts(device({ hostKind: null })), "device-isolated-server")).toHaveLength(0);
    expect(tagsOf(facts(device({ hostKind: undefined })), "device-isolated-server")).toHaveLength(0);
  });

  it("comes after the Full access row, which keeps its markup and test ids", () => {
    const html = facts(device({ hostKind: "service", fullAccessOptIn: false }));
    expect(tagsOf(html, "device-full-access")[0]).toContain('data-enabled="false"');
    expect(tagsOf(html, "device-full-access-icon")).toHaveLength(1);
    expect(text(from(html, "device-full-access"))).toContain("ocw-runtime full-access on");
    expect(html.indexOf('data-testid="device-full-access"')).toBeLessThan(
      html.indexOf('data-testid="device-isolated-server"'),
    );
  });

  it("has no control: the web never sets the mark or the host kind (P5)", () => {
    const html = facts(device({ hostKind: "service", isolatedServer: false }));
    const row = from(html, "device-isolated-server").split('data-testid="device-runtime-updates"')[0] ?? "";
    expect(row).not.toMatch(/<(button|input|select)\b/);
    expect(row).not.toContain('role="switch"');
    const sources = ["devices-settings.tsx", "device-bot-consents.tsx"].map((f) =>
      readFileSync(join(__dirname, f), "utf8"),
    );
    for (const s of sources) {
      expect(s).not.toMatch(/isolatedServer:\s/);
      expect(s).not.toMatch(/hostKind:\s/);
    }
  });
});
