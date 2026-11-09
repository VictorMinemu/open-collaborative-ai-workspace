import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Agent,
  BOT_WORK_ZONE_LIMITS,
  type BotWorkZoneProfileInput,
  type BotWorkZoneProfileView,
  type Device,
  type Project,
  type RuntimeControls,
} from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { botWorkZoneKeys, saveProfileMutation } from "@/lib/bot-work-zone-queries";
import { wzKeys } from "@/lib/workzone-queries";
import { newDraft, toProfileInput, WORK_ZONE_COPY, WorkZoneProfileSection } from "./work-zone-profile-section";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() } };
});

/**
 * The bot sheet's Work Zone section (07.16-12, D-01, D-08, PD-04, PD-20). The API decides whether the bot may act: the
 * status row renders its sentence, the form sends the full desired state in one PUT and the answer replaces it. Static
 * markup in node from cached queries, plus the pure draft helpers and the mutation options the hooks use.
 */

const SCOUT = "01a11635-d6e7-7c87-9f17-0000000000a1";
const ORG = "01a11635-d6e7-7c87-9f17-000000000001";
const ANA = "01a11635-d6e7-7c87-9f17-0000000000f1";
const MAC = "01a11635-d6e7-7c87-9f17-0000000000c1";
const BOX = "01a11635-d6e7-7c87-9f17-0000000000c2";
const OLD = "01a11635-d6e7-7c87-9f17-0000000000c3";
const WEB = "01a11635-d6e7-7c87-9f17-0000000000b1";
const API_REPO = "01a11635-d6e7-7c87-9f17-0000000000b2";
const PORTAL = "01a11635-d6e7-7c87-9f17-0000000000d1";

const T = "2026-11-09T09:00:00.000Z";

function device(over: Partial<Device> & Pick<Device, "id" | "name">): Device {
  return {
    ownerUserId: ANA,
    ownerName: "Ana Pérez",
    platform: "darwin",
    status: "online",
    shared: false,
    fullAccessOptIn: false,
    hostKind: "desktop",
    shareMaxMode: "default",
    lastSeenAt: T,
    runtimes: [
      { id: "claude-code", installed: true, version: "2.1.0", loggedIn: false },
      { id: "codex", installed: true, version: "0.60.0", loggedIn: true },
    ],
    daemonVersion: "0.9.0",
    projectCount: 2,
    revokedAt: null,
    createdAt: T,
    ...over,
  } as Device;
}

// The first device was removed and the second has no signed-in runtime: the third is the first usable one.
const DEVICES: Device[] = [
  device({ id: OLD, name: "Old laptop", revokedAt: T }),
  device({
    id: BOX,
    name: "Build box",
    runtimes: [{ id: "claude-code", installed: false, version: null, loggedIn: false }],
  }),
  device({ id: MAC, name: "Ana's MacBook" }),
];

function project(id: string, name: string, deviceId = MAC, team = false): Project {
  return {
    id,
    deviceId,
    deviceName: deviceId === MAC ? "Ana's MacBook" : "Build box",
    deviceOnline: true,
    name,
    gitRemote: null,
    defaultBranch: "main",
    available: true,
    createdAt: T,
    teamProject: team ? { id: PORTAL, name: "Customer portal", defaultVisibility: "project" } : null,
  };
}
const PROJECTS = [project(WEB, "web-app", MAC, true), project(API_REPO, "api", MAC)];

const CONTROLS: RuntimeControls = {
  runtime: "codex",
  catalog: { runtimeVersion: "0.60.0", collectedAt: T },
  models: [],
  otherRuntimes: [],
  permissionModes: [{ value: "default", available: true, reason: null, detail: null }],
  fastModeCost: null,
};

const EMPTY: BotWorkZoneProfileView = {
  profile: null,
  status: { active: false, reason: null, sentence: null },
  viewerCan: { edit: true, setOutsideContent: false },
};

function saved(status: BotWorkZoneProfileView["status"]): BotWorkZoneProfileView {
  return {
    profile: {
      id: "01a11635-d6e7-7c87-9f17-0000000000e1",
      agentId: SCOUT,
      deviceId: MAC,
      runtime: "codex",
      defaultModel: null,
      allowedModels: [],
      defaultEffort: null,
      allowedEfforts: [],
      defaultContextWindow: null,
      allowedContextWindows: [],
      fastMode: "off",
      defaultMode: "default",
      maxMode: "default",
      worktree: true,
      maxConcurrent: 2,
      promptsPerHour: 30,
      wakesPerSessionDay: 20,
      actOnOutsideContent: false,
      sponsor: { id: ANA, displayName: "Ana Pérez" },
      device: { id: MAC, name: "Ana's MacBook", online: true, hostKind: "desktop", isolatedServer: false },
      projects: [{ id: WEB, name: "web-app" }],
      actOnOutsideContentBy: null,
      actOnOutsideContentAt: null,
      updatedAt: T,
    },
    status,
    viewerCan: { edit: true, setOutsideContent: false },
  };
}

const SCOUT_AGENT = {
  id: SCOUT,
  organizationId: ORG,
  name: "Scout",
  username: "scout",
  scope: "personal",
  viewerCan: ["bot.read", "bot.configure"],
} as unknown as Agent;

function client(view: BotWorkZoneProfileView): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData(botWorkZoneKeys.profile(SCOUT), view);
  qc.setQueryData(wzKeys.devices, { devices: DEVICES });
  qc.setQueryData(wzKeys.projects, { projects: PROJECTS });
  qc.setQueryData(wzKeys.runtimeControls(MAC, "codex"), CONTROLS);
  return qc;
}

function render(view: BotWorkZoneProfileView, qc = client(view)): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <WorkZoneProfileSection agent={SCOUT_AGENT} />
    </QueryClientProvider>,
  );
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

/** The markup of the first element with `data-testid` = `id`, up to the end of the document (enough for `contains`). */
const from = (html: string, id: string) => html.slice(Math.max(0, html.indexOf(`data-testid="${id}"`)));

beforeEach(() => {
  vi.mocked(api.put).mockReset();
  vi.mocked(api.del).mockReset();
});

describe("a bot without a profile (Task 1)", () => {
  it("says so, and opens the form on the first usable device with its first signed-in runtime", () => {
    const html = render(EMPTY);
    expect(tagsOf(html, "work-zone-profile")).toHaveLength(1);
    expect(text(from(html, "work-zone-status"))).toContain(WORK_ZONE_COPY.empty);
    expect(WORK_ZONE_COPY.empty).toBe("No Work Zone profile yet");
    // The removed laptop and the box without a signed-in runtime are skipped.
    expect(text(from(html, "work-zone-device"))).toContain("Ana's MacBook");
    const codex = html.match(/<button[^>]*data-testid="work-zone-runtime-codex"[^>]*>/)?.[0] ?? "";
    expect(codex).toContain('aria-checked="true"');
    const claude = html.match(/<button[^>]*data-testid="work-zone-runtime-claude-code"[^>]*>/)?.[0] ?? "";
    expect(claude).toContain('aria-checked="false"');
    // The projects of that device, grouped by team project like the New session dialog.
    const projects = text(from(html, "work-zone-projects"));
    expect(projects).toContain("Customer portal");
    expect(projects).toContain("web-app");
    expect(projects).toContain("api");
    expect(tagsOf(html, "work-zone-save")).toHaveLength(1);
    // Nothing to remove yet.
    expect(tagsOf(html, "work-zone-remove")).toHaveLength(0);
  });

  it("starts from the platform defaults and sends the full desired state", () => {
    const draft = newDraft(DEVICES);
    expect(draft).not.toBeNull();
    if (!draft) return;
    const body = toProfileInput({ ...draft, projectIds: [WEB] });
    const expected: BotWorkZoneProfileInput = {
      deviceId: MAC,
      runtime: "codex",
      defaultModel: null,
      allowedModels: [],
      defaultEffort: null,
      allowedEfforts: [],
      defaultContextWindow: null,
      allowedContextWindows: [],
      fastMode: "off",
      defaultMode: "default",
      maxMode: "default",
      worktree: true,
      maxConcurrent: BOT_WORK_ZONE_LIMITS.maxConcurrentDefault,
      promptsPerHour: BOT_WORK_ZONE_LIMITS.promptsPerHourDefault,
      wakesPerSessionDay: BOT_WORK_ZONE_LIMITS.wakesPerSessionDayDefault,
      actOnOutsideContent: false,
      projectIds: [WEB],
    };
    expect(body).toEqual(expected);
    // No device the caller may use: no draft (the section says how to get one).
    expect(newDraft([DEVICES[0] as Device])).toBeNull();
  });

  it("Save profile is one PUT with that body; the answer replaces the cached view", async () => {
    const answer = saved({ active: false, reason: "no_consent", sentence: "Not allowed yet." });
    vi.mocked(api.put).mockResolvedValue(answer);
    const qc = client(EMPTY);
    const draft = newDraft(DEVICES);
    if (!draft) throw new Error("no draft");
    const body = toProfileInput({ ...draft, projectIds: [WEB] });
    await new MutationObserver(qc, saveProfileMutation(qc, SCOUT)).mutate(body);
    expect(api.put).toHaveBeenCalledTimes(1);
    const [path, opts] = vi.mocked(api.put).mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/agents/${SCOUT}/work-zone-profile`);
    expect((opts as { body: unknown }).body).toEqual(body);
    expect(qc.getQueryData(botWorkZoneKeys.profile(SCOUT))).toEqual(answer);
  });
});

describe("the API's status line (Task 1)", () => {
  it("renders Inactive · the API's sentence, and who the bot runs as", () => {
    const sentence = "The device's owner has not allowed this bot to run sessions there.";
    const html = render(saved({ active: false, reason: "no_consent", sentence }));
    const status = text(from(html, "work-zone-status"));
    expect(status).toContain(`Inactive · ${sentence}`);
    expect(status).not.toContain("Active ·");
    expect(text(html)).toContain("Runs as Ana Pérez");
    expect(tagsOf(html, "work-zone-status-dot")[0]).toContain("bg-warning");
  });

  it("renders Active with the green dot when the API says so; the form is the saved profile", () => {
    const html = render(saved({ active: true, reason: null, sentence: null }));
    expect(text(from(html, "work-zone-status")).startsWith("Active")).toBe(true);
    expect(tagsOf(html, "work-zone-status-dot")[0]).toContain("bg-success");
    const web = html.match(new RegExp(`<button[^>]*data-project-id="${WEB}"[^>]*>`))?.[0] ?? "";
    expect(web).toContain('aria-checked="true"');
    const apiRow = html.match(new RegExp(`<button[^>]*data-project-id="${API_REPO}"[^>]*>`))?.[0] ?? "";
    expect(apiRow).toContain('aria-checked="false"');
    expect(tagsOf(html, "work-zone-remove")).toHaveLength(1);
  });

  it("no success toast: the status line is the confirmation", () => {
    const source = readFileSync(join(__dirname, "work-zone-profile-section.tsx"), "utf8");
    expect(source).not.toMatch(/toast\.success/);
  });
});

describe("the bot sheet (Task 1)", () => {
  it("shows the Work Zone section only with bot.configure, right after Capabilities; nothing else moves", () => {
    const sheet = readFileSync(join(__dirname, "bot-detail-sheet.tsx"), "utf8");
    const titles = [...sheet.matchAll(/<SheetSection title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "Connections",
      "Who can use it",
      "Capabilities",
      "Work Zone",
      "Consulting other bots",
      "Profile & behaviour",
      "About",
      "Availability",
      "Danger zone",
    ]);
    expect(sheet).toMatch(
      /\{canConfigure \? \(\s*<SheetSection title="Work Zone">\s*<WorkZoneProfileSection agent=\{agent\} \/>/,
    );
  });
});
