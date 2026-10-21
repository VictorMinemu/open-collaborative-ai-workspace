"use client";

import type { ApprovalToolSourceKind, ToolApprovalMode, ToolCallApprovalView } from "@ocw/contracts";
import {
  ArrowRight,
  Container,
  Globe,
  KeyRound,
  type LucideIcon,
  MonitorPlay,
  Package,
  Plug,
  TriangleAlert,
  UserCheck,
  Users,
} from "lucide-react";
import Link from "next/link";
import type { ReactNode } from "react";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { ArgumentsView } from "./arguments-view";
import { UntrustedText, untrustedNodes } from "./untrusted-text";

/**
 * The body of an action review (Phase 07.5, D-02, APPROVE-02, UI-SPEC Surface 2 "Review pane", R7): a fact strip that
 * says in seconds who approves, how many people can see the details and whether the bot read outside content; the
 * ACTION (tool, source and whose account, target, where it was asked with the audience size and a link to the card,
 * and why a person is needed, in words); WHAT {BOT} WILL SEND in the server's order; and ALL ARGUMENTS, the exact
 * canonical JSON approval binds to. Every value the bot wrote goes through `UntrustedText` (T-07.5-13-01) and is shown
 * as the server gave it, masked and revealed (T-07.5-13-04). The header, footer and dialogs live in
 * `approval-review.tsx`.
 */

const SAFE_PREFIX = /^m[0-9a-f]{8}__(?=.)/;

/** `m1a2b3c4d__create_invoice` → `create_invoice` (the server shows the server name in Source). */
export function shortToolName(tool: string): string {
  return tool.replace(SAFE_PREFIX, "");
}

/**
 * The host and path the call reaches, or null. For an MCP tool the stored target is the server's internal safe name
 * (the `<safe>__` prefix of the tool), which names no place a person can check: it is not shown as a Target.
 */
export function targetOf(view: Pick<ToolCallApprovalView, "target" | "tool">): string | null {
  const t = view.target;
  if (!t) return null;
  return view.tool.startsWith(`${t}__`) ? null : t;
}

const own = (view: Pick<ToolCallApprovalView, "requestedFor">, meId: string | null) =>
  meId !== null && view.requestedFor.id === meId;

/** "Acme CRM · MCP server", "Acme CRM · your account", "notes · plugin", "Web request · Keychain key CRM key". */
export function sourceText(view: ToolCallApprovalView, meId: string | null): string {
  const s = view.source;
  switch (s.kind) {
    case "connector":
      if (s.account === "requester") {
        return `${s.name} · ${own(view, meId) ? "your" : `${view.requestedFor.displayName}'s`} account`;
      }
      return `${s.name} · connector`;
    case "plugin":
      return `${s.name} · plugin`;
    case "http":
      return s.keyName ? `${s.name} · Keychain key ${s.keyName}` : s.name;
    // 07.8-14: the bot's own sandbox or browser ("Sandbox", "Browser"), never "Web request".
    case "sandbox":
    case "browser":
      return s.name;
    default:
      return `${s.name} · MCP server`;
  }
}

const SOURCE_ICON: Record<ApprovalToolSourceKind, LucideIcon> = {
  mcp: Plug,
  connector: Plug,
  plugin: Package,
  http: Globe,
  sandbox: Container,
  browser: MonitorPlay,
};

const people = (n: number, verb: [string, string]) =>
  n === 1 ? `1 person ${verb[0]}` : `${n} people ${verb[1]}`;

/** "your DM with Scout · only you see this card", "# ops · 24 people see a summary card" (UI-SPEC "Audience"). */
export function askedInText(view: ToolCallApprovalView, meId: string | null): string {
  const { origin, conversationReaders: n } = view.audience;
  const mine = own(view, meId);
  const bot = view.agent.displayName;
  const requester = view.requestedFor.displayName;
  if (origin.kind === "dm") {
    const where = mine ? `your DM with ${bot}` : `${requester}'s DM with ${bot}`;
    const who =
      n <= 1
        ? mine
          ? "only you see this card"
          : `only ${requester} sees this card`
        : people(n, ["sees this card", "see this card"]);
    return `${where} · ${who}`;
  }
  let where: string;
  switch (origin.kind) {
    case "group":
      where = "a group DM";
      break;
    case "ai_chat":
      where = origin.name ? `the AI chat ${origin.name}` : "an AI chat";
      break;
    case "thread":
      where = origin.name ? `a thread in # ${origin.name}` : "a thread";
      break;
    default:
      where = origin.name ? `# ${origin.name}` : "a channel";
  }
  return `${where} · ${people(n, ["sees a summary card", "see a summary card"])}`;
}

const MODE_LABEL: Record<ToolApprovalMode, string> = {
  always: "Always ask",
  when_tainted: "Ask after outside content",
  never: "Never ask",
};

/** "Organization rule: Always ask for write_note", "Sales rule: Ask after outside content for all Acme CRM tools". */
export function whyText(view: Pick<ToolCallApprovalView, "policy" | "source">): string {
  const p = view.policy;
  if (!p) return "No rule asks for this any more.";
  const what = p.pattern.endsWith("__*") ? `all ${view.source.name} tools` : shortToolName(p.pattern);
  return `${p.scopeLabel} rule: ${MODE_LABEL[p.mode]} for ${what}`;
}

/**
 * Who approves, from the server's waiting label ("Waiting for a lead of Sales" → "Leads of Sales"; the viewer's own
 * name → "You"), for the fact strip's "{who} · approve this".
 */
export function approvalWho(
  view: Pick<ToolCallApprovalView, "approverLabel" | "requestedFor">,
  meId: string | null,
): string {
  const label = view.approverLabel;
  if (!label.startsWith("Waiting for ")) return label.startsWith("No one") ? "No one" : label;
  const rest = label.slice("Waiting for ".length);
  const person = /^(.*) to approve$/.exec(rest)?.[1];
  if (person !== undefined) {
    return person === view.requestedFor.displayName && own(view, meId) ? "You" : person;
  }
  const lead = /^a lead of (.*)$/.exec(rest)?.[1];
  if (lead !== undefined) return `Leads of ${lead}`;
  if (rest === "an admin") return "Admins";
  return rest;
}

/** What follows "Waiting for " in the server's label (the footer's waiting line), or null for a label without it. */
export function waitingFor(view: Pick<ToolCallApprovalView, "approverLabel">): string | null {
  return view.approverLabel.startsWith("Waiting for ")
    ? view.approverLabel.slice("Waiting for ".length)
    : null;
}

// ---------------------------------------------------------------- pieces

const SECTION_TITLE = "font-semibold text-muted-foreground text-xs uppercase tracking-wider";

function FactCell({
  icon: Icon,
  term,
  value,
  detail,
  testId,
  warning,
}: {
  icon: LucideIcon;
  /** The cell's name for assistive tech: the `<dt>`, which carries the glyph. */
  term: string;
  value: ReactNode;
  detail: ReactNode;
  testId: string;
  warning?: boolean;
}) {
  // A `<dl>` group holds only `<dt>`/`<dd>` (axe definition-list): the glyph sits in the `<dt>` with the hidden term.
  return (
    <div
      data-testid={testId}
      className={cn(
        "grid min-w-0 grid-cols-[1rem_minmax(0,1fr)] content-start gap-x-3 gap-y-0.5 rounded-lg border p-4 shadow-xs dark:shadow-none max-sm:flex max-sm:min-h-14 max-sm:flex-wrap max-sm:content-center max-sm:items-baseline max-sm:gap-x-1.5 max-sm:py-2",
        warning
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
          : "bg-card",
      )}
    >
      <dt className="row-span-2 pt-0.5 max-sm:mr-1.5 max-sm:self-center max-sm:pt-0">
        <Icon aria-hidden className={cn("size-4", warning ? "text-current" : "text-muted-foreground")} />
        <span className="sr-only">{term}</span>
      </dt>
      <dd className="min-w-0 break-words font-semibold text-sm">{value}</dd>
      <dd className={cn("min-w-0 break-words text-xs", warning ? "text-current" : "text-muted-foreground")}>
        {detail}
      </dd>
    </div>
  );
}

/** One row of a field list: label over value on phones, label left from 640 (UI-SPEC "Field list"). */
function Field({ label, children, testId }: { label: ReactNode; children: ReactNode; testId?: string }) {
  return (
    <div data-testid={testId} className="grid min-w-0 gap-0.5 sm:grid-cols-[7.5rem_minmax(0,1fr)] sm:gap-x-3">
      <dt className="min-w-0 break-words pt-px text-muted-foreground text-xs leading-5">{label}</dt>
      <dd className="min-w-0 break-words text-sm">{children}</dd>
    </div>
  );
}

/** A value with a line break or over 160 characters reads as a block; over 1,000 characters it clamps at 20 lines. */
function PreviewValue({ value }: { value: string }) {
  const block = value.includes("\n") || value.length > 160;
  if (!block) return <UntrustedText text={value} data-testid="preview-value" />;
  return (
    <div data-block="true" className="rounded-lg bg-muted/50 px-3 py-2 text-sm dark:bg-white/[0.03]">
      <UntrustedText
        text={value}
        clampLines={value.length > 1000 ? 20 : undefined}
        data-testid="preview-value"
      />
    </div>
  );
}

function Notice({
  icon: Icon,
  tone,
  children,
}: {
  icon: LucideIcon;
  tone: "warning" | "neutral";
  children: ReactNode;
}) {
  return (
    <p
      className={cn(
        "flex items-start gap-2 rounded-lg border px-3 py-2 text-sm",
        tone === "warning"
          ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-400/25 dark:bg-amber-400/10 dark:text-amber-200"
          : "bg-muted/40 text-foreground dark:bg-white/[0.03]",
      )}
    >
      <Icon aria-hidden className="mt-0.5 size-4 shrink-0" />
      <span className="min-w-0">{children}</span>
    </p>
  );
}

// ---------------------------------------------------------------- the view

export function ToolCallView({ view, meId }: { view: ToolCallApprovalView; meId: string | null }) {
  const bot = view.agent.displayName;
  const SourceIcon = SOURCE_ICON[view.source.kind];
  const target = targetOf(view);
  const readers = view.audience.detailReaders;
  const policy = view.policy;
  const why = whyText(view);
  return (
    <div data-testid="tool-call-body" className="@container grid min-w-0 gap-6">
      <dl
        aria-label="Who decides and who sees it"
        data-testid="approval-facts"
        className={cn("grid grid-cols-1 gap-3 @md:grid-cols-2", view.tainted && "@3xl:grid-cols-3")}
      >
        <FactCell
          testId="approval-fact-approvers"
          icon={UserCheck}
          term="Who approves"
          value={approvalWho(view, meId)}
          detail="approve this"
        />
        <FactCell
          testId="approval-fact-readers"
          icon={Users}
          term="Who can see the details"
          value={
            readers <= 1 ? (
              "Only you"
            ) : (
              <>
                <span className="text-lg leading-6 tabular-nums">{readers}</span> people
              </>
            )
          }
          detail="can see the details"
        />
        {view.tainted ? (
          <FactCell
            testId="approval-fact-taint"
            icon={TriangleAlert}
            term="Content"
            value="Read outside content"
            detail="in this turn"
            warning
          />
        ) : null}
      </dl>

      <section aria-labelledby="tool-call-action" className="grid min-w-0 gap-3">
        <h2 id="tool-call-action" className={SECTION_TITLE}>
          Action
        </h2>
        <dl className="grid min-w-0 gap-2.5">
          <Field label="Tool" testId="tool-call-tool">
            <span className="break-all font-medium font-mono text-[13px]">
              {untrustedNodes(shortToolName(view.tool))}
            </span>
          </Field>
          <Field label="Source" testId="tool-call-source">
            <span className="inline-flex min-w-0 items-start gap-1.5">
              <SourceIcon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
              <span className="min-w-0 break-words">{untrustedNodes(sourceText(view, meId))}</span>
            </span>
          </Field>
          {target ? (
            <Field label="Target" testId="tool-call-target">
              <span className="break-all font-mono text-[13px]">{untrustedNodes(target)}</span>
            </Field>
          ) : null}
          <Field label="Asked in" testId="tool-call-asked-in">
            <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
              <span className="min-w-0 break-words">{askedInText(view, meId)}</span>
              {view.audience.messageRoute ? (
                <Link
                  href={view.audience.messageRoute}
                  data-testid="tool-call-open-message"
                  className={cn(
                    buttonVariants({ variant: "link", size: "sm" }),
                    "h-auto px-0 has-[>svg]:px-0 max-lg:min-h-11",
                  )}
                >
                  Open message <ArrowRight aria-hidden />
                </Link>
              ) : null}
            </span>
          </Field>
          <Field label="Why" testId="tool-call-why">
            {policy?.viewerCanManage ? (
              <Link
                href={`/settings/approval-policies?scope=${encodeURIComponent(policy.scopeUnitId ?? "org")}&tool=${encodeURIComponent(policy.pattern).replace(/%2A/g, "*")}`}
                className="inline-flex items-center rounded-sm underline decoration-muted-foreground/50 underline-offset-4 outline-none hover:decoration-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 max-lg:min-h-11"
              >
                {why}
              </Link>
            ) : (
              why
            )}
          </Field>
        </dl>
      </section>

      {view.notices.hiddenCharacters || view.notices.maskedSecret ? (
        <div className="grid gap-2" data-testid="tool-call-notices">
          {view.notices.hiddenCharacters ? (
            <Notice icon={TriangleAlert} tone="warning">
              Contains hidden characters, shown as ⟨U+…⟩.
            </Notice>
          ) : null}
          {view.notices.maskedSecret ? (
            <Notice icon={KeyRound} tone="neutral">
              A value looks like a secret and is masked.
            </Notice>
          ) : null}
        </div>
      ) : null}

      <section aria-labelledby="tool-call-send" className="grid min-w-0 gap-3">
        <h2 id="tool-call-send" className={SECTION_TITLE}>
          What {bot} will send
        </h2>
        {view.preview.length > 0 ? (
          <dl className="grid min-w-0 gap-2.5" data-testid="tool-call-preview">
            {view.preview.map((f) => (
              <Field key={f.key} label={untrustedNodes(f.label)} testId={`preview-field-${f.key}`}>
                <PreviewValue value={f.value} />
              </Field>
            ))}
          </dl>
        ) : (
          <p className="text-muted-foreground text-sm">No values.</p>
        )}
        {view.truncated ? (
          <p data-testid="tool-call-truncated" className="text-muted-foreground text-xs">
            Some values are cut here. All arguments shows them in full.
          </p>
        ) : null}
      </section>

      <ArgumentsView json={view.argumentsJson} bytes={view.argumentsBytes} />

      <p data-testid="tool-call-written-by" className="-mt-3 text-muted-foreground text-xs">
        Written by {bot}. These exact values run once if you approve.
      </p>
    </div>
  );
}
