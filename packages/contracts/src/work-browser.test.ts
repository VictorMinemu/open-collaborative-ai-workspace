import { describe, expect, it } from "vitest";
import {
  AgentChannelBrowserAct,
  AgentChannelBrowserWait,
  BROWSER_LIMITS,
  BROWSER_TIMEOUTS_MS,
} from "./browser";
import { SessionEvent } from "./session-events";
import {
  browserToolFromName,
  CanonicalBrowserTool,
  CLOUD_METADATA_HOSTS,
  canonicalBrowserTool,
  claudeBrowserToolName,
  isCloudMetadataHost,
  isLoopbackHost,
  originOf,
  WORK_BROWSER_AUDIT,
  WORK_BROWSER_INPUTS,
  WORK_BROWSER_LIMITS,
  WORK_BROWSER_MCP_SERVER,
  WORK_BROWSER_REFUSAL_TEXT,
  WORK_BROWSER_SIGNIN_ROUTES,
  WORK_BROWSER_TIMEOUTS_MS,
  WorkBrowserActInput,
  WorkBrowserApprovalRequest,
  WorkBrowserCloseInput,
  WorkBrowserOpenInput,
  WorkBrowserRefusal,
  WorkBrowserScreenshotInput,
  WorkBrowserSignInInput,
  WorkBrowserSignInItem,
  WorkBrowserSignInList,
  WorkBrowserSignInUpload,
  WorkBrowserSnapshotInput,
  WorkBrowserTool,
  WorkBrowserWaitInput,
  WorkLiveClientFrame,
  WorkSessionBrowserState,
  workLivePath,
} from "./work-browser";
import { WorkApproval, WorkSession } from "./work-session";
import { DEFAULT_WORK_ZONE_POLICY, UpdateWorkZonePolicyRequest, WorkZonePolicy } from "./work-zone-policy";

const ID = "0199f0a0-0000-7000-8000-0000000000a1";
const ID2 = "0199f0a0-0000-7000-8000-0000000000b2";
const AT = "2026-11-25T10:00:00.000Z";
const turn = { eventId: ID, agentId: ID2 };

describe("tool names (PD-06)", () => {
  it("maps short, canonical and Claude names", () => {
    expect(WORK_BROWSER_MCP_SERVER).toBe("ocw_browser");
    expect(canonicalBrowserTool("open")).toBe("ocw_browser_open");
    expect(claudeBrowserToolName("signin")).toBe("mcp__ocw_browser__signin");
    expect(browserToolFromName("mcp__ocw_browser__open")).toBe("open");
    expect(browserToolFromName("ocw_browser_act")).toBe("act");
    expect(browserToolFromName("screenshot")).toBe("screenshot");
    expect(browserToolFromName("Bash")).toBeNull();
    expect(browserToolFromName("mcp__other__open")).toBeNull();
    expect(browserToolFromName("ocw_browser_eval")).toBeNull();
    expect(CanonicalBrowserTool.options).toEqual(WorkBrowserTool.options.map(canonicalBrowserTool));
    expect(Object.keys(WORK_BROWSER_INPUTS).sort()).toEqual([...WorkBrowserTool.options].sort());
  });
});

describe("tool bodies reuse the bots' fields and refinements (D-07, PD-06)", () => {
  it("act refuses what the bots' act refuses, without turn fields", () => {
    const cases: Record<string, unknown>[] = [
      { action: "type", ref: "e1" },
      { action: "click" },
      { action: "select", ref: "e4" },
      { action: "press" },
      { action: "scroll" },
      { action: "scroll", direction: "sideways" },
      { action: "evaluate", ref: "e1" },
      { action: "click", ref: "button[name=buy]" },
      { action: "click", ref: "e1", selector: "#buy" },
      { action: "type", ref: "e3", text: "x".repeat(BROWSER_LIMITS.typeMaxChars + 1) },
    ];
    for (const bad of cases) {
      expect(WorkBrowserActInput.safeParse(bad).success, JSON.stringify(bad).slice(0, 80)).toBe(false);
      expect(
        AgentChannelBrowserAct.safeParse({ ...turn, ...bad }).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false);
    }
    for (const good of [
      { action: "scroll", direction: "down" },
      { action: "click", ref: "e12" },
      { action: "type", ref: "e3", text: "hello" },
      { action: "press", key: "Enter" },
      { action: "select", ref: "e4", option: "Spain" },
    ]) {
      expect(WorkBrowserActInput.safeParse(good).success, JSON.stringify(good)).toBe(true);
      expect(AgentChannelBrowserAct.safeParse({ ...turn, ...good }).success, JSON.stringify(good)).toBe(true);
    }
    expect(WorkBrowserActInput.safeParse({ action: "scroll", direction: "down", eventId: ID }).success).toBe(
      false,
    );
  });

  it("wait refuses what the bots' wait refuses", () => {
    for (const bad of [{ for: "time" }, { for: "text" }, { for: "time", ms: 30_001 }, { for: "network" }]) {
      expect(WorkBrowserWaitInput.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
      expect(AgentChannelBrowserWait.safeParse({ ...turn, ...bad }).success, JSON.stringify(bad)).toBe(false);
    }
    expect(WorkBrowserWaitInput.safeParse({ for: "load" }).success).toBe(true);
    expect(WorkBrowserWaitInput.safeParse({ for: "text", text: "Orders" }).success).toBe(true);
  });

  it("open, snapshot, screenshot, close and sign-in are strict and bounded", () => {
    expect(WorkBrowserOpenInput.safeParse({ url: "http://localhost:3000/x" }).success).toBe(true);
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "http://u:p@localhost/",
      "chrome://settings",
    ]) {
      expect(WorkBrowserOpenInput.safeParse({ url }).success, url).toBe(false);
    }
    expect(WorkBrowserSnapshotInput.safeParse({}).success).toBe(true);
    expect(WorkBrowserSnapshotInput.safeParse({ html: true }).success).toBe(false);
    expect(WorkBrowserScreenshotInput.safeParse({ fullPage: true }).success).toBe(false);
    expect(WorkBrowserCloseInput.safeParse({}).success).toBe(true);
    expect(
      WorkBrowserSignInInput.safeParse({ host: "github.com", reason: "Open your repositories." }).success,
    ).toBe(true);
    expect(WorkBrowserSignInInput.safeParse({ host: "github.com", reason: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(WorkBrowserSignInInput.safeParse({ host: "github.com/login", reason: "r" }).success).toBe(false);
    expect(WorkBrowserSignInInput.safeParse({ host: "github.com", reason: "   " }).success).toBe(false);
  });
});

describe("limits and timeouts", () => {
  it("names the live and sign-in bounds and reuses the bots' timeouts", () => {
    expect(WORK_BROWSER_LIMITS.fps).toBe(4);
    expect(WORK_BROWSER_LIMITS.snapshotTextMax).toBe(32_000);
    expect(WORK_BROWSER_TIMEOUTS_MS.navigation).toBe(BROWSER_TIMEOUTS_MS.navigation);
    expect(WORK_BROWSER_TIMEOUTS_MS.op).toBe(BROWSER_TIMEOUTS_MS.agentOp);
    expect(WORK_BROWSER_TIMEOUTS_MS.signin).toBeGreaterThan(WORK_BROWSER_LIMITS.signinWaitMinutes * 60_000);
  });
});

describe("refusal sentences (D-09, D-20, D-32)", () => {
  it("has one short sentence per refusal", () => {
    for (const r of WorkBrowserRefusal.options) {
      const text = WORK_BROWSER_REFUSAL_TEXT[r];
      expect(text.length, r).toBeGreaterThan(0);
      expect(text.length, r).toBeLessThanOrEqual(200);
    }
    expect(WORK_BROWSER_REFUSAL_TEXT.signin_not_allowed).toBe(
      "Sign-ins work only in sessions only you can see.",
    );
    expect(WORK_BROWSER_REFUSAL_TEXT.image_model_required).toBe(
      "Screenshots need a model that accepts images.",
    );
    expect(WORK_BROWSER_REFUSAL_TEXT.paused).toBe("A person is controlling the page. Try again later.");
  });
});

describe("origins, loopback and metadata hosts (D-11, D-14, D-35)", () => {
  it("gives scheme://host:port with an explicit port", () => {
    expect(originOf("http://localhost:3000/x?y")).toBe("http://localhost:3000");
    expect(originOf("https://github.com/a")).toBe("https://github.com:443");
    expect(originOf("http://example.com")).toBe("http://example.com:80");
    expect(originOf("http://[::1]:8080/")).toBe("http://[::1]:8080");
    expect(originOf("HTTP://LocalHost:3000")).toBe("http://localhost:3000");
    expect(originOf("file:///etc/passwd")).toBeNull();
    expect(originOf("javascript:alert(1)")).toBeNull();
    expect(originOf("not a url")).toBeNull();
  });

  it("knows loopback hosts exactly", () => {
    for (const h of ["localhost", "127.0.0.1", "[::1]", "::1"]) expect(isLoopbackHost(h), h).toBe(true);
    for (const h of ["127.0.0.2", "localhost.example.com", "0.0.0.0", "example.com"]) {
      expect(isLoopbackHost(h), h).toBe(false);
    }
  });

  it("refuses cloud metadata hosts in every form", () => {
    for (const h of [
      ...CLOUD_METADATA_HOSTS,
      "169.254.169.254",
      "fd00:ec2::254",
      "[fd00:ec2::254]",
      "FD00:EC2:0:0:0:0:0:254",
      "::ffff:169.254.169.254",
      "[::ffff:a9fe:a9fe]",
      "metadata.google.internal",
      "Metadata.Google.Internal.",
      "100.100.100.200",
      "2852039166",
    ]) {
      expect(isCloudMetadataHost(h), h).toBe(true);
    }
    for (const h of ["github.com", "localhost", "169.254.169.253", "[::1]", "metadata.example.com"]) {
      expect(isCloudMetadataHost(h), h).toBe(false);
    }
  });
});

describe("approvals, live frames, sign-ins and session state", () => {
  it("bounds approval requests", () => {
    const req = { kind: "host", origin: "https://github.com:443", tool: "ocw_browser_open" } as const;
    expect(WorkBrowserApprovalRequest.safeParse(req).success).toBe(true);
    expect(WorkBrowserApprovalRequest.safeParse({ ...req, tool: "Bash" }).success).toBe(false);
    expect(WorkBrowserApprovalRequest.safeParse({ ...req, origin: "https://github.com:443/x" }).success).toBe(
      false,
    );
    expect(WorkBrowserApprovalRequest.safeParse({ ...req, reason: "x".repeat(201) }).success).toBe(false);
  });

  it("names every audit action under work_browser.", () => {
    const actions = Object.values(WORK_BROWSER_AUDIT);
    expect(actions).toHaveLength(11);
    for (const a of actions) expect(a.startsWith("work_browser."), a).toBe(true);
  });

  it("parses the live client frames and the path", () => {
    for (const f of [
      { type: "take" },
      { type: "keep" },
      { type: "release", save: true },
      { type: "text", text: "a" },
      { type: "mouse", event: "move", x: 1, y: 2, button: "none" },
    ]) {
      expect(WorkLiveClientFrame.safeParse(f).success, f.type).toBe(true);
    }
    expect(WorkLiveClientFrame.safeParse({ type: "release" }).success).toBe(false);
    expect(WorkLiveClientFrame.safeParse({ type: "resize", mode: "small" }).success).toBe(false);
    expect(workLivePath(ID)).toBe(`/api/v1/live/work-browser/${ID}`);
  });

  it("bounds sign-in DTOs and names the routes", () => {
    const upload = {
      sessionId: ID,
      origin: "https://github.com:443",
      state: { cookies: [], origins: [] },
      changed: true,
    };
    expect(WorkBrowserSignInUpload.safeParse(upload).success).toBe(true);
    expect(WorkBrowserSignInUpload.safeParse({ ...upload, path: "/x" }).success).toBe(false);
    const item = {
      id: ID,
      site: "github.com",
      scope: "work_zone",
      createdAt: AT,
      lastUsedAt: null,
      expiresAt: AT,
      status: "active",
    };
    expect(WorkBrowserSignInItem.safeParse(item).success).toBe(true);
    expect(WorkBrowserSignInItem.safeParse({ ...item, scope: "bot" }).success).toBe(false);
    expect(WorkBrowserSignInList.safeParse({ items: [item] }).success).toBe(true);
    expect(WORK_BROWSER_SIGNIN_ROUTES.list).toBe("/api/v1/work-browser/signins");
    expect(WORK_BROWSER_SIGNIN_ROUTES.upload).toBe("/api/v1/runtime/browser-signins/uploads/:uploadId");
  });

  it("shares a session's browser state without a host or a member", () => {
    expect(WorkSessionBrowserState.safeParse({ status: "available", live: true }).success).toBe(true);
    expect(WorkSessionBrowserState.safeParse({ status: "available", live: true, host: "x" }).success).toBe(
      false,
    );
  });
});

describe("policy, approvals and sessions stay additive (D-10, D-21, D-26, P2)", () => {
  const policy0718 = { ...DEFAULT_WORK_ZONE_POLICY, updatedAt: null } as Record<string, unknown>;
  delete policy0718.allowBrowser;

  it("parses a 07.18 policy and defaults the browser off", () => {
    expect(WorkZonePolicy.safeParse(policy0718).success).toBe(true);
    expect(WorkZonePolicy.parse(policy0718).allowBrowser).toBeUndefined();
    expect(DEFAULT_WORK_ZONE_POLICY.allowBrowser).toBe(false);
    expect(UpdateWorkZonePolicyRequest.safeParse({ allowBrowser: true }).success).toBe(true);
  });

  it("parses approvals and approval.requested with and without the browser request", () => {
    const browser = { kind: "signin", origin: "https://github.com:443", tool: "ocw_browser_signin" } as const;
    const approval = {
      id: ID,
      workSessionId: ID2,
      request: { tool: "mcp__ocw_browser__open", summary: "Open github.com", paths: [] },
      status: "pending",
      decidedBy: null,
      decidedByName: null,
      decision: null,
      comment: null,
      createdAt: AT,
      decidedAt: null,
    };
    expect(WorkApproval.safeParse(approval).success).toBe(true);
    expect(WorkApproval.safeParse({ ...approval, request: { ...approval.request, browser } }).success).toBe(
      true,
    );
    const ev = { type: "approval.requested", approvalId: ID, tool: "Bash", summary: "ls", paths: [] };
    expect(SessionEvent.safeParse(ev).success).toBe(true);
    expect(SessionEvent.safeParse({ ...ev, browser }).success).toBe(true);
    expect(SessionEvent.safeParse({ ...ev, browser: { ...browser, kind: "root" } }).success).toBe(false);
  });

  it("parses a session with and without the browser state", () => {
    const shape = WorkSession.shape.browser;
    expect(shape.safeParse(undefined).success).toBe(true);
    expect(shape.safeParse({ status: "update_device", live: false }).success).toBe(true);
  });
});
