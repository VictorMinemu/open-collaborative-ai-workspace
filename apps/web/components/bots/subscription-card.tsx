"use client";

import type {
  ModelProvider,
  ProviderAuthStatus,
  ProviderCatalogEntry,
  SubscriptionProviderKind,
} from "@ocw/contracts";
import {
  AlertTriangle,
  ArrowUpRight,
  Check,
  Copy,
  LogIn,
  RefreshCw,
  ShieldCheck,
  Unplug,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useCopy } from "@/hooks/use-copy";
import { errorMessage, isApiError } from "@/lib/api";
import {
  useCancelProviderAuth,
  useDeleteProvider,
  useProviderAuth,
  useStartProviderAuth,
  useUpsertProvider,
} from "@/lib/bots-queries";
import { cn, relativeTime } from "@/lib/utils";
import { AllowedModels, ProviderMark } from "./provider-bits";

const PLAN_LABELS: Record<string, string> = {
  free: "ChatGPT Free",
  plus: "ChatGPT Plus",
  pro: "ChatGPT Pro",
  team: "ChatGPT Business",
  business: "ChatGPT Business",
  enterprise: "ChatGPT Enterprise",
  edu: "ChatGPT Edu",
};

export function planLabel(planType: string | null): string | null {
  if (!planType) return null;
  return PLAN_LABELS[planType] ?? `ChatGPT ${planType.charAt(0).toUpperCase()}${planType.slice(1)}`;
}

/** Ticks every second while `active` (countdowns). */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active]);
  return now;
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * Settings › Models card for a subscription provider (ChatGPT via Codex). "Connect" asks the org's
 * OpenClaw cell to start a device-code sign-in; the card then shows the verification URL and the one-time
 * code, live, until the admin approves it in their browser. Tokens never reach this app (ADR-0006).
 */
export function SubscriptionCard({
  entry,
  provider,
}: {
  entry: ProviderCatalogEntry;
  provider: ModelProvider | null;
}) {
  const kind = entry.provider as SubscriptionProviderKind;
  const auth = useProviderAuth(kind);
  const start = useStartProviderAuth(kind);
  const cancel = useCancelProviderAuth(kind);
  const upsert = useUpsertProvider();
  const remove = useDeleteProvider();
  const [confirmRemove, setConfirmRemove] = useState(false);

  const status = auth.data;
  const account = provider?.account ?? status?.account ?? null;
  const connected = !!provider && !!account;
  const flowState = status?.state ?? "idle";
  const signingIn = flowState === "starting" || flowState === "pending";
  const cellOffline = status ? !status.cellConnected : false;

  async function connect(restart = false) {
    try {
      await start.mutateAsync(restart ? { restart: true } : {});
    } catch (err) {
      if (isApiError(err, 409)) toast.error("Bot runtime offline", { description: errorMessage(err) });
      else toast.error("Could not start the sign-in", { description: errorMessage(err) });
    }
  }

  async function onCancel() {
    try {
      await cancel.mutateAsync();
    } catch (err) {
      toast.error("Could not cancel", { description: errorMessage(err) });
    }
  }

  async function save(patch: { allowedModels?: string[]; enabled?: boolean }, message?: string) {
    if (!provider) return;
    const allowedModels = patch.allowedModels ?? provider.allowedModels;
    if (allowedModels.length === 0) {
      toast.error("Keep at least one model allowed");
      return;
    }
    try {
      await upsert.mutateAsync({
        provider: kind,
        allowedModels,
        enabled: patch.enabled ?? provider.enabled,
      });
      if (message) toast.success(message);
    } catch (err) {
      toast.error("Could not update the provider", { description: errorMessage(err) });
    }
  }

  async function onDisconnect() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      setTimeout(() => setConfirmRemove(false), 4000);
      return;
    }
    try {
      await remove.mutateAsync(kind);
      toast.success("ChatGPT subscription disconnected", {
        description: "Your bot runtime deleted its sign-in. Bots on these models stop answering.",
      });
    } catch (err) {
      toast.error("Could not disconnect", { description: errorMessage(err) });
    }
  }

  let badge: React.ReactNode;
  if (signingIn) badge = <Badge variant="brand">Signing in…</Badge>;
  else if (connected && account?.needsReconnect) badge = <Badge variant="warning">Reconnect needed</Badge>;
  else if (connected)
    badge = provider?.enabled ? (
      <Badge variant="success">Connected</Badge>
    ) : (
      <Badge variant="outline">Disabled</Badge>
    );
  else badge = <Badge variant="outline">Not connected</Badge>;

  return (
    <section
      data-testid={`provider-${entry.provider}`}
      data-auth-state={flowState}
      className={cn(
        "overflow-hidden rounded-2xl border bg-card shadow-xs transition-colors",
        connected && provider?.enabled && !account?.needsReconnect && "border-success/30",
        signingIn && "border-primary/40",
      )}
    >
      <div className="flex flex-wrap items-center gap-3 p-4">
        <ProviderMark provider={entry.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-[15px] tracking-tight">{entry.label}</h3>
            {badge}
          </div>
          <p className="mt-0.5 text-muted-foreground text-sm">{entry.description}</p>
          <p data-testid="subscription-scope" className="mt-0.5 text-muted-foreground text-xs">
            Used by bots only. AI chats use each member's own ChatGPT plan (Settings › AI chat).
          </p>
        </div>
        {connected ? (
          <div className="flex items-center gap-2 text-muted-foreground text-xs">
            Enabled
            <Switch
              checked={provider?.enabled ?? false}
              onCheckedChange={(v) =>
                save({ enabled: v }, v ? `${entry.label} enabled` : `${entry.label} disabled`)
              }
              aria-label={`Enable ${entry.label}`}
            />
          </div>
        ) : !signingIn && flowState !== "error" ? (
          <Button
            onClick={() => connect()}
            size="sm"
            disabled={start.isPending || auth.isPending || cellOffline}
            data-testid={`connect-${entry.provider}`}
            className="w-full sm:w-auto"
          >
            {start.isPending ? <Spinner /> : <LogIn />}
            Connect
          </Button>
        ) : null}
      </div>

      {auth.isPending ? (
        <div className="border-t px-4 py-3">
          <Skeleton className="h-5 w-64" />
        </div>
      ) : (
        <>
          {signingIn && status ? (
            <SignInPanel status={status} onCancel={onCancel} cancelling={cancel.isPending} />
          ) : null}

          {flowState === "error" && status?.error ? (
            <div
              data-testid="codex-auth-error"
              data-code={status.error.code}
              className="flex flex-wrap items-center gap-3 border-t bg-destructive/5 px-4 py-3 text-sm"
            >
              <AlertTriangle className="size-4 shrink-0 text-destructive" />
              <p className="min-w-0 flex-1">
                <span className="font-medium">
                  {status.error.code === "cancelled" ? "Sign-in cancelled." : "Sign-in did not finish."}
                </span>{" "}
                <span className="text-muted-foreground">
                  {status.error.code === "cancelled" ? "" : status.error.message}
                </span>
              </p>
              {connected ? null : (
                <Button
                  size="sm"
                  onClick={() => connect(true)}
                  disabled={start.isPending || cellOffline}
                  data-testid="retry-codex-auth"
                >
                  <RefreshCw /> Try again
                </Button>
              )}
            </div>
          ) : null}

          {!connected && !signingIn && cellOffline ? (
            <div className="flex flex-wrap items-center gap-2 border-t bg-warning/5 px-4 py-3 text-sm">
              <AlertTriangle className="size-4 shrink-0 text-warning" />
              <p className="min-w-0 flex-1">
                <span className="font-medium">Your bot runtime is offline.</span>{" "}
                <span className="text-muted-foreground">
                  The sign-in runs there, so it must be connected first.
                </span>
              </p>
              <Link
                href="/settings/bots-runtime"
                className="font-medium text-primary text-xs hover:underline"
              >
                Bots runtime
              </Link>
            </div>
          ) : null}

          {!connected && !signingIn && !cellOffline && flowState !== "error" ? (
            <p className="flex items-start gap-2 border-t bg-muted/20 px-4 py-3 text-muted-foreground text-xs">
              <ShieldCheck className="mt-px size-3.5 shrink-0" />
              Sign-in runs in your own bot runtime with a one-time code. Its tokens stay there and are renewed
              there; this workspace only learns which account is connected.
            </p>
          ) : null}

          {connected && provider && account ? (
            <div className="grid gap-4 border-t bg-muted/20 px-4 py-4">
              {account.needsReconnect ? (
                <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warning/30 bg-warning/5 px-3 py-2 text-sm">
                  <AlertTriangle className="size-4 shrink-0 text-warning" />
                  <p className="min-w-0 flex-1">
                    Your bot runtime lost this sign-in. Bots on ChatGPT models are paused until you reconnect.
                  </p>
                  <Button
                    size="sm"
                    onClick={() => connect(true)}
                    disabled={start.isPending || signingIn || cellOffline}
                  >
                    <LogIn /> Reconnect
                  </Button>
                </div>
              ) : null}
              <div
                className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm"
                data-testid="codex-account"
              >
                <span className="flex min-w-0 items-center gap-2">
                  <Check className="size-3.5 shrink-0 text-success" />
                  <span className="truncate">
                    Connected as{" "}
                    <span className="font-medium">{account.email ?? "your ChatGPT account"}</span>
                  </span>
                </span>
                {planLabel(account.planType) ? (
                  <Badge variant="secondary" className="h-5">
                    {planLabel(account.planType)}
                  </Badge>
                ) : null}
                <span className="text-muted-foreground text-xs">
                  Since {relativeTime(account.connectedAt)}
                </span>
                <span className="ml-auto flex gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => connect(true)}
                    disabled={start.isPending || signingIn || cellOffline}
                  >
                    Switch account
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={onDisconnect}
                    disabled={remove.isPending}
                    data-testid={`disconnect-${entry.provider}`}
                    className={cn(
                      confirmRemove ? "text-destructive" : "",
                      "hover:bg-destructive/10 hover:text-destructive",
                    )}
                  >
                    {remove.isPending ? <Spinner /> : <Unplug />}
                    {confirmRemove ? "Confirm" : "Disconnect"}
                  </Button>
                </span>
              </div>
              <AllowedModels
                entry={entry}
                provider={provider}
                onChange={(allowedModels, message) => void save({ allowedModels }, message)}
                customPlaceholder="Add a model id your plan includes, e.g. gpt-5.4"
              />
            </div>
          ) : null}
        </>
      )}
    </section>
  );
}

function SignInPanel({
  status,
  onCancel,
  cancelling,
}: {
  status: ProviderAuthStatus;
  onCancel: () => void;
  cancelling: boolean;
}) {
  const pending = status.state === "pending" && !!status.userCode && !!status.verificationUrl;
  const now = useNow(pending);
  const { copy, copied } = useCopy();
  const left = status.expiresAt ? new Date(status.expiresAt).getTime() - now : null;

  async function copyText(text: string, what: string) {
    try {
      await copy(text);
    } catch {
      toast.error(`Could not copy the ${what}`);
    }
  }

  if (!pending) {
    return (
      <div
        className="flex items-center gap-3 border-t bg-brand-soft/30 px-4 py-4 text-sm"
        data-testid="codex-auth-starting"
      >
        <Spinner className="text-primary" />
        <p className="min-w-0 flex-1 text-muted-foreground">Asking your bot runtime for a sign-in code…</p>
        <Button size="sm" variant="ghost" onClick={onCancel} disabled={cancelling}>
          Cancel
        </Button>
      </div>
    );
  }

  const url = status.verificationUrl ?? "";
  const code = status.userCode ?? "";
  const shortUrl = url.replace(/^https?:\/\//, "");
  return (
    <div className="grid gap-4 border-t bg-brand-soft/20 px-4 py-4" data-testid="codex-auth-pending">
      <ol className="grid gap-4 sm:grid-cols-2">
        <li className="grid content-start gap-2">
          <span className="flex items-center gap-2 font-medium text-sm">
            <StepNumber n={1} /> Open the sign-in page
          </span>
          <div className="flex items-center gap-1.5">
            <a
              href={url}
              target="_blank"
              rel="noreferrer noopener"
              className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-3 font-mono text-[12.5px] hover:border-primary/40"
              data-testid="codex-verification-url"
            >
              <span className="truncate">{shortUrl}</span>
              <ArrowUpRight className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
            </a>
            <Button
              variant="outline"
              size="icon"
              className="size-9"
              aria-label="Copy the sign-in link"
              onClick={() => copyText(url, "link")}
            >
              {copied === url ? <Check className="text-success" /> : <Copy />}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs">
            Sign in with the ChatGPT account whose plan bots should use.
          </p>
        </li>
        <li className="grid content-start gap-2">
          <span className="flex items-center gap-2 font-medium text-sm">
            <StepNumber n={2} /> Enter this code
          </span>
          <div className="flex items-center gap-1.5">
            <code
              className="flex h-9 min-w-0 flex-1 items-center justify-center rounded-lg border border-primary/30 bg-background px-3 font-mono font-semibold text-[17px] tracking-[0.18em]"
              data-testid="codex-user-code"
            >
              {code}
            </code>
            <Button
              variant="outline"
              size="sm"
              className="h-9"
              onClick={() => copyText(code, "code")}
              data-testid="copy-codex-code"
            >
              {copied === code ? <Check className="text-success" /> : <Copy />}
              {copied === code ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs" data-testid="codex-countdown">
            {left !== null && left > 0 ? `Expires in ${formatCountdown(left)}` : "Expired"} · works once,
            never share it
          </p>
        </li>
      </ol>
      <div className="flex items-center gap-3 rounded-lg border bg-background/70 px-3 py-2 text-sm">
        <span className="relative flex size-2.5 shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60" />
          <span className="relative size-2.5 rounded-full bg-primary" />
        </span>
        <p className="min-w-0 flex-1 text-muted-foreground" aria-live="polite">
          Waiting for you to approve it… this page updates by itself.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={cancelling}
          data-testid="cancel-codex-auth"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
      {n}
    </span>
  );
}
