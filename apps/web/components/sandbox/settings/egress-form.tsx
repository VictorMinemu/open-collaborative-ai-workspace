"use client";

import { AllowHost, SANDBOX_LIMITS, type SandboxEgressMode, type SandboxSettings } from "@ocw/contracts";
import { Plus, X } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { cn } from "@/lib/utils";
import { SaveFeedback, type SaveResult } from "./limits-form";

/**
 * Network (07.8-19; D-11, SBX-03, UI-SPEC §4.2): where the browser and the sandbox shell may connect (off, only the
 * allowed hosts, any public address; defaults Browser = Public, Shell = Allowlist) and the allowlist itself, edited
 * with the 07.4 private hosts chip editor. Hosts are checked with the contract's `AllowHost` (host, host:port or
 * `*.example.com`, lower case, up to 64); the API checks them again. Saved explicitly with the version read.
 */

export const PACKAGE_REGISTRIES = [
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "deb.debian.org",
] as const;

export const HOST_INVALID = "Use a host like api.example.com or *.example.com, with an optional :port";
export const HOST_DUPLICATE = "Already listed";
/** `SANDBOX_LIMITS.allowHostsMax` is 64; settings.test.tsx checks the sentence against the contract. */
export const HOST_LIMIT = "Up to 64 hosts";

/** Adds one typed host (trimmed, lower-cased) or says why not. */
export function addHost(hosts: readonly string[], input: string): { hosts: string[] } | { error: string } {
  const parsed = AllowHost.safeParse(input.trim().toLowerCase());
  if (!parsed.success) return { error: HOST_INVALID };
  if (hosts.includes(parsed.data)) return { error: HOST_DUPLICATE };
  if (hosts.length >= SANDBOX_LIMITS.allowHostsMax) return { error: HOST_LIMIT };
  return { hosts: [...hosts, parsed.data] };
}

/** Adds the package registries that are not listed yet, within the 64-host limit. */
export function addRegistries(hosts: readonly string[]): { hosts: string[]; added: number } {
  const next = [...hosts];
  for (const h of PACKAGE_REGISTRIES) {
    if (next.length >= SANDBOX_LIMITS.allowHostsMax) break;
    if (!next.includes(h)) next.push(h);
  }
  return { hosts: next, added: next.length - hosts.length };
}

const MODES: ReadonlyArray<{ id: SandboxEgressMode; label: string; description: string }> = [
  { id: "off", label: "Off", description: "No internet" },
  { id: "allowlist", label: "Allowlist", description: "Only the hosts below" },
  { id: "public", label: "Public", description: "Any public address" },
];

interface Draft {
  browserEgress: SandboxEgressMode;
  sandboxEgress: SandboxEgressMode;
  allowHosts: string[];
}

const draftOf = (s: SandboxSettings): Draft => ({
  browserEgress: s.browserEgress,
  sandboxEgress: s.sandboxEgress,
  allowHosts: [...s.allowHosts],
});

const sameDraft = (a: Draft, b: Draft) =>
  a.browserEgress === b.browserEgress &&
  a.sandboxEgress === b.sandboxEgress &&
  a.allowHosts.length === b.allowHosts.length &&
  a.allowHosts.every((h, i) => h === b.allowHosts[i]);

function ModeFieldset({
  legend,
  name,
  testPrefix,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  testPrefix: string;
  value: SandboxEgressMode;
  onChange: (mode: SandboxEgressMode) => void;
}) {
  return (
    // The legend floats left of the cards from 640 px (a floated legend joins the content box), above them on phones.
    <fieldset className="min-w-0">
      <legend className="mb-2 font-medium text-sm sm:float-left sm:mb-0 sm:w-28 sm:pt-3.5">{legend}</legend>
      <div className="grid gap-2 sm:ml-32 sm:grid-cols-3">
        {MODES.map((m) => {
          const selected = value === m.id;
          return (
            <label
              key={m.id}
              className={cn(
                "flex min-h-11 cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 shadow-xs transition-colors",
                selected && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
              )}
            >
              <input
                type="radio"
                name={name}
                value={m.id}
                checked={selected}
                onChange={() => onChange(m.id)}
                data-testid={`${testPrefix}-${m.id}`}
                className="mt-0.5 size-4 shrink-0 accent-primary"
              />
              <span className="min-w-0">
                <span className="block font-medium text-sm">{m.label}</span>
                <span className="block text-muted-foreground text-xs leading-snug">{m.description}</span>
              </span>
            </label>
          );
        })}
      </div>
    </fieldset>
  );
}

export function EgressForm({
  settings,
  disabledReason,
  notice,
  pending,
  onEdit,
  onSave,
}: {
  settings: SandboxSettings;
  disabledReason: string | null;
  notice: string | null;
  pending: boolean;
  onEdit: () => void;
  onSave: (patch: Draft) => Promise<SaveResult>;
}) {
  const id = useId();
  const saved = draftOf(settings);
  const [draft, setDraft] = useState<Draft>(saved);
  const [hostInput, setHostInput] = useState("");
  const [hostError, setHostError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const changed = !sameDraft(draft, saved);
  const showHosts = draft.browserEgress === "allowlist" || draft.sandboxEgress === "allowlist";

  const edit = (patch: Partial<Draft>) => {
    setDraft((d) => ({ ...d, ...patch }));
    setError(null);
    onEdit();
  };

  function add(e?: FormEvent) {
    e?.preventDefault();
    const res = addHost(draft.allowHosts, hostInput);
    if ("error" in res) {
      setHostError(res.error);
      return;
    }
    edit({ allowHosts: res.hosts });
    setHostInput("");
    setHostError(null);
  }

  function registries() {
    const res = addRegistries(draft.allowHosts);
    if (res.added === 0) {
      setHostError(draft.allowHosts.length >= SANDBOX_LIMITS.allowHostsMax ? HOST_LIMIT : HOST_DUPLICATE);
      return;
    }
    edit({ allowHosts: res.hosts });
    setHostError(null);
    toast.success(`Added ${res.added} ${res.added === 1 ? "registry" : "registries"}`);
  }

  async function submit() {
    setError(null);
    const res = await onSave(draft);
    if (res.kind === "error") setError(res.message);
  }

  return (
    <div className="grid gap-5 rounded-xl border bg-card p-4 shadow-xs sm:p-5" data-testid="egress-form">
      <ModeFieldset
        legend="Browser"
        name={`${id}-browser`}
        testPrefix="egress-browser"
        value={draft.browserEgress}
        onChange={(browserEgress) => edit({ browserEgress })}
      />
      <ModeFieldset
        legend="Sandbox shell"
        name={`${id}-shell`}
        testPrefix="egress-shell"
        value={draft.sandboxEgress}
        onChange={(sandboxEgress) => edit({ sandboxEgress })}
      />

      {showHosts ? (
        <div className="grid gap-3 border-t pt-4" data-testid="egress-allowlist">
          <p id={`${id}-hosts`} className="font-medium text-sm">
            Allowed hosts
          </p>
          {draft.allowHosts.length === 0 ? (
            <p className="text-muted-foreground text-sm" data-testid="egress-hosts-empty">
              No hosts yet. Allowlist parts can't connect anywhere until you add one.
            </p>
          ) : (
            <ul aria-labelledby={`${id}-hosts`} className="flex flex-wrap gap-1.5">
              {draft.allowHosts.map((h) => (
                <li
                  key={h}
                  className="inline-flex h-7 max-w-full items-center gap-1 rounded-md border bg-background pr-0.5 pl-2 font-mono text-xs max-md:h-11"
                  data-testid="egress-host-chip"
                  data-host={h}
                >
                  <span className="truncate">{h}</span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-xs"
                    aria-label={`Remove ${h}`}
                    onClick={() => edit({ allowHosts: draft.allowHosts.filter((x) => x !== h) })}
                    className="size-6 max-md:size-11"
                  >
                    <X />
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <form onSubmit={add} noValidate className="grid gap-1.5">
            <div className="flex gap-2">
              <Input
                value={hostInput}
                onChange={(e) => {
                  setHostInput(e.target.value);
                  setHostError(null);
                }}
                placeholder="api.example.com"
                aria-label="Allowed host"
                aria-invalid={hostError ? true : undefined}
                aria-describedby={hostError ? `${id}-host-error` : undefined}
                autoComplete="off"
                spellCheck={false}
                className="min-w-0 flex-1 font-mono text-[13px] max-md:h-11"
                data-testid="egress-host-input"
              />
              <Button
                type="submit"
                variant="outline"
                size="sm"
                className="h-9 max-md:h-11"
                data-testid="egress-host-add"
              >
                <Plus /> Add
              </Button>
            </div>
            {hostError ? (
              <p
                id={`${id}-host-error`}
                role="alert"
                className="text-[13px] text-destructive"
                data-testid="egress-host-error"
              >
                {hostError}
              </p>
            ) : null}
          </form>
          <div>
            <Button
              type="button"
              variant="link"
              size="sm"
              onClick={registries}
              className="px-0 max-md:h-11"
              data-testid="egress-registries"
            >
              Add package registries
            </Button>
          </div>
          <p className="text-muted-foreground text-xs leading-4">
            Private networks and OCW's own services are always refused. Private hosts come from Private
            network hosts in MCP servers.
          </p>
        </div>
      ) : null}

      <div className="grid gap-2 sm:justify-items-end">
        <Button
          onClick={() => void submit()}
          disabled={!changed || pending || disabledReason !== null}
          className="w-full max-md:h-11 sm:w-auto"
          data-testid="egress-save"
        >
          {pending ? <Spinner /> : null}
          Save network rules
        </Button>
        <p className="text-muted-foreground text-xs sm:text-right">
          Open pages and running commands keep their current connections until they close.
        </p>
        <SaveFeedback error={error} notice={notice} disabledReason={disabledReason} testId="egress" />
      </div>
    </div>
  );
}
