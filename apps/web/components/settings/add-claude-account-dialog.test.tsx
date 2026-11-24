import type { ClaudeSignInStart, PoolAccount } from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/panel-dialog";
import {
  completeClaudeSignInMutation,
  poolKeys,
  startClaudeSignInMutation,
} from "@/lib/account-pool-queries";
import { api } from "@/lib/api";
import { ClaudeAccountForm, claudeSignInRestarts, pastedCodeError } from "./add-claude-account-dialog";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() } };
});

/**
 * Settings › Account pool › Add Claude account (07.18-19 R3.1): "Connect a Claude account" is the primary action. It
 * opens Anthropic's own sign-in page in a new tab, then asks for the code that page shows; the API exchanges it and
 * seals the token. "Paste a setup-token instead" stays as the secondary way.
 */

const T = "2026-11-24T09:00:00.000Z";
const FLOW = "01a11635-d6e7-7c87-9f17-0000000000f1";
const ANA = "01a11635-d6e7-7c87-9f17-0000000000c1";
const AUTHORIZE =
  "https://claude.com/cai/oauth/authorize?code=true&client_id=9d1c250a-e61b-44d9-88ed-5944d1962f5e&response_type=code";

const started: ClaudeSignInStart = {
  flowId: FLOW,
  authorizeUrl: AUTHORIZE,
  expiresAt: "2026-11-24T09:10:00.000Z",
};

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

function render(node: ReactElement): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <Dialog open>{node}</Dialog>
    </QueryClientProvider>,
  );
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const tagsOf = (html: string, id: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`, "g")) ?? [];

const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  for (const m of CONSOLE) vi.spyOn(console, m);
});

afterEach(() => {
  for (const m of CONSOLE) expect(console[m]).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("Connect a Claude account (R3.1)", () => {
  it("leads with Connect a Claude account; pasting a setup-token is the secondary way", () => {
    const html = render(<ClaudeAccountForm onDone={() => undefined} initial={{ label: "ana@acme" }} />);
    const connect = tagsOf(html, "claude-connect-start")[0] ?? "";
    expect(connect).not.toContain(` disabled=""`);
    expect(text(html)).toContain("Connect a Claude account");
    expect(text(html)).toContain("Paste a setup-token instead");
    expect(tagsOf(html, "claude-use-token")).toHaveLength(1);
    // No token field and no terminal step on the first screen.
    expect(tagsOf(html, "claude-account-token")).toHaveLength(0);
    expect(text(html)).not.toContain("claude setup-token");
    expect(tagsOf(html, "claude-account-label")).toHaveLength(1);
  });

  it("needs a label before connecting a new account; a replacement needs none", () => {
    const none = render(<ClaudeAccountForm onDone={() => undefined} />);
    expect(tagsOf(none, "claude-connect-start")[0]).toContain(` disabled=""`);
    const again = render(
      <ClaudeAccountForm onDone={() => undefined} replacing={{ id: ANA, label: "ana@acme" }} />,
    );
    expect(tagsOf(again, "claude-account-label")).toHaveLength(0);
    expect(tagsOf(again, "claude-connect-start")[0]).not.toContain(` disabled=""`);
    expect(text(again)).toContain("Connect ana@acme again");
  });

  it("after Connect: Anthropic's page in a new tab, then one field for the code it shows", () => {
    const html = render(
      <ClaudeAccountForm onDone={() => undefined} initial={{ label: "ana@acme", flow: started }} />,
    );
    const link = tagsOf(html, "claude-authorize-link")[0] ?? "";
    expect(link).toContain(`href="${AUTHORIZE.replaceAll("&", "&amp;")}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    const code = tagsOf(html, "claude-code")[0] ?? "";
    expect(code).toContain('autoComplete="off"');
    expect(code).toContain('value=""');
    expect(text(html)).toContain("Paste the code");
    expect(tagsOf(html, "claude-code-save")[0]).toContain(` disabled=""`);
    // The fallback stays one click away.
    expect(tagsOf(html, "claude-use-token")).toHaveLength(1);
  });

  it("Add account turns on once a code is pasted; a paste that is clearly not the code says so", () => {
    const html = render(
      <ClaudeAccountForm
        onDone={() => undefined}
        initial={{ label: "ana@acme", flow: started, code: "ac_123#st_456" }}
      />,
    );
    expect(tagsOf(html, "claude-code-save")[0]).not.toContain(` disabled=""`);
    expect(pastedCodeError("ac_123#st_456")).toBeNull();
    expect(pastedCodeError("https://platform.claude.com/oauth/code/callback?code=a&state=b")).toBeNull();
    expect(pastedCodeError("")).toBeNull();
    expect(pastedCodeError("ac_123")).toBe("Copy all of the code, including the # in the middle.");
    expect(pastedCodeError("http://localhost:54545/callback?code=a")).toBe(
      "Paste the code from Anthropic's page, not this address.",
    );
  });

  it("a refused, expired or another sign-in's code needs a new start; a wrong paste or a missing label does not", () => {
    for (const code of ["code_refused", "sign_in_expired", "state_mismatch", "claude_unavailable"]) {
      expect(claudeSignInRestarts(code)).toBe(true);
    }
    for (const code of ["invalid_code", "label_required", "validation_error"]) {
      expect(claudeSignInRestarts(code)).toBe(false);
    }
  });

  it("the routes: start (with the account to replace), then complete with the code and the label", async () => {
    vi.mocked(api.post).mockResolvedValueOnce(started).mockResolvedValueOnce(account());
    const qc = new QueryClient();
    qc.setQueryData(poolKeys.view, { claude: null, chatgpt: null });
    await new MutationObserver(qc, startClaudeSignInMutation()).mutate({ accountId: ANA });
    await new MutationObserver(qc, completeClaudeSignInMutation(qc)).mutate({
      flowId: FLOW,
      code: "ac_123#st_456",
      label: "ana@acme",
    });
    const [startPath, startOpts] = vi.mocked(api.post).mock.calls[0] ?? [];
    expect(startPath).toBe("/api/v1/account-pool/claude/sign-ins");
    expect((startOpts as { body: unknown }).body).toEqual({ accountId: ANA });
    const [donePath, doneOpts] = vi.mocked(api.post).mock.calls[1] ?? [];
    expect(donePath).toBe("/api/v1/account-pool/claude/sign-ins/complete");
    expect((doneOpts as { body: unknown }).body).toEqual({
      flowId: FLOW,
      code: "ac_123#st_456",
      label: "ana@acme",
    });
    expect(qc.getQueryState(poolKeys.view)?.isInvalidated).toBe(true);
  });
});
