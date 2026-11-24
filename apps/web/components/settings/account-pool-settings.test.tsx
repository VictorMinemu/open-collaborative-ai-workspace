import type { AccountPoolView, PoolAccount, PoolPolicy, PoolProvider } from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { api } from "@/lib/api";
import { addClaudeAccountMutation, poolKeys } from "@/lib/account-pool-queries";
import { PoolSections } from "./account-pool-settings";
import { ClaudeAccountForm, claudeTokenError, SETUP_TOKEN_HELP } from "./add-claude-account-dialog";
import { SETTINGS_SECTIONS } from "./settings-nav";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() } };
});

/**
 * Settings › Account pool (07.18-15, D-10, D-15, PD-19, PD-22): admins see a Claude and a ChatGPT section, each with
 * its strategy and its accounts, and add a Claude account by pasting a setup-token. Static markup in node from the
 * view, plus the mutation options against a mocked `api`; the API decides every write.
 */

const T = "2026-11-24T09:00:00.000Z";
const ANA = "01a11635-d6e7-7c87-9f17-0000000000c1";

function policy(provider: PoolProvider, over: Partial<PoolPolicy> = {}): PoolPolicy {
  return {
    provider,
    strategy: "failover",
    scope: "all",
    fallbackToDeviceLogin: true,
    updatedAt: null,
    ...over,
  };
}

function account(over: Partial<PoolAccount> = {}): PoolAccount {
  return {
    id: ANA,
    provider: "claude",
    kind: "token",
    label: "ana@acme",
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
    createdAt: T,
    ...over,
  };
}

function view(over: { claude?: PoolAccount[]; chatgpt?: PoolAccount[] } = {}): AccountPoolView {
  return {
    claude: { policy: policy("claude"), accounts: over.claude ?? [account()] },
    chatgpt: { policy: policy("chatgpt"), accounts: over.chatgpt ?? [] },
  };
}

function render(node: ReactElement, qc = new QueryClient()): string {
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
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
  vi.mocked(api.post).mockReset();
  vi.mocked(api.patch).mockReset();
  vi.mocked(api.put).mockReset();
  vi.mocked(api.del).mockReset();
});

describe("Settings › Account pool in the nav (Task 1)", () => {
  it("is listed for provider.manage only, right after Models", () => {
    const entry = SETTINGS_SECTIONS.find((s) => s.id === "account-pool");
    expect(entry).toMatchObject({
      label: "Account pool",
      href: "/settings/account-pool",
      permission: "provider.manage",
    });
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids.indexOf("account-pool")).toBe(ids.indexOf("models") + 1);
  });
});

describe("the two provider sections (Task 1)", () => {
  it("renders Claude and ChatGPT, the strategy of each, the Claude row and the empty ChatGPT state", () => {
    const html = render(<PoolSections view={view()} />);
    const claude = from(html, "pool-section-claude");
    const chatgpt = from(html, "pool-section-chatgpt");
    expect(tagsOf(html, "pool-section-claude")).toHaveLength(1);
    expect(tagsOf(html, "pool-section-chatgpt")).toHaveLength(1);
    expect(text(claude)).toContain("Claude");
    expect(text(chatgpt)).toContain("ChatGPT");
    // Each strategy, as the default policy reads it (D-15: failover).
    expect(tagsOf(html, "pool-strategy-claude")).toHaveLength(1);
    expect(tagsOf(html, "pool-strategy-chatgpt")).toHaveLength(1);
    expect(text(claude)).toContain("Use one until its limit, then the next");
    // The Claude row.
    expect(tagsOf(html, "pool-account")).toHaveLength(1);
    expect(text(from(html, "pool-account"))).toContain("ana@acme");
    // ChatGPT has no account: one line of help and its add button.
    expect(tagsOf(html, "pool-empty-chatgpt")).toHaveLength(1);
    expect(text(from(html, "pool-empty-chatgpt"))).toContain("No ChatGPT accounts yet");
    expect(tagsOf(html, "pool-add-chatgpt").length).toBeGreaterThanOrEqual(1);
    expect(tagsOf(html, "pool-add-claude").length).toBeGreaterThanOrEqual(1);
    expect(text(html)).toContain("Add Claude account");
    expect(text(html)).toContain("Add ChatGPT account");
  });

  it("never asks for an API key (D-15)", () => {
    const html = text(render(<PoolSections view={view()} />));
    expect(html).not.toMatch(/api key/i);
  });

  it("renders labels as text", () => {
    const html = render(<PoolSections view={view({ claude: [account({ label: "<b>x</b>" })] })} />);
    expect(html).toContain("&lt;b&gt;x&lt;/b&gt;");
    expect(html).not.toContain("<b>x</b>");
  });
});

describe("Add Claude account (Task 1)", () => {
  it("explains claude setup-token and asks for a label and a password-type token", () => {
    const html = render(<ClaudeAccountForm onDone={() => undefined} />);
    expect(SETUP_TOKEN_HELP).toBe(
      "Run `claude setup-token` in a terminal where you are signed in to the Claude account, then paste the token here.",
    );
    expect(text(html)).toContain("claude setup-token");
    expect(text(html)).toContain("in a terminal where you are signed in to the Claude account");
    const label = tagsOf(html, "claude-account-label")[0] ?? "";
    expect(label).toContain('type="text"');
    const token = tagsOf(html, "claude-account-token")[0] ?? "";
    expect(token).toContain('type="password"');
    expect(token).toContain('autoComplete="off"');
    expect(token).toContain('value=""');
    const save = tagsOf(html, "claude-account-save")[0] ?? "";
    expect(save).toMatch(/disabled/);
  });

  it("refuses an API key inline with the contract's sentence; Save stays disabled", () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    expect(claudeTokenError(key)).toBe("This is an API key. Add it in Settings › Models.");
    const html = render(<ClaudeAccountForm onDone={() => undefined} initial={{ label: "ana@acme", token: key }} />);
    expect(text(from(html, "claude-account-token-error"))).toContain(
      "This is an API key. Add it in Settings › Models.",
    );
    expect(tagsOf(html, "claude-account-save")[0]).toMatch(/disabled/);
  });

  it("accepts a setup-token; empty reads as no error yet", () => {
    expect(claudeTokenError(`sk-ant-oat01-${"b".repeat(40)}`)).toBeNull();
    expect(claudeTokenError("")).toBeNull();
    expect(claudeTokenError("hello world, not a token")).toBe("A Claude setup-token starts with sk-ant-");
    expect(claudeTokenError("sk-ant-oat01-x")).toBe("Paste the whole token.");
  });

  it("Save posts the label and the token once and refreshes the list", async () => {
    const added = account({ id: "01a11635-d6e7-7c87-9f17-0000000000c2", label: "bea@acme" });
    vi.mocked(api.post).mockResolvedValue(added);
    const qc = new QueryClient();
    qc.setQueryData(poolKeys.view, view());
    const body = { label: "bea@acme", token: `sk-ant-oat01-${"c".repeat(40)}` };
    await new MutationObserver(qc, addClaudeAccountMutation(qc)).mutate(body);
    expect(api.post).toHaveBeenCalledTimes(1);
    const [path, opts] = vi.mocked(api.post).mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/account-pool/claude/accounts");
    expect((opts as { body: unknown }).body).toEqual(body);
    expect(qc.getQueryState(poolKeys.view)?.isInvalidated).toBe(true);
  });
});
