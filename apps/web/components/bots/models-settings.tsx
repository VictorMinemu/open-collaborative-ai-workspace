"use client";

import {
  catalogEntry,
  MODEL_PROVIDER_CATALOG,
  type ModelProvider,
  type ProviderCatalogEntry,
  UpsertModelProviderRequest,
} from "@ocw/contracts";
import { ExternalLink, FlaskConical, KeyRound, ShieldCheck, Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import {
  useBotsRealtime,
  useDeleteProvider,
  useIsAdmin,
  useModelProviders,
  useUpsertProvider,
} from "@/lib/bots-queries";
import { cn, relativeTime } from "@/lib/utils";
import { AllowedModels, ProviderMark } from "./provider-bits";
import { SubscriptionCard } from "./subscription-card";

export function ModelsSettings() {
  useBotsRealtime();
  const isAdmin = useIsAdmin();
  const providers = useModelProviders(isAdmin);
  const [connecting, setConnecting] = useState<ProviderCatalogEntry | null>(null);

  if (!isAdmin) {
    return (
      <Shell>
        <div className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
          Only workspace admins can manage model providers.
        </div>
      </Shell>
    );
  }

  const byKind = new Map((providers.data?.providers ?? []).map((p) => [p.provider, p]));
  const connected = [...byKind.values()].filter((p) => (p.hasKey || p.account) && p.enabled).length;

  return (
    <Shell>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-semibold text-[15px] tracking-tight">Model providers</h2>
          <p className="mt-0.5 max-w-xl text-muted-foreground text-sm">
            Bots run on the models you allow here: an API key, or your own ChatGPT subscription.
          </p>
        </div>
        {providers.data ? (
          <Badge variant={connected ? "success" : "outline"} className="h-6 px-2 text-xs">
            {connected} connected
          </Badge>
        ) : null}
      </div>

      {providers.data?.mockEnabled ? (
        <div className="flex items-center gap-3 rounded-xl border border-dashed bg-muted/30 px-4 py-3 text-sm">
          <FlaskConical className="size-4 shrink-0 text-primary" />
          <p>
            <span className="font-medium">Mock model enabled.</span>{" "}
            <span className="text-muted-foreground">
              <code className="font-mono text-xs">fake/mock-1</code> is available to bots for testing; it
              never calls a paid model.
            </span>
          </p>
        </div>
      ) : null}

      {providers.isPending ? (
        <div className="grid gap-3">
          {[0, 1, 2, 3].map((i) => (
            <Skeleton key={i} className="h-24 rounded-2xl" />
          ))}
        </div>
      ) : providers.isError ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable onRetry={() => providers.refetch()} retrying={providers.isFetching} />
        </div>
      ) : (
        <div className="grid gap-3" data-testid="provider-cards">
          {/* Subscriptions first: no key to manage, the quickest way to give bots a model. */}
          {[...MODEL_PROVIDER_CATALOG]
            .sort((a, b) => Number(b.authMode === "subscription") - Number(a.authMode === "subscription"))
            .map((entry) =>
              entry.authMode === "subscription" ? (
                <SubscriptionCard
                  key={entry.provider}
                  entry={entry}
                  provider={byKind.get(entry.provider) ?? null}
                />
              ) : (
                <ProviderCard
                  key={entry.provider}
                  entry={entry}
                  provider={byKind.get(entry.provider) ?? null}
                  onConnect={() => setConnecting(entry)}
                />
              ),
            )}
        </div>
      )}

      <p className="flex items-center gap-1.5 text-muted-foreground text-xs">
        <ShieldCheck className="size-3.5" />
        Keys are stored AES-256-GCM encrypted and only delivered to your own OpenClaw runtime. Subscription
        sign-ins stay inside that runtime.
      </p>

      <ConnectDialog
        entry={connecting}
        existing={connecting ? (byKind.get(connecting.provider) ?? null) : null}
        onOpenChange={(o) => !o && setConnecting(null)}
      />
    </Shell>
  );
}

function Shell({ children }: { children: React.ReactNode }) {
  return <div className="mx-auto grid w-full max-w-3xl gap-5 px-4 py-6 sm:px-6 sm:py-8">{children}</div>;
}

function ProviderCard({
  entry,
  provider,
  onConnect,
}: {
  entry: ProviderCatalogEntry;
  provider: ModelProvider | null;
  onConnect: () => void;
}) {
  const upsert = useUpsertProvider();
  const remove = useDeleteProvider();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const configured = !!provider?.hasKey;

  async function save(patch: { allowedModels?: string[]; enabled?: boolean }, message?: string) {
    if (!provider) return;
    const allowedModels = patch.allowedModels ?? provider.allowedModels;
    if (allowedModels.length === 0) {
      toast.error("Keep at least one model allowed");
      return;
    }
    try {
      await upsert.mutateAsync({
        provider: entry.provider as UpsertModelProviderRequest["provider"],
        allowedModels,
        enabled: patch.enabled ?? provider.enabled,
      });
      if (message) toast.success(message);
    } catch (err) {
      toast.error("Could not update the provider", { description: errorMessage(err) });
    }
  }

  async function onRemove() {
    if (!confirmRemove) {
      setConfirmRemove(true);
      setTimeout(() => setConfirmRemove(false), 4000);
      return;
    }
    try {
      await remove.mutateAsync(entry.provider);
      toast.success(`${entry.label} disconnected`);
    } catch (err) {
      toast.error("Could not remove the provider", { description: errorMessage(err) });
    }
  }

  return (
    <section
      data-testid={`provider-${entry.provider}`}
      className={cn(
        "overflow-hidden rounded-2xl border bg-card shadow-xs transition-colors",
        configured && provider?.enabled && "border-success/30",
      )}
    >
      <div className="flex flex-wrap items-center gap-3 p-4">
        <ProviderMark provider={entry.provider} />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <h3 className="font-semibold text-[15px] tracking-tight">{entry.label}</h3>
            {configured ? (
              provider?.enabled ? (
                <Badge variant="success">Connected</Badge>
              ) : (
                <Badge variant="outline">Disabled</Badge>
              )
            ) : (
              <Badge variant="outline">Not configured</Badge>
            )}
          </div>
          <p className="mt-0.5 text-muted-foreground text-sm">{entry.description}</p>
        </div>
        {configured ? (
          <div className="flex items-center gap-2">
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
          </div>
        ) : (
          <Button
            onClick={onConnect}
            size="sm"
            variant="outline"
            data-testid={`connect-${entry.provider}`}
            className="w-full sm:w-auto"
          >
            <KeyRound /> Add API key
          </Button>
        )}
      </div>

      {configured && provider ? (
        <div className="grid gap-4 border-t bg-muted/20 px-4 py-4">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
            <span className="flex items-center gap-2">
              <KeyRound className="size-3.5 text-muted-foreground" />
              <span className="font-mono text-[13px] tracking-wider">••••••••{provider.keyHint ?? ""}</span>
            </span>
            {provider.baseUrl ? (
              <span className="truncate font-mono text-muted-foreground text-xs">{provider.baseUrl}</span>
            ) : null}
            <span className="text-muted-foreground text-xs">Updated {relativeTime(provider.updatedAt)}</span>
            <span className="ml-auto flex gap-1">
              <Button variant="ghost" size="sm" onClick={onConnect}>
                Replace key
              </Button>
              <Button
                variant="ghost"
                size="sm"
                onClick={onRemove}
                disabled={remove.isPending}
                className={cn(
                  confirmRemove ? "text-destructive" : "",
                  "hover:bg-destructive/10 hover:text-destructive",
                )}
              >
                {remove.isPending ? <Spinner /> : <Trash2 />}
                {confirmRemove ? "Confirm" : "Remove"}
              </Button>
            </span>
          </div>

          <AllowedModels
            entry={entry}
            provider={provider}
            onChange={(allowedModels, message) => void save({ allowedModels }, message)}
            customPlaceholder="Add a model id, e.g. claude-sonnet-5-5-20260901"
          />
        </div>
      ) : null}
    </section>
  );
}

function ConnectDialog({
  entry,
  existing,
  onOpenChange,
}: {
  entry: ProviderCatalogEntry | null;
  existing: ModelProvider | null;
  onOpenChange: (open: boolean) => void;
}) {
  const upsert = useUpsertProvider();
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [models, setModels] = useState("");
  const [errors, setErrors] = useState<{ apiKey?: string; baseUrl?: string; models?: string }>({});
  const open = entry !== null;
  const needsModels = !!entry && entry.models.length === 0 && !existing;

  function close() {
    onOpenChange(false);
    setTimeout(() => {
      setApiKey("");
      setBaseUrl("");
      setModels("");
      setErrors({});
    }, 200);
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!entry) return;
    const allowedModels =
      existing?.allowedModels ??
      (needsModels
        ? models
            .split(/[\s,]+/)
            .map((m) => m.trim())
            .filter(Boolean)
        : entry.models.filter((m) => m.preselected).map((m) => m.id));
    const parsed = UpsertModelProviderRequest.safeParse({
      provider: entry.provider,
      apiKey: apiKey.trim(),
      ...(entry.baseUrlRequired || baseUrl.trim() ? { baseUrl: baseUrl.trim() || null } : {}),
      allowedModels,
      enabled: existing?.enabled ?? true,
    });
    if (!parsed.success) {
      const next: typeof errors = {};
      for (const issue of parsed.error.issues) {
        const k = String(issue.path[0]);
        if (k === "apiKey") next.apiKey = "Paste the full API key (at least 8 characters)";
        if (k === "baseUrl") next.baseUrl = "Enter a valid URL, e.g. http://localhost:8000/v1";
        if (k === "allowedModels") next.models = "Add at least one model id";
      }
      setErrors(next);
      return;
    }
    if (entry.baseUrlRequired && !parsed.data.baseUrl && !existing?.baseUrl) {
      setErrors({ baseUrl: "A base URL is required" });
      return;
    }
    try {
      await upsert.mutateAsync(parsed.data);
      toast.success(existing ? `${entry.label} key replaced` : `${entry.label} connected`, {
        description: existing ? undefined : "Its models are now available to bots.",
      });
      close();
    } catch (err) {
      toast.error("Could not save the key", { description: errorMessage(err) });
    }
  }

  const label = entry?.label ?? "";
  return (
    <Dialog open={open} onOpenChange={(o) => !o && close()}>
      <DialogContent data-testid="connect-provider-dialog">
        <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
          <DialogHeader>
            <div className="mb-2">{entry ? <ProviderMark provider={entry.provider} /> : null}</div>
            <DialogTitle>{existing ? `Replace ${label} key` : `Connect ${label}`}</DialogTitle>
            <DialogDescription>
              The key is encrypted before it is stored and is never displayed again.
            </DialogDescription>
          </DialogHeader>
          <DialogBody className="grid gap-4">
            {entry?.baseUrlRequired || (entry && catalogEntry(entry.provider)?.baseUrlRequired) ? (
              <FormField
                id="provider-base-url"
                label="Base URL"
                error={errors.baseUrl}
                hint="OpenAI-compatible endpoint"
              >
                <Input
                  id="provider-base-url"
                  value={baseUrl}
                  placeholder={existing?.baseUrl ?? "http://localhost:8000/v1"}
                  onChange={(e) => setBaseUrl(e.target.value)}
                  aria-invalid={!!errors.baseUrl}
                  aria-describedby={describedBy("provider-base-url", errors.baseUrl, "x")}
                  className="font-mono text-[13px]"
                />
              </FormField>
            ) : null}
            <FormField
              id="provider-api-key"
              label="API key"
              error={errors.apiKey}
              action={
                entry?.keyUrl ? (
                  <a
                    href={entry.keyUrl}
                    target="_blank"
                    rel="noreferrer"
                    className="flex items-center gap-1 text-primary text-xs hover:underline"
                  >
                    Get a key <ExternalLink className="size-3" />
                  </a>
                ) : null
              }
            >
              <Input
                id="provider-api-key"
                data-testid="provider-api-key"
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={apiKey}
                placeholder={entry?.keyPlaceholder}
                onChange={(e) => {
                  setApiKey(e.target.value);
                  setErrors((x) => ({ ...x, apiKey: undefined }));
                }}
                aria-invalid={!!errors.apiKey}
                aria-describedby={describedBy("provider-api-key", errors.apiKey)}
                className="font-mono text-[13px]"
              />
            </FormField>
            {needsModels ? (
              <FormField id="provider-models" label="Model ids" error={errors.models} hint="Comma-separated">
                <Input
                  id="provider-models"
                  value={models}
                  placeholder="llama-4-70b, qwen-3"
                  onChange={(e) => setModels(e.target.value)}
                  aria-invalid={!!errors.models}
                  aria-describedby={describedBy("provider-models", errors.models, "x")}
                  className="font-mono text-[13px]"
                />
              </FormField>
            ) : entry && !existing ? (
              <p className="text-muted-foreground text-xs">
                Allows{" "}
                {entry.models
                  .filter((m) => m.preselected)
                  .map((m) => m.label)
                  .join(", ")}
                . You can change this after connecting.
              </p>
            ) : null}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={close}>
              Cancel
            </Button>
            <Button type="submit" disabled={upsert.isPending} data-testid="save-provider">
              {upsert.isPending ? <Spinner /> : <KeyRound />}
              {existing ? "Replace key" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
