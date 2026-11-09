import { describe, expect, it } from "vitest";
import type { z } from "zod";
import {
  AgentChannelWorkSessionPrompt,
  AgentChannelWorkSessionPromptResponse,
  AgentChannelWorkSessionRead,
  AgentChannelWorkSessionReadResponse,
  AgentChannelWorkSessionStart,
  AgentChannelWorkSessionStartResponse,
  AgentChannelWorkSessionStop,
  AgentChannelWorkSessionStopResponse,
  BOT_WORK_SESSION_PROPOSED_SENTENCE,
  BOT_WORK_SESSION_SENTENCES,
  BOT_WORK_ZONE_LIMITS,
  BotFastMode,
  BotProfileInactiveReason,
  BotWorkSessionReadModel,
  BotWorkSessionRefusal,
  TurnWorkZone,
  WorkSessionDecider,
} from "./bot-work-zone";

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
    expect(TurnWorkZone.safeParse({ ...WORK_ZONE_FIXTURE, maxMode: "bypassPermissions" }).success).toBe(
      false,
    );
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
    expect(
      AgentChannelWorkSessionStart.safeParse({ ...minimal, permissionMode: "bypassPermissions" }).success,
    ).toBe(false);
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
      { ...started, mode: "danger-full-access" },
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
      { ...fullRead, session: { ...fullRead.session, mode: "bypassPermissions" } },
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
