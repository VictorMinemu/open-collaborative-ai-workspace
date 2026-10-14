"use client";

import {
  type Agent,
  type CreateVaultItemRequest,
  isAllowedInjectionHeader,
  type UpdateVaultItemRequest,
  VAULT_LIMITS,
  VaultHostPattern,
  type VaultItem,
  type VaultItemList,
  type VaultKind,
  VaultPathPrefix,
  vaultHostAllowed,
} from "@ocw/contracts";
import { ChevronRight, KeyRound, Lock, Plus, Save, X } from "lucide-react";
import Link from "next/link";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";
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
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useAgents } from "@/lib/bots-queries";
import { connectionDate } from "@/lib/connections-format";
import { useCreateVaultItem, useSetVaultItemAgents, useUpdateVaultItem } from "@/lib/keychain-queries";
import { useUnits } from "@/lib/org-queries";
import { useCan } from "@/lib/permissions";
import { useMe } from "@/lib/queries";
import { cn } from "@/lib/utils";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

export const VAULT_KINDS: Array<{ value: VaultKind; label: string; hint: string }> = [
  { value: "api_key", label: "API key", hint: "Sent as a header" },
  { value: "basic", label: "Username & password", hint: "Sent as HTTP Basic" },
  { value: "oauth", label: "OAuth client", hint: "OCW gets a short-lived token" },
];

export const kindLabel = (k: VaultKind) => VAULT_KINDS.find((x) => x.value === k)?.label ?? k;

const PRIVATE_V4 = [/^10\./, /^127\./, /^169\.254\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^0\./];

/** The host part of a pattern (`erp.lan:8443` → `erp.lan`, `*.x.com` → `x.com`). */
function hostPart(pattern: string): string {
  return pattern.replace(/^\*\./, "").replace(/:\d+$/, "");
}

/** An IP literal in a private, loopback or link-local range, or `localhost`: never allowed for personal keys. */
export function isPrivateLiteral(pattern: string): boolean {
  const h = hostPart(pattern);
  return h === "localhost" || PRIVATE_V4.some((r) => r.test(h));
}

/** Looks like a host on a private network (UI-SPEC § 3): a private literal, `.lan` / `.local` / `.internal`, or one label. */
export function looksPrivate(pattern: string): boolean {
  const h = hostPart(pattern);
  return isPrivateLiteral(pattern) || /\.(lan|local|internal)$/.test(h) || !h.includes(".");
}

export type VaultDialogMode =
  | { kind: "create"; scope: "personal" | "unit"; unitId: string | null }
  | { kind: "edit"; item: VaultItem; replace: boolean };

/**
 * Add or edit a keychain item (07.4-13, UI-SPEC § 3 "Vault item dialog", D-04, R3). Secret fields are write-only: a
 * create takes them, an edit shows only the locked `Value set · updated {date}` line until Replace value, and the form
 * unmounts on close so nothing typed stays in the DOM (T-07.4-13-01). Full screen at 390 with a sticky footer.
 */
export function VaultItemDialog({
  mode,
  units,
  onOpenChange,
}: {
  mode: VaultDialogMode | null;
  units: VaultItemList["manageableUnits"];
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={mode !== null} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="vault-item-dialog"
        className="sm:max-w-lg max-sm:inset-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none max-sm:border-0"
      >
        {mode ? (
          <VaultForm
            key={mode.kind === "edit" ? `${mode.item.id}:${mode.replace}` : `new:${mode.scope}`}
            mode={mode}
            units={units}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

type Errors = Partial<
  Record<
    | "name"
    | "hosts"
    | "value"
    | "username"
    | "password"
    | "clientId"
    | "clientSecret"
    | "tokenUrl"
    | "header"
    | "path"
    | "form",
    string
  >
>;

function VaultForm({
  mode,
  units,
  onDone,
}: {
  mode: VaultDialogMode;
  units: VaultItemList["manageableUnits"];
  onDone: () => void;
}) {
  const editing = mode.kind === "edit" ? mode.item : null;
  const scope = editing ? editing.scope : mode.kind === "create" ? mode.scope : "personal";
  const create = useCreateVaultItem();
  const update = useUpdateVaultItem();
  const setAgents = useSetVaultItemAgents();
  const canOpenMcp = useCan("bot.manage");
  const [name, setName] = useState(editing?.name ?? "");
  const [unitId, setUnitId] = useState<string | null>(
    editing?.unitId ?? (mode.kind === "create" ? mode.unitId : null),
  );
  const [kind, setKind] = useState<VaultKind>(editing?.kind ?? "api_key");
  const [replacing, setReplacing] = useState(editing === null || (mode.kind === "edit" && mode.replace));
  const [secret, setSecret] = useState({
    value: "",
    username: "",
    password: "",
    clientId: "",
    clientSecret: "",
    oauthScope: "",
  });
  const [tokenUrl, setTokenUrl] = useState(editing?.tokenUrl ?? "");
  const [hosts, setHosts] = useState<string[]>(editing?.allowedHosts ?? []);
  const [hostDraft, setHostDraft] = useState("");
  const [hostError, setHostError] = useState<string | undefined>();
  const [agentIds, setAgentIds] = useState<string[]>(editing?.agentIds ?? []);
  const [advanced, setAdvanced] = useState(false);
  const [header, setHeader] = useState(editing?.injection.header ?? "Authorization");
  const [scheme, setScheme] = useState<"bearer" | "raw">(
    editing?.injection.scheme === "raw" ? "raw" : "bearer",
  );
  const [path, setPath] = useState(editing?.allowedPathPrefix ?? "");
  const [errors, setErrors] = useState<Errors>({});
  const pending = create.isPending || update.isPending || setAgents.isPending;
  const clear = (...keys: Array<keyof Errors>) =>
    setErrors((e) => {
      const next = { ...e };
      for (const k of keys) delete next[k];
      return next;
    });

  function addHost(): string[] | null {
    const raw = hostDraft.trim();
    if (!raw) return hosts;
    const parsed = VaultHostPattern.safeParse(raw);
    if (!parsed.success) {
      setHostError("Use a host like api.example.com or *.example.com, with an optional :port");
      return null;
    }
    if (scope === "personal" && isPrivateLiteral(parsed.data)) {
      setHostError("Private network addresses aren't allowed for personal keys");
      return null;
    }
    if (hosts.includes(parsed.data)) {
      setHostDraft("");
      return hosts;
    }
    if (hosts.length >= VAULT_LIMITS.hosts) {
      setHostError(`Up to ${VAULT_LIMITS.hosts} hosts`);
      return null;
    }
    const next = [...hosts, parsed.data];
    setHosts(next);
    setHostDraft("");
    setHostError(undefined);
    clear("hosts", "tokenUrl");
    return next;
  }

  const injection = (): CreateVaultItemRequest["injection"] =>
    kind === "basic" ? { header: "Authorization", scheme: "basic" } : { header: header.trim(), scheme };

  function validate(allHosts: string[]): Errors {
    const e: Errors = {};
    if (!name.trim()) e.name = "Give the key a name";
    if (allHosts.length === 0) e.hosts = "Add at least one host";
    if (replacing) {
      if (kind === "api_key" && !secret.value) e.value = "Enter the key";
      if (kind === "basic" && !secret.username) e.username = "Enter the username";
      if (kind === "basic" && !secret.password) e.password = "Enter the password";
      if (kind === "oauth" && !secret.clientId.trim()) e.clientId = "Enter the client ID";
      if (kind === "oauth" && !secret.clientSecret) e.clientSecret = "Enter the client secret";
    }
    if (kind === "oauth") {
      if (!tokenUrl.trim().startsWith("https://")) e.tokenUrl = "The token URL must use HTTPS";
      else if (!vaultHostAllowed(allHosts, tokenUrl.trim()))
        e.tokenUrl = "The token URL's host must be one of the allowed hosts";
    }
    if (kind !== "basic" && !isAllowedInjectionHeader(header.trim()))
      e.header = "That header can't carry a key";
    if (path.trim() && !VaultPathPrefix.safeParse(path).success) e.path = "Paths start with /";
    return e;
  }

  function secretBody() {
    if (kind === "api_key") return { kind, value: secret.value } as const;
    if (kind === "basic") return { kind, username: secret.username, password: secret.password } as const;
    return {
      kind,
      clientId: secret.clientId.trim(),
      clientSecret: secret.clientSecret,
      ...(secret.oauthScope.trim() ? { scope: secret.oauthScope.trim() } : {}),
    } as const;
  }

  async function submit(ev: FormEvent) {
    ev.preventDefault();
    const allHosts = addHost();
    if (allHosts === null) return;
    const e = validate(allHosts);
    setErrors(e);
    if (Object.keys(e).length > 0) return;
    const prefix = path.trim() || undefined;
    try {
      if (!editing) {
        const common = {
          name: name.trim(),
          allowedHosts: allHosts,
          ...(prefix ? { allowedPathPrefix: prefix } : {}),
          injection: injection(),
          ...(scope === "unit" ? { scope: "unit" as const, unitId } : { scope: "personal" as const }),
        };
        const s = secretBody();
        const body: CreateVaultItemRequest =
          s.kind === "oauth"
            ? {
                ...common,
                kind: "oauth",
                tokenUrl: tokenUrl.trim(),
                clientId: s.clientId,
                clientSecret: s.clientSecret,
                ...(s.scope ? { oauthScope: s.scope } : {}),
              }
            : { ...common, ...s };
        const item = await create.mutateAsync(body);
        setSecret({ value: "", username: "", password: "", clientId: "", clientSecret: "", oauthScope: "" });
        if (agentIds.length > 0) {
          try {
            await setAgents.mutateAsync({ id: item.id, agentIds });
          } catch {
            toast.warning("Key saved, but its bots weren't updated. Try again in Edit.");
            onDone();
            return;
          }
        }
        toast.success("Key saved");
        onDone();
        return;
      }
      const patch: UpdateVaultItemRequest = {};
      if (name.trim() !== editing.name) patch.name = name.trim();
      if (allHosts.join("\n") !== editing.allowedHosts.join("\n")) patch.allowedHosts = allHosts;
      if ((prefix ?? null) !== editing.allowedPathPrefix) patch.allowedPathPrefix = prefix ?? null;
      const inj = injection();
      if (
        kind !== "basic" &&
        (inj.header !== editing.injection.header || inj.scheme !== editing.injection.scheme)
      ) {
        patch.injection = inj;
      }
      if (kind === "oauth" && tokenUrl.trim() !== (editing.tokenUrl ?? "")) patch.tokenUrl = tokenUrl.trim();
      if (replacing) patch.secret = secretBody();
      if (Object.keys(patch).length > 0) await update.mutateAsync({ id: editing.id, body: patch });
      setSecret({ value: "", username: "", password: "", clientId: "", clientSecret: "", oauthScope: "" });
      const sameAgents =
        agentIds.length === editing.agentIds.length && agentIds.every((a) => editing.agentIds.includes(a));
      if (!sameAgents) await setAgents.mutateAsync({ id: editing.id, agentIds });
      toast.success(`${name.trim()} updated`);
      onDone();
    } catch (err) {
      setErrors({ form: errorMessage(err) });
    }
  }

  const changed =
    !editing ||
    replacing ||
    name.trim() !== editing.name ||
    hosts.join("\n") !== editing.allowedHosts.join("\n") ||
    hostDraft.trim() !== "" ||
    (path.trim() || null) !== editing.allowedPathPrefix ||
    (kind !== "basic" &&
      (header.trim() !== editing.injection.header || scheme !== editing.injection.scheme)) ||
    (kind === "oauth" && tokenUrl.trim() !== (editing.tokenUrl ?? "")) ||
    agentIds.length !== editing.agentIds.length ||
    agentIds.some((a) => !editing.agentIds.includes(a));

  const title = editing ? `Edit ${editing.name}` : scope === "unit" ? "Add a unit key" : "Add a key";
  const privateHosts = scope === "unit" ? hosts.filter(looksPrivate) : [];
  const secretField = (
    id: "value" | "username" | "password" | "clientId" | "clientSecret" | "oauthScope",
    label: string,
    opts: { testId: string; plain?: boolean; optional?: boolean } = { testId: "" },
  ) => {
    const error = id === "oauthScope" ? undefined : errors[id];
    const hint = opts.optional
      ? "Optional. Write-only. Never shown again."
      : "Write-only. Never shown again.";
    const fieldId = `vault-${opts.testId}`;
    return (
      <FormField key={id} id={fieldId} label={label} error={error} hint={hint}>
        <Input
          id={fieldId}
          type={opts.plain ? "text" : "password"}
          value={secret[id]}
          onChange={(e) => {
            setSecret((s) => ({ ...s, [id]: e.target.value }));
            if (id !== "oauthScope") clear(id);
          }}
          autoComplete={opts.plain ? "off" : "new-password"}
          spellCheck={false}
          aria-invalid={!!error}
          aria-describedby={describedBy(fieldId, error, hint)}
          className={cn("font-mono text-[13px]", TOUCH)}
          data-testid={fieldId}
        />
      </FormField>
    );
  };

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-1 flex-col">
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>
          Bots use it by handle. The value is sent only to the hosts below and never shown again.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid flex-1 content-start gap-5">
        <FormField id="vault-name" label="Name" error={errors.name}>
          <Input
            id="vault-name"
            value={name}
            maxLength={VAULT_LIMITS.nameChars}
            placeholder="CRM API"
            onChange={(e) => {
              setName(e.target.value);
              clear("name");
            }}
            aria-invalid={!!errors.name}
            aria-describedby={describedBy("vault-name", errors.name)}
            className={TOUCH}
            data-testid="vault-name"
          />
        </FormField>

        {scope === "unit" && !editing ? (
          <FormField id="vault-unit" label="Unit">
            <Select
              items={units.map((u) => ({ value: u.unitId ?? "org", label: u.name }))}
              value={unitId ?? "org"}
              onValueChange={(v) => v && setUnitId(v === "org" ? null : String(v))}
            >
              <SelectTrigger id="vault-unit" aria-label="Unit" className={TOUCH} data-testid="vault-unit" />
              <SelectContent>
                {units.map((u) => (
                  <SelectItem key={u.unitId ?? "org"} value={u.unitId ?? "org"}>
                    {u.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
        ) : null}

        <fieldset className="grid gap-2">
          <legend className="mb-2 font-medium text-sm">Type</legend>
          <div className="grid gap-2 sm:grid-cols-3">
            {VAULT_KINDS.map((k) => {
              const selected = kind === k.value;
              const locked = editing !== null && !selected;
              return (
                <label
                  key={k.value}
                  className={cn(
                    "flex cursor-pointer items-start gap-2.5 rounded-lg border bg-card p-2.5 transition-colors max-md:min-h-11 sm:flex-col sm:gap-1",
                    selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                    locked && "cursor-not-allowed opacity-60",
                  )}
                  data-testid={`vault-kind-${k.value}`}
                >
                  <input
                    type="radio"
                    name="vault-kind"
                    value={k.value}
                    checked={selected}
                    disabled={locked}
                    onChange={() => {
                      setKind(k.value);
                      clear(
                        "value",
                        "username",
                        "password",
                        "clientId",
                        "clientSecret",
                        "tokenUrl",
                        "header",
                      );
                    }}
                    className="mt-0.5 size-4 shrink-0 accent-primary sm:sr-only"
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-[13px]">{k.label}</span>
                    <span className="block text-[11.5px] text-muted-foreground leading-snug">{k.hint}</span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {replacing ? (
          <div className="grid gap-4">
            {kind === "api_key"
              ? secretField("value", editing ? "New API key" : "API key", { testId: "value" })
              : null}
            {kind === "basic" ? (
              <>
                {secretField("username", editing ? "New username" : "Username", {
                  testId: "username",
                  plain: true,
                })}
                {secretField("password", editing ? "New password" : "Password", { testId: "password" })}
              </>
            ) : null}
            {kind === "oauth" ? (
              <>
                {secretField("clientId", editing ? "New client ID" : "Client ID", {
                  testId: "client-id",
                  plain: true,
                })}
                {secretField("clientSecret", editing ? "New client secret" : "Client secret", {
                  testId: "client-secret",
                })}
                {secretField("oauthScope", "Scope", { testId: "oauth-scope", plain: true, optional: true })}
              </>
            ) : null}
          </div>
        ) : editing ? (
          <div className="grid gap-2">
            <span className="font-medium text-sm">{kindLabel(kind)}</span>
            <div className="flex items-center gap-2">
              <span
                className="flex h-9 min-w-0 flex-1 items-center gap-2 rounded-md border border-dashed px-3 text-muted-foreground text-xs max-md:h-11"
                data-testid="vault-value-state"
              >
                <Lock className="size-3.5 shrink-0" aria-hidden />
                <span className="truncate">Value set · updated {connectionDate(editing.valueUpdatedAt)}</span>
              </span>
              <Button
                type="button"
                variant="outline"
                size="sm"
                className={cn("h-9", TOUCH)}
                onClick={() => setReplacing(true)}
                data-testid="vault-replace"
              >
                Replace value
              </Button>
            </div>
          </div>
        ) : null}

        {kind === "oauth" ? (
          <FormField
            id="vault-token-url"
            label="Token URL"
            error={errors.tokenUrl}
            hint="Its host must be one of the allowed hosts."
          >
            <Input
              id="vault-token-url"
              type="url"
              inputMode="url"
              value={tokenUrl}
              placeholder="https://auth.example.com/oauth/token"
              onChange={(e) => {
                setTokenUrl(e.target.value);
                clear("tokenUrl");
              }}
              aria-invalid={!!errors.tokenUrl}
              aria-describedby={describedBy("vault-token-url", errors.tokenUrl, "x")}
              autoComplete="off"
              spellCheck={false}
              className={cn("font-mono text-[13px]", TOUCH)}
              data-testid="vault-token-url"
            />
          </FormField>
        ) : null}

        <div className="grid gap-2" data-testid="vault-hosts">
          <span className="font-medium text-sm" id="vault-hosts-label">
            Allowed hosts
          </span>
          {hosts.length > 0 ? (
            <ul aria-label="Allowed hosts" className="flex flex-wrap gap-1.5">
              {hosts.map((h) => (
                <li
                  key={h}
                  className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-background pr-0.5 pl-2 font-mono text-xs max-md:h-11"
                  data-testid="vault-host-chip"
                  data-host={h}
                >
                  <span className="truncate" title={h}>
                    {h}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${h}`}
                    onClick={() => setHosts(hosts.filter((x) => x !== h))}
                    className="size-6 max-md:size-11"
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          ) : null}
          <div className="flex gap-2">
            <Input
              value={hostDraft}
              onChange={(e) => {
                setHostDraft(e.target.value);
                setHostError(undefined);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addHost();
                }
              }}
              placeholder="api.example.com or *.example.com"
              aria-labelledby="vault-hosts-label"
              aria-invalid={!!(hostError ?? errors.hosts)}
              aria-describedby="vault-hosts-message"
              autoComplete="off"
              spellCheck={false}
              className={cn("flex-1 font-mono text-[13px]", TOUCH)}
              data-testid="vault-host-input"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className={cn("h-9", TOUCH)}
              onClick={() => addHost()}
              data-testid="vault-host-add"
            >
              <Plus /> Add host
            </Button>
          </div>
          {hostError || errors.hosts ? (
            <p
              id="vault-hosts-message"
              role="alert"
              className="text-[13px] text-destructive"
              data-testid="vault-hosts-error"
            >
              {hostError ?? errors.hosts}
            </p>
          ) : (
            <p id="vault-hosts-message" className="text-[13px] text-muted-foreground">
              The key is sent only to these hosts.
            </p>
          )}
          {privateHosts.map((h) => (
            <p
              key={h}
              role="note"
              className="rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-[13px] leading-snug"
              data-testid="vault-private-hint"
            >
              {h} is on a private network. It works only if an admin lists it in Private network hosts.
              {canOpenMcp ? (
                <>
                  {" "}
                  <Link href="/settings/mcp-servers" className="font-medium text-primary hover:underline">
                    Open MCP servers
                  </Link>
                </>
              ) : null}
            </p>
          ))}
        </div>

        <BotsChecklist scope={scope} unitId={unitId} selected={agentIds} onChange={setAgentIds} />

        <div className="grid gap-3">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className={cn("justify-self-start", TOUCH)}
            aria-expanded={advanced}
            onClick={() => setAdvanced((a) => !a)}
            data-testid="vault-advanced"
          >
            <ChevronRight className={cn("transition-transform", advanced && "rotate-90")} aria-hidden />
            Advanced
          </Button>
          {advanced ? (
            <div className="grid gap-4 sm:grid-cols-2">
              {kind === "basic" ? (
                <>
                  <ReadOnly label="Header" value="Authorization" />
                  <ReadOnly label="Scheme" value="Basic" />
                </>
              ) : (
                <>
                  <FormField id="vault-header" label="Header" error={errors.header}>
                    <Input
                      id="vault-header"
                      value={header}
                      onChange={(e) => {
                        setHeader(e.target.value);
                        clear("header");
                      }}
                      aria-invalid={!!errors.header}
                      aria-describedby={describedBy("vault-header", errors.header)}
                      spellCheck={false}
                      className={cn("font-mono text-[13px]", TOUCH)}
                      data-testid="vault-header"
                    />
                  </FormField>
                  <FormField id="vault-scheme" label="Scheme">
                    <Select
                      items={[
                        { value: "bearer", label: "Bearer" },
                        { value: "raw", label: "Raw" },
                      ]}
                      value={scheme}
                      onValueChange={(v) => v && setScheme(v === "raw" ? "raw" : "bearer")}
                    >
                      <SelectTrigger
                        id="vault-scheme"
                        aria-label="Scheme"
                        className={TOUCH}
                        data-testid="vault-scheme"
                      />
                      <SelectContent>
                        <SelectItem value="bearer">Bearer</SelectItem>
                        <SelectItem value="raw">Raw</SelectItem>
                      </SelectContent>
                    </Select>
                  </FormField>
                </>
              )}
              <FormField
                id="vault-path"
                label="Path prefix"
                error={errors.path}
                hint="Optional"
                className="sm:col-span-2"
              >
                <Input
                  id="vault-path"
                  value={path}
                  placeholder="/v2/"
                  onChange={(e) => {
                    setPath(e.target.value);
                    clear("path");
                  }}
                  aria-invalid={!!errors.path}
                  aria-describedby={describedBy("vault-path", errors.path, "x")}
                  spellCheck={false}
                  className={cn("font-mono text-[13px]", TOUCH)}
                  data-testid="vault-path"
                />
              </FormField>
            </div>
          ) : null}
        </div>

        {errors.form ? (
          <p
            role="alert"
            className="rounded-lg border border-destructive/30 bg-destructive/8 px-3 py-2 text-[13px] text-destructive"
            data-testid="vault-form-error"
          >
            {errors.form}
          </p>
        ) : null}
      </DialogBody>
      <DialogFooter className="max-sm:sticky max-sm:bottom-0 max-sm:pb-[max(env(safe-area-inset-bottom),12px)]">
        <Button type="button" variant="outline" onClick={onDone} disabled={pending} className={TOUCH}>
          Cancel
        </Button>
        <Button type="submit" disabled={pending || !changed} className={TOUCH} data-testid="vault-save">
          {pending ? <Spinner /> : editing ? <Save /> : <KeyRound />}
          {editing ? "Save changes" : "Add key"}
        </Button>
      </DialogFooter>
    </form>
  );
}

function ReadOnly({ label, value }: { label: string; value: string }) {
  return (
    <div className="grid gap-2">
      <span className="font-medium text-sm">{label}</span>
      <span className="flex h-9 items-center rounded-md border bg-muted/40 px-3 font-mono text-[13px] max-md:h-11">
        {value}
      </span>
    </div>
  );
}

/**
 * "Bots that may use it" (`vault-agents`). Personal keys: the member's own bots and the shared bots they can read (a
 * personal key is only ever used on the owner's own turns). Unit keys: the bots the member may configure.
 */
function BotsChecklist({
  scope,
  unitId,
  selected,
  onChange,
}: {
  scope: "personal" | "unit";
  unitId: string | null;
  selected: string[];
  onChange: (ids: string[]) => void;
}) {
  const agents = useAgents();
  const me = useMe();
  const units = useUnits();
  const myId = me.data?.user.id;
  const candidates = (agents.data?.agents ?? []).filter((a: Agent) => {
    if (selected.includes(a.id)) return true;
    if (scope === "personal") return a.scope === "team" || a.ownerUserId === myId;
    if (a.scope !== "team" || !a.viewerCan?.includes("bot.configure")) return false;
    return unitId === null || a.unitId === unitId || a.unitId === null || a.unitId === undefined;
  });
  const label = (a: Agent) => {
    if (a.scope === "personal") return a.ownerUserId === myId ? "your personal bot" : "personal bot";
    const unit = a.unitId ? units.data?.units.find((u) => u.id === a.unitId)?.name : null;
    return unit ?? "Organization";
  };
  return (
    <div className="grid gap-2">
      <span className="font-medium text-sm" id="vault-agents-label">
        Bots that may use it
      </span>
      {agents.isPending ? (
        <p className="text-muted-foreground text-sm">
          <Spinner className="mr-2 inline size-3.5" />
          <span className="sr-only">Loading bots</span>
        </p>
      ) : candidates.length === 0 ? (
        <p className="text-muted-foreground text-sm" data-testid="vault-agents">
          You have no bots that can use keys yet.
        </p>
      ) : (
        <ul
          aria-labelledby="vault-agents-label"
          className="scrollbar-thin grid max-h-48 divide-y overflow-y-auto rounded-lg border"
          data-testid="vault-agents"
        >
          {candidates.map((a) => (
            <li key={a.id}>
              <label className="flex cursor-pointer items-center gap-2.5 px-3 py-2 text-sm max-md:min-h-11">
                <input
                  type="checkbox"
                  checked={selected.includes(a.id)}
                  onChange={(e) =>
                    onChange(e.target.checked ? [...selected, a.id] : selected.filter((x) => x !== a.id))
                  }
                  className="size-4 shrink-0 accent-primary"
                  data-testid={`vault-agent-${a.id}`}
                />
                <span className="min-w-0 truncate">
                  <span className="font-medium">{a.name}</span>
                  <span className="text-muted-foreground"> · {label(a)}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
