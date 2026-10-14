"use client";

import {
  type Agent,
  type AgentTemplate,
  type AgentTemplatePreview,
  type AgentTemplateSkip,
  type ConnectionStatus,
  modelLabel,
} from "@ocw/contracts";
import {
  Archive,
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  LayoutTemplate,
  MoreHorizontal,
  Pencil,
  Plus,
  TriangleAlert,
  X,
} from "lucide-react";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { ServerUnreachable } from "@/components/common/server-unreachable";
import { Button } from "@/components/ui/button";
import {
  DialogContent as ConfirmContent,
  DialogDescription as ConfirmDescription,
  Dialog as ConfirmDialog,
  DialogFooter as ConfirmFooter,
  DialogHeader as ConfirmHeader,
  DialogTitle as ConfirmTitle,
} from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import {
  shortTool,
  useAgentTemplates,
  useInstantiateTemplate,
  useTemplatePreview,
  useUpdateTemplate,
} from "@/lib/agent-template-queries";
import { errorMessage, isApiError } from "@/lib/api";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { SheetSection } from "./bot-form";
import { TemplateEditorSheet } from "./template-editor-sheet";

/** `{unit} · v{n}` / `Organization · v{n}`. */
export const templateMeta = (t: AgentTemplate) => `${t.unitName ?? "Organization"} · v${t.currentVersion}`;

/** The 07.4-UI-SPEC skip sentences. */
export function skipText(s: AgentTemplateSkip, t: AgentTemplate | null): string {
  switch (s.reason) {
    case "not_personal_allowed":
      return s.kind === "capability"
        ? `${s.id === "internet" ? "Internet" : "Memory"} isn't allowed for personal agents.`
        : `${shortTool(s.id)} isn't allowed for personal agents.`;
    case "vault_denied":
      return "You can't use one of the template's unit keys.";
    case "model_not_allowed": {
      const [provider, ...rest] = s.id.split("/");
      const label = t
        ? modelLabel(t.latest.modelProvider, t.latest.modelId)
        : `${provider}/${rest.join("/")}`;
      return `${label} isn't allowed for personal agents; it uses the workspace default instead.`;
    }
    case "clamped":
      return "Daily limit lowered to the workspace maximum.";
  }
}

const STATUS: Record<ConnectionStatus, { label: string; icon: typeof CircleCheck; className: string }> = {
  not_connected: { label: "Not connected", icon: CircleDashed, className: "bg-muted text-muted-foreground" },
  connected: {
    label: "Connected",
    icon: CircleCheck,
    className: "bg-emerald-100 text-emerald-800 dark:bg-emerald-400/15 dark:text-emerald-300",
  },
  needs_reconnect: {
    label: "Needs reconnect",
    icon: CircleAlert,
    className: "bg-amber-100 text-amber-800 dark:bg-amber-400/15 dark:text-amber-300",
  },
};

/** Connection state pill (UI-SPEC § Color › Connection state): text always written out. */
export function ConnectionPill({ status }: { status: ConnectionStatus }) {
  const s = STATUS[status];
  const Icon = s.icon;
  return (
    <span
      className={cn(
        "inline-flex h-6 shrink-0 items-center gap-1.5 rounded-full px-2.5 font-semibold text-xs",
        s.className,
      )}
    >
      <Icon className="size-3.5" aria-hidden />
      {s.label}
    </span>
  );
}

/** The required connectors of a template with the viewer's own status and a Connect link (Start dialog, detail sheet). */
export function ConnectorRows({
  connectors,
}: {
  connectors: Array<{ serverId: string; name: string; status: ConnectionStatus }>;
}) {
  return (
    <ul className="grid divide-y rounded-lg border" aria-label="Connections">
      {connectors.map((c) => (
        <li
          key={c.serverId}
          className="flex flex-wrap items-center gap-x-3 gap-y-1 px-3 py-2 text-sm md:min-h-11"
        >
          <span className="min-w-0 basis-full truncate font-medium sm:flex-1 sm:basis-auto">{c.name}</span>
          <ConnectionPill status={c.status} />
          {c.status !== "connected" ? (
            <Link
              href={`/settings/connections?connector=${c.serverId}`}
              className="ml-auto inline-flex min-h-11 items-center gap-1 font-medium text-primary text-sm hover:underline sm:ml-0 md:min-h-0"
              aria-label={`Connect ${c.name}`}
            >
              Connect <ExternalLink className="size-3.5" aria-hidden />
            </Link>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

function TemplateTile() {
  return (
    <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-brand-soft text-brand-soft-foreground">
      <LayoutTemplate className="size-4" aria-hidden />
    </span>
  );
}

/**
 * Bots › Templates (07.4-UI-SPEC § 4): the templates the caller may see, below the bots grid. Members start their own
 * agent from one (Start dialog: preview first); members see no section when there are no templates.
 */
export function TemplatesSection({ onStarted }: { onStarted: (agent: Agent) => void }) {
  const templates = useAgentTemplates();
  const canCreatePersonal = useCan("bot.create_personal");
  const [starting, setStarting] = useState<AgentTemplate | null>(null);
  const [editing, setEditing] = useState<AgentTemplate | "new" | null>(null);
  const [archiving, setArchiving] = useState<AgentTemplate | null>(null);

  const list = templates.data?.templates ?? [];
  const manageable = templates.data?.manageableUnits ?? [];
  if (templates.isSuccess && list.length === 0 && manageable.length === 0) return null;

  return (
    <section
      data-testid="templates-section"
      aria-labelledby="templates-heading"
      className="px-4 pt-2 pb-6 sm:px-6 sm:pb-8"
    >
      <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
        <div className="min-w-0">
          <h2 id="templates-heading" className="font-semibold text-[15px] tracking-tight">
            Templates
          </h2>
          <p className="mt-0.5 text-muted-foreground text-sm">
            Start your own agent from a template your team keeps up to date.
          </p>
        </div>
        {manageable.length > 0 ? (
          <Button
            variant="outline"
            onClick={() => setEditing("new")}
            data-testid="template-new"
            className="w-full sm:w-auto max-md:h-11"
          >
            <Plus /> New template
          </Button>
        ) : null}
      </div>

      {templates.isPending ? (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3 2xl:grid-cols-4">
          {[0, 1, 2].map((i) => (
            <div key={i} className="rounded-2xl border bg-card p-4">
              <div className="flex gap-3">
                <Skeleton className="size-9 rounded-lg" />
                <div className="flex-1 space-y-2">
                  <Skeleton className="h-4 w-28" />
                  <Skeleton className="h-3 w-20" />
                </div>
              </div>
              <Skeleton className="mt-4 h-3 w-full" />
              <Skeleton className="mt-4 h-9 w-full rounded-md" />
            </div>
          ))}
        </div>
      ) : templates.isError ? (
        <ServerUnreachable onRetry={() => templates.refetch()} retrying={templates.isFetching} />
      ) : list.length === 0 ? (
        <div className="mt-3 rounded-2xl border border-dashed px-6 py-12 text-center">
          <p className="font-semibold text-sm">No templates yet</p>
          <p className="mt-1 text-muted-foreground text-sm">
            Publish one so people in your units can start their own agent in two clicks.
          </p>
          <Button onClick={() => setEditing("new")} variant="outline" className="mt-4 max-md:h-11">
            <Plus /> New template
          </Button>
        </div>
      ) : (
        <div className="mt-3 grid gap-3 sm:grid-cols-2 sm:gap-4 xl:grid-cols-3 2xl:grid-cols-4">
          {list.map((t) => (
            <TemplateCard
              key={t.id}
              template={t}
              canStart={canCreatePersonal}
              onStart={() => setStarting(t)}
              onEdit={() => setEditing(t)}
              onArchive={() => setArchiving(t)}
            />
          ))}
        </div>
      )}

      <StartTemplateDialog
        template={starting}
        onClose={() => setStarting(null)}
        onStarted={(agent) => {
          setStarting(null);
          onStarted(agent);
        }}
      />
      <TemplateEditorSheet
        open={editing !== null}
        template={editing === "new" ? null : editing}
        manageableUnits={manageable}
        onClose={() => setEditing(null)}
      />
      <ArchiveTemplateDialog template={archiving} onClose={() => setArchiving(null)} />
    </section>
  );
}

function TemplateCard({
  template: t,
  canStart,
  onStart,
  onEdit,
  onArchive,
}: {
  template: AgentTemplate;
  canStart: boolean;
  onStart: () => void;
  onEdit: () => void;
  onArchive: () => void;
}) {
  const titleId = `template-${t.id}-title`;
  return (
    <article
      aria-labelledby={titleId}
      data-testid="template-card"
      data-template-id={t.id}
      className="flex min-w-0 flex-col rounded-2xl border bg-card p-4 shadow-xs"
    >
      <div className="flex items-start gap-3">
        <TemplateTile />
        <div className="min-w-0 flex-1">
          <h3 id={titleId} className="truncate font-semibold text-sm">
            {t.name}
          </h3>
          <p className="mt-0.5 truncate text-muted-foreground text-xs" data-testid="template-meta">
            {templateMeta(t)}
          </p>
        </div>
        {t.canManage ? (
          <DropdownMenu>
            <DropdownMenuTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="-my-1 -mr-1 shrink-0 text-muted-foreground max-md:-my-2.5 max-md:-mr-2.5 max-md:size-11"
                  aria-label={`${t.name} actions`}
                  data-testid="template-menu"
                />
              }
            >
              <MoreHorizontal />
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              <DropdownMenuItem onClick={onEdit} data-testid="template-edit" className="max-md:min-h-11">
                <Pencil /> Edit…
              </DropdownMenuItem>
              <DropdownMenuItem
                onClick={onArchive}
                data-testid="template-archive"
                className="max-md:min-h-11"
              >
                <Archive /> Archive…
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        ) : null}
      </div>
      {t.description ? (
        <p className="mt-3 line-clamp-2 text-muted-foreground text-sm">{t.description}</p>
      ) : null}
      {t.requiredConnectors.length > 0 ? (
        <p className="mt-2 text-muted-foreground text-xs" data-testid="template-needs">
          Needs {t.requiredConnectors.map((c) => c.name).join(", ")}
        </p>
      ) : null}
      <div className="mt-auto pt-4">
        {canStart ? (
          <Button
            variant="outline"
            className="w-full max-md:h-11"
            onClick={onStart}
            aria-label={`Start from template ${t.name}`}
            data-testid={`template-start-${t.id}`}
          >
            Start from template
          </Button>
        ) : (
          <p className="text-muted-foreground text-xs">You can't create personal agents in this workspace.</p>
        )}
      </div>
    </article>
  );
}

function abilitiesLine(t: AgentTemplate, preview: AgentTemplatePreview): string {
  const caps = t.latest.capabilities;
  const denied = (id: string) =>
    preview.skipped.some(
      (s) => s.kind === "capability" && s.id === id && s.reason === "not_personal_allowed",
    );
  const memory = caps.memory && !denied("memory");
  const internet = caps.internet && !denied("internet");
  const limit = caps.dailyLimit === null ? "No daily limit" : `${caps.dailyLimit} replies a day`;
  const clamped = preview.skipped.some((s) => s.kind === "capability" && s.id === "dailyLimit");
  return [
    `Memory ${memory ? "on" : "off"}`,
    `Internet ${internet ? "on" : "off"}`,
    clamped ? "Daily limit at the workspace maximum" : limit,
  ].join(" · ");
}

/** Start from template (`template-start-dialog`): the preview loads first; Create is disabled until it has. */
export function StartTemplateDialog({
  template,
  onClose,
  onStarted,
}: {
  template: AgentTemplate | null;
  onClose: () => void;
  onStarted: (agent: Agent) => void;
}) {
  const [shown, setShown] = useState<AgentTemplate | null>(template);
  if (template && template !== shown) setShown(template);
  const t = template ?? shown;
  const preview = useTemplatePreview(template?.id ?? null);
  const start = useInstantiateTemplate();
  const [name, setName] = useState("");
  const [archived, setArchived] = useState(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reset when another template is opened
  useEffect(() => {
    setName(template?.name ?? "");
    setArchived(false);
    start.reset();
  }, [template?.id]);

  const p = preview.data;
  const skippedTools = new Set(p?.skipped.filter((s) => s.kind === "tool").map((s) => s.id) ?? []);
  const tools = t ? t.latest.toolGrants.filter((g) => !skippedTools.has(g.toolName)) : [];
  const modelSkipped = p?.skipped.some((s) => s.kind === "model") ?? false;
  const blocked = !p || p.capReached || archived;

  function create() {
    if (!t || blocked) return;
    start.mutate(
      { id: t.id, body: name.trim() && name.trim() !== t.name ? { name: name.trim() } : {} },
      {
        onSuccess: (res) => {
          toast.success(`${res.agent.name} is ready`);
          onStarted(res.agent);
        },
        onError: (err) => {
          if (isApiError(err, 409) && err.code === "template_archived") setArchived(true);
          else if (!(isApiError(err, 409) && err.code === "personal_bot_limit")) {
            toast.error("Could not create your agent", { description: errorMessage(err) });
          }
          void preview.refetch();
        },
      },
    );
  }

  return (
    <Dialog open={template !== null} onOpenChange={(o) => !o && onClose()}>
      <DialogContent className="sm:max-w-lg" showClose={false} data-testid="template-start-dialog">
        <DialogHeader>
          <DialogClose
            render={
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="Close"
                className="absolute top-3 right-3 text-muted-foreground max-md:size-11"
              />
            }
          >
            <X />
          </DialogClose>
          <DialogTitle>Start from “{t?.name}”</DialogTitle>
          <DialogDescription>
            Creates your own personal agent. It's private to you; later template versions are offered, never
            forced.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="grid gap-6">
          <div className="grid gap-2">
            <label htmlFor="template-start-name" className="font-medium text-sm">
              Name
            </label>
            <Input
              id="template-start-name"
              value={name}
              maxLength={80}
              onChange={(e) => setName(e.target.value)}
              className="max-md:h-11"
            />
          </div>
          {preview.isPending ? (
            <div className="grid gap-2" aria-hidden>
              <Skeleton className="h-4 w-2/3" />
              <Skeleton className="h-4 w-1/2" />
              <Skeleton className="h-4 w-3/5" />
            </div>
          ) : preview.isError || !p || !t ? (
            <div role="alert" className="flex flex-wrap items-center gap-3 text-sm">
              <span>Couldn't check what this template includes.</span>
              <Button variant="outline" size="sm" onClick={() => preview.refetch()} className="max-md:h-11">
                Try again
              </Button>
            </div>
          ) : (
            <>
              <SheetSection title="Your agent gets">
                <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[7rem_1fr]">
                  <dt className="text-muted-foreground text-xs sm:pt-0.5">Model</dt>
                  <dd>
                    {modelSkipped
                      ? "Workspace default"
                      : modelLabel(t.latest.modelProvider, t.latest.modelId)}
                  </dd>
                  <dt className="text-muted-foreground text-xs sm:pt-0.5">Abilities</dt>
                  <dd>{abilitiesLine(t, p)}</dd>
                  <dt className="text-muted-foreground text-xs sm:pt-0.5">Tools</dt>
                  <dd className="break-words font-mono text-xs sm:pt-0.5">
                    {tools.length ? tools.map((g) => shortTool(g.toolName)).join(", ") : "None"}
                  </dd>
                </dl>
              </SheetSection>
              {p.skipped.length > 0 ? (
                <SheetSection title="Not included">
                  <ul className="grid gap-1.5 text-sm" data-testid="template-skipped">
                    {p.skipped.map((s) => (
                      <li key={`${s.kind}:${s.id}`} className="flex items-start gap-2">
                        <CircleSlash className="mt-0.5 size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                        <span>{skipText(s, t)}</span>
                      </li>
                    ))}
                  </ul>
                </SheetSection>
              ) : null}
              {p.requiredConnectors.length > 0 ? (
                <SheetSection title="Connect to use all of it">
                  <ConnectorRows connectors={p.requiredConnectors} />
                </SheetSection>
              ) : null}
            </>
          )}
          {p?.capReached ? (
            <p
              role="note"
              data-testid="template-cap-reached"
              className="flex items-start gap-2 rounded-lg border border-warning/30 bg-warning/8 px-3 py-2 text-sm"
            >
              <TriangleAlert className="mt-0.5 size-4 shrink-0 text-warning" aria-hidden />
              You already have {p.limit} personal bots (the limit is {p.limit}).
            </p>
          ) : null}
          {archived ? (
            <p role="alert" className="text-destructive text-sm" data-testid="template-archived">
              This template was archived.
            </p>
          ) : null}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} className="max-md:h-11">
            Cancel
          </Button>
          <Button
            onClick={create}
            disabled={blocked || start.isPending}
            className="max-md:h-11"
            data-testid="template-create"
          >
            {start.isPending ? <Spinner /> : null}
            Create my agent
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** Archive confirmation (07.4-UI-SPEC R9): reversible server-side, so the confirm button is outline, not red. */
function ArchiveTemplateDialog({
  template,
  onClose,
}: {
  template: AgentTemplate | null;
  onClose: () => void;
}) {
  const archive = useUpdateTemplate();
  const cancelRef = useRef<HTMLButtonElement>(null);
  const [shown, setShown] = useState<AgentTemplate | null>(template);
  if (template && template !== shown) setShown(template);
  const t = template ?? shown;
  return (
    <ConfirmDialog
      open={template !== null}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          archive.reset();
        }
      }}
    >
      <ConfirmContent data-testid="template-archive-dialog" initialFocus={cancelRef}>
        <ConfirmHeader>
          <ConfirmTitle>Archive “{t?.name}”?</ConfirmTitle>
          <ConfirmDescription>
            Nobody can start new agents from it. Agents already started keep working.
          </ConfirmDescription>
        </ConfirmHeader>
        {archive.isError ? (
          <p role="alert" className="text-destructive text-sm">
            {errorMessage(archive.error)}
          </p>
        ) : null}
        <ConfirmFooter>
          <Button ref={cancelRef} variant="outline" onClick={onClose} className="max-md:h-11">
            Cancel
          </Button>
          <Button
            variant="outline"
            disabled={archive.isPending || !t}
            className="max-md:h-11"
            data-testid="template-archive-confirm"
            onClick={() =>
              t &&
              archive.mutate(
                { id: t.id, body: { archived: true } },
                {
                  onSuccess: () => {
                    onClose();
                    toast.success(`${t.name} archived`);
                  },
                },
              )
            }
          >
            {archive.isPending ? <Spinner /> : <Archive />} Archive template
          </Button>
        </ConfirmFooter>
      </ConfirmContent>
    </ConfirmDialog>
  );
}
