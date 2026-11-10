import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  type Agent,
  BOT_WORK_ZONE_LIMITS,
  type BotWorkZoneProfileInput,
  type BotWorkZoneProfileView,
  type Device,
  type ModelControl,
  OUTSIDE_CONTENT_WARNING,
  type Project,
  type RuntimeControls,
} from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ApiRequestError, api } from "@/lib/api";
import { botWorkZoneKeys, removeProfileMutation, saveProfileMutation } from "@/lib/bot-work-zone-queries";
import { wzKeys } from "@/lib/workzone-queries";
import { onRadioGroupKeyDown } from "../work-zone/new-session-sections";
import {
  addable,
  FAST_MODE_OPTIONS,
  fieldError,
  filterProjects,
  LIMIT_FIELDS,
  newDraft,
  offerFrom,
  RemoveProfileButton,
  RuntimeChoice,
  reconcile,
  toProfileInput,
  WORK_ZONE_COPY,
  WorkZoneProfileEditor,
  WorkZoneProfileSection,
  withDefaultMode,
  withMaxMode,
} from "./work-zone-profile-section";

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

/** The markup inside the first element with `data-testid` = `id`, up to the end of the document. */
const from = (html: string, id: string) => {
  const at = html.indexOf(`data-testid="${id}"`);
  return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1);
};

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
  it("shows the Work Zone section only with bot.configure, after Consulting other bots (which stays right after Capabilities); nothing else moves", () => {
    const sheet = readFileSync(join(__dirname, "bot-detail-sheet.tsx"), "utf8");
    const titles = [...sheet.matchAll(/<SheetSection title="([^"]+)"/g)].map((m) => m[1]);
    expect(titles).toEqual([
      "Connections",
      "Who can use it",
      "Capabilities",
      "Consulting other bots",
      "Work Zone",
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

// ---------------------------------------------------------------- Task 2: every field within the caller's controls

function model(over: Partial<ModelControl> & Pick<ModelControl, "id" | "displayName">): ModelControl {
  return {
    available: true,
    reason: null,
    detail: null,
    description: null,
    resolvedModel: null,
    legacy: false,
    isDefault: false,
    badge: null,
    efforts: [],
    defaultEffort: null,
    contextWindows: [],
    defaultContextWindow: null,
    fastMode: { available: false, reason: "runtime", detail: null, supported: false },
    supportsAutoMode: false,
    imageInput: true,
    ...over,
  } as ModelControl;
}

const option = <V,>(value: V, reason: ModelControl["reason"] = null) => ({
  value,
  available: reason === null,
  reason,
  detail: null,
});

const RICH: RuntimeControls = {
  runtime: "codex",
  catalog: { runtimeVersion: "0.60.0", collectedAt: T },
  models: [
    model({
      id: "gpt-5",
      displayName: "GPT-5",
      isDefault: true,
      efforts: [
        { ...option("low"), description: null },
        { ...option("medium"), description: null },
        { ...option("high", "org_policy"), description: null },
      ],
      contextWindows: [option(200_000), option(1_000_000, "runtime")],
      fastMode: { available: true, reason: null, detail: null, supported: true },
    }),
    model({ id: "gpt-4", displayName: "GPT-4", available: false, reason: "org_policy", legacy: true }),
    model({ id: "gpt-x", displayName: "GPT-X", available: false, reason: "not_confirmed" }),
  ],
  otherRuntimes: [],
  permissionModes: [
    option("default" as const),
    option("acceptEdits" as const),
    option("auto" as const, "not_confirmed"),
    option("fullAccess" as const, "device_opt_in"),
    option("plan" as const),
  ],
  fastModeCost: null,
};

function editor(
  view: BotWorkZoneProfileView,
  initial?: Parameters<typeof WorkZoneProfileEditor>[0]["initial"],
  controls: RuntimeControls = RICH,
): string {
  const qc = client(view);
  qc.setQueryData(wzKeys.runtimeControls(MAC, "codex"), controls);
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <WorkZoneProfileEditor agent={SCOUT_AGENT} view={view} devices={DEVICES} initial={initial} />
    </QueryClientProvider>,
  );
}

const active = () => saved({ active: true, reason: null, sentence: null });

describe("the offer: the caller's live controls for the device and runtime (Task 2)", () => {
  it("lists the models; unavailable ones are disabled with their reason, unconfirmed ones are not shown", () => {
    const offer = offerFrom(RICH);
    expect(offer.models.map((m) => [m.value, m.label, m.available, m.reason])).toEqual([
      ["gpt-5", "GPT-5", true, null],
      ["gpt-4", "GPT-4", false, "Not allowed by your organization"],
    ]);
    expect(offer.efforts.map((e) => [e.value, e.label, e.available, e.reason])).toEqual([
      ["low", "Low", true, null],
      ["medium", "Medium", true, null],
      ["high", "High", false, "Not allowed by your organization"],
    ]);
    expect(offer.contextWindows.map((c) => [c.value, c.label, c.available, c.reason])).toEqual([
      [200_000, "200k", true, null],
      [1_000_000, "1M", false, "Codex does not offer this here"],
    ]);
    expect(offer.fast).toEqual({ available: true, reason: null });
    expect(FAST_MODE_OPTIONS.map((o) => o.label)).toEqual(["Off", "Bot may turn it on", "On"]);
  });

  it("Full access keeps its warning style and is disabled with the reason; unconfirmed modes are not shown", () => {
    const modes = offerFrom(RICH).modes;
    expect(modes.map((m) => m.value)).toEqual(["default", "acceptEdits", "fullAccess", "plan"]);
    const full = modes.find((m) => m.value === "fullAccess");
    expect(full).toMatchObject({ label: "Full access", available: false, warning: true });
    expect(full?.reason).toBe(
      "Full access is off on this device. Its owner can turn it on in the desktop app.",
    );
    expect(modes.find((m) => m.value === "default")?.label).toBe("Supervised");
  });

  it("“Bot may also use” never offers an unavailable value, the default or one already chosen", () => {
    const offer = offerFrom(RICH);
    expect(addable(offer.models, [], null).map((m) => m.value)).toEqual(["gpt-5"]);
    expect(addable(offer.models, [], "gpt-5")).toEqual([]);
    expect(addable(offer.efforts, ["low"], null).map((e) => e.value)).toEqual(["medium"]);
  });

  it("another device or runtime drops what it no longer offers, and names it", () => {
    const base = newDraft(DEVICES);
    if (!base) throw new Error("no draft");
    const draft = {
      ...base,
      defaultModel: "gpt-5",
      allowedModels: ["gpt-4", "gpt-5"],
      defaultEffort: "high",
      allowedEfforts: ["low", "high"],
      defaultContextWindow: 1_000_000,
      allowedContextWindows: [200_000],
      fastMode: "on" as const,
      defaultMode: "fullAccess" as const,
      maxMode: "fullAccess" as const,
    };
    const { draft: next, removed } = reconcile(draft, offerFrom(RICH));
    expect(next).toMatchObject({
      defaultModel: "gpt-5",
      allowedModels: ["gpt-5"],
      defaultEffort: null,
      allowedEfforts: ["low"],
      defaultContextWindow: null,
      allowedContextWindows: [200_000],
      fastMode: "on",
      defaultMode: "default",
      maxMode: "default",
    });
    expect(removed).toEqual(["GPT-4", "High", "1M", "Full access"]);
    // Nothing to drop: the same draft back and no names.
    expect(reconcile(next, offerFrom(RICH))).toEqual({ draft: next, removed: [] });
    // A device whose only model offers no fast mode, effort or window: all three go, and are named.
    const noFast = { ...RICH, models: [model({ id: "gpt-5", displayName: "GPT-5" })] };
    expect(reconcile(next, offerFrom(noFast))).toMatchObject({
      draft: { fastMode: "off", allowedEfforts: [], allowedContextWindows: [] },
      removed: ["Low", "200k", "Fast mode"],
    });
  });

  it("a default mode above the highest raises the highest to it; a lower highest lowers the default", () => {
    const base = newDraft(DEVICES);
    if (!base) throw new Error("no draft");
    expect(withDefaultMode(base, "acceptEdits")).toMatchObject({
      defaultMode: "acceptEdits",
      maxMode: "acceptEdits",
    });
    const high = { ...base, defaultMode: "acceptEdits" as const, maxMode: "fullAccess" as const };
    expect(withDefaultMode(high, "default")).toMatchObject({ defaultMode: "default", maxMode: "fullAccess" });
    expect(withMaxMode(high, "default")).toMatchObject({ defaultMode: "default", maxMode: "default" });
  });
});

describe("the form (Task 2)", () => {
  it("renders every group with the current values: models, options, modes, worktree and the three limits", () => {
    const html = editor(active());
    for (const id of [
      "work-zone-default-model",
      "work-zone-allowed-models",
      "work-zone-default-effort",
      "work-zone-allowed-efforts",
      "work-zone-default-context",
      "work-zone-allowed-contexts",
      "work-zone-fast",
      "work-zone-default-mode",
      "work-zone-max-mode",
      "work-zone-worktree",
    ]) {
      expect(tagsOf(html, id), id).toHaveLength(1);
    }
    expect(text(from(html, "work-zone-default-model"))).toContain("Runtime default");
    expect(text(from(html, "work-zone-fast"))).toContain("Off");
    expect(text(from(html, "work-zone-default-mode"))).toContain("Supervised");
    // No default and nothing listed: the API lets the bot use any model the device offers.
    expect(text(html)).toContain("Any model this device offers");
    expect(tagsOf(html, "work-zone-worktree")[0]).toContain('aria-checked="true"');
  });

  it("the limits are number fields bounded by BOT_WORK_ZONE_LIMITS", () => {
    expect(LIMIT_FIELDS.map((f) => [f.key, f.min, f.max])).toEqual([
      ["maxConcurrent", 1, BOT_WORK_ZONE_LIMITS.maxConcurrentMax],
      ["promptsPerHour", 1, BOT_WORK_ZONE_LIMITS.promptsPerHourMax],
      ["wakesPerSessionDay", 0, BOT_WORK_ZONE_LIMITS.wakesPerSessionDayMax],
    ]);
    expect([BOT_WORK_ZONE_LIMITS.maxConcurrentMax, BOT_WORK_ZONE_LIMITS.promptsPerHourMax]).toEqual([
      10, 120,
    ]);
    expect(BOT_WORK_ZONE_LIMITS.wakesPerSessionDayMax).toBe(100);
    const html = editor(active());
    for (const [key, value] of [
      ["maxConcurrent", 2],
      ["promptsPerHour", 30],
      ["wakesPerSessionDay", 20],
    ] as const) {
      const input = tagsOf(html, `work-zone-limit-${key}`)[0] ?? "";
      const f = LIMIT_FIELDS.find((x) => x.key === key);
      expect(input).toContain('type="number"');
      expect(input).toContain(`min="${f?.min}"`);
      expect(input).toContain(`max="${f?.max}"`);
      expect(input).toContain(`value="${value}"`);
    }
  });

  it("an admin gets the switch with the warning in an amber callout; others read the value", () => {
    const admin = active();
    admin.viewerCan = { edit: true, setOutsideContent: true };
    const html = editor(admin);
    expect(tagsOf(html, "work-zone-outside-switch")).toHaveLength(1);
    expect(text(from(html, "work-zone-outside-warning"))).toContain(OUTSIDE_CONTENT_WARNING.slice(0, 60));
    expect(tagsOf(html, "work-zone-outside-warning")[0]).toContain("amber");

    const lead = editor(active());
    expect(tagsOf(lead, "work-zone-outside-switch")).toHaveLength(0);
    const row = text(from(lead, "work-zone-outside"));
    expect(row).toContain("Off");
    expect(row).toContain(WORK_ZONE_COPY.adminOnly);
    expect(WORK_ZONE_COPY.adminOnly).toBe("Only an admin can change this");
  });

  it("a refused save marks its field with the API's message and keeps the form", () => {
    const refused = new ApiRequestError(400, "invalid_work_zone_profile", "GPT-4 is not available to you", {
      field: "allowedModels",
    });
    expect(fieldError(refused)).toEqual({ field: "allowedModels", message: "GPT-4 is not available to you" });
    const flag = new ApiRequestError(403, "outside_content_admin_only", "Only an admin can change whether …");
    expect(fieldError(flag)).toEqual({
      field: "actOnOutsideContent",
      message: "Only an admin can change whether …",
    });
    expect(fieldError(new ApiRequestError(500, "internal", "boom"))).toBeNull();

    const html = editor(active(), {
      errors: {
        allowedModels: "GPT-4 is not available to you",
        actOnOutsideContent: "Only an admin can change whether …",
      },
    });
    expect(text(from(html, "work-zone-allowed-models-field"))).toContain("GPT-4 is not available to you");
    expect(text(from(html, "work-zone-outside"))).toContain("Only an admin can change whether …");
    expect(tagsOf(html, "work-zone-save")).toHaveLength(1);
  });

  it("offers a filter above 8 projects, matching the repository or its team project", () => {
    expect(tagsOf(editor(active()), "work-zone-projects-filter")).toHaveLength(0);
    const many = Array.from({ length: 9 }, (_, i) =>
      project(`01a11635-d6e7-7c87-9f17-00000000010${i}`, `repo-${i}`, MAC, i === 0),
    );
    const qc = client(active());
    qc.setQueryData(wzKeys.projects, { projects: many });
    qc.setQueryData(wzKeys.runtimeControls(MAC, "codex"), RICH);
    const html = renderToStaticMarkup(
      <QueryClientProvider client={qc}>
        <WorkZoneProfileEditor agent={SCOUT_AGENT} view={active()} devices={DEVICES} />
      </QueryClientProvider>,
    );
    const filter = tagsOf(html, "work-zone-projects-filter")[0] ?? "";
    expect(filter).toContain('aria-label="Filter projects"');
    expect(filter).toContain("max-md:h-11");
    expect(filterProjects(many, "REPO-3").map((p) => p.name)).toEqual(["repo-3"]);
    expect(filterProjects(many, "customer").map((p) => p.name)).toEqual(["repo-0"]);
    expect(filterProjects(many, "  ")).toHaveLength(9);
  });

  it("shows what a device or runtime change removed in a muted line", () => {
    const html = editor(active(), { removed: ["GPT-4", "High"] });
    expect(text(from(html, "work-zone-removed"))).toContain("Removed: GPT-4, High");
  });

  it("Remove profile asks once, then DELETE answers the empty state", async () => {
    const button = (confirming: boolean) =>
      text(
        renderToStaticMarkup(
          <RemoveProfileButton confirming={confirming} pending={false} onClick={() => {}} />,
        ),
      );
    expect(button(false)).toBe(WORK_ZONE_COPY.remove);
    expect(button(true)).toBe(WORK_ZONE_COPY.confirmRemove);
    expect([WORK_ZONE_COPY.remove, WORK_ZONE_COPY.confirmRemove]).toEqual([
      "Remove profile",
      "Confirm remove",
    ]);
    vi.mocked(api.del).mockResolvedValue(EMPTY);
    const qc = client(active());
    await new MutationObserver(qc, removeProfileMutation(qc, SCOUT)).mutate();
    expect(api.del).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.del).mock.calls[0]?.[0]).toBe(`/api/v1/agents/${SCOUT}/work-zone-profile`);
    expect(qc.getQueryData(botWorkZoneKeys.profile(SCOUT))).toEqual(EMPTY);
    expect(text(from(render(EMPTY, qc), "work-zone-status"))).toContain(WORK_ZONE_COPY.empty);
  });
});

// ---------------------------------------------------------------- Task 3: touch, keyboard, screen reader, both themes

/** A profile with a chip in every "Bot may also use" list, Full access as the highest mode, seen by an admin. */
function full(): BotWorkZoneProfileView {
  const v = active();
  if (!v.profile) throw new Error("no profile");
  v.profile = {
    ...v.profile,
    allowedModels: ["gpt-5"],
    allowedEfforts: ["low"],
    allowedContextWindows: [200_000],
    maxMode: "fullAccess",
  };
  v.viewerCan = { edit: true, setOutsideContent: true };
  return v;
}

const SOURCE = readFileSync(join(__dirname, "work-zone-profile-section.tsx"), "utf8");

describe("keyboard, touch and screen reader (Task 3)", () => {
  it("every control has an accessible name", () => {
    const html = editor(full());
    const labelled = new Set([...html.matchAll(/<label[^>]*for="([^"]+)"/g)].map((m) => m[1]));
    const ids = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
    const unnamed: string[] = [];
    // Buttons (and Select triggers): a label, a labelledby that exists, a <label for>, or their own text.
    for (const m of html.matchAll(/<button([^>]*)>([\s\S]*?)<\/button>/g)) {
      const tag = m[1] ?? "";
      const by = tag.match(/aria-labelledby="([^"]+)"/)?.[1];
      const id = tag.match(/\sid="([^"]+)"/)?.[1];
      const named =
        /aria-label="[^"]+"/.test(tag) ||
        (!!by && ids.has(by)) ||
        (!!id && labelled.has(id)) ||
        text(m[2] ?? "") !== "";
      if (!named) unnamed.push(tag.slice(0, 120));
    }
    // Switches and number inputs.
    for (const m of html.matchAll(/<(?:span|button|input)([^>]*(?:role="switch"|type="number")[^>]*)>/g)) {
      const tag = m[1] ?? "";
      const by = tag.match(/aria-labelledby="([^"]+)"/)?.[1];
      const id = tag.match(/\sid="([^"]+)"/)?.[1];
      if (!(/aria-label="[^"]+"/.test(tag) || (!!by && ids.has(by)) || (!!id && labelled.has(id)))) {
        unnamed.push(tag.slice(0, 120));
      }
    }
    expect(unnamed).toEqual([]);
    // The chips name what they remove.
    expect(html).toContain('aria-label="Remove GPT-5"');
    expect(html).toContain('aria-label="Remove Low"');
    expect(html).toContain('aria-label="Remove 200k"');
  });

  it("the runtime is a radio group moved with the arrow keys; the status is a polite live region", () => {
    const element = RuntimeChoice({
      labelId: "rt",
      value: "codex",
      device: DEVICES[2] ?? null,
      disabled: false,
      onChange: () => {},
    });
    expect(element.props.role).toBe("radiogroup");
    expect(element.props["aria-labelledby"]).toBe("rt");
    expect(element.props.onKeyDown).toBe(onRadioGroupKeyDown);
    const status = tagsOf(editor(full()), "work-zone-status")[0] ?? "";
    expect(status).toContain('aria-live="polite"');
    expect(status).toContain('role="status"');
  });

  it("at 390 every control is full width and 44 px tall; the limits stack; long names truncate with a title", () => {
    const html = editor(full());
    for (const id of [
      "work-zone-device",
      "work-zone-default-model",
      "work-zone-allowed-models",
      "work-zone-fast",
      "work-zone-default-mode",
      "work-zone-max-mode",
      "work-zone-limit-maxConcurrent",
      "work-zone-save",
      "work-zone-remove",
    ]) {
      const tag = tagsOf(html, id)[0] ?? "";
      expect(tag, id).toContain("w-full");
      expect(tag, id).toMatch(/max-md:h-11|max-md:min-h-11/);
    }
    const chip = html.match(/<button[^>]*aria-label="Remove GPT-5"[^>]*>/)?.[0] ?? "";
    expect(chip).toContain("max-md:size-11");
    expect(html).toContain("grid grid-cols-1 gap-4 md:grid-cols-3");
    expect(html).toMatch(/<span[^>]*title="web-app"[^>]*>web-app<\/span>/);
    expect(html).toMatch(/<span[^>]*title="Customer portal"/);
    expect(SOURCE.match(/max-md:h-11|max-md:min-h-11/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("uses theme tokens and the amber/emerald pairs only, each with its dark variant; no raw hex", () => {
    expect(SOURCE.match(/#[0-9a-fA-F]{6}\b/g) ?? []).toEqual([]);
    expect(SOURCE.match(/#[0-9a-fA-F]{3}\b/g) ?? []).toEqual([]);
    // Every class string that sets an amber or emerald text colour also sets its dark variant.
    for (const cls of SOURCE.match(/"[^"]*\btext-(?:amber|emerald)-\d{3}[^"]*"/g) ?? []) {
      expect(cls, cls).toMatch(/dark:text-(?:amber|emerald)-\d{3}/);
    }
  });
});
