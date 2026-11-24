import {
  type AccountPoolView,
  BOTS_WEIGHTED_NOTE,
  type PoolAccount,
  type PoolPolicy,
  type PoolProvider,
} from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/panel-dialog";
import {
  addClaudeAccountMutation,
  poolKeys,
  removePoolAccountMutation,
  reorderPoolMutation,
  updatePoolAccountMutation,
  updatePoolPolicyMutation,
} from "@/lib/account-pool-queries";
import { api } from "@/lib/api";
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

function view(
  over: {
    claude?: PoolAccount[];
    chatgpt?: PoolAccount[];
    claudePolicy?: Partial<PoolPolicy>;
    chatgptPolicy?: Partial<PoolPolicy>;
  } = {},
): AccountPoolView {
  return {
    claude: { policy: policy("claude", over.claudePolicy), accounts: over.claude ?? [account()] },
    chatgpt: { policy: policy("chatgpt", over.chatgptPolicy), accounts: over.chatgpt ?? [] },
  };
}

const BEA = "01a11635-d6e7-7c87-9f17-0000000000c2";
const CAI = "01a11635-d6e7-7c87-9f17-0000000000c3";
const BUILD = { id: "01a11635-d6e7-7c87-9f17-0000000000d1", name: "Build server", online: true };

/** Three Claude accounts in order: ready, cooling with usage, needs a new token. */
const THREE = [
  account(),
  account({
    id: BEA,
    label: "bea@acme",
    priority: 1,
    weight: 3,
    status: "cooling",
    cooldownUntil: "2026-11-24T15:40:00.000Z",
    lastUsedAt: "2026-11-24T08:00:00.000Z",
    usage: {
      at: T,
      windows: [
        { kind: "five_hour", usedPercent: 100, resetsAt: "2026-11-24T15:40:00.000Z" },
        { kind: "seven_day", usedPercent: 61, resetsAt: null },
      ],
    },
  }),
  account({ id: CAI, label: "cai@acme", priority: 2, status: "needs_sign_in" }),
];

/** The opening tag of the element with this accessible name. */
const named = (html: string, name: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*aria-label="${name}"[^>]*>`))?.[0] ?? "";

function render(node: ReactElement, qc = new QueryClient()): string {
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

/** Dialog parts need the dialog's root; the popup itself (a portal) is not rendered in node. */
const inDialog = (node: ReactElement) => render(<Dialog open>{node}</Dialog>);

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
    const html = inDialog(<ClaudeAccountForm onDone={() => undefined} />);
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
    expect(save).toContain(` disabled=""`);
  });

  it("refuses an API key inline with the contract's sentence; Save stays disabled", () => {
    const key = `sk-ant-api03-${"a".repeat(40)}`;
    expect(claudeTokenError(key)).toBe("This is an API key. Add it in Settings › Models.");
    const html = inDialog(
      <ClaudeAccountForm onDone={() => undefined} initial={{ label: "ana@acme", token: key }} />,
    );
    const alert = html.match(/<p[^>]*role="alert"[^>]*>([^<]*)<\/p>/)?.[1] ?? "";
    expect(alert).toBe("This is an API key. Add it in Settings › Models.");
    expect(tagsOf(html, "claude-account-save")[0]).toContain(` disabled=""`);
  });

  it("Save turns on with a label and a setup-token", () => {
    const html = inDialog(
      <ClaudeAccountForm
        onDone={() => undefined}
        initial={{ label: "ana@acme", token: `sk-ant-oat01-${"b".repeat(40)}` }}
      />,
    );
    expect(tagsOf(html, "claude-account-save")[0]).not.toContain(` disabled=""`);
    expect(html).not.toContain('role="alert"');
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

describe("account rows (Task 2)", () => {
  const html = render(<PoolSections view={view({ claude: THREE })} />);

  it("shows each account's label, where it lives, its status, when it was used and its usage", () => {
    const rows = tagsOf(html, "pool-account");
    expect(rows).toHaveLength(3);
    const bea = text(from(html, `pool-account-${BEA}`)).split("cai@acme")[0] ?? "";
    expect(bea).toContain("bea@acme");
    expect(bea).toContain("Sealed on the server");
    expect(bea).toMatch(/Cooling until (Tue )?\d\d:\d\d/);
    expect(bea).toContain("Used");
    expect(bea).toContain("5 hours");
    expect(bea).toContain("100%");
    expect(bea).toContain("7 days");
    expect(bea).toContain("61%");
    expect(tagsOf(html, "pool-usage-bar").length).toBe(2);
    expect(text(from(html, `pool-account-${CAI}`))).toContain("Paste a new token");
    expect(text(from(html, `pool-account-${ANA}`))).toContain("Not used yet");
  });

  it("has an on/off switch, rename, up and down, and remove, each with an accessible name", () => {
    expect(named(html, "Use ana@acme")).toMatch(/aria-checked="true"|data-checked/);
    expect(named(html, "Rename ana@acme")).not.toBe("");
    expect(named(html, "Remove ana@acme")).not.toBe("");
    expect(named(html, "Move ana@acme up")).toContain(` disabled=""`);
    expect(named(html, "Move ana@acme down")).not.toContain(` disabled=""`);
    expect(named(html, "Move bea@acme up")).not.toContain(` disabled=""`);
    expect(named(html, "Move cai@acme down")).toContain(` disabled=""`);
    // A token account can get a new token.
    expect(named(html, "Replace the token of cai@acme")).not.toBe("");
  });

  it("shows the weight only under weighted", () => {
    expect(named(html, "Weight for bea@acme")).toBe("");
    const weighted = render(
      <PoolSections view={view({ claude: THREE, claudePolicy: { strategy: "weighted" } })} />,
    );
    const weight = named(weighted, "Weight for bea@acme");
    expect(weight).toContain('type="number"');
    expect(weight).toContain('min="1"');
    expect(weight).toContain('max="100"');
    expect(weight).toContain('value="3"');
  });

  it("stacks on a phone: no fixed widths that would scroll sideways", () => {
    const row = tagsOf(html, `pool-account-${ANA}`)[0] ?? "";
    expect(row).toContain("flex-col");
    expect(row).toContain("sm:flex-row");
  });
});

describe("strategy, scope and fallback (Task 2)", () => {
  it("each section has its strategy select; Claude also has the scope; both have the fallback switch", () => {
    const html = render(<PoolSections view={view()} />);
    expect(tagsOf(html, "pool-strategy-select-claude")).toHaveLength(1);
    expect(tagsOf(html, "pool-strategy-select-chatgpt")).toHaveLength(1);
    expect(tagsOf(html, "pool-scope-claude")).toHaveLength(1);
    expect(tagsOf(html, "pool-scope-chatgpt")).toHaveLength(0);
    expect(tagsOf(html, "pool-fallback-claude")).toHaveLength(1);
    expect(tagsOf(html, "pool-fallback-chatgpt")).toHaveLength(1);
    expect(text(html)).toContain("Use the device's own login when no account is ready");
    expect(text(from(html, "pool-scope-claude"))).toContain("Work Zone and bots");
    // D-15: a session keeps its account until that account hits its limit.
    expect(text(html)).toContain("A session keeps its account until that account hits its limit.");
  });

  it("says bots use round-robin under weighted, and nothing about it otherwise", () => {
    expect(BOTS_WEIGHTED_NOTE).toBe("Bots don't support weighted. They use round-robin.");
    const failover = render(<PoolSections view={view()} />);
    expect(text(failover)).not.toContain(BOTS_WEIGHTED_NOTE);
    const weighted = render(<PoolSections view={view({ chatgptPolicy: { strategy: "weighted" } })} />);
    expect(text(from(weighted, "pool-section-chatgpt"))).toContain(BOTS_WEIGHTED_NOTE);
  });

  it("says bots use the Anthropic API key when Claude tokens do not reach the bots", () => {
    const html = render(<PoolSections view={view()} cellClaudeTokens={false} />);
    expect(text(from(html, "pool-section-claude"))).toContain("Bots use the Anthropic API key");
    expect(text(render(<PoolSections view={view()} />))).not.toContain("Bots use the Anthropic API key");
  });

  it("names a ChatGPT account on a device and one in the bots runtime", () => {
    const html = render(
      <PoolSections
        view={view({
          chatgpt: [
            account({ id: BEA, provider: "chatgpt", kind: "device_slot", label: "ops@acme", device: BUILD }),
            account({
              id: CAI,
              provider: "chatgpt",
              kind: "cell_profile",
              label: "bots@acme",
              planType: "pro",
            }),
          ],
        })}
      />,
    );
    const section = text(from(html, "pool-section-chatgpt"));
    expect(section).toContain("On Build server");
    expect(section).toContain("Bots runtime");
    expect(section).toContain("ChatGPT Pro");
  });
});

describe("the row and policy writes (Task 2)", () => {
  it("the switch is optimistic and rolls back when the API refuses", async () => {
    const qc = new QueryClient();
    qc.setQueryData(poolKeys.view, view({ claude: THREE }));
    let release: (v: unknown) => void = () => undefined;
    vi.mocked(api.patch).mockReturnValue(new Promise((r) => (release = r)));
    const pending = new MutationObserver(qc, updatePoolAccountMutation(qc)).mutate({
      id: ANA,
      body: { enabled: false },
    });
    await vi.waitFor(() =>
      expect(qc.getQueryData<AccountPoolView>(poolKeys.view)?.claude.accounts[0]?.enabled).toBe(false),
    );
    expect(api.patch).toHaveBeenCalledTimes(1);
    release(account({ enabled: false, status: "disabled" }));
    await pending;
    const [path, opts] = vi.mocked(api.patch).mock.calls[0] ?? [];
    expect(path).toBe(`/api/v1/account-pool/accounts/${ANA}`);
    expect((opts as { body: unknown }).body).toEqual({ enabled: false });

    vi.mocked(api.patch).mockRejectedValue(new Error("refused"));
    qc.setQueryData(poolKeys.view, view({ claude: THREE }));
    await new MutationObserver(qc, updatePoolAccountMutation(qc))
      .mutate({ id: ANA, body: { enabled: false } })
      .catch(() => undefined);
    expect(qc.getQueryData<AccountPoolView>(poolKeys.view)?.claude.accounts[0]?.enabled).toBe(true);
  });

  it("reorder waits for the server and takes its view", async () => {
    const qc = new QueryClient();
    qc.setQueryData(poolKeys.view, view({ claude: THREE }));
    const answer = view({
      claude: [THREE[1] as PoolAccount, THREE[0] as PoolAccount, THREE[2] as PoolAccount],
    });
    vi.mocked(api.put).mockResolvedValue(answer);
    await new MutationObserver(qc, reorderPoolMutation(qc)).mutate({
      provider: "claude",
      accountIds: [BEA, ANA, CAI],
    });
    const [path, opts] = vi.mocked(api.put).mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/account-pool/claude/order");
    expect((opts as { body: unknown }).body).toEqual({ accountIds: [BEA, ANA, CAI] });
    expect(qc.getQueryData(poolKeys.view)).toEqual(answer);
  });

  it("the strategy, scope and fallback go to the provider's policy route", async () => {
    const qc = new QueryClient();
    qc.setQueryData(poolKeys.view, view());
    const saved = policy("chatgpt", { strategy: "round_robin", updatedAt: T });
    vi.mocked(api.put).mockResolvedValue(saved);
    await new MutationObserver(qc, updatePoolPolicyMutation(qc)).mutate({
      provider: "chatgpt",
      body: { strategy: "round_robin" },
    });
    const [path, opts] = vi.mocked(api.put).mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/account-pool/chatgpt/policy");
    expect((opts as { body: unknown }).body).toEqual({ strategy: "round_robin" });
    expect(qc.getQueryData<AccountPoolView>(poolKeys.view)?.chatgpt.policy).toEqual(saved);
  });

  it("remove is one DELETE and refreshes the list", async () => {
    const qc = new QueryClient();
    qc.setQueryData(poolKeys.view, view({ claude: THREE }));
    vi.mocked(api.del).mockResolvedValue({ ok: true });
    await new MutationObserver(qc, removePoolAccountMutation(qc)).mutate(CAI);
    expect(vi.mocked(api.del).mock.calls[0]?.[0]).toBe(`/api/v1/account-pool/accounts/${CAI}`);
    expect(qc.getQueryState(poolKeys.view)?.isInvalidated).toBe(true);
  });
});
