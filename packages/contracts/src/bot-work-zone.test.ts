import { describe, expect, it } from "vitest";
import type { z } from "zod";
import { AgentCard } from "./agent-cards";
import {
  AgentChannelWorkSessionPrompt,
  AgentChannelWorkSessionPromptResponse,
  AgentChannelWorkSessionRead,
  AgentChannelWorkSessionReadResponse,
  AgentChannelWorkSessionStart,
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionStop,
  AgentChannelWorkSessionStopResponse,
  AgentChannelWorkSessionDownload,
  AgentChannelWorkSessionDownloadResponse,
  AgentChannelWorkSessionUpload,
  AgentChannelWorkSessionUploadResponse,
  BOT_PROFILE_STATUS_SENTENCES,
  BOT_WORK_SESSION_PROPOSED_SENTENCE,
  BOT_WORK_SESSION_SENTENCES,
  BOT_WORK_ZONE_LIMITS,
  BotFastMode,
  BotProfileInactiveReason,
  BotWorkSessionReadModel,
  BotWorkSessionRefusal,
  BotWorkZoneProfile,
  BotWorkZoneProfileInput,
  BotWorkZoneProfileView,
  DeviceBotConsentsView,
  OUTSIDE_CONTENT_WARNING,
  SetDeviceBotConsentRequest,
  TurnWorkZone,
  WORK_SESSION_CARD_LABELS,
  WorkSessionDecider,
  workSessionCardOf,
  workSessionCardStatus,
  workSessionStepLabel,
} from "./bot-work-zone";
import { RUNTIME_BYPASS_LITERALS, type WorkSessionStatus } from "./session-events";

const EVENT = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f01";
const AGENT = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f02";
const PROJECT = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f03";
const PROJECT_2 = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f04";
const DEVICE = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f05";
const SESSION = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f06";
const CARD = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f07";
const APPROVAL = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f08";

/** The hub's fixture offer: Claude Code on one device, two projects, Full access as the ceiling. */
const WORK_ZONE_FIXTURE = {
  runtime: "claude-code",
  device: { id: DEVICE, name: "build-server", online: true },
  projects: [
    { id: PROJECT, name: "billing-api" },
    { id: PROJECT_2, name: "web" },
  ],
  projectsMore: 0,
  models: ["claude-sonnet-4-5", "claude-opus-4-1"],
  defaultModel: "claude-sonnet-4-5",
  efforts: ["low", "high"],
  fastMode: "allowed",
  defaultMode: "default",
  maxMode: "fullAccess",
  outsideContent: false,
  sessions: [{ id: SESSION, status: "running", projectName: "billing-api" }],
};

describe("bot Work Zone limits and offer (07.16 D-05, PD-17, PD-22)", () => {
  it("the limits are the hub's (A-06 defaults)", () => {
    expect(BOT_WORK_ZONE_LIMITS).toEqual({
      projectsMax: 50,
      turnProjects: 20,
      allowedValuesMax: 20,
      maxConcurrentDefault: 2,
      maxConcurrentMax: 10,
      promptsPerHourDefault: 30,
      promptsPerHourMax: 120,
      wakesPerSessionDayDefault: 20,
      wakesPerSessionDayMax: 100,
      orgSessionsDefault: 10,
      orgSessionsMax: 1000,
      promptChars: 50_000,
      readOutputChars: 6_000,
      readTools: 10,
      readFiles: 50,
      readApprovals: 10,
      readApprovalPaths: 10,
      readMine: 20,
      deciders: 3,
      summaryChars: 500,
      errorChars: 500,
      toolSummaryChars: 200,
      turnSessions: 10,
    });
    expect([...BotFastMode.options]).toEqual(["off", "allowed", "on"]);
  });

  it("a turn's Work Zone offer parses as sent", () => {
    expect(TurnWorkZone.parse(WORK_ZONE_FIXTURE)).toEqual(WORK_ZONE_FIXTURE);
  });

  it("the offer is bounded: 20 projects, 10 sessions, a known runtime and modes", () => {
    const project = { id: PROJECT, name: "p" };
    const session = { id: SESSION, status: "idle", projectName: "p" };
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, projects: Array(20).fill(project) }).success).toBe(
      true,
    );
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, projects: Array(21).fill(project) }).success).toBe(
      false,
    );
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, sessions: Array(10).fill(session) }).success).toBe(
      true,
    );
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, sessions: Array(11).fill(session) }).success).toBe(
      false,
    );
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, runtime: "opencode" }).success).toBe(false);
    expect(
      TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, maxMode: RUNTIME_BYPASS_LITERALS[0] }).success,
    ).toBe(false);
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, projectsMore: -1 }).success).toBe(false);
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, models: Array(21).fill("m") }).success).toBe(false);
  });

  it("the offer never names a host path, a user or a URL (principle 7, P2)", () => {
    const keys = new Set<string>();
    const walk = (v: unknown) => {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === "object")
        for (const [k, inner] of Object.entries(v)) {
          keys.add(k);
          walk(inner);
        }
    };
    walk(TurnWorkZone.parse(WORK_ZONE_FIXTURE));
    for (const k of keys) expect(k).not.toMatch(/absolute|abs_path|hostPath|path|url|userId|token/i);
  });
});

describe("ocw_work_session_start body (07.16 D-05, D-07, PD-09, P6)", () => {
  const minimal = {
    eventId: EVENT,
    agentId: AGENT,
    projectId: PROJECT,
    prompt: "Fix the failing invoice test",
  };
  const full = {
    ...minimal,
    model: "claude-opus-4-1",
    effort: "high",
    fastMode: true,
    contextWindow: 200_000,
    permissionMode: "acceptEdits",
  };

  it("parses the minimal body and the body with every optional field", () => {
    expect(AgentChannelWorkSessionStart.parse(minimal)).toEqual(minimal);
    expect(AgentChannelWorkSessionStart.parse(full)).toEqual(full);
  });

  it("can never name a device, a user, a visibility, a worktree or an audience", () => {
    for (const extra of [
      { deviceId: DEVICE },
      { userId: AGENT },
      { visibility: "project" },
      { worktree: false },
      { audience: { kind: "owner" } },
    ]) {
      expect(
        AgentChannelWorkSessionStart.safeParse({ ...minimal, ...extra }).success,
        Object.keys(extra)[0],
      ).toBe(false);
    }
  });

  it("the prompt is trimmed and 1..50 000 characters", () => {
    expect(AgentChannelWorkSessionStart.parse({ ...minimal, prompt: "  go  " }).prompt).toBe("go");
    expect(AgentChannelWorkSessionStart.safeParse({ ...minimal, prompt: "   " }).success).toBe(false);
    expect(AgentChannelWorkSessionStart.safeParse({ ...minimal, prompt: "x".repeat(50_000) }).success).toBe(
      true,
    );
    expect(AgentChannelWorkSessionStart.safeParse({ ...minimal, prompt: "x".repeat(50_001) }).success).toBe(
      false,
    );
  });

  it("refuses a runtime bypass literal, an empty model and non-uuid ids", () => {
    expect(RUNTIME_BYPASS_LITERALS.length).toBeGreaterThan(0);
    for (const literal of RUNTIME_BYPASS_LITERALS) {
      expect(
        AgentChannelWorkSessionStart.safeParse({ ...minimal, permissionMode: literal }).success,
        literal,
      ).toBe(false);
      expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, defaultMode: literal }).success, literal).toBe(
        false,
      );
    }
    expect(AgentChannelWorkSessionStart.safeParse({ ...minimal, model: " " }).success).toBe(false);
    expect(AgentChannelWorkSessionStart.safeParse({ ...minimal, projectId: "billing-api" }).success).toBe(
      false,
    );
  });
});

describe("start answers, refusal codes and their sentences (07.16 D-05, D-08)", () => {
  const started = {
    kind: "started",
    workSessionId: SESSION,
    status: "provisioning",
    cardMessageId: CARD,
    model: "claude-sonnet-4-5",
    mode: "fullAccess",
    projectName: "billing-api",
  };
  const proposed = {
    kind: "proposed",
    approvalId: APPROVAL,
    reason: "outside_content",
    sentence: BOT_WORK_SESSION_PROPOSED_SENTENCE,
  };
  const refused = {
    kind: "refused",
    code: "profile_inactive",
    sentence: BOT_WORK_SESSION_SENTENCES.profile_inactive,
    reason: "sponsor_device_access",
  };

  it("the refusal codes are the hub's closed set, in order", () => {
    expect([...BotWorkSessionRefusal.options]).toEqual([
      "not_in_turn",
      "cap_reached",
      "profile_inactive",
      "project_not_allowed",
      "setting_not_allowed",
      "mode_not_allowed",
      "prompt_not_allowed",
      "too_many_sessions",
      "org_limit",
      "prompt_rate",
      "tree_busy",
      "device_offline",
      "runtime_unavailable",
      "outside_content",
      "outside_content_bypass",
      "session_output",
      "not_your_session",
      "session_ended",
      "not_allowed",
      // 07.17.1.1 (D-01 … D-13): appended, never reordered.
      "attachment_not_found",
      "path_not_allowed",
      "file_exists",
      "file_not_found",
      "not_a_file",
      "file_too_large",
      "file_cap_reached",
      "session_busy",
      "session_not_running",
      "runtime_too_old",
      "storage_unavailable",
      "transfer_failed",
      "transfer_timeout",
    ]);
    expect([...BotProfileInactiveReason.options]).toEqual([
      "bot_disabled",
      "no_consent",
      "device_revoked",
      "sponsor_inactive",
      "sponsor_not_allowed",
      "sponsor_device_access",
      "no_projects",
      "org_disabled",
    ]);
  });

  it("one fixed sentence per code, short, without placeholders, links or paths", () => {
    expect(Object.keys(BOT_WORK_SESSION_SENTENCES)).toEqual([...BotWorkSessionRefusal.options]);
    for (const s of [...Object.values(BOT_WORK_SESSION_SENTENCES), BOT_WORK_SESSION_PROPOSED_SENTENCE]) {
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(300);
      expect(s).not.toContain("{");
      expect(s).not.toContain("http");
      expect(s).not.toMatch(/\S\/\S/);
    }
    expect(BOT_WORK_SESSION_SENTENCES.outside_content_bypass).toBe(
      "After outside content, Full access runs only on an isolated server. Use a lower mode.",
    );
  });

  it("parses started, proposed and refused answers", () => {
    expect(AgentChannelWorkSessionStartResponse.parse(started)).toEqual(started);
    expect(
      AgentChannelWorkSessionStartResponse.parse({ ...started, cardMessageId: null, model: null }),
    ).toEqual({
      ...started,
      cardMessageId: null,
      model: null,
    });
    expect(AgentChannelWorkSessionStartResponse.parse(proposed)).toEqual(proposed);
    expect(AgentChannelWorkSessionStartResponse.parse(refused)).toEqual(refused);
    const setting = {
      kind: "refused",
      code: "setting_not_allowed",
      sentence: BOT_WORK_SESSION_SENTENCES.setting_not_allowed,
      field: "model",
    };
    expect(AgentChannelWorkSessionStartResponse.parse(setting)).toEqual(setting);
  });

  it("refuses an unknown code, a long sentence, an unknown field and another proposal reason", () => {
    for (const bad of [
      { ...refused, code: "quota_moved" },
      { ...refused, sentence: "x".repeat(301) },
      { ...refused, field: "worktree" },
      { ...refused, reason: "expired" },
      { ...proposed, reason: "tainted" },
      { ...started, mode: RUNTIME_BYPASS_LITERALS[2] },
      { ...started, kind: "queued" },
    ]) {
      expect(AgentChannelWorkSessionStartResponse.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
});

/** Every object key a schema can produce, walking objects, arrays, unions and wrappers (zod 4 definitions). */
function keysOf(schema: z.ZodType, out = new Set<string>()): Set<string> {
  const def = (schema as unknown as { _zod: { def: Record<string, unknown> & { type: string } } })._zod.def;
  switch (def.type) {
    case "object":
      for (const [k, inner] of Object.entries(def.shape as Record<string, z.ZodType>)) {
        out.add(k);
        keysOf(inner, out);
      }
      break;
    case "array":
      keysOf(def.element as z.ZodType, out);
      break;
    case "union":
      for (const o of def.options as z.ZodType[]) keysOf(o, out);
      break;
    case "optional":
    case "nullable":
    case "default":
    case "catch":
    case "readonly":
      keysOf(def.innerType as z.ZodType, out);
      break;
    default:
      break;
  }
  return out;
}

const PROMPT_ID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f09";
const PERSON = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f0a";

/** A read model at every bound: 6 000 characters of output, 10 tools, 50 files, 10 approvals, 3 deciders. */
const fullRead = {
  kind: "read",
  session: {
    id: SESSION,
    status: "idle",
    runtime: "claude-code",
    model: "claude-sonnet-4-5",
    mode: "acceptEdits",
    worktree: true,
    title: "Fix the invoice test",
    projectName: "billing-api",
    updatedAt: "2026-11-09T10:00:00.000Z",
  },
  queue: {
    queued: 0,
    running: 0,
    completed: 2,
    failed: 0,
    cancelled: 0,
    mine: [{ id: PROMPT_ID, status: "completed", position: 1 }],
  },
  output: {
    texts: [
      { seq: 41, text: "a".repeat(3_000) },
      { seq: 57, text: "b".repeat(3_000) },
    ],
    truncated: true,
  },
  tools: Array.from({ length: 10 }, (_, i) => ({
    name: `Edit${i}`,
    ok: i % 2 === 0 ? true : null,
    summary: "edited",
  })),
  changes: {
    files: Array.from({ length: 50 }, (_, i) => ({
      path: `src/invoices/f${i}.ts`,
      status: "modified",
      additions: 3,
      deletions: 1,
    })),
    branch: "ocw/fix-invoice-test",
    truncated: true,
  },
  approvals: Array.from({ length: 10 }, () => ({
    id: APPROVAL,
    tool: "Bash",
    paths: ["scripts/migrate.sh"],
    summary: "Run the migration script",
  })),
  deciders: Array.from({ length: 3 }, (_, i) => ({
    id: PERSON,
    handle: `p${i}`,
    displayName: `Person ${i}`,
  })),
  error: null,
  cursor: 57,
};

describe("prompt, read and stop bodies (07.16 D-05, PD-13, PD-14, P6)", () => {
  const prompt = {
    eventId: EVENT,
    agentId: AGENT,
    workSessionId: SESSION,
    prompt: "Now run the whole suite",
  };
  const read = { eventId: EVENT, agentId: AGENT, workSessionId: SESSION };
  const stop = { eventId: EVENT, agentId: AGENT, workSessionId: SESSION };

  it("parse their minimal bodies", () => {
    expect(AgentChannelWorkSessionPrompt.parse(prompt)).toEqual(prompt);
    expect(AgentChannelWorkSessionRead.parse(read)).toEqual(read);
    expect(AgentChannelWorkSessionStop.parse(stop)).toEqual(stop);
  });

  it("each refuses a user or a device", () => {
    for (const [schema, body] of [
      [AgentChannelWorkSessionPrompt, prompt],
      [AgentChannelWorkSessionRead, read],
      [AgentChannelWorkSessionStop, stop],
    ] as const) {
      expect(schema.safeParse({ ...body, userId: PERSON }).success).toBe(false);
      expect(schema.safeParse({ ...body, deviceId: DEVICE }).success).toBe(false);
    }
  });

  it("the prompt has the start's bounds; the read cursor is a non-negative integer", () => {
    expect(AgentChannelWorkSessionPrompt.parse({ ...prompt, prompt: " go " }).prompt).toBe("go");
    expect(AgentChannelWorkSessionPrompt.safeParse({ ...prompt, prompt: "" }).success).toBe(false);
    expect(AgentChannelWorkSessionPrompt.safeParse({ ...prompt, prompt: "x".repeat(50_001) }).success).toBe(
      false,
    );
    expect(AgentChannelWorkSessionRead.parse({ ...read, cursor: 0 })).toEqual({ ...read, cursor: 0 });
    expect(AgentChannelWorkSessionRead.safeParse({ ...read, cursor: -1 }).success).toBe(false);
    expect(AgentChannelWorkSessionRead.safeParse({ ...read, cursor: 1.5 }).success).toBe(false);
  });
});

describe("the redacted read model and the answers (07.16 D-05, D-10, PD-14, principle 7)", () => {
  it("parses a read model at every bound", () => {
    expect(AgentChannelWorkSessionReadResponse.parse(fullRead)).toEqual(fullRead);
    const { kind: _, ...model } = fullRead;
    expect(BotWorkSessionReadModel.parse(model)).toEqual(model);
  });

  it("an empty read: no texts, no changes, the snapshot's cursor (E9)", () => {
    const empty = {
      ...fullRead,
      output: { texts: [], truncated: false },
      tools: [],
      changes: null,
      approvals: [],
      deciders: [],
      cursor: 0,
    };
    expect(AgentChannelWorkSessionReadResponse.parse(empty)).toEqual(empty);
  });

  it("refuses output over 6 000 characters, a host path, 11 tools and 4 deciders", () => {
    const over = {
      ...fullRead,
      output: { texts: [...fullRead.output.texts, { seq: 58, text: "c" }], truncated: true },
    };
    const absoluteFile = {
      ...fullRead,
      changes: { ...fullRead.changes, files: [{ ...fullRead.changes.files[0], path: "/Users/x/repo/a.ts" }] },
    };
    const absoluteApproval = {
      ...fullRead,
      approvals: [{ ...fullRead.approvals[0], paths: ["/Users/x/repo/a.ts"] }],
    };
    const elevenTools = { ...fullRead, tools: [...fullRead.tools, fullRead.tools[0]] };
    const fourDeciders = { ...fullRead, deciders: [...fullRead.deciders, fullRead.deciders[0]] };
    for (const bad of [over, absoluteFile, absoluteApproval, elevenTools, fourDeciders]) {
      expect(AgentChannelWorkSessionReadResponse.safeParse(bad).success).toBe(false);
    }
    for (const bad of [
      { ...fullRead, error: "x".repeat(501) },
      { ...fullRead, tools: [{ name: "Edit", ok: true, summary: "x".repeat(201) }] },
      {
        ...fullRead,
        changes: { ...fullRead.changes, files: [...fullRead.changes.files, fullRead.changes.files[0]] },
      },
      { ...fullRead, approvals: [...fullRead.approvals, fullRead.approvals[0]] },
      { ...fullRead, approvals: [{ ...fullRead.approvals[0], paths: Array(11).fill("a.ts") }] },
      {
        ...fullRead,
        changes: { ...fullRead.changes, files: [{ ...fullRead.changes.files[0], path: "../etc/passwd" }] },
      },
      { ...fullRead, queue: { ...fullRead.queue, mine: Array(21).fill(fullRead.queue.mine[0]) } },
      { ...fullRead, session: { ...fullRead.session, mode: RUNTIME_BYPASS_LITERALS[0] } },
    ]) {
      expect(AgentChannelWorkSessionReadResponse.safeParse(bad).success).toBe(false);
    }
  });

  it("a decider is an id, a handle and a name", () => {
    const decider = { id: PERSON, handle: "ana", displayName: "Ana" };
    expect(WorkSessionDecider.parse(decider)).toEqual(decider);
    expect(WorkSessionDecider.safeParse({ ...decider, handle: "x".repeat(65) }).success).toBe(false);
  });

  it("prompt and stop answers parse queued, stopped and refused", () => {
    const queued = {
      kind: "queued",
      workSessionId: SESSION,
      promptId: PROMPT_ID,
      position: 2,
      status: "queued",
    };
    const stopped = { kind: "stopped", workSessionId: SESSION };
    const refused = {
      kind: "refused",
      code: "not_your_session",
      sentence: BOT_WORK_SESSION_SENTENCES.not_your_session,
    };
    expect(AgentChannelWorkSessionPromptResponse.parse(queued)).toEqual(queued);
    expect(AgentChannelWorkSessionPromptResponse.parse(refused)).toEqual(refused);
    expect(AgentChannelWorkSessionStopResponse.parse(stopped)).toEqual(stopped);
    expect(AgentChannelWorkSessionStopResponse.parse(refused)).toEqual(refused);
    expect(AgentChannelWorkSessionReadResponse.parse(refused)).toEqual(refused);
    expect(AgentChannelWorkSessionPromptResponse.safeParse({ ...queued, status: "waiting" }).success).toBe(
      false,
    );
    expect(AgentChannelWorkSessionStopResponse.safeParse(queued).success).toBe(false);
  });

  it("no key of any answer variant names a host path or a URL (principle 7, P2)", () => {
    for (const schema of [
      AgentChannelWorkSessionStartResponse,
      AgentChannelWorkSessionPromptResponse,
      AgentChannelWorkSessionStopResponse,
      AgentChannelWorkSessionReadResponse,
    ]) {
      const keys = keysOf(schema);
      expect(keys.has("kind")).toBe(true);
      for (const k of keys) expect(k).not.toMatch(/absolute|abs_path|hostPath|url/i);
    }
    expect(keysOf(AgentChannelWorkSessionReadResponse).has("cursor")).toBe(true);
  });
});

describe("profile and consent views (07.16 D-01, D-03, D-04, PD-04, PD-05, PD-06)", () => {
  const input = {
    deviceId: DEVICE,
    runtime: "claude-code",
    projectIds: [PROJECT, PROJECT_2],
    defaultModel: "claude-sonnet-4-5",
    allowedModels: ["claude-sonnet-4-5", "claude-opus-4-1"],
    defaultEffort: "high",
    allowedEfforts: ["low", "high"],
    defaultContextWindow: null,
    allowedContextWindows: [200_000],
    fastMode: "allowed",
    defaultMode: "default",
    maxMode: "fullAccess",
    worktree: true,
    maxConcurrent: 2,
    promptsPerHour: 30,
    wakesPerSessionDay: 20,
    actOnOutsideContent: false,
  };
  const { projectIds: _ids, ...rest } = input;
  const profile = {
    ...rest,
    id: CARD,
    agentId: AGENT,
    sponsor: { id: PERSON, displayName: "Ana" },
    device: { id: DEVICE, name: "build-server", online: true, hostKind: "service", isolatedServer: true },
    projects: [
      { id: PROJECT, name: "billing-api" },
      { id: PROJECT_2, name: "web" },
    ],
    actOnOutsideContentBy: null,
    actOnOutsideContentAt: null,
    updatedAt: "2026-11-09T10:00:00.000Z",
  };

  it("the profile body parses whole", () => {
    expect(BotWorkZoneProfileInput.parse(input)).toEqual(input);
    expect(
      BotWorkZoneProfileInput.parse({ ...input, wakesPerSessionDay: 0, maxConcurrent: 10 }),
    ).toBeTruthy();
  });

  it("the profile body refuses a sponsor, oversized lists, duplicates and out-of-range limits", () => {
    const projects51 = Array.from(
      { length: 51 },
      (_, i) => `0190d5e2-7c3a-7cc2-9d2e-${String(i).padStart(12, "0")}`,
    );
    for (const bad of [
      { sponsorUserId: PERSON },
      { projectIds: projects51 },
      { projectIds: [] },
      { projectIds: [PROJECT, PROJECT] },
      { allowedModels: Array(21).fill("m") },
      { maxConcurrent: 11 },
      { maxConcurrent: 0 },
      { promptsPerHour: 0 },
      { promptsPerHour: 121 },
      { wakesPerSessionDay: 101 },
      { maxMode: RUNTIME_BYPASS_LITERALS[0] },
      { fastMode: "always" },
    ]) {
      expect(
        BotWorkZoneProfileInput.safeParse({ ...input, ...bad }).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false);
    }
  });

  it("the view parses with no profile and with a full profile", () => {
    const none = {
      profile: null,
      status: { active: false, reason: null, sentence: null },
      viewerCan: { edit: true, setOutsideContent: false },
    };
    expect(BotWorkZoneProfileView.parse(none)).toEqual(none);
    const inactive = {
      profile: { ...profile, actOnOutsideContentBy: { id: PERSON, displayName: "Ana" } },
      status: { active: false, reason: "no_consent", sentence: BOT_PROFILE_STATUS_SENTENCES.no_consent },
      viewerCan: { edit: true, setOutsideContent: true },
    };
    expect(BotWorkZoneProfileView.parse(inactive)).toEqual(inactive);
    expect(BotWorkZoneProfile.parse(profile)).toEqual(profile);
    expect(
      BotWorkZoneProfile.safeParse({ ...profile, device: { ...profile.device, hostKind: "vm" } }).success,
    ).toBe(false);
  });

  it("one status sentence per inactive reason; it and the warning are short, without placeholders or links", () => {
    expect(Object.keys(BOT_PROFILE_STATUS_SENTENCES)).toEqual([...BotProfileInactiveReason.options]);
    for (const s of [...Object.values(BOT_PROFILE_STATUS_SENTENCES), OUTSIDE_CONTENT_WARNING]) {
      expect(s.length).toBeGreaterThan(0);
      expect(s.length).toBeLessThanOrEqual(300);
      expect(s).not.toContain("{");
      expect(s).not.toContain("http");
    }
    expect(OUTSIDE_CONTENT_WARNING).toContain("Full access still needs an isolated server.");
  });

  it("a consent request names only the per-bot Full access choice; the consents view parses empty and full", () => {
    expect(SetDeviceBotConsentRequest.parse({ allowFullAccess: true })).toEqual({ allowFullAccess: true });
    expect(SetDeviceBotConsentRequest.safeParse({ allowFullAccess: true, agentId: AGENT }).success).toBe(
      false,
    );
    expect(SetDeviceBotConsentRequest.safeParse({}).success).toBe(false);
    const empty = { consents: [], requests: [], viewerCan: { grant: false } };
    expect(DeviceBotConsentsView.parse(empty)).toEqual(empty);
    const full = {
      consents: [
        {
          agentId: AGENT,
          displayName: "Scout",
          handle: "scout",
          allowFullAccess: false,
          grantedBy: { id: PERSON, displayName: "Ana" },
          grantedAt: "2026-11-09T10:00:00.000Z",
        },
      ],
      requests: [
        {
          agentId: AGENT,
          displayName: "Scout",
          handle: "scout",
          sponsor: { id: PERSON, displayName: "Ana" },
          profileUpdatedAt: "2026-11-09T10:00:00.000Z",
        },
      ],
      viewerCan: { grant: true },
    };
    expect(DeviceBotConsentsView.parse(full)).toEqual(full);
  });
});

describe("live card helpers (07.16 D-12, PD-12, ADR-0031)", () => {
  it("maps every session status to the card's pill", () => {
    expect(workSessionCardStatus("provisioning")).toEqual({ status: "running" });
    expect(workSessionCardStatus("running")).toEqual({ status: "running" });
    expect(workSessionCardStatus("idle")).toEqual({ status: "info", statusLabel: "Idle" });
    expect(workSessionCardStatus("waiting_approval")).toEqual({ status: "pending", statusLabel: "Approval" });
    expect(workSessionCardStatus("host_offline")).toEqual({ status: "pending", statusLabel: "Offline" });
    expect(workSessionCardStatus("completed")).toEqual({ status: "succeeded" });
    expect(workSessionCardStatus("failed")).toEqual({ status: "failed" });
    expect(workSessionCardStatus("archived")).toEqual({ status: "cancelled", statusLabel: "Stopped" });
  });

  it("names the step of every status", () => {
    const step = (status: WorkSessionStatus, turn = 0) =>
      workSessionStepLabel({ status, turn, pendingApprovals: 0 });
    expect(step("provisioning")).toBe("Starting");
    expect(step("running", 3)).toBe("Working · turn 3");
    expect(step("waiting_approval", 2)).toBe("Waiting for approval");
    expect(step("idle", 0)).toBe("Ready");
    expect(step("idle", 2)).toBe("Turn 2 done");
    expect(step("host_offline", 2)).toBe("Device offline");
    expect(step("failed", 2)).toBe("Failed");
    expect(step("completed", 2)).toBe("Ended");
    expect(step("archived", 2)).toBe("Stopped");
  });

  const live = (over: Record<string, unknown> = {}) =>
    AgentCard.parse({
      kind: "work_zone",
      title: "Work Zone · billing-api",
      fields: [
        { label: WORK_SESSION_CARD_LABELS.runtime, value: "Claude Code" },
        { label: WORK_SESSION_CARD_LABELS.project, value: "billing-api" },
        { label: WORK_SESSION_CARD_LABELS.device, value: "build-server" },
        { label: WORK_SESSION_CARD_LABELS.model, value: "claude-sonnet-4-5" },
        { label: WORK_SESSION_CARD_LABELS.mode, value: "Full access" },
        { label: WORK_SESSION_CARD_LABELS.step, value: "Working · turn 1" },
        { label: WORK_SESSION_CARD_LABELS.updated, value: "2026-11-09T10:00:00.000Z" },
      ],
      status: "running",
      actions: [
        { kind: "open", label: "Open session", target: `/work-zone/${SESSION}` },
        { kind: "follow", label: "Follow" },
      ],
      version: 1,
      decision: null,
      updatedAt: "2026-11-09T10:00:00.000Z",
      platformOwned: true,
      ...over,
    });

  it("the labels are the hub's, in card order", () => {
    expect({ ...WORK_SESSION_CARD_LABELS }).toEqual({
      runtime: "Runtime",
      project: "Project",
      device: "Device",
      model: "Model",
      mode: "Mode",
      step: "Step",
      updated: "Updated",
    });
  });

  it("reads a platform-owned live card", () => {
    expect(workSessionCardOf(live())).toEqual({
      workSessionId: SESSION,
      runtime: "claude-code",
      project: "billing-api",
      device: "build-server",
      model: "claude-sonnet-4-5",
      mode: "Full access",
      fullAccess: true,
      step: "Working · turn 1",
      updatedAt: "2026-11-09T10:00:00.000Z",
    });
    const codex = live({
      fields: [
        { label: "Runtime", value: "Codex" },
        { label: "Mode", value: "Supervised" },
      ],
    });
    expect(workSessionCardOf(codex)).toEqual({
      workSessionId: SESSION,
      runtime: "codex",
      project: null,
      device: null,
      model: null,
      mode: "Supervised",
      fullAccess: false,
      step: null,
      updatedAt: null,
    });
  });

  it("an unknown runtime label reads as no runtime", () => {
    for (const value of ["OpenCode", "constructor", "claude-code"]) {
      expect(workSessionCardOf(live({ fields: [{ label: "Runtime", value }] }))?.runtime, value).toBeNull();
    }
  });

  it("is null for a proposal card, an agent-owned card, another kind and any other open target", () => {
    const approval = {
      id: APPROVAL,
      actionHash: "a".repeat(64),
      status: "pending",
      requestedForUserId: PERSON,
      warnings: [],
    };
    expect(workSessionCardOf(live({ approval }))).toBeNull();
    expect(workSessionCardOf(live({ platformOwned: false }))).toBeNull();
    expect(workSessionCardOf(live({ platformOwned: undefined }))).toBeNull();
    expect(workSessionCardOf(live({ kind: "report" }))).toBeNull();
    expect(
      workSessionCardOf(
        live({ actions: [{ kind: "open", label: "Review", target: `/approvals/${APPROVAL}` }] }),
      ),
    ).toBeNull();
    expect(
      workSessionCardOf(live({ actions: [{ kind: "open", label: "Open", target: "/work-zone/new" }] })),
    ).toBeNull();
    expect(workSessionCardOf(live({ actions: [{ kind: "follow", label: "Follow" }] }))).toBeNull();
  });
});

describe("upload and download bodies, answers and refusals (07.17.1.1 D-01, D-02, D-03, D-08, PD-04, PD-21, P6)", () => {
  const ATTACHMENT = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4f09";
  const ids = { eventId: EVENT, agentId: AGENT, workSessionId: SESSION };
  const upload = { ...ids, attachmentId: ATTACHMENT, path: "docs/spec.pdf" };
  const download = { ...ids, path: "README.md" };
  const MiB = 1024 * 1024;

  it("the upload body is ids and a repo-relative path, overwrite optional", () => {
    expect(AgentChannelWorkSessionUpload.parse(upload)).toEqual(upload);
    expect(AgentChannelWorkSessionUpload.parse({ ...upload, overwrite: true })).toEqual({
      ...upload,
      overwrite: true,
    });
  });

  it("the upload body never names a device, a user, a conversation, a URL, an absolute path or bytes", () => {
    for (const extra of [
      { deviceId: DEVICE },
      { userId: AGENT },
      { conversationId: PROJECT },
      { url: "https://example.test/f" },
      { absolutePath: "/Users/ana/repo/docs/spec.pdf" },
      { bytes: "aGVsbG8=" },
    ]) {
      expect(AgentChannelWorkSessionUpload.safeParse({ ...upload, ...extra }).success, Object.keys(extra)[0]).toBe(
        false,
      );
    }
    const { attachmentId: _, ...noAttachment } = upload;
    expect(AgentChannelWorkSessionUpload.safeParse(noAttachment).success).toBe(false);
    expect(AgentChannelWorkSessionUpload.safeParse({ ...upload, path: "../x" }).success).toBe(false);
    expect(AgentChannelWorkSessionUpload.safeParse({ ...upload, path: "/etc/passwd" }).success).toBe(false);
  });

  it("the download body is ids and a path, nothing else", () => {
    expect(AgentChannelWorkSessionDownload.parse(download)).toEqual(download);
    expect(AgentChannelWorkSessionDownload.safeParse({ ...download, attachmentId: ATTACHMENT }).success).toBe(false);
    expect(AgentChannelWorkSessionDownload.safeParse({ ...download, overwrite: true }).success).toBe(false);
    expect(AgentChannelWorkSessionDownload.safeParse({ ...download, deviceId: DEVICE }).success).toBe(false);
    expect(AgentChannelWorkSessionDownload.safeParse({ ...download, path: "a\\b" }).success).toBe(false);
  });

  it("the answers: uploaded, downloaded, and a refusal naming the limit and the size", () => {
    const uploaded = { kind: "uploaded", workSessionId: SESSION, path: "docs/spec.pdf", sizeBytes: 1234 };
    const downloaded = {
      kind: "downloaded",
      workSessionId: SESSION,
      attachmentId: ATTACHMENT,
      name: "README.md",
      sizeBytes: 2048,
      contentType: "text/markdown",
    };
    const tooLarge = {
      kind: "refused",
      code: "file_too_large",
      sentence: BOT_WORK_SESSION_SENTENCES.file_too_large,
      limit: { bytes: 10 * MiB, source: "bot" },
      sizeBytes: 12 * MiB,
    };
    expect(AgentChannelWorkSessionUploadResponse.parse(uploaded)).toEqual(uploaded);
    expect(AgentChannelWorkSessionUploadResponse.parse(tooLarge)).toEqual(tooLarge);
    expect(AgentChannelWorkSessionDownloadResponse.parse(downloaded)).toEqual(downloaded);
    expect(AgentChannelWorkSessionDownloadResponse.parse(tooLarge)).toEqual(tooLarge);
    expect(AgentChannelWorkSessionUploadResponse.safeParse(downloaded).success).toBe(false);
    expect(AgentChannelWorkSessionDownloadResponse.safeParse(uploaded).success).toBe(false);
    const wrongSource = { ...tooLarge, limit: { bytes: 10 * MiB, source: "user" } };
    expect(AgentChannelWorkSessionUploadResponse.safeParse(wrongSource).success).toBe(false);
    expect(AgentChannelWorkSessionDownloadResponse.safeParse(wrongSource).success).toBe(false);
    expect(AgentChannelWorkSessionUploadResponse.safeParse({ ...uploaded, path: "/abs" }).success).toBe(false);
    expect(AgentChannelWorkSessionDownloadResponse.safeParse({ ...downloaded, name: "x".repeat(256) }).success).toBe(
      false,
    );
    // 07.16 answers and refusals keep parsing without the new optional fields.
    const legacy = { kind: "refused", code: "session_ended", sentence: BOT_WORK_SESSION_SENTENCES.session_ended };
    expect(AgentChannelWorkSessionStopResponse.parse(legacy)).toEqual(legacy);
  });

  it("the 13 new codes have the hub's sentences, verbatim; the 19 07.16 sentences are unchanged", () => {
    expect({
      attachment_not_found: BOT_WORK_SESSION_SENTENCES.attachment_not_found,
      path_not_allowed: BOT_WORK_SESSION_SENTENCES.path_not_allowed,
      file_exists: BOT_WORK_SESSION_SENTENCES.file_exists,
      file_not_found: BOT_WORK_SESSION_SENTENCES.file_not_found,
      not_a_file: BOT_WORK_SESSION_SENTENCES.not_a_file,
      file_too_large: BOT_WORK_SESSION_SENTENCES.file_too_large,
      file_cap_reached: BOT_WORK_SESSION_SENTENCES.file_cap_reached,
      session_busy: BOT_WORK_SESSION_SENTENCES.session_busy,
      session_not_running: BOT_WORK_SESSION_SENTENCES.session_not_running,
      runtime_too_old: BOT_WORK_SESSION_SENTENCES.runtime_too_old,
      storage_unavailable: BOT_WORK_SESSION_SENTENCES.storage_unavailable,
      transfer_failed: BOT_WORK_SESSION_SENTENCES.transfer_failed,
      transfer_timeout: BOT_WORK_SESSION_SENTENCES.transfer_timeout,
    }).toEqual({
      attachment_not_found:
        "That attachment is not one this turn can use. Use a file attached in this thread before the request.",
      path_not_allowed:
        "That path can't be used. Name a file inside the project, outside .git, .claude, .codex and .ocw-worktrees, and not a secrets file such as .env or a private key.",
      file_exists: "That file already exists in the session. Choose another path, or set overwrite to replace it.",
      file_not_found: "There is no file at that path in the session's working tree.",
      not_a_file: "That path is not a regular file. Name one file; folders and links can't be moved.",
      file_too_large: "That file is larger than this bot may move.",
      file_cap_reached: "This turn has moved as many files as it may. Ask the person to send the request again.",
      session_busy: "The session is working. Upload when its turn is done.",
      session_not_running:
        "The session isn't running on its device. Send it a prompt to resume it, then try again.",
      runtime_too_old: "The device's runtime is too old to move files. Update it in Settings › Devices.",
      storage_unavailable: "File storage is not set up on this server, so files can't be moved.",
      transfer_failed: "The file could not be moved. Try again, or tell the person.",
      transfer_timeout: "The device did not finish moving the file in time. Try again, or try a smaller file.",
    });
    expect(BOT_WORK_SESSION_SENTENCES.not_in_turn).toBe("Work Zone sessions are not available on this turn.");
    expect(BOT_WORK_SESSION_SENTENCES.not_allowed).toBe(
      "The bot's sponsor is not allowed to do this in the Work Zone any more.",
    );
    expect(Object.keys(BOT_WORK_SESSION_SENTENCES).slice(0, 19)).toEqual([
      "not_in_turn",
      "cap_reached",
      "profile_inactive",
      "project_not_allowed",
      "setting_not_allowed",
      "mode_not_allowed",
      "prompt_not_allowed",
      "too_many_sessions",
      "org_limit",
      "prompt_rate",
      "tree_busy",
      "device_offline",
      "runtime_unavailable",
      "outside_content",
      "outside_content_bypass",
      "session_output",
      "not_your_session",
      "session_ended",
      "not_allowed",
    ]);
  });
});
