"use client";

import {
  BOT_FILE_LIMITS,
  BOT_WORK_ZONE_LIMITS,
  EFFORT_LABELS,
  fileSizeLabel,
  KNOWN_EFFORTS,
  type PermissionMode,
  type RuntimeId,
  type RuntimeUpdatesLevel,
  type UpdateWorkZonePolicyRequest,
  type WorkZonePolicyView,
} from "@ocw/contracts";
import {
  Bot,
  ClipboardList,
  FilePen,
  FileUp,
  Hand,
  type LucideIcon,
  RefreshCw,
  RotateCcw,
  Save,
  ShieldAlert,
  Sparkles,
  Zap,
} from "lucide-react";
import { type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { errorMessage, isApiError } from "@/lib/api";
import { useCan, usePermissions } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { useUpdateWorkZonePolicy, useWorkZonePolicy } from "@/lib/workzone-policy-queries";

type Draft = Omit<WorkZonePolicyView, "updatedAt" | "knownModels" | "botSessionsMax" | "botFileMaxBytes"> & {
  /** 07.16 (D-15, PD-22): always a number in the form (absent on the API = the default). */
  botSessionsMax: number;
  /**
   * 07.17.1.1 (D-07, PD-11): "Largest file a bot moves" in MB (MiB), always a number in the form (absent = 25). The
   * view's `serverFileMaxBytes` stays in the draft read-only: it is the field's ceiling and never sent.
   */
  botFileMaxMb: number;
};
type GovernedMode = Draft["allowedPermissionModes"][number];
type Restrict = Record<RuntimeId, boolean>;

const RUNTIME_IDS: readonly RuntimeId[] = ["claude-code", "codex"];
const RUNTIME_LABELS: Record<RuntimeId, string> = { "claude-code": "Claude Code", codex: "Codex" };

/** D-12: the menu a controller sees, in ladder order. Full access has its own switch (ADR-0012). */
const MODES: Array<{ value: GovernedMode; label: string; description: string; icon: LucideIcon }> = [
  {
    value: "plan",
    label: "Plan",
    description: "Read-only: proposes a plan and changes nothing.",
    icon: ClipboardList,
  },
  {
    value: "default",
    label: "Supervised",
    description: "Asks before every file edit and every command.",
    icon: Hand,
  },
  {
    value: "acceptEdits",
    label: "Auto-accept edits",
    description: "File edits run without asking; commands still ask.",
    icon: FilePen,
  },
  {
    value: "auto",
    label: "Auto",
    description:
      "The runtime approves what it judges safe and asks for the rest. Only on models that support it.",
    icon: Sparkles,
  },
];
const MODE_ORDER = MODES.map((m) => m.value as PermissionMode);

/** ADR-0012: the organization switch is only one of the three conditions Full access needs. */
const FULL_ACCESS_LEGS = [
  { label: "Organization policy", note: "This switch" },
  { label: "Device owner", note: "Enables it on the device" },
  { label: "Member", note: "Has Full access on that device" },
];

const NO_LIMIT = "none";

/** 07.11 (D-02): how far devices may update their coding CLIs; each device can only lower it. */
const RUNTIME_UPDATE_LEVELS: Array<{ value: RuntimeUpdatesLevel; label: string; description: string }> = [
  {
    value: "automatic",
    label: "Automatic",
    description: "Devices update Claude Code and Codex when the agent is idle. Turns are never cut.",
  },
  {
    value: "notify",
    label: "Notify only",
    description: "Devices report new versions; the device owner or an admin presses Update now.",
  },
  { value: "off", label: "Off", description: "Devices don't check for new versions." },
];

const MIB = 1024 * 1024;

/** The field's ceiling in whole MB: the server's `OCW_ATTACHMENT_MAX_BYTES`, or 1 GiB when an older API says none. */
const fileCeilingMb = (serverBytes: number | undefined) =>
  Math.max(1, Math.floor((serverBytes ?? BOT_FILE_LIMITS.ceilingMaxBytes) / MIB));

export const toDraft = ({
  updatedAt: _u,
  knownModels: _k,
  botFileMaxBytes,
  ...rest
}: WorkZonePolicyView): Draft => ({
  ...rest,
  botSessionsMax: rest.botSessionsMax ?? BOT_WORK_ZONE_LIMITS.orgSessionsDefault,
  // A server ceiling below the stored value shows what applies: the lower of the two wins at every call (PD-11).
  botFileMaxMb: Math.min(
    fileCeilingMb(rest.serverFileMaxBytes),
    Math.max(1, Math.floor((botFileMaxBytes ?? BOT_FILE_LIMITS.defaultMaxBytes) / MIB)),
  ),
});

/** 07.16 (D-15, PD-22): the organization's cap on bot-started sessions. */
export const BOT_SESSIONS_COPY = {
  label: "Bot sessions at once",
  hint: "0 = bots never start Work Zone sessions",
  invalid: `Enter a whole number from 0 to ${BOT_WORK_ZONE_LIMITS.orgSessionsMax}`,
} as const;

/** What the API would refuse (0..1000, whole numbers), refused before sending; null when the value is fine. */
export function botSessionsError(value: string): string | null {
  const v = value.trim();
  if (!/^\d+$/.test(v)) return BOT_SESSIONS_COPY.invalid;
  return Number(v) <= BOT_WORK_ZONE_LIMITS.orgSessionsMax ? null : BOT_SESSIONS_COPY.invalid;
}

/** 07.17.1.1 (D-07, PD-20): the organization's per-file limit for files bots move. */
export const BOT_FILE_MAX_COPY = {
  label: "Largest file a bot moves",
  unit: "MB",
  applies: "Applies to files bots upload into or download from their Work Zone sessions.",
  hint: (ceiling: string) =>
    `Up to ${ceiling} on this server. Applies to files bots upload into or download from their Work Zone sessions.`,
  invalid: (n: number) => `Enter a whole number from 1 to ${n}.`,
} as const;

/** What the API would refuse (a whole number of MB from 1 to the server's ceiling); null when the value is fine. */
export function botFileMaxError(value: string, ceilingBytes: number | undefined): string | null {
  const max = fileCeilingMb(ceilingBytes);
  const v = value.trim();
  if (!/^\d+$/.test(v)) return BOT_FILE_MAX_COPY.invalid(max);
  const n = Number(v);
  return n >= 1 && n <= max ? null : BOT_FILE_MAX_COPY.invalid(max);
}

/** A refused save that names a field of the form (400 `invalid_work_zone_policy` with `details.field`). */
export function policyFieldError(err: unknown): { field: string; message: string } | null {
  if (!isApiError(err, 400) || err.code !== "invalid_work_zone_policy") return null;
  const field = (err.details as { field?: unknown } | null | undefined)?.field;
  return typeof field === "string" ? { field, message: err.message } : null;
}

/**
 * The Save body: the whole draft, a runtime left on "any model" sending no list. The bot file limit goes in bytes,
 * and only to an API that reported its ceiling (an older one does not know the field).
 */
export function toPolicyBody(draft: Draft, restrict: Restrict): UpdateWorkZonePolicyRequest {
  const { botFileMaxMb, serverFileMaxBytes, ...rest } = draft;
  return {
    ...rest,
    allowedModels: {
      "claude-code": restrict["claude-code"] ? draft.allowedModels["claude-code"] : [],
      codex: restrict.codex ? draft.allowedModels.codex : [],
    },
    ...(serverFileMaxBytes !== undefined ? { botFileMaxBytes: botFileMaxMb * MIB } : {}),
  };
}
const restrictOf = (d: Draft): Restrict => ({
  "claude-code": d.allowedModels["claude-code"].length > 0,
  codex: d.allowedModels.codex.length > 0,
});

/** Order-insensitive: toggling a mode or a model off and on again is not a change. */
function canonical(d: Draft): string {
  return JSON.stringify({
    ...d,
    allowedPermissionModes: [...d.allowedPermissionModes].sort(),
    allowedModels: {
      "claude-code": [...d.allowedModels["claude-code"]].sort(),
      codex: [...d.allowedModels.codex].sort(),
    },
  });
}

/**
 * Settings › Work Zone policy (Phase 03.2, D-02, D-11, D-12; WZC-03/04): what every Work Zone session of the
 * organization may use: permission modes, Full access, models per runtime, a maximum effort per runtime and
 * fast mode. One Save; the API stores, audits and enforces it on every turn (the page enforces nothing).
 * Admins only (`work_zone.manage`).
 */
export function WorkZonePolicySettings() {
  const permissions = usePermissions();
  const canManage = useCan("work_zone.manage");
  const policy = useWorkZonePolicy(canManage);

  if (!canManage) {
    return permissions.isPending ? (
      <Skeleton className="h-40 rounded-2xl" />
    ) : (
      <div className="rounded-xl border border-dashed px-4 py-10 text-center text-muted-foreground text-sm">
        Only workspace admins can change the Work Zone policy.
      </div>
    );
  }
  if (policy.isPending) {
    return (
      <div className="grid gap-3">
        <Skeleton className="h-6 w-48" />
        <Skeleton className="h-32 rounded-2xl" />
        <Skeleton className="h-48 rounded-2xl" />
      </div>
    );
  }
  if (policy.isError) {
    return (
      <div className="rounded-xl border bg-card">
        <ServerUnreachable onRetry={() => policy.refetch()} retrying={policy.isFetching} />
      </div>
    );
  }
  return <PolicyForm policy={policy.data} />;
}

/**
 * The policy form. `initial` is the state an edit leaves (the tests render an out-of-range bot sessions cap);
 * the page starts it from the saved policy.
 */
export function PolicyForm({
  policy,
  initial,
}: {
  policy: WorkZonePolicyView;
  initial?: { botSessions?: string; botFileMax?: string; botFileMaxError?: string } | undefined;
}) {
  const save = useUpdateWorkZonePolicy();
  const saved = toDraft(policy);
  const [draft, setDraft] = useState<Draft>(saved);
  const [restrict, setRestrict] = useState<Restrict>(restrictOf(saved));
  const [modelErrors, setModelErrors] = useState<Partial<Record<RuntimeId, string>>>({});
  // The field's text, so an out-of-range value stays visible with its error; the draft keeps the last valid number.
  const [botSessions, setBotSessions] = useState(initial?.botSessions ?? String(saved.botSessionsMax));
  const botError = botSessionsError(botSessions);
  // 07.17.1.1 (D-07): the same pattern for the bot file limit, plus the API's own refusal of the field.
  const [botFileMax, setBotFileMax] = useState(initial?.botFileMax ?? String(saved.botFileMaxMb));
  const [botFileMaxRefused, setBotFileMaxRefused] = useState<string | null>(initial?.botFileMaxError ?? null);
  const fileError = botFileMaxError(botFileMax, policy.serverFileMaxBytes);
  const savedRestrict = restrictOf(saved);
  const dirty =
    canonical(draft) !== canonical(saved) ||
    RUNTIME_IDS.some((rt) => restrict[rt] !== savedRestrict[rt]) ||
    botSessions.trim() !== String(saved.botSessionsMax) ||
    botFileMax.trim() !== String(saved.botFileMaxMb);
  const noModes = draft.allowedPermissionModes.length === 0;

  // Leaving the page with unsaved changes asks first.
  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  function toggleMode(mode: GovernedMode, on: boolean) {
    setDraft((d) => {
      const set = new Set<PermissionMode>(d.allowedPermissionModes);
      if (on) set.add(mode);
      else set.delete(mode);
      return {
        ...d,
        allowedPermissionModes: MODE_ORDER.filter((m): m is GovernedMode => set.has(m)),
      };
    });
  }

  function toggleModel(rt: RuntimeId, id: string, on: boolean) {
    setModelErrors((e) => ({ ...e, [rt]: undefined }));
    setDraft((d) => {
      const list = d.allowedModels[rt].filter((m) => m !== id);
      return { ...d, allowedModels: { ...d.allowedModels, [rt]: on ? [...list, id] : list } };
    });
  }

  function reset() {
    setDraft(saved);
    setRestrict(savedRestrict);
    setModelErrors({});
    setBotSessions(String(saved.botSessionsMax));
    setBotFileMax(String(saved.botFileMaxMb));
    setBotFileMaxRefused(null);
  }

  function changeBotSessions(value: string) {
    setBotSessions(value);
    if (botSessionsError(value) === null) setDraft((d) => ({ ...d, botSessionsMax: Number(value.trim()) }));
  }

  function changeBotFileMax(value: string) {
    setBotFileMax(value);
    setBotFileMaxRefused(null);
    if (botFileMaxError(value, policy.serverFileMaxBytes) === null) {
      setDraft((d) => ({ ...d, botFileMaxMb: Number(value.trim()) }));
    }
  }

  async function submit() {
    const errors: Partial<Record<RuntimeId, string>> = {};
    for (const rt of RUNTIME_IDS) {
      if (restrict[rt] && draft.allowedModels[rt].length === 0) {
        errors[rt] = "Pick at least one model, or allow any model the device reports";
      }
    }
    setModelErrors(errors);
    if (noModes || botError || fileError || Object.keys(errors).length > 0) return;
    try {
      const updated = await save.mutateAsync(toPolicyBody(draft, restrict));
      const next = toDraft(updated);
      setDraft(next);
      setRestrict(restrictOf(next));
      setBotSessions(String(next.botSessionsMax));
      setBotFileMax(String(next.botFileMaxMb));
      setBotFileMaxRefused(null);
      toast.success("Work Zone policy saved", {
        description: "Every Work Zone session follows it from its next turn.",
      });
    } catch (err) {
      const refused = policyFieldError(err);
      if (refused?.field === "botFileMaxBytes") setBotFileMaxRefused(refused.message);
      else toast.error("Could not save the Work Zone policy", { description: errorMessage(err) });
    }
  }

  return (
    <div className="grid gap-8" data-testid="work-zone-policy-settings">
      <Section
        title="Permission modes"
        description="The modes members may pick for a session and for each message they send."
      >
        <fieldset className="grid gap-2 sm:grid-cols-2">
          <legend className="sr-only">Allowed permission modes</legend>
          {MODES.map((m) => {
            const on = draft.allowedPermissionModes.includes(m.value);
            return (
              <label
                key={m.value}
                className={cn(
                  "flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 shadow-xs transition-colors",
                  on && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                )}
              >
                <input
                  type="checkbox"
                  checked={on}
                  onChange={(e) => toggleMode(m.value, e.target.checked)}
                  data-testid={`mode-allow-${m.value}`}
                  className="mt-0.5 size-4 shrink-0 accent-primary"
                />
                <span className="min-w-0 flex-1">
                  <span className="flex items-center gap-1.5 font-medium text-sm">
                    <m.icon aria-hidden className="size-3.5 text-muted-foreground" />
                    {m.label}
                  </span>
                  <span className="mt-0.5 block text-muted-foreground text-xs leading-snug">
                    {m.description}
                  </span>
                </span>
              </label>
            );
          })}
        </fieldset>
        {noModes ? (
          <p role="alert" className="text-[13px] text-destructive">
            Keep at least one permission mode allowed.
          </p>
        ) : null}
      </Section>

      <Section
        title="Full access"
        description="The riskiest mode: the coding agent edits files and runs commands without asking anyone."
      >
        <div
          className={cn(
            "grid gap-4 rounded-2xl border bg-card p-4 shadow-xs transition-colors",
            draft.allowFullAccess && "border-warning/50 bg-warning/5",
          )}
        >
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
          <label className="flex cursor-pointer items-start gap-3">
            <IconTile icon={ShieldAlert} warn={draft.allowFullAccess} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-sm">Allow Full access</span>
              <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">
                Runs Claude Code and Codex in their bypass mode, with no approval prompts. It also needs the
                device owner to enable it on the device and the member to have Full access on that device.
              </span>
            </span>
            <Switch
              checked={draft.allowFullAccess}
              onCheckedChange={(allowFullAccess) => setDraft((d) => ({ ...d, allowFullAccess }))}
              aria-label="Allow Full access"
              data-testid="allow-full-access"
              className="mt-1"
            />
          </label>
          <ol className="ml-11 grid gap-1.5 sm:grid-cols-3" aria-label="Full access needs all three">
            {FULL_ACCESS_LEGS.map((leg, i) => (
              <li
                key={leg.label}
                className={cn(
                  "flex items-center gap-2 rounded-lg border bg-background px-2.5 py-1.5",
                  i === 0 && draft.allowFullAccess && "border-warning/50",
                )}
              >
                <span
                  aria-hidden
                  className="flex size-5 shrink-0 items-center justify-center rounded-full bg-muted font-medium text-[11px] text-muted-foreground tabular-nums"
                >
                  {i + 1}
                </span>
                <span className="min-w-0">
                  <span className="block truncate font-medium text-xs">{leg.label}</span>
                  <span className="block truncate text-[11px] text-muted-foreground">{leg.note}</span>
                </span>
              </li>
            ))}
          </ol>
        </div>
      </Section>

      <Section title="Models" description="Which models sessions may use, per coding agent.">
        <div className="grid gap-3">
          {RUNTIME_IDS.map((rt) => (
            <RuntimeModels
              key={rt}
              runtime={rt}
              known={policy.knownModels[rt]}
              saved={saved.allowedModels[rt]}
              chosen={draft.allowedModels[rt]}
              restricted={restrict[rt]}
              error={modelErrors[rt]}
              onRestrict={(v) => {
                setRestrict((r) => ({ ...r, [rt]: v }));
                setModelErrors((e) => ({ ...e, [rt]: undefined }));
              }}
              onToggle={(id, on) => toggleModel(rt, id, on)}
            />
          ))}
        </div>
      </Section>

      <Section
        title="Maximum effort"
        description="The highest reasoning effort sessions may pick. Higher effort is slower and uses more of the subscription."
      >
        <div className="grid gap-3 rounded-2xl border bg-card p-4 shadow-xs sm:grid-cols-2 sm:gap-4">
          {RUNTIME_IDS.map((rt) => (
            <EffortField
              key={rt}
              runtime={rt}
              value={draft.maxEffort[rt]}
              onChange={(v) => setDraft((d) => ({ ...d, maxEffort: { ...d.maxEffort, [rt]: v } }))}
            />
          ))}
        </div>
      </Section>

      <Section title="Fast mode" description="Faster answers that cost more than the standard rate.">
        <div
          className={cn(
            "rounded-2xl border bg-card p-4 shadow-xs transition-colors",
            draft.allowFastMode && "border-warning/50 bg-warning/5",
          )}
        >
          {/* biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label */}
          <label className="flex cursor-pointer items-start gap-3">
            <IconTile icon={Zap} warn={draft.allowFastMode} />
            <span className="min-w-0 flex-1">
              <span className="block font-medium text-sm">Allow fast mode</span>
              <span className="mt-0.5 block text-muted-foreground text-xs leading-relaxed">
                Claude: billed from paid usage credits. Codex: uses ChatGPT plan limits at about 2.5x.
              </span>
            </span>
            <Switch
              checked={draft.allowFastMode}
              onCheckedChange={(allowFastMode) => setDraft((d) => ({ ...d, allowFastMode }))}
              aria-label="Allow fast mode"
              data-testid="allow-fast-mode"
              className="mt-1"
            />
          </label>
        </div>
      </Section>

      <Section
        title="Runtime updates"
        description="How the organization's devices keep Claude Code and Codex up to date."
      >
        <RuntimeUpdatesField
          value={draft.runtimeUpdates}
          onChange={(runtimeUpdates) => setDraft((d) => ({ ...d, runtimeUpdates }))}
        />
      </Section>

      <Section
        title="Bots"
        description="How many Work Zone sessions bots may run at once, and the largest file they move."
      >
        <BotSessionsField value={botSessions} error={botError} onChange={changeBotSessions} />
        <BotFileMaxField
          value={botFileMax}
          serverFileMaxBytes={policy.serverFileMaxBytes}
          error={fileError ?? botFileMaxRefused}
          onChange={changeBotFileMax}
        />
      </Section>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        <span
          className={cn("mr-auto text-xs", noModes ? "text-destructive" : "text-muted-foreground")}
          aria-live="polite"
        >
          {noModes
            ? "Allow at least one mode to save"
            : dirty
              ? "Unsaved changes"
              : policy.updatedAt
                ? "All changes saved"
                : "Defaults: Full access and fast mode off"}
        </span>
        <Button variant="outline" onClick={reset} disabled={!dirty || save.isPending}>
          <RotateCcw /> Discard
        </Button>
        <Button
          onClick={submit}
          disabled={!dirty || noModes || !!botError || !!fileError || save.isPending}
          data-testid="save-policy"
        >
          {save.isPending ? <Spinner /> : <Save />}
          Save policy
        </Button>
      </div>
    </div>
  );
}

/**
 * One runtime's model allow-list. Only models the organization's devices reported can be chosen; an id saved
 * earlier that no device reports any more stays listed (marked) so it can be removed.
 */
function RuntimeModels({
  runtime,
  known,
  saved,
  chosen,
  restricted,
  error,
  onRestrict,
  onToggle,
}: {
  runtime: RuntimeId;
  known: WorkZonePolicyView["knownModels"][RuntimeId];
  saved: string[];
  chosen: string[];
  restricted: boolean;
  error?: string;
  onRestrict: (v: boolean) => void;
  onToggle: (id: string, on: boolean) => void;
}) {
  const label = RUNTIME_LABELS[runtime];
  const knownIds = new Set(known.map((m) => m.id));
  const orphans = [...new Set([...saved, ...chosen])].filter((id) => !knownIds.has(id));
  const rows = [
    ...known.map((m) => ({ id: m.id, name: m.displayName, reported: true })),
    ...orphans.map((id) => ({ id, name: id, reported: false })),
  ];
  return (
    <div className="grid gap-3 rounded-2xl border bg-card p-4 shadow-xs" data-testid={`models-${runtime}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="min-w-0">
          <span className="block font-medium text-sm">{label}</span>
          <span className="block text-muted-foreground text-xs">
            {restricted
              ? `${chosen.length} of ${rows.length} chosen`
              : "Sessions may use any model the device reports"}
          </span>
        </span>
        <div
          className="inline-flex max-w-full rounded-lg border bg-muted/40 p-0.5"
          role="radiogroup"
          aria-label={`${label} models`}
        >
          {[
            { value: false, label: "Any model the device reports" },
            { value: true, label: "Chosen models" },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={restricted === o.value}
              onClick={() => onRestrict(o.value)}
              className={cn(
                "h-7 rounded-md px-2.5 font-medium text-xs outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/40",
                restricted === o.value
                  ? "bg-background text-foreground shadow-xs"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>
      {restricted ? (
        rows.length === 0 ? (
          <p className="rounded-lg border border-dashed px-3 py-4 text-center text-muted-foreground text-xs">
            No device has reported its {label} models yet. Pair a device with {label} signed in, then choose
            here.
          </p>
        ) : (
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {rows.map((m) => (
              <li key={m.id} data-testid="model-option">
                <label
                  className={cn(
                    "flex cursor-pointer items-center gap-3 rounded-lg border bg-background px-3 py-2",
                    !m.reported && "border-dashed",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={chosen.includes(m.id)}
                    onChange={(e) => onToggle(m.id, e.target.checked)}
                    aria-label={`Allow ${m.name}`}
                    className="size-4 shrink-0 accent-primary"
                  />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate font-medium text-[13px]">{m.name}</span>
                    {m.reported ? (
                      <span className="block truncate font-mono text-[11px] text-muted-foreground">
                        {m.id}
                      </span>
                    ) : (
                      <span className="block truncate text-[11px] text-amber-700 dark:text-amber-300">
                        Not reported by any device
                      </span>
                    )}
                  </span>
                </label>
              </li>
            ))}
          </ul>
        )
      ) : null}
      {error ? (
        <p role="alert" className="text-[13px] text-destructive">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function EffortField({
  runtime,
  value,
  onChange,
}: {
  runtime: RuntimeId;
  value: string | null;
  onChange: (v: string | null) => void;
}) {
  const id = useId();
  const items = [
    { value: NO_LIMIT, label: "No limit" },
    ...KNOWN_EFFORTS.map((e) => ({ value: e as string, label: EFFORT_LABELS[e] ?? e })),
  ];
  // A level saved through the API that the ladder does not know stays visible as itself.
  if (value !== null && !items.some((i) => i.value === value)) items.push({ value, label: value });
  return (
    <div className="grid gap-1.5">
      <span id={id} className="font-medium text-sm">
        {RUNTIME_LABELS[runtime]}
      </span>
      <Select
        items={items}
        value={value ?? NO_LIMIT}
        onValueChange={(v) => v && onChange(v === NO_LIMIT ? null : v)}
      >
        <SelectTrigger aria-labelledby={id} data-testid={`max-effort-${runtime}`} className="h-10 sm:h-9" />
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
      <span className="text-muted-foreground text-xs">
        {value === null
          ? "Sessions may pick any effort the model offers"
          : "Sessions cannot pick a higher level"}
      </span>
    </div>
  );
}

export function RuntimeUpdatesField({
  value,
  onChange,
}: {
  value: RuntimeUpdatesLevel;
  onChange: (v: RuntimeUpdatesLevel) => void;
}) {
  const id = useId();
  const chosen = RUNTIME_UPDATE_LEVELS.find((l) => l.value === value);
  return (
    <div className="grid gap-3 rounded-2xl border bg-card p-4 shadow-xs">
      <div className="flex items-start gap-3">
        <IconTile icon={RefreshCw} warn={false} />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <span id={id} className="font-medium text-sm">
            Updates on devices
          </span>
          <Select
            items={RUNTIME_UPDATE_LEVELS.map((l) => ({ value: l.value, label: l.label }))}
            value={value}
            onValueChange={(v) => {
              const level = RUNTIME_UPDATE_LEVELS.find((l) => l.value === v);
              if (level) onChange(level.value);
            }}
          >
            <SelectTrigger
              aria-labelledby={id}
              data-testid="policy-runtime-updates"
              className="h-11 w-full sm:h-9 sm:w-64"
            />
            <SelectContent>
              {RUNTIME_UPDATE_LEVELS.map((l) => (
                <SelectItem key={l.value} value={l.value}>
                  <span className="grid gap-0.5 py-0.5">
                    <span>{l.label}</span>
                    <span className="max-w-72 whitespace-normal text-muted-foreground text-xs">
                      {l.description}
                    </span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <span className="text-muted-foreground text-xs">{chosen?.description}</span>
        </div>
      </div>
      <p className="ml-11 text-muted-foreground text-xs leading-relaxed">
        A device owner can lower this on the device (desktop app › Runtime updates, or{" "}
        <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-[12px]">
          ocw-runtime updates
        </code>
        ).
      </p>
    </div>
  );
}

/** The org cap on bot sessions (D-15, PD-22): bot-started sessions active in the organization at the same time. */
function BotSessionsField({
  value,
  error,
  onChange,
}: {
  value: string;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const id = useId();
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-xs">
      <div className="flex items-start gap-3">
        <IconTile icon={Bot} warn={false} />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <label htmlFor={id} className="font-medium text-sm">
            {BOT_SESSIONS_COPY.label}
          </label>
          <Input
            id={id}
            type="number"
            inputMode="numeric"
            min={0}
            max={BOT_WORK_ZONE_LIMITS.orgSessionsMax}
            step={1}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            aria-invalid={error ? true : undefined}
            aria-describedby={`${id}-hint`}
            data-testid="policy-bot-sessions"
            className="w-full tabular-nums max-lg:h-11 sm:w-32"
          />
          <span id={`${id}-hint`} className="text-muted-foreground text-xs">
            {BOT_SESSIONS_COPY.hint}. Each bot also has its own limit in its Work Zone profile.
          </span>
          {error ? (
            <p role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

/**
 * The organization's "Largest file a bot moves" (D-07, PD-11, PD-20): per file, for bot uploads into and downloads from
 * their Work Zone sessions, in MB, at most the server's attachment limit. Each bot may only lower it in its profile.
 */
function BotFileMaxField({
  value,
  serverFileMaxBytes,
  error,
  onChange,
}: {
  value: string;
  serverFileMaxBytes: number | undefined;
  error: string | null;
  onChange: (v: string) => void;
}) {
  const id = useId();
  const hint =
    serverFileMaxBytes === undefined
      ? BOT_FILE_MAX_COPY.applies
      : BOT_FILE_MAX_COPY.hint(fileSizeLabel(serverFileMaxBytes));
  const describedBy = [`${id}-unit`, `${id}-hint`, error ? `${id}-error` : null].filter(Boolean).join(" ");
  return (
    <div className="rounded-2xl border bg-card p-4 shadow-xs">
      <div className="flex items-start gap-3">
        <IconTile icon={FileUp} warn={false} />
        <div className="grid min-w-0 flex-1 gap-1.5">
          <label htmlFor={id} className="font-medium text-sm">
            {BOT_FILE_MAX_COPY.label}
          </label>
          <div className="relative w-full sm:w-32">
            <Input
              id={id}
              type="number"
              inputMode="numeric"
              min={1}
              max={fileCeilingMb(serverFileMaxBytes)}
              step={1}
              value={value}
              onChange={(e) => onChange(e.target.value)}
              aria-invalid={error ? true : undefined}
              aria-describedby={describedBy}
              data-testid="bot-file-max"
              className="w-full pr-11 tabular-nums max-lg:h-11"
            />
            <span
              id={`${id}-unit`}
              className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-foreground text-sm"
            >
              {BOT_FILE_MAX_COPY.unit}
            </span>
          </div>
          <span id={`${id}-hint`} className="text-muted-foreground text-xs leading-relaxed">
            {hint} Each bot can lower it in its Work Zone profile.
          </span>
          {error ? (
            <p id={`${id}-error`} role="alert" className="text-[13px] text-destructive">
              {error}
            </p>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function IconTile({ icon: Icon, warn }: { icon: LucideIcon; warn: boolean }) {
  return (
    <span
      aria-hidden
      className={cn(
        "mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg border bg-background text-muted-foreground",
        warn && "border-warning/50 text-warning",
      )}
    >
      <Icon className="size-4" />
    </span>
  );
}

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="grid gap-3">
      <div>
        <h2 className="font-semibold text-[15px] tracking-tight">{title}</h2>
        <p className="mt-0.5 text-muted-foreground text-sm">{description}</p>
      </div>
      {children}
    </section>
  );
}
