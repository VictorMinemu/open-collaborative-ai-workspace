"use client";

import type { ModelProvider, ProviderCatalogEntry } from "@ocw/contracts";
import { Plug, Plus, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";

const MARKS: Record<string, { className: string; text: string }> = {
  anthropic: { className: "bg-[#d97757] text-white", text: "A" },
  openai: { className: "bg-foreground text-background", text: "O" },
  openrouter: { className: "bg-indigo-500 text-white", text: "R" },
  "openai-compatible": { className: "bg-muted text-muted-foreground", text: "" },
  "openai-codex": { className: "bg-[#10a37f] text-white text-[11px] tracking-tight", text: "GPT" },
};

/**
 * The METERED label of an API-key provider (P-11): every AI chat and bot turn on an organization key is billed to
 * the organization. Same look as the AI chat model picker's badge.
 */
export function MeteredBadge({ className }: { className?: string }) {
  return (
    <span
      data-testid="provider-metered"
      title="Billed to your organization"
      className={cn(
        "inline-flex h-[18px] shrink-0 items-center rounded-[5px] border border-amber-500/35 bg-amber-500/10 px-1 font-semibold text-[10px] text-amber-700 leading-none tracking-wide dark:border-amber-400/30 dark:bg-amber-400/10 dark:text-amber-300",
        className,
      )}
    >
      METERED
    </span>
  );
}

export function ProviderMark({ provider }: { provider: string }) {
  const m = MARKS[provider] ?? { className: "bg-muted", text: "?" };
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-10 shrink-0 items-center justify-center rounded-xl font-bold text-base shadow-xs",
        m.className,
      )}
    >
      {m.text || <Plug className="size-4" />}
    </span>
  );
}

/** Allowed-model toggles + custom model ids for a connected provider (API key or subscription). */
export function AllowedModels({
  entry,
  provider,
  onChange,
  customPlaceholder,
}: {
  entry: ProviderCatalogEntry;
  provider: ModelProvider;
  onChange: (allowedModels: string[], message?: string) => void;
  customPlaceholder: string;
}) {
  const [custom, setCustom] = useState("");
  const catalogIds = entry.models.map((m) => m.id);
  const extra = provider.allowedModels.filter((m) => !catalogIds.includes(m));
  const allowed = new Set(provider.allowedModels);

  function toggle(id: string, on: boolean) {
    onChange(on ? [...allowed, id] : [...allowed].filter((m) => m !== id));
  }

  function addCustom(e: FormEvent) {
    e.preventDefault();
    const id = custom.trim();
    if (!id || allowed.has(id)) return;
    setCustom("");
    onChange([...allowed, id], `${id} allowed`);
  }

  return (
    <div className="grid gap-1.5">
      <span className="font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
        Allowed models
      </span>
      <span data-testid="allowed-models-help" className="-mt-1 text-muted-foreground text-xs">
        {entry.authMode === "subscription"
          ? "These models are available to bots."
          : "These models are available to AI chats and bots."}
      </span>
      <ul className="grid gap-1 sm:grid-cols-2">
        {entry.models.map((m) => (
          <li key={m.id}>
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium text-[13px]">{m.label}</span>
                <span className="block truncate text-muted-foreground text-xs">{m.hint}</span>
              </span>
              <Switch
                checked={allowed.has(m.id)}
                onCheckedChange={(v) => toggle(m.id, v)}
                aria-label={`Allow ${m.label}`}
                data-testid={`allow-${m.id}`}
              />
            </div>
          </li>
        ))}
        {extra.map((id) => (
          <li key={id}>
            <div className="flex items-center justify-between gap-3 rounded-lg border bg-background px-3 py-2">
              <span className="min-w-0">
                <span className="block truncate font-medium font-mono text-[12.5px]">{id}</span>
                <span className="block text-muted-foreground text-xs">Custom model</span>
              </span>
              <Button
                variant="ghost"
                size="icon-xs"
                aria-label={`Remove ${id}`}
                onClick={() => toggle(id, false)}
              >
                <X />
              </Button>
            </div>
          </li>
        ))}
      </ul>
      <form onSubmit={addCustom} className="mt-1 flex gap-2">
        <Input
          value={custom}
          onChange={(e) => setCustom(e.target.value)}
          placeholder={customPlaceholder}
          aria-label="Custom model id"
          className="h-8 font-mono text-[12.5px]"
        />
        <Button type="submit" variant="outline" size="sm" disabled={!custom.trim()}>
          <Plus /> Add
        </Button>
      </form>
    </div>
  );
}
