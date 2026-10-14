import { describe, expect, it } from "vitest";
import {
  AgentChannelWorkZoneProjects,
  AgentChannelWorkZoneProjectsResponse,
  AgentChannelWorkZonePropose,
  AgentChannelWorkZoneProposeResponse,
  ApprovalView,
  BUILTIN_TOOLS,
  isApprovableTool,
  isDangerousToolName,
  KNOWN_APPROVAL_KINDS,
  WORK_ZONE_PROPOSAL_LIMITS,
  WORK_ZONE_START_KIND,
  WorkPrompt,
  WorkZoneProposalRefusal,
  WorkZoneProposalView,
  WorkZoneStartBlock,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-14T10:00:00.000Z";

describe("Work Zone proposal contracts (D-03, P-08)", () => {
  it("names the kind and the limits", () => {
    expect(WORK_ZONE_START_KIND).toBe("work_zone.start");
    expect(KNOWN_APPROVAL_KINDS).toContain(WORK_ZONE_START_KIND);
    expect(WORK_ZONE_PROPOSAL_LIMITS).toEqual({
      promptChars: 50_000,
      pendingPerRequester: 3,
      pendingTtlMs: 24 * 60 * 60 * 1000,
      excerptChars: 500,
    });
  });

  const propose = {
    eventId: ID,
    agentId: ID2,
    projectId: ID,
    deviceId: ID2,
    prompt: "Fix the rounding error",
  };

  it("a proposal is project, device, prompt and an optional runtime: never a mode, a model or a person", () => {
    expect(AgentChannelWorkZonePropose.parse(propose)).toEqual(propose);
    expect(AgentChannelWorkZonePropose.parse({ ...propose, runtime: "codex" }).runtime).toBe("codex");
    expect(AgentChannelWorkZonePropose.parse({ ...propose, prompt: "  Fix it  " }).prompt).toBe("Fix it");
    for (const extra of [
      { permissionMode: "fullAccess" },
      { mode: "acceptEdits" },
      { model: "gpt-5" },
      { fullAccess: true },
      { userId: ID },
    ]) {
      expect(
        AgentChannelWorkZonePropose.safeParse({ ...propose, ...extra }).success,
        Object.keys(extra)[0],
      ).toBe(false);
    }
    expect(AgentChannelWorkZonePropose.safeParse({ ...propose, prompt: "" }).success).toBe(false);
    expect(AgentChannelWorkZonePropose.safeParse({ ...propose, prompt: " \n\t " }).success).toBe(false);
    expect(AgentChannelWorkZonePropose.safeParse({ ...propose, prompt: "x".repeat(50_000) }).success).toBe(
      true,
    );
    expect(AgentChannelWorkZonePropose.safeParse({ ...propose, prompt: "x".repeat(50_001) }).success).toBe(
      false,
    );
    expect(AgentChannelWorkZonePropose.safeParse({ ...propose, runtime: "cursor" }).success).toBe(false);
  });

  const project = (i: number, runtimes = 2) => ({
    projectId: ID,
    name: `billing-api-${i}`,
    device: { id: ID2, name: "MacBook Pro", online: true },
    runtimes: Array.from({ length: runtimes }, (_, r) => ({
      id: r % 2 === 0 ? "claude-code" : "codex",
      label: r % 2 === 0 ? "Claude Code" : "Codex",
      available: true,
    })),
  });

  it("the project listing names the turn only, and is bounded with no host path", () => {
    expect(AgentChannelWorkZoneProjects.parse({ eventId: ID, agentId: ID2 })).toEqual({
      eventId: ID,
      agentId: ID2,
    });
    expect(AgentChannelWorkZoneProjects.safeParse({ eventId: ID, agentId: ID2, userId: ID }).success).toBe(
      false,
    );
    const ok = AgentChannelWorkZoneProjectsResponse.parse({ projects: [project(1)] });
    expect(ok.projects[0]).not.toHaveProperty("path");
    expect(
      AgentChannelWorkZoneProjectsResponse.safeParse({
        projects: Array.from({ length: 51 }, (_, i) => project(i)),
      }).success,
    ).toBe(false);
    expect(AgentChannelWorkZoneProjectsResponse.safeParse({ projects: [project(1, 5)] }).success).toBe(false);
    const withPath = AgentChannelWorkZoneProjectsResponse.parse({
      projects: [
        { ...project(1), path: "/Users/ana/billing-api", device: { ...project(1).device, root: "/Users" } },
      ],
    });
    expect(withPath.projects[0]).not.toHaveProperty("path");
    expect(withPath.projects[0]?.device).not.toHaveProperty("root");
  });

  it("refusals are a fixed list; the response is an approval or a refusal", () => {
    expect(WorkZoneProposalRefusal.options).toEqual([
      "unknown_turn",
      "not_in_turn",
      "tainted",
      "cap_reached",
      "not_allowed",
      "prompt_not_allowed",
      "project_not_found",
      "device_not_shared",
      "device_offline",
      "runtime_unavailable",
      "too_many_pending",
    ]);
    expect(AgentChannelWorkZoneProposeResponse.parse({ approvalId: ID, created: true })).toEqual({
      approvalId: ID,
      created: true,
    });
    expect(AgentChannelWorkZoneProposeResponse.parse({ refused: "tainted" })).toEqual({ refused: "tainted" });
    expect(AgentChannelWorkZoneProposeResponse.safeParse({ refused: "nope" }).success).toBe(false);
    expect(WorkZoneStartBlock.options).toEqual([
      "device_offline",
      "runtime_unavailable",
      "device_not_shared",
      "project_not_found",
      "not_allowed",
    ]);
  });

  const view = {
    type: "work_zone_proposal",
    title: "Start a session in billing-api",
    project: { id: ID, name: "billing-api", removed: false },
    device: { id: ID2, name: "MacBook Pro", online: true, usable: true },
    runtime: { id: "claude-code", label: "Claude Code", available: true },
    mode: "default",
    prompt: "Fix the rounding error in invoice totals.",
    agent: { id: ID2, displayName: "Scout" },
    requestedFor: { id: ID, displayName: "Ana Pérez" },
    origin: { kind: "dm", name: null },
    workSessionId: null,
    startBlocked: null,
  };

  it("the proposal view's mode is always default; it is an approval view", () => {
    expect(WorkZoneProposalView.parse(view).mode).toBe("default");
    expect(WorkZoneProposalView.safeParse({ ...view, mode: "fullAccess" }).success).toBe(false);
    expect(WorkZoneProposalView.safeParse({ ...view, mode: "acceptEdits" }).success).toBe(false);
    expect(ApprovalView.parse(view).type).toBe("work_zone_proposal");
    expect(
      ApprovalView.parse({ ...view, workSessionId: ID, startBlocked: "device_offline", origin: null }).type,
    ).toBe("work_zone_proposal");
    expect(ApprovalView.safeParse({ ...view, prompt: "x".repeat(50_001) }).success).toBe(false);
  });

  it("the two Work Zone tools are built-ins: never dangerous, never approvable", () => {
    expect(BUILTIN_TOOLS.workZoneProjects).toBe("ocw_work_zone_projects");
    expect(BUILTIN_TOOLS.startWorkZone).toBe("ocw_start_work_zone");
    for (const t of [BUILTIN_TOOLS.workZoneProjects, BUILTIN_TOOLS.startWorkZone]) {
      expect(isDangerousToolName(t), t).toBe(false);
      expect(isApprovableTool(t), t).toBe(false);
    }
  });

  const prompt = {
    id: ID,
    workSessionId: ID,
    authorUserId: ID,
    authorName: "Ana Pérez",
    originDeviceId: null,
    body: "Fix it",
    status: "queued",
    position: 0,
    createdAt: NOW,
    dispatchedAt: null,
    completedAt: null,
    attachments: [],
  };

  it("a prompt names the bot that proposed it; older prompts parse as proposed by nobody", () => {
    expect(WorkPrompt.parse(prompt).proposedBy).toBeNull();
    expect(
      WorkPrompt.parse({ ...prompt, proposedBy: { agentId: ID2, displayName: "Scout" } }).proposedBy,
    ).toEqual({
      agentId: ID2,
      displayName: "Scout",
    });
    expect(
      WorkPrompt.safeParse({ ...prompt, proposedBy: { agentId: "x", displayName: "Scout" } }).success,
    ).toBe(false);
  });
});
