"use client";

import {
  type AiChatPolicy,
  catalogEntry,
  isSubscriptionProvider,
  type ModelProvider,
  modelLabel,
} from "@ocw/contracts";
import { MessagesSquare, Plus, RotateCcw, Save, X } from "lucide-react";
import { type KeyboardEvent, type ReactNode, useEffect, useId, useState } from "react";
import { toast } from "sonner";
import { MeteredBadge } from "@/components/bots/provider-bits";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useAiChatPolicy, useUpdateAiChatPolicy } from "@/lib/ai-usage-queries";
import { errorMessage } from "@/lib/api";
import { useModelProviders } from "@/lib/bots-queries";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";

/**
 * Settings › Models › AI chats (05-08, D-06, AICHAT-07): the organization's AI chat policy. Who pays (the member's
 * own ChatGPT plan, organization models), per-member daily limits, answers (concurrency, context, web search) and
 * models (plan allowlist, title models). Every organization-key field carries METERED (P-11). One Save; the API
 * applies it to the next answer. Admins only (`provider.manage`); the 30-day reports follow below it (05-09).
 */
export function AiChatPolicySettings() {
  const canManage = useCan("provider.manage");
  const policy = useAiChatPolicy(canManage);
  if (!canManage) return null;
  return (
    <section
      aria-labelledby="ai-chat-policy-title"
      className="mx-auto grid w-full max-w-3xl gap-5 px-4 pb-8 sm:px-6"
      data-testid="ai-chat-policy-settings"
    >
      <div className="border-t pt-7">
        <h2
          id="ai-chat-policy-title"
          className="flex items-center gap-2 font-semibold text-[15px] tracking-tight"
        >
          <MessagesSquare aria-hidden className="size-4 text-muted-foreground" />
          AI chats
        </h2>
        <p className="mt-0.5 max-w-xl text-muted-foreground text-sm">
          How members chat with AI in this workspace. Changes apply from the next answer.
        </p>
      </div>
      {policy.isPending ? (
        <div className="grid gap-3">
          <Skeleton className="h-28 rounded-2xl" />
          <Skeleton className="h-40 rounded-2xl" />
          <Skeleton className="h-32 rounded-2xl" />
        </div>
      ) : policy.isError ? (
        <div className="rounded-xl border bg-card">
          <ServerUnreachable onRetry={() => policy.refetch()} retrying={policy.isFetching} />
        </div>
      ) : (
        <PolicyForm policy={policy.data} />
      )}
    </section>
  );
}

/** Numbers are edited as text so a field can be empty ("no limit"). */
interface Draft {
  chatgptPlanEnabled: boolean;
  orgKeysEnabled: boolean;
  orgKeyDailyGenerations: string;
  orgKeyDailyDollars: string;
  planDailyGenerations: string;
  concurrentGenerationsPerUser: string;
  maxContextTokens: string;
  webEnabled: boolean;
  planAllowedModels: string[];
  titleModels: Record<string, string>;
}

const str = (n: number | null) => (n === null ? "" : String(n));
const dollars = (micros: number | null) => (micros === null ? "" : String(micros / 1_000_000));

function toDraft(p: AiChatPolicy): Draft {
  return {
    chatgptPlanEnabled: p.chatgptPlanEnabled,
    orgKeysEnabled: p.orgKeysEnabled,
    orgKeyDailyGenerations: str(p.orgKeyDailyGenerations),
    orgKeyDailyDollars: dollars(p.orgKeyDailyCostMicros),
    planDailyGenerations: str(p.planDailyGenerations),
    concurrentGenerationsPerUser: String(p.concurrentGenerationsPerUser),
    maxContextTokens: String(p.maxContextTokens),
    webEnabled: p.webEnabled,
    planAllowedModels: [...p.planAllowedModels],
    titleModels: { ...p.titleModels },
  };
}

type Errors = Partial<Record<keyof Draft, string>>;

const MAX_GENERATIONS = 100_000;
const MAX_DOLLARS = 10_000;

/** Whole number in [min, max], or null for an empty optional field; a string is the error. */
function wholeNumber(v: string, min: number, max: number, optional: boolean): number | null | string {
  const t = v.trim();
  if (t === "")
    return optional ? null : `Enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}`;
  const n = Number(t);
  if (!Number.isInteger(n) || n < min || n > max) {
    return `Enter a whole number from ${min.toLocaleString()} to ${max.toLocaleString()}${optional ? ", or leave it empty" : ""}`;
  }
  return n;
}

/** The draft as a policy, or the field errors. */
function parse(d: Draft): { policy: AiChatPolicy } | { errors: Errors } {
  const errors: Errors = {};
  const orgKeyDailyGenerations = wholeNumber(d.orgKeyDailyGenerations, 1, MAX_GENERATIONS, true);
  const planDailyGenerations = wholeNumber(d.planDailyGenerations, 1, MAX_GENERATIONS, true);
  const concurrent = wholeNumber(d.concurrentGenerationsPerUser, 1, 10, false);
  const context = wholeNumber(d.maxContextTokens, 4_000, 1_000_000, false);
  if (typeof orgKeyDailyGenerations === "string") errors.orgKeyDailyGenerations = orgKeyDailyGenerations;
  if (typeof planDailyGenerations === "string") errors.planDailyGenerations = planDailyGenerations;
  if (typeof concurrent === "string") errors.concurrentGenerationsPerUser = concurrent;
  if (typeof context === "string") errors.maxContextTokens = context;
  let orgKeyDailyCostMicros: number | null = null;
  const money = d.orgKeyDailyDollars.trim();
  if (money !== "") {
    const usd = Number(money);
    if (!Number.isFinite(usd) || usd < 0.01 || usd > MAX_DOLLARS || !/^\d+(\.\d{1,2})?$/u.test(money)) {
      errors.orgKeyDailyDollars = `Enter an amount from $0.01 to $${MAX_DOLLARS.toLocaleString()}, or leave it empty`;
    } else {
      orgKeyDailyCostMicros = Math.round(usd * 100) * 10_000;
    }
  }
  if (Object.keys(errors).length > 0) return { errors };
  return {
    policy: {
      chatgptPlanEnabled: d.chatgptPlanEnabled,
      orgKeysEnabled: d.orgKeysEnabled,
      orgKeyDailyGenerations: orgKeyDailyGenerations as number | null,
      orgKeyDailyCostMicros,
      planDailyGenerations: planDailyGenerations as number | null,
      concurrentGenerationsPerUser: concurrent as number,
      maxContextTokens: context as number,
      webEnabled: d.webEnabled,
      planAllowedModels: d.planAllowedModels,
      titleModels: Object.fromEntries(Object.entries(d.titleModels).filter(([, v]) => v.trim() !== "")),
    },
  };
}

const same = (a: Draft, b: Draft) => JSON.stringify(a) === JSON.stringify(b);

function PolicyForm({ policy }: { policy: AiChatPolicy }) {
  const save = useUpdateAiChatPolicy();
  const providers = useModelProviders();
  const saved = toDraft(policy);
  const [draft, setDraft] = useState<Draft>(saved);
  const [errors, setErrors] = useState<Errors>({});
  const dirty = !same(draft, saved);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [dirty]);

  const set = <K extends keyof Draft>(key: K, value: Draft[K]) => {
    setDraft((d) => ({ ...d, [key]: value }));
    setErrors((e) => ({ ...e, [key]: undefined }));
  };

  /** An emptied title model drops its key, so clearing a field brings back "no changes". */
  const setTitle = (key: string, value: string) => {
    const { [key]: _old, ...rest } = draft.titleModels;
    set("titleModels", value.trim() === "" ? rest : { ...rest, [key]: value });
  };

  async function submit() {
    const parsed = parse(draft);
    if ("errors" in parsed) {
      setErrors(parsed.errors);
      return;
    }
    try {
      const updated = await save.mutateAsync(parsed.policy);
      setDraft(toDraft(updated));
      toast.success("AI chat policy saved", { description: "It applies from the next answer." });
    } catch (err) {
      toast.error("Could not save the AI chat policy", { description: errorMessage(err) });
    }
  }

  // API-key providers that can answer AI chats (subscriptions are for bots only).
  const keyProviders: ModelProvider[] = (providers.data?.providers ?? []).filter(
    (p) => !isSubscriptionProvider(p.provider) && p.hasKey && p.allowedModels.length > 0,
  );

  return (
    <div className="grid gap-4">
      <Card title="Who pays">
        <ToggleRow
          label="Members' own ChatGPT plan"
          description="Each member signs in with ChatGPT. It never costs the organization."
          checked={draft.chatgptPlanEnabled}
          onChange={(v) => set("chatgptPlanEnabled", v)}
          testId="ai-policy-chatgptPlanEnabled"
        />
        <ToggleRow
          label="Organization models"
          metered
          description="Answers on the API keys above, billed to your organization."
          checked={draft.orgKeysEnabled}
          onChange={(v) => set("orgKeysEnabled", v)}
          testId="ai-policy-orgKeysEnabled"
        />
      </Card>

      <Card
        title="Daily limits per member"
        description="Counted per UTC day. Leave a field empty for no limit."
      >
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <TextField
            label="Organization models per member per day"
            metered
            hint="Answers a day, regenerations included"
            value={draft.orgKeyDailyGenerations}
            placeholder="No limit"
            inputMode="numeric"
            error={errors.orgKeyDailyGenerations}
            onChange={(v) => set("orgKeyDailyGenerations", v)}
            testId="ai-policy-orgKeyDailyGenerations"
          />
          <TextField
            label="Spend per member per day"
            metered
            hint="Estimated from published prices"
            prefix="$"
            value={draft.orgKeyDailyDollars}
            placeholder="No limit"
            inputMode="decimal"
            error={errors.orgKeyDailyDollars}
            onChange={(v) => set("orgKeyDailyDollars", v)}
            testId="ai-policy-orgKeyDailyDollars"
          />
          <TextField
            label="ChatGPT plan answers per member per day"
            hint="Optional; the plan has its own limits"
            value={draft.planDailyGenerations}
            placeholder="No limit"
            inputMode="numeric"
            error={errors.planDailyGenerations}
            onChange={(v) => set("planDailyGenerations", v)}
            testId="ai-policy-planDailyGenerations"
          />
        </div>
      </Card>

      <Card title="Answers">
        <div className="grid gap-4 p-4 sm:grid-cols-2">
          <TextField
            label="Answers at the same time, per member"
            hint="From 1 to 10, across all their chats"
            value={draft.concurrentGenerationsPerUser}
            inputMode="numeric"
            error={errors.concurrentGenerationsPerUser}
            onChange={(v) => set("concurrentGenerationsPerUser", v)}
            testId="ai-policy-concurrentGenerationsPerUser"
          />
          <TextField
            label="Context sent to the model"
            hint="Tokens of history, from 4,000 to 1,000,000"
            suffix="tokens"
            value={draft.maxContextTokens}
            inputMode="numeric"
            error={errors.maxContextTokens}
            onChange={(v) => set("maxContextTokens", v)}
            testId="ai-policy-maxContextTokens"
          />
        </div>
        <ToggleRow
          label="Web search"
          description="Members can let an answer search the web."
          checked={draft.webEnabled}
          onChange={(v) => set("webEnabled", v)}
          testId="ai-policy-webEnabled"
        />
      </Card>

      <Card title="Models">
        <div className="grid gap-2.5 p-4">
          <div>
            <span className="block font-medium text-sm">ChatGPT plan models</span>
            <span className="block text-muted-foreground text-xs">
              Model ids members may pick on their plan. Empty: every model their plan offers.
            </span>
          </div>
          <TagInput
            values={draft.planAllowedModels}
            onChange={(v) => set("planAllowedModels", v)}
            placeholder="e.g. gpt-6-astra"
            testId="ai-policy-planAllowedModels"
          />
        </div>
        <div className="grid gap-3 p-4" data-testid="ai-policy-titleModels">
          <div>
            <span className="block font-medium text-sm">Title models</span>
            <span className="block text-muted-foreground text-xs">
              The small model that names new chats. Automatic picks the smallest one.
            </span>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <TextField
              label="ChatGPT plan"
              value={draft.titleModels.chatgpt_plan ?? ""}
              placeholder="Automatic"
              onChange={(v) => setTitle("chatgpt_plan", v)}
              testId="ai-policy-title-chatgpt_plan"
            />
            {keyProviders.map((p) => (
              <TitleModelSelect
                key={p.provider}
                provider={p}
                value={draft.titleModels[p.provider] ?? ""}
                onChange={(v) => setTitle(p.provider, v)}
              />
            ))}
          </div>
        </div>
      </Card>

      <div className="sticky bottom-0 z-10 -mx-4 flex flex-wrap items-center justify-end gap-x-3 gap-y-2 border-t bg-background/90 px-4 py-3 backdrop-blur sm:-mx-6 sm:px-6">
        {/* On a phone the two buttons keep one row; the enabled Save already says something changed. */}
        <span className="mr-auto hidden text-muted-foreground text-xs sm:inline" aria-live="polite">
          {dirty ? "Unsaved changes" : "All changes saved"}
        </span>
        <Button
          variant="outline"
          onClick={() => {
            setDraft(saved);
            setErrors({});
          }}
          disabled={!dirty || save.isPending}
        >
          <RotateCcw /> Discard
        </Button>
        <Button
          onClick={submit}
          disabled={!dirty || save.isPending}
          aria-label="Save AI chat policy"
          data-testid="ai-policy-save"
        >
          {save.isPending ? <Spinner /> : <Save />}
          Save policy
        </Button>
      </div>
    </div>
  );
}

function Card({
  title,
  description,
  children,
}: {
  title: string;
  description?: string;
  children: ReactNode;
}) {
  return (
    <div className="overflow-hidden rounded-2xl border bg-card shadow-xs">
      <div className="border-b bg-muted/30 px-4 py-2.5">
        <h3 className="font-medium text-[13px]">{title}</h3>
        {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
      </div>
      <div className="divide-y">{children}</div>
    </div>
  );
}

function ToggleRow({
  label,
  description,
  metered,
  checked,
  onChange,
  testId,
}: {
  label: string;
  description: string;
  metered?: boolean;
  checked: boolean;
  onChange: (v: boolean) => void;
  testId: string;
}) {
  return (
    // biome-ignore lint/a11y/noLabelWithoutControl: the Switch renders the control inside the label
    <label className="flex cursor-pointer items-center justify-between gap-4 px-4 py-3.5">
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
          {label}
          {metered ? <MeteredBadge /> : null}
        </span>
        <span className="block text-muted-foreground text-xs leading-snug">{description}</span>
      </span>
      <Switch checked={checked} onCheckedChange={onChange} aria-label={label} data-testid={testId} />
    </label>
  );
}

function TextField({
  label,
  hint,
  metered,
  value,
  placeholder,
  prefix,
  suffix,
  inputMode,
  error,
  onChange,
  testId,
}: {
  label: string;
  hint?: string;
  metered?: boolean;
  value: string;
  placeholder?: string;
  prefix?: string;
  suffix?: string;
  inputMode?: "numeric" | "decimal";
  error?: string | undefined;
  onChange: (v: string) => void;
  testId: string;
}) {
  const id = useId();
  return (
    <div className="grid content-start gap-1.5">
      {/* The badge follows the label's last word: a long label never leaves it alone on a line. */}
      <label htmlFor={id} className="font-medium text-sm leading-5">
        {label}
        {metered ? <MeteredBadge className="ml-1.5 align-[1px]" /> : null}
      </label>
      <div className="relative">
        {prefix ? (
          <span className="pointer-events-none absolute inset-y-0 left-3 flex items-center text-muted-foreground text-sm">
            {prefix}
          </span>
        ) : null}
        <Input
          id={id}
          type="text"
          inputMode={inputMode}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
          aria-invalid={!!error}
          aria-describedby={`${id}-help`}
          data-testid={testId}
          className={cn("h-9 w-full tabular-nums", prefix && "pl-6", suffix && "pr-16")}
        />
        {suffix ? (
          <span className="pointer-events-none absolute inset-y-0 right-3 flex items-center text-muted-foreground text-xs">
            {suffix}
          </span>
        ) : null}
      </div>
      {error || hint ? (
        <span
          id={`${id}-help`}
          className={cn("text-xs", error ? "text-destructive" : "text-muted-foreground")}
        >
          {error ?? hint}
        </span>
      ) : null}
    </div>
  );
}

const AUTOMATIC = "__automatic__";

function TitleModelSelect({
  provider,
  value,
  onChange,
}: {
  provider: ModelProvider;
  value: string;
  onChange: (v: string) => void;
}) {
  const label = catalogEntry(provider.provider)?.label ?? provider.provider;
  const items = [
    { value: AUTOMATIC, label: "Automatic" },
    ...provider.allowedModels.map((m) => ({ value: m, label: modelLabel(provider.provider, m) })),
  ];
  return (
    <div className="grid content-start gap-1.5">
      <span className="flex flex-wrap items-center gap-1.5 font-medium text-sm">
        {label}
        <MeteredBadge />
      </span>
      <Select
        items={items}
        value={value || AUTOMATIC}
        onValueChange={(v) => onChange(!v || v === AUTOMATIC ? "" : v)}
      >
        <SelectTrigger
          aria-label={`Title model for ${label}`}
          data-testid={`ai-policy-title-${provider.provider}`}
        />
        <SelectContent>
          {items.map((i) => (
            <SelectItem key={i.value} value={i.value}>
              {i.label}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

/** Model ids as removable chips; Enter or comma adds what was typed. */
function TagInput({
  values,
  onChange,
  placeholder,
  testId,
}: {
  values: string[];
  onChange: (v: string[]) => void;
  placeholder: string;
  testId: string;
}) {
  const [text, setText] = useState("");
  const add = () => {
    const parts = text
      .split(/[\s,]+/u)
      .map((p) => p.trim())
      .filter((p) => /^[A-Za-z0-9._:/-]{1,100}$/u.test(p));
    if (parts.length > 0) onChange([...new Set([...values, ...parts])].slice(0, 50));
    setText("");
  };
  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      add();
    } else if (e.key === "Backspace" && text === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  };
  return (
    <div className="grid gap-2" data-testid={testId}>
      {values.length > 0 ? (
        <ul className="flex flex-wrap gap-1.5">
          {values.map((v) => (
            <li
              key={v}
              className="inline-flex h-7 items-center gap-1 rounded-full border bg-background pr-1 pl-2.5 font-mono text-[12px]"
            >
              {v}
              <button
                type="button"
                aria-label={`Remove ${v}`}
                onClick={() => onChange(values.filter((x) => x !== v))}
                className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-muted-foreground text-xs">Every plan model is allowed.</p>
      )}
      <div className="flex gap-2">
        <Input
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={placeholder}
          aria-label="Add a ChatGPT plan model id"
          className="h-9 flex-1 font-mono text-[13px] sm:max-w-xs"
        />
        <Button type="button" variant="outline" onClick={add} disabled={text.trim() === ""}>
          <Plus /> Add
        </Button>
      </div>
    </div>
  );
}
