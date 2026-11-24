import { describe, expect, it } from "vitest";
import {
  AccountPoolErrorCode,
  AccountPoolPreview,
  AccountPoolView,
  AccountSourcePreview,
  AddClaudeTokenRequest,
  accountSourceLabel,
  accountSwitchedSentence,
  BOTS_WEIGHTED_NOTE,
  BotPoolSignIn,
  CELL_CLAUDE_TOKENS,
  DeviceSignIn,
  normalizeStrategy,
  POOL_PROVIDER_OF_RUNTIME,
  POOL_STRATEGY_TEXT,
  PoolAccount,
  PoolPolicy,
  PoolStrategy,
  PoolStrategyChoice,
  ReorderPoolRequest,
  SessionPoolAccountRef,
  StartDeviceSignInRequest,
  UpdatePoolAccountRequest,
  UpdatePoolPolicyRequest,
} from "./account-pool";
import { SERVER_ONLY_SESSION_EVENTS, SessionEvent } from "./session-events";
import { WorkSession } from "./work-session";

// Token-shaped values are assembled at runtime so no credential-shaped literal sits whole in the repository.
const fake = (...parts: string[]) => parts.join("");
const URL_SAFE = "abcdefghijKLMNOPQRST0123456789_-uvwxyzAB";
const TOKEN = fake("sk-", "ant-", "oat01-", URL_SAFE);
const API_KEY = fake("sk-", "ant-", "api03-", URL_SAFE);

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const AT = "2026-11-24T10:00:00.000Z";
const UNTIL = "2026-11-24T15:40:00.000Z";

const tokenRow = {
  id: uuid(1),
  provider: "claude",
  kind: "token",
  label: "Ana's Max",
  enabled: true,
  priority: 0,
  weight: 1,
  status: "ready",
  cooldownUntil: null,
  limitReason: null,
  lastUsedAt: null,
  usage: null,
  planType: null,
  origin: "admin",
  device: null,
  createdAt: AT,
} as const;
const slotRow = {
  ...tokenRow,
  id: uuid(2),
  provider: "chatgpt",
  kind: "device_slot",
  label: "Ops Plus",
  status: "cooling",
  cooldownUntil: UNTIL,
  limitReason: "usage_limit",
  usage: { windows: [{ kind: "primary", usedPercent: 100, resetsAt: UNTIL }], at: AT },
  planType: "plus",
  device: { id: uuid(9), name: "build-01", online: true },
} as const;
const cellRow = {
  ...tokenRow,
  id: uuid(3),
  provider: "chatgpt",
  kind: "cell_profile",
  origin: "adopted",
} as const;
const policy = {
  provider: "claude",
  strategy: "failover",
  scope: "all",
  fallbackToDeviceLogin: true,
  updatedAt: null,
} as const;

/** A `work_session.updated` payload as the 07.17 API sent it (no poolAccount). */
const session0717 = {
  id: uuid(100),
  conversationId: uuid(101),
  projectId: uuid(102),
  projectName: "web",
  deviceId: uuid(103),
  deviceName: "Ana's MacBook",
  deviceOnline: true,
  runtime: "claude-code",
  model: null,
  permissionMode: "default",
  worktree: false,
  branch: "main",
  status: "idle",
  title: "Fix the login redirect",
  titleSource: "user",
  createdBy: uuid(104),
  createdByName: "Ana",
  queuedCount: 0,
  pendingApprovals: 0,
  lastError: null,
  settings: { requested: {}, effective: null, pending: false },
  fullAccess: false,
  runningSince: null,
  diffStat: null,
  createdAt: AT,
  updatedAt: AT,
};

describe("strategies", () => {
  it("accepts fill_first as a choice and stores it as failover", () => {
    expect(PoolStrategyChoice.parse("fill_first")).toBe("fill_first");
    expect(PoolStrategy.safeParse("fill_first").success).toBe(false);
    expect(normalizeStrategy("fill_first")).toBe("failover");
    expect(normalizeStrategy("failover")).toBe("failover");
    expect(normalizeStrategy("round_robin")).toBe("round_robin");
    expect(normalizeStrategy("weighted")).toBe("weighted");
  });

  it("has the verbatim texts", () => {
    expect(POOL_STRATEGY_TEXT).toEqual({
      failover: {
        label: "Use one until its limit, then the next",
        short: "failover",
        description: "The first ready account in your order. The next one only while it cools down.",
      },
      round_robin: {
        label: "Round-robin",
        short: "round-robin",
        description: "The ready account used least recently.",
      },
      weighted: {
        label: "Weighted",
        short: "weighted",
        description: "Ready accounts in proportion to their weight.",
      },
    });
    expect(BOTS_WEIGHTED_NOTE).toBe("Bots don't support weighted. They use round-robin.");
  });

  it("maps each runtime to its provider", () => {
    expect(POOL_PROVIDER_OF_RUNTIME).toEqual({ "claude-code": "claude", codex: "chatgpt" });
  });
});

describe("admin requests", () => {
  const add = { label: "Ana's Max", token: TOKEN };

  it("AddClaudeTokenRequest is strict and bounded", () => {
    expect(AddClaudeTokenRequest.parse({ label: "  Ana  ", token: TOKEN })).toEqual({
      label: "Ana",
      token: TOKEN,
    });
    expect(AddClaudeTokenRequest.safeParse({ ...add, extra: 1 }).success).toBe(false);
    expect(AddClaudeTokenRequest.safeParse({ ...add, label: "   " }).success).toBe(false);
    expect(AddClaudeTokenRequest.safeParse({ ...add, label: "x".repeat(121) }).success).toBe(false);
    const api = AddClaudeTokenRequest.safeParse({ ...add, token: API_KEY });
    expect(api.success).toBe(false);
    expect(api.error?.issues.map((i) => i.message)).toContain(
      "This is an API key. Add it in Settings › Models.",
    );
  });

  it("update requests refuse an empty body and out-of-range weights", () => {
    expect(UpdatePoolAccountRequest.safeParse({}).success).toBe(false);
    expect(UpdatePoolPolicyRequest.safeParse({}).success).toBe(false);
    expect(UpdatePoolAccountRequest.safeParse({ weight: 0 }).success).toBe(false);
    expect(UpdatePoolAccountRequest.safeParse({ weight: 101 }).success).toBe(false);
    expect(UpdatePoolAccountRequest.safeParse({ weight: 1.5 }).success).toBe(false);
    expect(UpdatePoolAccountRequest.parse({ weight: 100 })).toEqual({ weight: 100 });
    expect(UpdatePoolAccountRequest.parse({ enabled: false })).toEqual({ enabled: false });
    expect(UpdatePoolAccountRequest.safeParse({ token: API_KEY }).success).toBe(false);
    expect(UpdatePoolAccountRequest.safeParse({ label: "A", secretId: uuid(1) }).success).toBe(false);
    expect(UpdatePoolPolicyRequest.parse({ strategy: "fill_first" })).toEqual({ strategy: "fill_first" });
    expect(UpdatePoolPolicyRequest.safeParse({ scope: "everyone" }).success).toBe(false);
  });

  it("ReorderPoolRequest refuses repeated ids, none and 21 ids", () => {
    const twenty = Array.from({ length: 20 }, (_, i) => uuid(i + 1));
    expect(ReorderPoolRequest.safeParse({ accountIds: twenty }).success).toBe(true);
    expect(ReorderPoolRequest.safeParse({ accountIds: [...twenty, uuid(99)] }).success).toBe(false);
    expect(ReorderPoolRequest.safeParse({ accountIds: [uuid(1), uuid(1)] }).success).toBe(false);
    expect(ReorderPoolRequest.safeParse({ accountIds: [] }).success).toBe(false);
  });

  it("sign-in requests are strict", () => {
    expect(StartDeviceSignInRequest.safeParse({ deviceId: uuid(9), label: "Ops" }).success).toBe(true);
    expect(StartDeviceSignInRequest.safeParse({ deviceId: uuid(9), label: "Ops", x: 1 }).success).toBe(false);
    expect(BotPoolSignIn.safeParse({ label: "Bots 1" }).success).toBe(true);
    expect(BotPoolSignIn.safeParse({ label: "" }).success).toBe(false);
  });
});

describe("DTOs toward a browser", () => {
  it("PoolAccount parses a token, a slot and a cell profile row", () => {
    for (const row of [tokenRow, slotRow, cellRow]) expect(PoolAccount.parse(row)).toEqual(row);
  });

  it("no browser-facing schema has a token, secret id or e-mail key", () => {
    const forbidden = ["token", "oauthToken", "secretId", "email"];
    const shapes = [PoolAccount.shape, PoolPolicy.shape, SessionPoolAccountRef.shape, DeviceSignIn.shape];
    for (const shape of shapes) for (const key of forbidden) expect(Object.keys(shape)).not.toContain(key);
    for (const option of AccountSourcePreview.options)
      for (const key of forbidden) expect(Object.keys(option.shape)).not.toContain(key);
  });

  it("AccountPoolView holds both providers, at most 20 accounts each", () => {
    const view = {
      claude: { policy, accounts: [tokenRow] },
      chatgpt: { policy: { ...policy, provider: "chatgpt" }, accounts: [slotRow, cellRow] },
    };
    expect(AccountPoolView.parse(view)).toEqual(view);
    const many = Array.from({ length: 21 }, (_, i) => ({ ...tokenRow, id: uuid(i + 10) }));
    expect(AccountPoolView.safeParse({ ...view, claude: { policy, accounts: many } }).success).toBe(false);
  });

  it("DeviceSignIn parses a pending and a failed sign-in", () => {
    const pending = {
      id: uuid(20),
      deviceId: uuid(9),
      label: "Ops",
      state: "pending",
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1234",
      expiresAt: UNTIL,
      error: null,
      accountId: null,
      startedAt: AT,
    };
    expect(DeviceSignIn.safeParse(pending).success).toBe(true);
    expect(
      DeviceSignIn.safeParse({
        ...pending,
        state: "error",
        verificationUrl: null,
        userCode: null,
        error: { code: "runtime_too_old", message: "Update the OCW runtime on this device." },
      }).success,
    ).toBe(true);
  });

  it("lists the error codes", () => {
    expect(AccountPoolErrorCode.options).toContain("api_key_not_allowed");
    expect(AccountPoolErrorCode.options).toContain("no_account");
    expect(typeof CELL_CLAUDE_TOKENS).toBe("boolean");
  });
});

describe("account source previews", () => {
  it("parses each source and labels it", () => {
    const preview = {
      "claude-code": { source: "pool", strategy: "failover", ready: 2 },
      codex: { source: "device_login" },
    } as const;
    expect(AccountPoolPreview.parse(preview)).toEqual(preview);
    expect(AccountSourcePreview.parse({ source: "none", resetsAt: UNTIL })).toEqual({
      source: "none",
      resetsAt: UNTIL,
    });
    expect(accountSourceLabel({ source: "pool", strategy: "failover", ready: 1 })).toBe(
      "Account: pool (failover)",
    );
    expect(accountSourceLabel({ source: "pool", strategy: "round_robin", ready: 1 })).toBe(
      "Account: pool (round-robin)",
    );
    expect(accountSourceLabel({ source: "device_login" })).toBe("This device's login");
    expect(accountSourceLabel({ source: "none", resetsAt: null })).toBe("No pool account is ready");
  });
});

describe("accountSwitchedSentence", () => {
  const fmt = () => "15:40";
  it("gives each verbatim shape", () => {
    expect(
      accountSwitchedSentence({ fromLabel: "A", toLabel: "B", reason: "limit", until: UNTIL }, fmt),
    ).toBe("Switched to account B: A reached its limit until 15:40");
    expect(accountSwitchedSentence({ fromLabel: "A", toLabel: "B", reason: "limit", until: null }, fmt)).toBe(
      "Switched to account B: A reached its limit",
    );
    expect(
      accountSwitchedSentence({ fromLabel: "A", toLabel: null, reason: "limit", until: UNTIL }, fmt),
    ).toBe("Switched to this device's login: A reached its limit until 15:40");
    expect(
      accountSwitchedSentence({ fromLabel: "A", toLabel: "B", reason: "unavailable", until: null }, fmt),
    ).toBe("Switched to account B: A is no longer available");
    expect(
      accountSwitchedSentence({ fromLabel: null, toLabel: "B", reason: "limit", until: UNTIL }, fmt),
    ).toBe("Switched to account B: this device's login reached its limit until 15:40");
  });

  it("passes the ISO time to the caller's formatter and cuts labels to 120", () => {
    const seen: string[] = [];
    accountSwitchedSentence({ fromLabel: "A", toLabel: "B", reason: "limit", until: UNTIL }, (iso) => {
      seen.push(iso);
      return "x";
    });
    expect(seen).toEqual([UNTIL]);
    const long = "L".repeat(300);
    const s = accountSwitchedSentence(
      { fromLabel: "A", toLabel: long, reason: "unavailable", until: null },
      fmt,
    );
    expect(s).toBe(`Switched to account ${"L".repeat(120)}: A is no longer available`);
  });
});

describe("account.switched session event", () => {
  it("parses and is server-only", () => {
    const e = { type: "account.switched", fromLabel: "A", toLabel: null, reason: "limit", until: UNTIL };
    expect(SessionEvent.parse(e)).toEqual(e);
    expect(SessionEvent.safeParse({ ...e, reason: "manual" }).success).toBe(false);
    expect(SERVER_ONLY_SESSION_EVENTS.has("account.switched")).toBe(true);
    expect(SERVER_ONLY_SESSION_EVENTS.has("session.error")).toBe(false);
  });
});

describe("WorkSession.poolAccount", () => {
  it("a 07.17 session parses with and without poolAccount", () => {
    expect(WorkSession.parse(session0717).poolAccount).toBeUndefined();
    const ref = { id: uuid(1), label: "Ana's Max", provider: "claude" } as const;
    expect(WorkSession.parse({ ...session0717, poolAccount: ref }).poolAccount).toEqual(ref);
    expect(WorkSession.parse({ ...session0717, poolAccount: null }).poolAccount).toBeNull();
    expect(
      WorkSession.safeParse({ ...session0717, poolAccount: { ...ref, provider: "gemini" } }).success,
    ).toBe(false);
  });
});
