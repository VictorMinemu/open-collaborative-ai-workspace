import { describe, expect, it } from "vitest";
import { AccountUsageSnapshot, ClaudeSetupToken, POOL_LIMITS, PoolLabel } from "./account-pool";
import {
  AccountLoginPayload,
  AccountLogoutPayload,
  CommandKind,
  DEVICE_ACCOUNT_POOL_VERSION,
  DeviceToServerFrame,
  HelloFrame,
  PromptPayload,
  SessionAccount,
  SessionStartPayload,
} from "./device-link";

// Token-shaped values are assembled at runtime so no credential-shaped literal sits whole in the repository.
const fake = (...parts: string[]) => parts.join("");
const URL_SAFE = "abcdefghijKLMNOPQRST0123456789_-uvwxyzAB";
const TOKEN = fake("sk-", "ant-", "oat01-", URL_SAFE);
const API_KEY = fake("sk-", "ant-", "api03-", URL_SAFE);

const ACCOUNT_ID = "0199f0a0-0000-7000-8000-0000000000a1";
const SLOT_ID = "0199f0a0-0000-4000-8000-0000000000b2";
const SESSION_ID = "0199f0a0-0000-7000-8000-0000000000c3";
const COMMAND_ID = "0199f0a0-0000-7000-8000-0000000000d4";
const AT = "2026-11-24T10:00:00.000Z";
const RESETS = "2026-11-24T15:40:00.000Z";

const start0717 = { projectLocalId: "p1", runtime: "claude-code", permissionMode: "default" } as const;
const tokenAccount = { kind: "token", accountId: ACCOUNT_ID, label: "Ana's Max", oauthToken: TOKEN } as const;
const slotAccount = {
  kind: "device_slot",
  accountId: ACCOUNT_ID,
  label: "Ops Plus",
  slotId: SLOT_ID,
} as const;

const usage = {
  windows: [
    { kind: "five_hour", usedPercent: 42.5, resetsAt: RESETS },
    { kind: "seven_day", usedPercent: null, resetsAt: null },
  ],
  at: AT,
} as const;

const hello0717 = {
  type: "hello",
  protocolVersion: 1,
  device: { name: "Mac", platform: "darwin" },
  runtimes: [{ id: "claude-code", installed: true, version: "2.1.290", loggedIn: true }],
} as const;

const slotReport = (i: number) => ({
  slotId: `0199f0a0-0000-4000-8000-${String(i).padStart(12, "0")}`,
  label: `Slot ${i}`,
  origin: "server" as const,
  signedIn: true,
  planType: "plus",
  usage: null,
});

describe("account-pool primitives for the Device Link", () => {
  it("bounds labels and tokens as the hub names them", () => {
    expect(PoolLabel.parse("  Ana  ")).toBe("Ana");
    expect(PoolLabel.safeParse("   ").success).toBe(false);
    expect(PoolLabel.safeParse("x".repeat(121)).success).toBe(false);
    expect(ClaudeSetupToken.parse(TOKEN)).toBe(TOKEN);
    expect(POOL_LIMITS.switchesPerTurn).toBe(3);
    expect(AccountUsageSnapshot.safeParse(usage).success).toBe(true);
  });

  it("refuses an API key with the Settings › Models sentence", () => {
    const r = ClaudeSetupToken.safeParse(API_KEY);
    expect(r.success).toBe(false);
    expect(r.error?.issues.map((i) => i.message)).toContain(
      "This is an API key. Add it in Settings › Models.",
    );
  });
});

describe("SessionStartPayload.account", () => {
  it("parses a 07.17 start unchanged", () => {
    const parsed = SessionStartPayload.parse(start0717);
    expect(parsed.account).toBeUndefined();
  });

  it("parses a token account and a device slot account", () => {
    expect(SessionStartPayload.parse({ ...start0717, account: tokenAccount }).account).toEqual(tokenAccount);
    expect(SessionStartPayload.parse({ ...start0717, account: slotAccount }).account).toEqual(slotAccount);
    expect(SessionStartPayload.parse({ ...start0717, account: null }).account).toBeNull();
  });

  it("refuses an API key, whitespace, a short token and a slot without slotId", () => {
    const bad = [
      { ...tokenAccount, oauthToken: API_KEY },
      { ...tokenAccount, oauthToken: fake("sk-", "ant-", "oat01-", "abc def", URL_SAFE) },
      { ...tokenAccount, oauthToken: TOKEN.slice(0, 19) },
      { kind: "device_slot", accountId: ACCOUNT_ID, label: "Ops" },
    ];
    for (const account of bad) {
      expect(SessionStartPayload.safeParse({ ...start0717, account }).success, JSON.stringify(account)).toBe(
        false,
      );
    }
    expect(TOKEN.slice(0, 19)).toHaveLength(19);
  });

  it("is a closed set of kinds", () => {
    expect(SessionAccount.safeParse({ ...tokenAccount, kind: "cell_profile" }).success).toBe(false);
  });
});

describe("PromptPayload.account", () => {
  const prompt = { promptId: "p-1", text: "hi" };
  it("parses absent, null and a token account", () => {
    expect(PromptPayload.parse(prompt).account).toBeUndefined();
    expect(PromptPayload.parse({ ...prompt, account: null }).account).toBeNull();
    expect(PromptPayload.parse({ ...prompt, account: tokenAccount }).account).toEqual(tokenAccount);
  });
});

describe("HelloFrame.accountPool", () => {
  it("parses a 07.17 hello and one with accountPool 1; refuses 2", () => {
    expect(HelloFrame.parse(hello0717).accountPool).toBeUndefined();
    expect(HelloFrame.parse({ ...hello0717, accountPool: DEVICE_ACCOUNT_POOL_VERSION }).accountPool).toBe(1);
    expect(HelloFrame.safeParse({ ...hello0717, accountPool: 2 }).success).toBe(false);
    expect(DeviceToServerFrame.safeParse({ ...hello0717, accountPool: 1 }).success).toBe(true);
  });
});

describe("device → server account frames", () => {
  it("parses session.account_limited with nulls and with every field set", () => {
    const base = { type: "session.account_limited", sessionId: SESSION_ID, reason: "five_hour", at: AT };
    expect(
      DeviceToServerFrame.safeParse({ ...base, promptId: null, accountId: null, resetsAt: null }).success,
    ).toBe(true);
    expect(
      DeviceToServerFrame.safeParse({ ...base, promptId: "p-1", accountId: ACCOUNT_ID, resetsAt: RESETS })
        .success,
    ).toBe(true);
    expect(
      DeviceToServerFrame.safeParse({ ...base, promptId: null, accountId: null, resetsAt: null, reason: "x" })
        .success,
    ).toBe(false);
  });

  it("parses account.usage naming exactly one of accountId and slotId", () => {
    const base = { type: "account.usage", usage };
    expect(DeviceToServerFrame.safeParse({ ...base, accountId: ACCOUNT_ID }).success).toBe(true);
    expect(DeviceToServerFrame.safeParse({ ...base, slotId: SLOT_ID }).success).toBe(true);
    expect(DeviceToServerFrame.safeParse({ ...base, accountId: ACCOUNT_ID, slotId: SLOT_ID }).success).toBe(
      false,
    );
    expect(DeviceToServerFrame.safeParse(base).success).toBe(false);
  });

  it("parses accounts.sync with 10 slots and refuses 11", () => {
    const ten = Array.from({ length: POOL_LIMITS.slotsPerDevice }, (_, i) => slotReport(i + 1));
    expect(DeviceToServerFrame.safeParse({ type: "accounts.sync", codexSlots: ten }).success).toBe(true);
    expect(
      DeviceToServerFrame.safeParse({ type: "accounts.sync", codexSlots: [...ten, slotReport(11)] }).success,
    ).toBe(false);
  });

  it("parses account.login in each phase", () => {
    const base = { type: "account.login", requestId: COMMAND_ID, slotId: SLOT_ID };
    const frames = [
      {
        ...base,
        phase: "code",
        verificationUrl: "https://auth.openai.com/codex/device",
        userCode: "ABCD-1234",
        expiresAt: RESETS,
      },
      { ...base, phase: "completed", planType: "pro" },
      { ...base, phase: "failed", error: { code: "expired", message: "The code expired." } },
    ];
    for (const f of frames) expect(DeviceToServerFrame.safeParse(f).success, f.phase).toBe(true);
    expect(DeviceToServerFrame.safeParse({ ...base, phase: "done" }).success).toBe(false);
  });

  it("carries no token or e-mail field in any account frame", () => {
    const limited = DeviceToServerFrame.parse({
      type: "session.account_limited",
      sessionId: SESSION_ID,
      promptId: null,
      accountId: null,
      reason: "unknown",
      resetsAt: null,
      at: AT,
      oauthToken: TOKEN,
      email: "a@example.com",
    });
    expect(JSON.stringify(limited)).not.toContain("oauthToken");
    expect(JSON.stringify(limited)).not.toContain("email");
  });
});

describe("account commands", () => {
  it("lists account.login and account.logout", () => {
    expect(CommandKind.parse("account.login")).toBe("account.login");
    expect(CommandKind.parse("account.logout")).toBe("account.logout");
  });

  it("strict payloads refuse an extra key", () => {
    const login = { provider: "chatgpt", slotId: SLOT_ID, label: "Ops" };
    expect(AccountLoginPayload.safeParse(login).success).toBe(true);
    expect(AccountLoginPayload.safeParse({ ...login, token: TOKEN }).success).toBe(false);
    expect(AccountLoginPayload.safeParse({ ...login, provider: "claude" }).success).toBe(false);
    expect(AccountLogoutPayload.safeParse({ slotId: SLOT_ID }).success).toBe(true);
    expect(AccountLogoutPayload.safeParse({ slotId: SLOT_ID, extra: 1 }).success).toBe(false);
  });
});
