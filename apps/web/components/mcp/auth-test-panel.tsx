"use client";

import {
  authFailureFix,
  type ClientCredentialsInput,
  type McpTransport,
  type OAuthTestMode,
  type OAuthTestRequest,
  type OAuthTestResponse,
  usesOAuthSignIn,
} from "@ocw/contracts";
import { CircleCheck, CircleDashed, CircleX, Stethoscope, TriangleAlert } from "lucide-react";
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useOAuthTest } from "@/lib/mcp-queries";
import { stepLabel, stepOfFailure } from "@/lib/org-connection-format";
import { cn } from "@/lib/utils";

/**
 * "Test sign-in" in the MCP server dialog (07.14 D-10, D-18, PD-08, PD-12): dry-runs the sign-in of the dialog's
 * current values (or the saved server) through `POST /connectors/oauth-test`. Nothing is stored or registered. Every
 * sentence comes from closed codes (`stepLabel`, `authFailureFix`), never from the provider's answer.
 */

/** The dialog's values the test needs. Write-only fields are sent only when typed (else the stored ones are used). */
export interface AuthTestValues {
  /** The saved server, when editing: its stored clients and secret are used for what the form leaves empty. */
  serverId: string | null;
  url: string;
  transport: McpTransport;
  mode: OAuthTestMode;
  useCimd: boolean;
  /** The typed pre-registered client (sign-in modes), when any field of it was typed. */
  oauthClient: { issuer: string; clientId: string; clientSecret?: string } | undefined;
  cc: { clientId: string; clientSecret: string; tokenUrl: string };
  scopes: string[];
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === "https:" || u.protocol === "http:";
  } catch {
    return false;
  }
}

/** The `OAuthTestRequest` for the dialog's values: only the chosen mode's fields, and the page's origin. */
export function oauthTestRequest(v: AuthTestValues, pageOrigin: string): OAuthTestRequest {
  const url = v.url.trim();
  const req: OAuthTestRequest = {
    authMode: v.mode,
    ...(v.serverId ? { serverId: v.serverId } : {}),
    ...(url ? { url } : {}),
    ...(v.transport === "streamable-http" || v.transport === "sse" ? { transport: v.transport } : {}),
    pageOrigin,
  };
  if (usesOAuthSignIn(v.mode)) {
    req.oauthUseCimd = v.useCimd;
    // An incomplete client is left out (the saved clients are used); the dialog's own checks name the missing field.
    const c = v.oauthClient;
    if (c && isHttpUrl(c.issuer.trim()) && c.clientId.trim()) {
      req.oauthClient = {
        issuer: c.issuer.trim(),
        clientId: c.clientId.trim(),
        ...(c.clientSecret ? { clientSecret: c.clientSecret } : {}),
      };
    }
  }
  if (v.mode === "org_client_credentials" && v.cc.clientId.trim()) {
    const tokenEndpoint = v.cc.tokenUrl.trim();
    const cc: ClientCredentialsInput = { clientId: v.cc.clientId.trim() };
    if (v.cc.clientSecret) cc.clientSecret = v.cc.clientSecret;
    if (tokenEndpoint) cc.tokenEndpoint = tokenEndpoint;
    req.clientCredentials = cc;
  }
  if (v.scopes.length > 0) req.oauthScopes = v.scopes;
  return req;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * The public-URL check (RESEARCH Pitfall 1), the server's rule (diagnosis `public_url`; 07.14 review WR-05): providers
 * return the browser to the redirect URI, so a workspace opened from another machine (behind a proxy or tunnel) whose
 * redirect URI is still loopback (`OCW_PUBLIC_API_URL` left at its default) sends the admin to their own machine, and
 * a plain-http redirect URI on a non-loopback host is refused by providers wherever the page is. Only then does it
 * warn. An API on its own HTTPS host beside the web is a supported layout (`docs/self-hosting/reverse-proxy.md` rule
 * 1) and never warns; nor does a loopback redirect URI on a local page. Null when nothing is wrong or the URI is
 * missing.
 */
export function publicUrlMismatch(
  redirectUri: string,
  pageHref: string,
): { redirectHost: string; pageHost: string } | null {
  let redirect: URL;
  let page: URL;
  try {
    redirect = new URL(redirectUri);
    page = new URL(pageHref);
  } catch {
    return null;
  }
  const loopback = LOOPBACK_HOSTS.has(redirect.hostname);
  // Plain http on a non-loopback host is refused by providers wherever the page is; loopback works only locally.
  const unreachable = loopback ? !LOOPBACK_HOSTS.has(page.hostname) : redirect.protocol !== "https:";
  return unreachable ? { redirectHost: redirect.hostname, pageHost: page.hostname } : null;
}

/** The result line: ready / a token issued, or the first failed step and its fix line. */
export function testOutcome(
  result: OAuthTestResponse,
  mode: OAuthTestMode,
  server: string,
): { ok: boolean; title: string; fix: string | null } {
  if (result.ok) {
    return {
      ok: true,
      title:
        mode === "org_client_credentials"
          ? `${server} issued a token. Save to use it.`
          : `${server}'s sign-in looks ready. Save, then Connect.`,
      fix: null,
    };
  }
  if (!result.failure) return { ok: false, title: "The sign-in check didn't finish. Try again.", fix: null };
  return {
    ok: false,
    title: `Sign-in fails at: ${stepLabel(stepOfFailure(result.failure))}`,
    fix: authFailureFix(result.failure, server),
  };
}

const STEP_STATUS = {
  ok: { icon: CircleCheck, word: "Passed", className: "text-emerald-700 dark:text-emerald-400" },
  failed: { icon: CircleX, word: "Failed", className: "text-destructive" },
  skipped: { icon: CircleDashed, word: "Not checked", className: "text-muted-foreground" },
} as const;

/** The step list and the result line of one answer (an `<ol>`, the status as text beside each icon). */
export function AuthTestResult({
  result,
  mode,
  server,
}: {
  result: OAuthTestResponse;
  mode: OAuthTestMode;
  server: string;
}) {
  const outcome = testOutcome(result, mode, server);
  return (
    <div className="grid gap-2.5" data-testid="mcp-auth-test-result" data-ok={outcome.ok}>
      <ol className="grid gap-1" aria-label="Sign-in steps">
        {result.steps.map((s) => {
          const status = STEP_STATUS[s.status];
          const Icon = status.icon;
          return (
            <li
              key={s.step}
              className="flex min-w-0 items-center gap-2 text-[13px]"
              data-testid="mcp-auth-test-step"
              data-step={s.step}
              data-status={s.status}
            >
              <Icon className={cn("size-3.5 shrink-0", status.className)} aria-hidden />
              <span className={cn("min-w-0 flex-1", s.status === "skipped" && "text-muted-foreground")}>
                {stepLabel(s.step)}
              </span>
              <span
                className={cn(
                  "shrink-0 text-xs",
                  s.status === "failed" ? status.className : "text-muted-foreground",
                )}
              >
                {status.word}
              </span>
            </li>
          );
        })}
      </ol>
      <div
        className={cn(
          "rounded-md px-3 py-2 text-[13px] leading-snug",
          outcome.ok
            ? "bg-emerald-50 text-emerald-900 dark:bg-emerald-400/10 dark:text-emerald-200"
            : "border border-destructive/30 bg-destructive/8 text-foreground",
        )}
      >
        <p className="font-medium">{outcome.title}</p>
        {outcome.fix ? (
          <p className="mt-0.5 text-muted-foreground" data-testid="mcp-auth-test-fix">
            {outcome.fix}
          </p>
        ) : null}
      </div>
    </div>
  );
}

/**
 * The panel: the outline `Test sign-in` button, the public-URL warning (computed here from the redirect URI and the
 * page, independently of any answer), the last answer and a polite live region that reads the outcome. The answer is
 * dropped when the mode changes (it described another check).
 */
export function AuthTestPanel({
  values,
  server,
  redirectUri,
}: {
  values: AuthTestValues;
  /** The server's name for the copy ("this server" while unnamed). */
  server: string;
  /** The instance's redirect URI (`McpServerList.oauth`), for the public-URL warning. */
  redirectUri: string;
}) {
  const test = useOAuthTest();
  const [answer, setAnswer] = useState<{ mode: OAuthTestMode; result: OAuthTestResponse } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pageHref, setPageHref] = useState<string | null>(null);
  useEffect(() => setPageHref(window.location.href), []);
  const signIn = usesOAuthSignIn(values.mode);
  const mismatch = signIn && pageHref && redirectUri ? publicUrlMismatch(redirectUri, pageHref) : null;
  const shown = answer?.mode === values.mode ? answer : null;
  const outcome = shown ? testOutcome(shown.result, shown.mode, server) : null;

  async function run() {
    setError(null);
    const mode = values.mode;
    try {
      const result = await test.mutateAsync(oauthTestRequest(values, window.location.origin));
      setAnswer({ mode, result });
    } catch (err) {
      setAnswer(null);
      // Our API's own fixed messages (invalid URL, rate limit); the provider is never quoted.
      setError(errorMessage(err));
    }
  }

  return (
    <div className="grid min-w-0 gap-3 rounded-lg border bg-muted/20 p-3" data-testid="mcp-auth-test-panel">
      <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2">
        <p className="min-w-0 flex-1 basis-48 text-[13px] text-muted-foreground leading-snug">
          {signIn
            ? `Check ${server}'s sign-in before saving. Nothing is stored.`
            : `Check that ${server} issues a token with these credentials. Nothing is stored.`}
        </p>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => void run()}
          disabled={test.isPending}
          className="max-md:h-11"
          data-testid="mcp-auth-test"
        >
          {test.isPending ? <Spinner /> : <Stethoscope aria-hidden />}
          {test.isPending ? "Testing…" : "Test sign-in"}
        </Button>
      </div>
      {mismatch ? (
        <p
          role="note"
          className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning/8 px-3 py-2 text-[13px] leading-snug"
          data-testid="mcp-public-url-warning"
        >
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0 text-warning" aria-hidden />
          <span className="min-w-0 [overflow-wrap:anywhere]">
            This workspace tells providers to return to {mismatch.redirectHost}, but you opened it at{" "}
            {mismatch.pageHost}. Set OCW_PUBLIC_API_URL to this workspace's public HTTPS address (pnpm ocw
            enable proxy), then reload.
          </span>
        </p>
      ) : null}
      {shown ? <AuthTestResult result={shown.result} mode={shown.mode} server={server} /> : null}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
      <p className="sr-only" aria-live="polite">
        {test.isPending ? "Testing…" : outcome ? [outcome.title, outcome.fix].filter(Boolean).join(". ") : ""}
      </p>
    </div>
  );
}
