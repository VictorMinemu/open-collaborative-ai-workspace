import { describe, expect, it } from "vitest";
import {
  AgentCard,
  AgentCardActionEvent,
  AgentChannelApprovalRefusalDetails,
  AgentChannelToolCallDecision,
  AgentChannelToolCallRequest,
  AgentChannelToolRefusal,
  ApprovalView,
  isAgentCardRoute,
  KNOWN_APPROVAL_KINDS,
  TurnToolFlags,
} from "./index";
// tool-approvals.ts imports only common.ts and the leaf agent-card-route.ts (approvals.ts imports it, never the reverse).
import {
  ApprovableGroup,
  CanonicalJsonError,
  CreateToolApprovalPolicyRequest,
  canonicalJson,
  DeleteToolApprovalPolicyQuery,
  isApprovableTool,
  matchesToolPattern,
  prettyCanonicalJson,
  revealInvisible,
  strictestMode,
  TOOL_APPROVAL_LIMITS,
  TOOL_CALL_KIND,
  ToolApprovalAccess,
  ToolApprovalErrorCode,
  ToolApprovalHistory,
  ToolApprovalHistoryQuery,
  ToolApprovalMode,
  ToolApprovalPolicy,
  ToolApprovalPolicyPage,
  ToolApprovalRefusal,
  ToolApprovalScopeQuery,
  ToolApproverKind,
  ToolCallApprovalView,
  ToolPattern,
  UpdateToolApprovalPolicyRequest,
} from "./tool-approvals";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-14T10:00:00.000Z";

function errorCode(fn: () => unknown): string | null {
  try {
    fn();
    return null;
  } catch (e) {
    expect(e).toBeInstanceOf(CanonicalJsonError);
    return (e as CanonicalJsonError).code;
  }
}

describe("canonicalJson (RFC 8785)", () => {
  it("serializes the Appendix B numbers like ECMAScript Number::toString", () => {
    const vectors: Array<[number, string]> = [
      [0, "0"],
      [-0, "0"],
      [1e21, "1e+21"],
      [1e23, "1e+23"],
      [333333333.3333333, "333333333.3333333"],
      [5e-324, "5e-324"],
      [9.999999999999997e-7, "9.999999999999997e-7"],
      [1e-7, "1e-7"],
      [0.000001, "0.000001"],
      [4.5, "4.5"],
      [2e-3, "0.002"],
      [9007199254740991, "9007199254740991"],
      [295147905179352830000, "295147905179352830000"],
    ];
    for (const [n, s] of vectors) expect(canonicalJson(n), String(n)).toBe(s);
  });

  it("sorts keys by UTF-16 code units (§3.2.3 sample)", () => {
    const sample = {
      "€": "Euro Sign",
      "\r": "Carriage Return",
      דּ: "Hebrew Letter Dalet With Dagesh",
      "1": "One",
      "😀": "Emoji: Grinning Face",
      "\u0080": "Control",
      ö: "Latin Small Letter O With Diaeresis",
    };
    expect(canonicalJson(sample)).toBe(
      [
        '{"\\r":"Carriage Return"',
        '"1":"One"',
        '"\u0080":"Control"',
        '"ö":"Latin Small Letter O With Diaeresis"',
        '"€":"Euro Sign"',
        '"😀":"Emoji: Grinning Face"',
        '"דּ":"Hebrew Letter Dalet With Dagesh"}',
      ].join(","),
    );
  });

  it("sorts nested objects, keeps array order, emits no whitespace and escapes like JSON", () => {
    expect(canonicalJson({ b: 1, a: [2, { d: null, c: true }] })).toBe('{"a":[2,{"c":true,"d":null}],"b":1}');
    expect(canonicalJson({ s: 'a\u001fb"c\\d' })).toBe('{"s":"a\\u001fb\\"c\\\\d"}');
    expect(canonicalJson([])).toBe("[]");
    expect(canonicalJson({})).toBe("{}");
    expect(canonicalJson("x")).toBe('"x"');
    expect(canonicalJson(null)).toBe("null");
    expect(canonicalJson(false)).toBe("false");
  });

  it("is independent of the input key order", () => {
    const a = { to: "x", amount: 10, meta: { z: [1, 2], a: "b" } };
    const b = { meta: { a: "b", z: [1, 2] }, amount: 10, to: "x" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
  });

  it("throws CanonicalJsonError instead of normalising ambiguous input", () => {
    expect(errorCode(() => canonicalJson("\ud800"))).toBe("lone_surrogate");
    expect(errorCode(() => canonicalJson({ v: "a\udc00" }))).toBe("lone_surrogate");
    expect(errorCode(() => canonicalJson({ "\ud800": 1 }))).toBe("lone_surrogate");
    expect(errorCode(() => canonicalJson(Number.NaN))).toBe("non_finite");
    expect(errorCode(() => canonicalJson({ n: Number.POSITIVE_INFINITY }))).toBe("non_finite");
    expect(errorCode(() => canonicalJson([Number.NEGATIVE_INFINITY]))).toBe("non_finite");
    expect(errorCode(() => canonicalJson({ u: undefined }))).toBe("undefined");
    expect(errorCode(() => canonicalJson(undefined))).toBe("undefined");
    expect(errorCode(() => canonicalJson([1, undefined]))).toBe("undefined");
    expect(errorCode(() => canonicalJson({ d: new Date(0) }))).toBe("unsupported");
    expect(errorCode(() => canonicalJson(new Map()))).toBe("unsupported");
    class Thing {
      a = 1;
    }
    expect(errorCode(() => canonicalJson({ t: new Thing() }))).toBe("unsupported");
    expect(errorCode(() => canonicalJson(10n))).toBe("unsupported");
    expect(errorCode(() => canonicalJson({ f: () => 1 }))).toBe("unsupported");
    expect(canonicalJson(Object.assign(Object.create(null), { b: 1, a: 2 }))).toBe('{"a":2,"b":1}');
  });

  it("refuses nesting deeper than 32", () => {
    const nest = (n: number): unknown => {
      let v: unknown = 0;
      for (let i = 0; i < n; i++) v = i % 2 === 0 ? [v] : { k: v };
      return v;
    };
    expect(() => canonicalJson(nest(32))).not.toThrow();
    expect(errorCode(() => canonicalJson(nest(33)))).toBe("too_deep");
    expect(errorCode(() => prettyCanonicalJson(nest(33)))).toBe("too_deep");
  });
});

describe("prettyCanonicalJson", () => {
  const input = { "2": "b", "10": "a", x: { z: 1, y: [1, 2] } };

  it("keeps the canonical key order (integer-like keys included) with a two-space indent", () => {
    expect(prettyCanonicalJson(input)).toBe(
      [
        "{",
        '  "10": "a",',
        '  "2": "b",',
        '  "x": {',
        '    "y": [',
        "      1,",
        "      2",
        "    ],",
        '    "z": 1',
        "  }",
        "}",
      ].join("\n"),
    );
    expect(canonicalJson(JSON.parse(prettyCanonicalJson(input)))).toBe(canonicalJson(input));
    expect(prettyCanonicalJson({ a: [], b: {} })).toBe('{\n  "a": [],\n  "b": {}\n}');
  });

  it("refuses what canonicalJson refuses", () => {
    expect(errorCode(() => prettyCanonicalJson({ v: "\ud800" }))).toBe("lone_surrogate");
    expect(errorCode(() => prettyCanonicalJson({ v: Number.NaN }))).toBe("non_finite");
  });
});

describe("revealInvisible", () => {
  it("turns bidi, zero-width, BOM and tag characters into visible markers", () => {
    expect(revealInvisible("pay‮to")).toBe("pay⟨U+202E⟩to");
    for (const cp of [
      0x200b, 0x200c, 0x200d, 0x2060, 0xfeff, 0x2066, 0x2067, 0x2068, 0x2069, 0x061c, 0x202a,
    ]) {
      const hex = cp.toString(16).toUpperCase().padStart(4, "0");
      expect(revealInvisible(`a${String.fromCodePoint(cp)}b`), hex).toBe(`a⟨U+${hex}⟩b`);
    }
    expect(revealInvisible(`x${String.fromCodePoint(0xe0041)}y`)).toBe("x⟨U+E0041⟩y");
  });

  it("leaves line breaks, tabs, plain text and emoji alone", () => {
    expect(revealInvisible("a\nb\tc")).toBe("a\nb\tc");
    expect(revealInvisible("Invoice for Globex S.L., 1250.00 EUR")).toBe(
      "Invoice for Globex S.L., 1250.00 EUR",
    );
    expect(revealInvisible("ok 😀 €")).toBe("ok 😀 €");
  });
});

describe("tool-call approval wire contracts (tracer)", () => {
  const request = { eventId: ID, agentId: ID2, tool: "m1a2b3c4d__create_invoice", toolCallId: "call-1" };

  it("names the kind and the limits", () => {
    expect(TOOL_CALL_KIND).toBe("tool.call");
    expect(TOOL_APPROVAL_LIMITS).toEqual({
      argumentsBytes: 32_768,
      previewFields: 12,
      previewValueChars: 500,
      pendingPerRequester: 5,
      pendingTtlMs: 24 * 60 * 60 * 1000,
      grantUseMs: 15 * 60 * 1000,
      deniedSuppressMs: 24 * 60 * 60 * 1000,
      approverUsersMax: 20,
      historyPage: 30,
      // Phase 07.8 (D-12, R8): a browser-action approval expires with the held page.
      browserPendingTtlMs: 15 * 60 * 1000,
    });
    expect(TOOL_APPROVAL_LIMITS.browserPendingTtlMs).toBe(900_000);
  });

  it("a request may carry the model's arguments (≤ 32 KB); old requests still parse", () => {
    const withArgs = AgentChannelToolCallRequest.parse({ ...request, arguments: { to: "x", amount: 10 } });
    expect(withArgs.arguments).toEqual({ to: "x", amount: 10 });
    expect(
      AgentChannelToolCallRequest.safeParse({ ...request, arguments: { body: "x".repeat(32_800) } }).success,
    ).toBe(false);
    const old = AgentChannelToolCallRequest.parse(request);
    expect(old).not.toHaveProperty("arguments");
    expect(old.params).toEqual({});
  });

  it("a decision may carry the approval it waits on; old decisions still parse", () => {
    const decision = {
      callId: ID,
      allowed: false,
      reason: "approval_required",
      approval: { id: ID2, created: true, waitingFor: "a lead of Sales", requesterName: "Ana Pérez" },
    };
    expect(AgentChannelToolCallDecision.parse(decision).approval?.waitingFor).toBe("a lead of Sales");
    expect(
      AgentChannelToolCallDecision.parse({ callId: ID, allowed: true, reason: null }),
    ).not.toHaveProperty("approval");
    expect(
      AgentChannelToolCallDecision.parse({ callId: ID, allowed: true, reason: null, approval: null })
        .approval,
    ).toBe(null);
    expect(
      AgentChannelToolCallDecision.safeParse({
        ...decision,
        approval: { ...decision.approval, waitingFor: "x".repeat(201) },
      }).success,
    ).toBe(false);
    expect(AgentChannelApprovalRefusalDetails.parse({ approval: decision.approval }).approval?.id).toBe(ID2);
    // 07.5-11: approval_denied names who denied it and their note (display name only), on the gate and the 409s.
    const denial = { deciderName: "Marta Gil", note: "Duplicate invoice" };
    expect(AgentChannelApprovalRefusalDetails.parse({ denial })).toEqual({ denial });
    expect(
      AgentChannelToolCallDecision.parse({ callId: ID, allowed: false, reason: "approval_denied", denial })
        .denial,
    ).toEqual(denial);
    expect(
      AgentChannelApprovalRefusalDetails.safeParse({ denial: { ...denial, note: "x".repeat(281) } }).success,
    ).toBe(false);
    expect(
      AgentChannelApprovalRefusalDetails.safeParse({ denial: { deciderName: "Marta Gil" } }).success,
    ).toBe(false);
  });

  it("every gate refusal is also a connector / keychain tool refusal", () => {
    for (const r of ToolApprovalRefusal.options) expect(AgentChannelToolRefusal.options, r).toContain(r);
    expect(ToolApprovalRefusal.options).toEqual([
      "approval_required",
      "approval_pending",
      "approval_denied",
      "approval_used",
      "arguments_too_large",
      "arguments_invalid",
      "too_many_pending",
      "policy_changed",
    ]);
  });

  it("turn flags may carry the approval mode; old flags still parse", () => {
    expect(
      TurnToolFlags.parse({ untrustedOutput: false, sideEffecting: true, approval: "when_tainted" }).approval,
    ).toBe("when_tainted");
    expect(
      TurnToolFlags.safeParse({ untrustedOutput: false, sideEffecting: true, approval: "sometimes" }).success,
    ).toBe(false);
    expect(TurnToolFlags.parse({ untrustedOutput: false, sideEffecting: true })).not.toHaveProperty(
      "approval",
    );
  });

  const field = (i: number) => ({ key: `k${i}`, label: `K${i}`, value: `v${i}` });
  const view = {
    type: "tool_call",
    title: "Run create_invoice on Acme CRM",
    tool: "m1a2b3c4d__create_invoice",
    source: { kind: "connector", name: "Acme CRM", account: "requester", keyName: null },
    target: "erp.acme.example/api/invoices",
    preview: Array.from({ length: 12 }, (_, i) => field(i)),
    truncated: false,
    argumentsJson: '{\n  "amount": 10\n}',
    argumentsBytes: 13,
    notices: { hiddenCharacters: false, maskedSecret: false },
    tainted: true,
    agent: { id: ID2, displayName: "Scout" },
    requestedFor: { id: ID, displayName: "Ana Pérez" },
    approverLabel: "Waiting for a lead of Sales",
    policy: {
      scopeUnitId: ID,
      scopeLabel: "Sales",
      mode: "always",
      pattern: "m1a2b3c4d__*",
      viewerCanManage: false,
    },
    audience: {
      origin: { kind: "channel", name: "ops" },
      conversationReaders: 24,
      detailReaders: 3,
      messageRoute: `/chat/${ID}?message=${ID2}`,
    },
    useBy: null,
    usedAt: null,
  };

  it("Phase 07.8: a tool_call view can carry a browser action (R8) and D-13's cross-site open", () => {
    const click = {
      action: "click",
      element: { role: "button", name: "Place order" },
      host: "shop.example.com",
      secure: true,
      signedIn: true,
      sessionSite: "shop.example.com",
      value: null,
      option: null,
    };
    expect(ToolCallApprovalView.parse({ ...view, tool: "ocw_browser_act", browser: click }).browser).toEqual(
      click,
    );
    const open = {
      action: "open",
      element: null,
      host: "evil.example",
      secure: true,
      signedIn: false,
      sessionSite: "panel.fake.test",
      value: null,
      option: null,
    };
    expect(
      ToolCallApprovalView.parse({ ...view, tool: "ocw_browser_open", browser: open }).browser?.action,
    ).toBe("open");
    expect(ToolCallApprovalView.parse(view).browser).toBeUndefined();
    expect(ToolCallApprovalView.parse({ ...view, browser: null }).browser).toBeNull();
    for (const bad of [
      { ...click, action: "evaluate" },
      { ...click, host: "https://shop.example.com/" },
      { ...click, value: "x".repeat(TOOL_APPROVAL_LIMITS.previewValueChars + 1) },
      { ...click, element: { role: "button", name: "x".repeat(201) } },
      { ...click, cookies: [] },
    ]) {
      expect(
        ToolCallApprovalView.safeParse({ ...view, browser: bad }).success,
        JSON.stringify(bad).slice(0, 80),
      ).toBe(false);
    }
  });

  it("the tool_call view is an approval view bounded at 12 preview fields", () => {
    expect(ToolCallApprovalView.parse(view).preview).toHaveLength(12);
    expect(ApprovalView.parse(view).type).toBe("tool_call");
    expect(ApprovalView.safeParse({ ...view, preview: [...view.preview, field(12)] }).success).toBe(false);
    expect(
      ApprovalView.safeParse({ ...view, preview: [{ key: "k", label: "K", value: "v".repeat(501) }] })
        .success,
    ).toBe(false);
    expect(
      ApprovalView.safeParse({
        ...view,
        audience: { ...view.audience, messageRoute: "https://evil.example" },
      }).success,
    ).toBe(false);
    expect(ApprovalView.parse({ ...view, policy: null }).type).toBe("tool_call");
    expect(KNOWN_APPROVAL_KINDS).toEqual(
      expect.arrayContaining(["memory.write", "tool.call", "work_zone.start"]),
    );
    expect(KNOWN_APPROVAL_KINDS[0]).toBe("memory.write");
  });

  const card = {
    kind: "approval",
    title: "Scout wants to run create_invoice for Ana Pérez",
    fields: [],
    status: "pending",
    actions: [],
    version: 1,
    decision: null,
    updatedAt: NOW,
    platformOwned: true,
    approval: {
      id: ID,
      actionHash: "a".repeat(64),
      status: "pending",
      requestedForUserId: ID2,
      warnings: [],
    },
  };

  it("the card's approval link gains the 07.5 fields; a 07.2 link still parses", () => {
    const linked = AgentCard.parse({
      ...card,
      approval: {
        ...card.approval,
        kind: "tool.call",
        display: "summary",
        useBy: NOW,
        usedAt: null,
        waitingFor: "Waiting for a lead of Sales",
        actionFields: 2,
        expiresAt: NOW,
        deviceId: null,
        resultRoute: null,
        blocked: null,
      },
    });
    expect(linked.approval?.display).toBe("summary");
    expect(AgentCard.safeParse({ ...card, approval: { ...card.approval, display: "full" } }).success).toBe(
      false,
    );
    expect(AgentCard.safeParse({ ...card, approval: { ...card.approval, actionFields: 4 } }).success).toBe(
      false,
    );
    expect(
      AgentCard.safeParse({ ...card, approval: { ...card.approval, blocked: "device_offline" } }).success,
    ).toBe(true);
    expect(AgentCard.parse(card).approval).not.toHaveProperty("display");
    expect(isAgentCardRoute(`/approvals/${ID}`)).toBe(true);
    expect(isAgentCardRoute("/approvals")).toBe(true);
    expect(isAgentCardRoute("/approvalsx")).toBe(false);
  });

  const cardActionEvent = {
    eventId: ID,
    seq: 3,
    type: "agent.card_action.v1",
    organizationId: ID,
    cellId: ID,
    agent: { id: ID2, handle: "scout", displayName: "Scout" },
    conversation: { id: ID, kind: "dm", name: null },
    thread: { rootMessageId: ID },
    message: {
      id: ID,
      text: "Marta Gil approved “Run create_invoice on Acme CRM”",
      createdAt: NOW,
      author: { kind: "user", id: ID, displayName: "Ana Pérez" },
      mentions: [],
    },
    threadHistory: [],
    roster: [],
    cardAction: {
      messageId: ID,
      kind: "approval",
      title: "Run create_invoice on Acme CRM",
      outcome: "approved",
    },
  };

  it("the card-action event may carry the decider and the grant block; older events still parse", () => {
    const withGrant = AgentCardActionEvent.parse({
      ...cardActionEvent,
      cardAction: {
        ...cardActionEvent.cardAction,
        decidedBy: { id: ID2, displayName: "Marta Gil" },
        grant: { tool: "m1a2b3c4d__create_invoice", arguments: canonicalJson({ amount: 10 }), useBy: NOW },
      },
    });
    expect(withGrant.cardAction.grant?.arguments).toBe('{"amount":10}');
    expect(withGrant.cardAction.decidedBy?.displayName).toBe("Marta Gil");
    const old = AgentCardActionEvent.parse(cardActionEvent);
    expect(old.cardAction).not.toHaveProperty("grant");
    expect(
      AgentCardActionEvent.safeParse({
        ...cardActionEvent,
        cardAction: {
          ...cardActionEvent.cardAction,
          grant: { tool: "t", arguments: "x".repeat(32_769), useBy: NOW },
        },
      }).success,
    ).toBe(false);
  });
});

describe("approvable tools and patterns (D-01, P-04)", () => {
  it("only plugin, MCP, connector tools and ocw_http_request are approvable", () => {
    for (const t of ["m1a2b3c4d__create_invoice", "ocw_http_request", "acme_plugin_tool"]) {
      expect(isApprovableTool(t), t).toBe(true);
    }
    for (const t of [
      "web_search",
      "web_fetch",
      "ocw_memory_save",
      "ocw_memory_propose",
      "ocw_agent_card",
      "ocw_connector_list",
      "ocw_connector_call",
      "ocw_work_zone_projects",
      "ocw_start_work_zone",
      "ocw_board_card",
      "OCW_MEMORY_SAVE",
      "",
      "a b",
      "x".repeat(129),
    ]) {
      expect(isApprovableTool(t), t).toBe(false);
    }
  });

  it("Phase 07.8: every confined sandbox and browser tool is approvable except sign-in and close (SBX-04, D-12)", () => {
    for (const t of [
      "ocw_sandbox_exec",
      "ocw_sandbox_write",
      "ocw_sandbox_delete",
      "ocw_sandbox_import",
      "ocw_browser_act",
      "ocw_browser_open",
      "ocw_browser_snapshot",
    ]) {
      expect(isApprovableTool(t), t).toBe(true);
      expect(ToolPattern.safeParse(t).success, t).toBe(true);
    }
    for (const t of [
      "ocw_browser_signin",
      "ocw_browser_close",
      "ocw_memory_save",
      "web_fetch",
      // Exact lower case only: a look-alike never slips in.
      "OCW_SANDBOX_EXEC",
      "ocw_Browser_act",
      "ocw_sandbox_",
      "ocw_sandboxexec",
    ]) {
      expect(isApprovableTool(t), t).toBe(false);
    }
  });

  it("a pattern is an approvable exact name or every tool of one server", () => {
    for (const p of ["m1a2b3c4d__*", "m1a2b3c4d__create_invoice", "ocw_http_request", "x".repeat(128)]) {
      expect(ToolPattern.safeParse(p).success, p).toBe(true);
    }
    for (const p of [
      "*",
      "m1a2b3c4d*",
      "M1A2B3C4D__*",
      "ocw_*",
      "web_fetch",
      "m1a2b3c4__*",
      "x".repeat(129),
    ]) {
      expect(ToolPattern.safeParse(p).success, p).toBe(false);
    }
  });

  it("matchesToolPattern: a server pattern covers its tools only; an exact pattern only itself", () => {
    expect(matchesToolPattern("m1a2b3c4d__*", "m1a2b3c4d__x")).toBe(true);
    expect(matchesToolPattern("m1a2b3c4d__*", "m1a2b3c4e__x")).toBe(false);
    expect(matchesToolPattern("m1a2b3c4d__*", "m1a2b3c4d")).toBe(false);
    expect(matchesToolPattern("m1a2b3c4d__*", "m1a2b3c4d__")).toBe(false);
    expect(matchesToolPattern("m1a2b3c4d__x", "m1a2b3c4d__x")).toBe(true);
    expect(matchesToolPattern("m1a2b3c4d__x", "m1a2b3c4d__xy")).toBe(false);
    expect(matchesToolPattern("ocw_http_request", "ocw_http_request")).toBe(true);
  });

  it("strictestMode: always > when_tainted > never; none is never", () => {
    expect(strictestMode(["never", "when_tainted"])).toBe("when_tainted");
    expect(strictestMode(["when_tainted", "always", "never"])).toBe("always");
    expect(strictestMode([])).toBe("never");
    expect(ToolApprovalMode.options).toEqual(["never", "always", "when_tainted"]);
    expect(ToolApproverKind.options).toEqual(["requester", "users", "unit_leads", "admins"]);
  });
});

describe("approval policy contracts (D-01, D-04, UI-SPEC R3–R5)", () => {
  const create = { scopeUnitId: null, toolPattern: "m1a2b3c4d__*", mode: "always", approverKind: "admins" };
  const refused = (v: unknown) => CreateToolApprovalPolicyRequest.safeParse(v).success;

  it("a valid rule parses; the refinements refuse the rest", () => {
    expect(CreateToolApprovalPolicyRequest.parse(create)).toMatchObject(create);
    expect(refused({ ...create, approverKind: "users", approverUserIds: [ID] })).toBe(true);
    expect(refused({ ...create, scopeUnitId: ID, approverKind: "unit_leads" })).toBe(true);
    expect(refused({ ...create, mode: "never", approverKind: "requester" })).toBe(true);
    expect(refused({ ...create, approverKind: "requester" })).toBe(true);

    const ids = (n: number) =>
      Array.from({ length: n }, (_, i) => `0199a1b2-c3d4-7e5f-8a9b-${String(i).padStart(12, "0")}`);
    expect(refused({ ...create, approverKind: "users", approverUserIds: [] })).toBe(false);
    expect(refused({ ...create, approverKind: "users" })).toBe(false);
    expect(refused({ ...create, approverKind: "users", approverUserIds: ids(20) })).toBe(true);
    expect(refused({ ...create, approverKind: "users", approverUserIds: ids(21) })).toBe(false);
    expect(refused({ ...create, approverKind: "users", approverUserIds: [ID, ID] })).toBe(false);
    expect(refused({ ...create, approverKind: "unit_leads" })).toBe(false);
    expect(refused({ ...create, mode: "never", approverKind: "users", approverUserIds: [ID] })).toBe(false);
    expect(refused({ ...create, mode: "never", approverKind: "admins" })).toBe(false);
    expect(refused({ ...create, approverUserIds: [ID] })).toBe(false);
    expect(refused({ ...create, toolPattern: "web_fetch" })).toBe(false);
    expect(refused({ ...create, toolPattern: "ocw_memory_save" })).toBe(false);
    expect(refused({ ...create, extra: true })).toBe(false);
    expect(refused({ ...create, scopeUnitId: undefined })).toBe(false);
  });

  it("an update names its version and changes something, with the same refinements", () => {
    expect(UpdateToolApprovalPolicyRequest.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(UpdateToolApprovalPolicyRequest.parse({ expectedVersion: 1, mode: "when_tainted" })).toEqual({
      expectedVersion: 1,
      mode: "when_tainted",
    });
    expect(
      UpdateToolApprovalPolicyRequest.safeParse({
        expectedVersion: 1,
        approverKind: "users",
        approverUserIds: [ID],
      }).success,
    ).toBe(true);
    expect(
      UpdateToolApprovalPolicyRequest.safeParse({ expectedVersion: 1, approverKind: "users" }).success,
    ).toBe(false);
    expect(
      UpdateToolApprovalPolicyRequest.safeParse({
        expectedVersion: 1,
        approverKind: "admins",
        approverUserIds: [ID],
      }).success,
    ).toBe(false);
    expect(
      UpdateToolApprovalPolicyRequest.safeParse({ expectedVersion: 1, mode: "never", approverKind: "admins" })
        .success,
    ).toBe(false);
    expect(
      UpdateToolApprovalPolicyRequest.safeParse({ expectedVersion: 1, mode: "always", toolPattern: "x" })
        .success,
    ).toBe(false);
    expect(UpdateToolApprovalPolicyRequest.safeParse({ expectedVersion: 0, mode: "always" }).success).toBe(
      false,
    );
  });

  it("scope, delete and history queries", () => {
    expect(ToolApprovalScopeQuery.parse({ scope: "org" }).scope).toBe("org");
    expect(ToolApprovalScopeQuery.parse({ scope: ID }).scope).toBe(ID);
    expect(ToolApprovalScopeQuery.safeParse({ scope: "everyone" }).success).toBe(false);
    expect(DeleteToolApprovalPolicyQuery.parse({ expectedVersion: "3" }).expectedVersion).toBe(3);
    expect(DeleteToolApprovalPolicyQuery.safeParse({ expectedVersion: "0" }).success).toBe(false);
    expect(ToolApprovalHistoryQuery.parse({ scope: "org" })).toEqual({ scope: "org" });
    expect(ToolApprovalHistoryQuery.parse({ scope: ID, cursor: "abc" }).cursor).toBe("abc");
  });

  const policy = {
    id: ID,
    scopeUnitId: null,
    toolPattern: "m1a2b3c4d__*",
    mode: "always",
    approverKind: "unit_leads",
    approverUserIds: [],
    version: 2,
    updatedAt: NOW,
    updatedBy: { id: ID2, displayName: "Marta Gil" },
  };

  it("the policy page, access, catalog group, history and error codes parse their minimal examples", () => {
    expect(ToolApprovalPolicy.parse(policy).version).toBe(2);
    expect(ToolApprovalPolicy.safeParse({ ...policy, approverUserIds: Array(21).fill(ID) }).success).toBe(
      false,
    );
    const group = {
      source: { kind: "mcp", id: ID, name: "Acme CRM", safeName: "m1a2b3c4d" },
      tools: [{ name: "m1a2b3c4d__create_invoice", sideEffecting: true }],
    };
    expect(ApprovableGroup.parse(group).tools).toHaveLength(1);
    expect(
      ApprovableGroup.parse({
        source: { kind: "http", id: null, name: "Keychain", safeName: null },
        tools: [],
      }).source.kind,
    ).toBe("http");
    expect(
      ToolApprovalPolicyPage.parse({
        scope: { unitId: null, label: "Organization" },
        policies: [policy],
        inherited: [{ ...policy, scopeLabel: "Organization" }],
        catalog: [group],
        approverLabels: { [ID]: "Leads of Sales" },
      }).policies,
    ).toHaveLength(1);
    expect(
      ToolApprovalAccess.parse({ manageable: { organization: false, unitIds: [ID] } }).manageable.unitIds,
    ).toEqual([ID]);
    const item = {
      id: ID,
      at: NOW,
      actor: null,
      action: "deleted",
      toolPattern: "m1a2b3c4d__*",
      mode: null,
      approverLabel: null,
    };
    expect(ToolApprovalHistory.parse({ items: [item], nextCursor: null }).items).toHaveLength(1);
    expect(ToolApprovalHistory.safeParse({ items: Array(31).fill(item), nextCursor: null }).success).toBe(
      false,
    );
    expect(ToolApprovalErrorCode.options).toEqual([
      "tool_not_approvable",
      "invalid_tool_pattern",
      "policy_exists",
      "policy_version_conflict",
      "policy_weaker_than_inherited",
    ]);
  });
});
