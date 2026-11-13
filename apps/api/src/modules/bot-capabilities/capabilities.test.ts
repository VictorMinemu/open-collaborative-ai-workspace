import {
  type BotCapabilities,
  type BotPolicy,
  type BuiltinCapability,
  DEFAULT_BOT_POLICY,
  DEFAULT_CAPABILITIES,
  type ToolGrant,
} from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  type CatalogSource,
  confinedCapabilities,
  effectiveCapabilities,
  effectiveTools,
  readCapabilities,
  taskPolicyFor,
} from "./capabilities";

/**
 * D-06 truth table: effective = toggle ∧ org-wide policy ∧ (personal ? personal policy : true) ∧ configured ∧
 * resolver(agent ∩ human), each refusal with the reason the UI shows. PURE (no database).
 */

const policy = (patch: Partial<Record<BuiltinCapability, { orgWide: boolean; personal: boolean }>> = {}) =>
  ({
    ...DEFAULT_BOT_POLICY,
    capabilities: { ...DEFAULT_BOT_POLICY.capabilities, ...patch },
    updatedAt: null,
  }) satisfies BotPolicy;

const allOn: BotCapabilities = {
  internet: true,
  memory: true,
  dateTime: true,
  replyMode: "all",
  dailyLimit: 30,
  sandbox: false,
  browser: false,
  longTasks: true,
};

const view = (
  scope: "team" | "personal",
  opts: {
    caps?: Partial<BotCapabilities>;
    policy?: BotPolicy;
    configured?: boolean;
    human?: { internet: boolean } | null;
  } = {},
) =>
  effectiveCapabilities({
    scope,
    caps: { ...allOn, ...opts.caps },
    policy: opts.policy ?? policy(),
    configured: { internet: opts.configured ?? true },
    human: opts.human === undefined ? { internet: true } : opts.human,
  });

describe("readCapabilities", () => {
  it("fills defaults by scope and ignores unknown or invalid keys", () => {
    expect(readCapabilities({ scope: "personal", capabilities: {} })).toEqual(DEFAULT_CAPABILITIES.personal);
    expect(readCapabilities({ scope: "team", capabilities: { internet: true, bogus: 1 } })).toEqual({
      ...DEFAULT_CAPABILITIES.team,
      internet: true,
    });
    expect(readCapabilities({ scope: "team", capabilities: { dailyLimit: -3, replyMode: "nope" } })).toEqual(
      DEFAULT_CAPABILITIES.team,
    );
  });
});

describe("effectiveCapabilities", () => {
  it("everything allowed → effective with no reason", () => {
    const v = view("team");
    for (const cap of ["internet", "memory", "dateTime", "replyModeAll"] as const) {
      expect(v[cap]).toEqual({ enabled: true, effective: true, reason: null });
    }
  });

  it.each(["internet", "memory", "dateTime", "replyModeAll"] as const)(
    "%s: org-wide off → org_policy for any bot",
    (cap) => {
      const p = policy({ [cap]: { orgWide: false, personal: true } });
      expect(view("team", { policy: p })[cap]).toEqual({
        enabled: true,
        effective: false,
        reason: "org_policy",
      });
      if (cap !== "replyModeAll") {
        expect(view("personal", { policy: p })[cap].reason).toBe("org_policy");
      }
    },
  );

  it.each(["internet", "memory", "dateTime"] as const)(
    "%s: personal off → personal_policy on a personal bot, team bots stay effective",
    (cap) => {
      const p = policy({ [cap]: { orgWide: true, personal: false } });
      expect(view("personal", { policy: p })[cap]).toEqual({
        enabled: true,
        effective: false,
        reason: "personal_policy",
      });
      expect(view("team", { policy: p })[cap]).toEqual({ enabled: true, effective: true, reason: null });
    },
  );

  it("internet without a search provider → not_configured", () => {
    expect(view("team", { configured: false }).internet).toEqual({
      enabled: true,
      effective: false,
      reason: "not_configured",
    });
    // Other capabilities need no provider.
    expect(view("team", { configured: false }).memory.effective).toBe(true);
  });

  it("internet denied to the human (agent ∩ human) → denied_for_you; no human side → not judged", () => {
    expect(view("team", { human: { internet: false } }).internet).toEqual({
      enabled: true,
      effective: false,
      reason: "denied_for_you",
    });
    expect(view("team", { human: null }).internet.effective).toBe(true);
  });

  it("a toggle that is off is never effective and keeps the reason it could not be switched on", () => {
    const off = view("team", {
      caps: { internet: false, memory: false, dateTime: false, replyMode: "mentions" },
      policy: policy({ internet: { orgWide: false, personal: false } }),
    });
    expect(off.internet).toEqual({ enabled: false, effective: false, reason: "org_policy" });
    for (const cap of ["memory", "dateTime", "replyModeAll"] as const) {
      expect(off[cap]).toEqual({ enabled: false, effective: false, reason: null });
    }
    // Personal bots: reply mode `all` is a channel setting, so it is refused even while off.
    expect(view("personal", { caps: { replyMode: "mentions" } }).replyModeAll).toEqual({
      enabled: false,
      effective: false,
      reason: "dm_only",
    });
  });

  it("reply mode `all` on a personal bot → dm_only (it lives only in its owner's DM)", () => {
    expect(view("personal").replyModeAll).toEqual({ enabled: true, effective: false, reason: "dm_only" });
  });

  it("reason precedence: org_policy before personal_policy before not_configured before denied_for_you", () => {
    const both = policy({ internet: { orgWide: false, personal: false } });
    expect(
      view("personal", { policy: both, configured: false, human: { internet: false } }).internet.reason,
    ).toBe("org_policy");
    const personalOff = policy({ internet: { orgWide: true, personal: false } });
    expect(
      view("personal", { policy: personalOff, configured: false, human: { internet: false } }).internet
        .reason,
    ).toBe("personal_policy");
    expect(view("personal", { configured: false, human: { internet: false } }).internet.reason).toBe(
      "not_configured",
    );
  });
});

describe("effectiveCapabilities: Long tasks (07.17.1.1.2 D-04)", () => {
  it("all on → effective with no reason", () => {
    expect(view("team").longTasks).toEqual({ enabled: true, effective: true, reason: null });
    expect(view("personal").longTasks).toEqual({ enabled: true, effective: true, reason: null });
  });

  it("the organization switch off → org_policy; the personal one off → personal_policy for a personal bot only", () => {
    const orgOff = policy({ longTasks: { orgWide: false, personal: true } });
    expect(view("team", { policy: orgOff }).longTasks).toEqual({
      enabled: true,
      effective: false,
      reason: "org_policy",
    });
    const personalOff = policy({ longTasks: { orgWide: true, personal: false } });
    expect(view("personal", { policy: personalOff }).longTasks).toEqual({
      enabled: true,
      effective: false,
      reason: "personal_policy",
    });
    expect(view("team", { policy: personalOff }).longTasks).toEqual({
      enabled: true,
      effective: true,
      reason: null,
    });
  });

  it("needs nothing configured and no per-person permission: never not_configured nor denied_for_you", () => {
    expect(view("team", { configured: false, human: { internet: false } }).longTasks).toEqual({
      enabled: true,
      effective: true,
      reason: null,
    });
    expect(view("team", { caps: { longTasks: false } }).longTasks).toEqual({
      enabled: false,
      effective: false,
      reason: null,
    });
  });
});

describe("taskPolicyFor: may this bot run long tasks (07.17.1.1.2 D-04, E11)", () => {
  const limits = { maxTurns: 40, maxHours: 8, maxRunning: 10 };

  it("a team bot with the defaults may, with the policy's three limits", () => {
    expect(taskPolicyFor({ scope: "team", caps: allOn, policy: policy() })).toEqual({
      enabled: true,
      reason: null,
      ...limits,
    });
    const saved = { ...policy(), tasks: { maxTurns: 12, maxHours: 3, maxRunning: 0 } };
    expect(taskPolicyFor({ scope: "personal", caps: allOn, policy: saved })).toEqual({
      enabled: true,
      reason: null,
      maxTurns: 12,
      maxHours: 3,
      maxRunning: 0,
    });
  });

  it("the organization switch off → org_policy for every bot", () => {
    const p = policy({ longTasks: { orgWide: false, personal: true } });
    for (const scope of ["team", "personal"] as const) {
      expect(taskPolicyFor({ scope, caps: allOn, policy: p })).toEqual({
        enabled: false,
        reason: "org_policy",
        ...limits,
      });
    }
  });

  it("only the personal switch off → personal_policy for a personal bot; a team bot still may", () => {
    const p = policy({ longTasks: { orgWide: true, personal: false } });
    expect(taskPolicyFor({ scope: "personal", caps: allOn, policy: p })).toMatchObject({
      enabled: false,
      reason: "personal_policy",
    });
    expect(taskPolicyFor({ scope: "team", caps: allOn, policy: p })).toMatchObject({
      enabled: true,
      reason: null,
    });
  });

  it("the bot's own toggle off → never enabled; the policy's reason, if any, is kept", () => {
    const off = { ...allOn, longTasks: false };
    expect(taskPolicyFor({ scope: "team", caps: off, policy: policy() })).toEqual({
      enabled: false,
      reason: null,
      ...limits,
    });
    expect(
      taskPolicyFor({
        scope: "team",
        caps: off,
        policy: policy({ longTasks: { orgWide: false, personal: false } }),
      }),
    ).toMatchObject({ enabled: false, reason: "org_policy" });
  });
});

// ---------------------------------------------------------------- tools (BOT-10)

const MCP_ID = "0199a1b2-c3d4-7e5f-8a9b-000000000001";
const PLUGIN_ID = "0199a1b2-c3d4-7e5f-8a9b-000000000002";

const mcp = (patch: Partial<CatalogSource> = {}): CatalogSource => ({
  sourceKind: "mcp",
  sourceId: MCP_ID,
  sourceName: "Docs",
  status: "ready",
  orgEnabled: true,
  personalAllowed: false,
  trustedChaining: false,
  tools: [
    { name: "m3f9a12c4__echo", title: "Echo", description: "Echoes", sideEffecting: false },
    { name: "m3f9a12c4__exec", title: null, description: null, sideEffecting: true },
    { name: "m3f9a12c4__search", title: null, description: null, sideEffecting: false },
  ],
  ...patch,
});

const plugin = (patch: Partial<CatalogSource> = {}): CatalogSource => ({
  sourceKind: "plugin",
  sourceId: PLUGIN_ID,
  sourceName: "@openclaw/weather-plugin",
  status: "installed",
  orgEnabled: true,
  personalAllowed: true,
  trustedChaining: false,
  tools: [{ name: "weather_lookup", title: null, description: "Forecast", sideEffecting: true }],
  ...patch,
});

const grant = (sourceKind: "mcp" | "plugin", sourceId: string, tool: string): ToolGrant => ({
  sourceKind,
  sourceId,
  tool,
});

const tools = (
  scope: "team" | "personal",
  catalog: CatalogSource[],
  grants: ToolGrant[],
  humanToolAllowed: (tool: string) => boolean | null = () => true,
) =>
  effectiveTools({
    scope,
    caps: allOn,
    policy: policy(),
    catalog,
    grants,
    humanToolAllowed,
  });

const find = (list: ReturnType<typeof tools>, name: string) => {
  const t = list.find((x) => x.tool === name);
  if (!t) throw new Error(`tool ${name} not listed`);
  return t;
};

describe("effectiveTools", () => {
  it("a granted tool of a ready, org-enabled MCP server is effective", () => {
    const list = tools("team", [mcp()], [grant("mcp", MCP_ID, "m3f9a12c4__echo")]);
    expect(find(list, "m3f9a12c4__echo")).toMatchObject({
      sourceKind: "mcp",
      sourceId: MCP_ID,
      sourceName: "Docs",
      title: "Echo",
      sideEffecting: false,
      granted: true,
      effective: true,
      reason: null,
    });
  });

  it("the same tool on a personal bot is personal_policy until the server allows personal bots", () => {
    const g = [grant("mcp", MCP_ID, "m3f9a12c4__echo")];
    expect(find(tools("personal", [mcp()], g), "m3f9a12c4__echo")).toMatchObject({
      effective: false,
      reason: "personal_policy",
    });
    expect(find(tools("personal", [mcp({ personalAllowed: true })], g), "m3f9a12c4__echo")).toMatchObject({
      effective: true,
      reason: null,
    });
  });

  it("an org-disabled source → org_policy", () => {
    const list = tools("team", [mcp({ orgEnabled: false })], [grant("mcp", MCP_ID, "m3f9a12c4__echo")]);
    expect(find(list, "m3f9a12c4__echo").reason).toBe("org_policy");
  });

  it("a server in error, or a plugin that is not installed → source_unavailable", () => {
    expect(
      find(
        tools("team", [mcp({ status: "error" })], [grant("mcp", MCP_ID, "m3f9a12c4__echo")]),
        "m3f9a12c4__echo",
      ).reason,
    ).toBe("source_unavailable");
    expect(
      find(
        tools("team", [plugin({ status: "failed" })], [grant("plugin", PLUGIN_ID, "weather_lookup")]),
        "weather_lookup",
      ).reason,
    ).toBe("source_unavailable");
    expect(
      find(tools("team", [plugin()], [grant("plugin", PLUGIN_ID, "weather_lookup")]), "weather_lookup")
        .effective,
    ).toBe(true);
  });

  it("a dangerous name → dangerous even when granted and allowed, and before any other reason", () => {
    const list = tools(
      "team",
      [mcp({ status: "error", orgEnabled: false })],
      [grant("mcp", MCP_ID, "m3f9a12c4__exec")],
    );
    expect(find(list, "m3f9a12c4__exec")).toMatchObject({
      granted: true,
      effective: false,
      reason: "dangerous",
    });
    const listed = tools("team", [mcp()], []);
    expect(find(listed, "m3f9a12c4__exec")).toMatchObject({
      granted: false,
      effective: false,
      reason: "dangerous",
    });
  });

  it("humanToolAllowed false → denied_for_you; null → not judged", () => {
    const g = [grant("mcp", MCP_ID, "m3f9a12c4__echo")];
    expect(
      find(
        tools("team", [mcp()], g, () => false),
        "m3f9a12c4__echo",
      ).reason,
    ).toBe("denied_for_you");
    expect(
      find(
        tools("team", [mcp()], g, () => null),
        "m3f9a12c4__echo",
      ).effective,
    ).toBe(true);
  });

  it("an ungranted tool of a usable source is listed with granted:false, effective:false, reason:null", () => {
    const list = tools("team", [mcp()], [grant("mcp", MCP_ID, "m3f9a12c4__echo")]);
    expect(find(list, "m3f9a12c4__search")).toMatchObject({ granted: false, effective: false, reason: null });
  });

  it("an ungranted tool carries the reason it could not be enabled (source, org, personal policy)", () => {
    // The UI disables the switch and explains it, so a manager never enables a tool in vain.
    expect(find(tools("personal", [mcp()], []), "m3f9a12c4__echo")).toMatchObject({
      granted: false,
      effective: false,
      reason: "personal_policy",
    });
    expect(find(tools("personal", [mcp({ personalAllowed: true })], []), "m3f9a12c4__echo").reason).toBe(
      null,
    );
    expect(find(tools("team", [mcp({ orgEnabled: false })], []), "m3f9a12c4__echo").reason).toBe(
      "org_policy",
    );
    expect(find(tools("team", [mcp({ status: "probing" })], []), "m3f9a12c4__echo").reason).toBe(
      "source_unavailable",
    );
    // The human side is only judged for granted tools (the resolver is asked per grant).
    expect(
      find(
        tools("team", [mcp()], [], () => false),
        "m3f9a12c4__echo",
      ).reason,
    ).toBe(null);
  });

  it("a grant pointing at a tool the catalog no longer lists is dropped", () => {
    const list = tools("team", [mcp()], [grant("mcp", MCP_ID, "m3f9a12c4__gone")]);
    expect(list.some((t) => t.tool === "m3f9a12c4__gone")).toBe(false);
  });
});

describe("confinedCapabilities: the Sandbox and Browser rows (07.8-11, D-12, R11)", () => {
  const all = {
    caps: { sandbox: true, browser: false },
    configured: true,
    settings: { enabled: true, killed: false },
    moduleAllowed: { sandbox: true, browser: true },
  };

  it("everything on: available, enabled is the bot's own switch", () => {
    expect(confinedCapabilities(all)).toEqual({
      sandbox: { enabled: true, available: true, reason: null },
      browser: { enabled: false, available: true, reason: null },
    });
  });

  it("reason precedence: service_down, org_off, killed, module_off", () => {
    const off = { enabled: false, killed: true };
    expect(confinedCapabilities({ ...all, configured: false, settings: off }).sandbox.reason).toBe(
      "service_down",
    );
    expect(confinedCapabilities({ ...all, settings: off }).sandbox.reason).toBe("org_off");
    expect(confinedCapabilities({ ...all, settings: { enabled: true, killed: true } }).sandbox.reason).toBe(
      "killed",
    );
    const noSandbox = confinedCapabilities({ ...all, moduleAllowed: { sandbox: false, browser: true } });
    expect(noSandbox.sandbox).toEqual({ enabled: true, available: false, reason: "module_off" });
    expect(noSandbox.browser).toEqual({ enabled: false, available: true, reason: null });
  });
});
