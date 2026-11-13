"use client";

import {
  type BotCapabilityView,
  type CatalogTool,
  type ToolGrant,
  TURN_CATALOG_TOOLS_MAX,
} from "@ocw/contracts";
import { ArrowUpRight, Lock, Plug, Puzzle, Wrench } from "lucide-react";
import Link from "next/link";
import { toast } from "sonner";
import { SideEffectBadge } from "@/components/mcp/mcp-tools-list";
import { Switch } from "@/components/ui/switch";
import { errorMessage } from "@/lib/api";
import { useUpdateBotCapabilities } from "@/lib/capability-queries";
import { useCan } from "@/lib/permissions";
import { cn } from "@/lib/utils";
import { reasonText } from "./capability-reason";

const grantOf = (t: Pick<CatalogTool, "sourceKind" | "sourceId" | "tool">): ToolGrant => ({
  sourceKind: t.sourceKind,
  sourceId: t.sourceId,
  tool: t.tool,
});
const keyOf = (t: ToolGrant) => `${t.sourceKind}:${t.sourceId}:${t.tool}`;

/** MCP tools are `<safeServerName>__<tool>`; people know them by the server's own name. */
export function shortToolName(t: Pick<CatalogTool, "sourceKind" | "tool">): string {
  if (t.sourceKind !== "mcp") return t.tool;
  const i = t.tool.indexOf("__");
  return i === -1 ? t.tool : t.tool.slice(i + 2);
}

export type BulkMode = "read" | "all" | "none";

/**
 * The bot's full grant set after one per-source bulk action: `read` turns on the source's read-only tools and off the
 * ones that change data, `all` turns every available tool on, `none` turns them all off. A blocked tool (a reason and
 * not granted) is never turned on; other sources keep their grants.
 */
export function bulkGrants(all: CatalogTool[], sourceTools: CatalogTool[], mode: BulkMode): ToolGrant[] {
  const inSource = new Set(sourceTools.map(keyOf));
  const others = all.filter((t) => t.granted && !inSource.has(keyOf(t))).map(grantOf);
  const on = sourceTools.filter((t) => {
    if (mode === "none") return false;
    if (t.reason !== null && !t.granted) return false;
    return mode === "all" || !t.sideEffecting;
  });
  return [...others, ...on.map(grantOf)];
}

/** A quiet text button for the per-source bulk actions. */
function BulkButton({
  onClick,
  testId,
  children,
}: {
  onClick: () => void;
  testId: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      data-testid={testId}
      className="rounded px-1.5 py-0.5 font-medium text-primary hover:bg-primary/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
    >
      {children}
    </button>
  );
}

/**
 * Per-bot tools from MCP servers and marketplace plugins (BOT-10, D-06): one switch per tool, grouped by
 * source. The API decides availability: a tool with a `reason` is disabled and explained (never hidden), and a
 * granted tool that lost its source stays visible so it can be switched off. Saving sends the full grant set.
 * `readOnly` forces every switch off for everyone (the agent page, 07.2-14); `title` names the section there.
 */
export function ToolsSection({
  view,
  readOnly: forceReadOnly = false,
  title = "Tools",
  headingLevel = 4,
}: {
  view: BotCapabilityView;
  readOnly?: boolean;
  title?: string;
  /** The title's HTML level (the look never changes): 4 in the bot sheet, 2 on the agent page. */
  headingLevel?: 2 | 3 | 4;
}) {
  const Heading = `h${headingLevel}` as const;
  const update = useUpdateBotCapabilities(view.agentId);
  const canMcp = useCan("mcp.manage");
  const canPlugins = useCan("plugin.manage");
  const readOnly = forceReadOnly || !view.viewerCan.includes("bot.configure");

  const groups: Array<{ key: string; kind: CatalogTool["sourceKind"]; name: string; tools: CatalogTool[] }> =
    [];
  for (const t of view.tools) {
    const key = `${t.sourceKind}:${t.sourceId}`;
    let g = groups.find((x) => x.key === key);
    if (!g) {
      g = { key, kind: t.sourceKind, name: t.sourceName, tools: [] };
      groups.push(g);
    }
    g.tools.push(t);
  }

  function save(tools: ToolGrant[]) {
    update.mutate(
      { tools },
      {
        onError: (err) => toast.error("Could not change the bot's tools", { description: errorMessage(err) }),
      },
    );
  }

  function toggle(tool: CatalogTool, on: boolean) {
    const others = view.tools.filter((t) => t.granted && keyOf(t) !== keyOf(tool)).map(grantOf);
    save(on ? [...others, grantOf(tool)] : others);
  }

  function setSource(sourceTools: CatalogTool[], mode: BulkMode) {
    save(bulkGrants(view.tools, sourceTools, mode));
  }

  return (
    <section className="grid gap-2" data-testid="tools-section" aria-labelledby={`tools-${view.agentId}`}>
      <div className="flex items-baseline justify-between gap-2">
        <Heading id={`tools-${view.agentId}`} className="font-medium text-sm">
          {title}
        </Heading>
        {groups.length > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {view.tools.filter((t) => t.effective).length} of {view.tools.length} on
          </span>
        ) : null}
      </div>

      {(view.toolsOverLimit ?? 0) > 0 ? (
        <p
          className="flex items-start gap-2 rounded-lg border border-warning/40 bg-warning/8 px-3 py-2 text-foreground/85 text-xs leading-snug"
          data-testid="tools-over-limit"
          role="status"
        >
          <Lock className="mt-px size-3.5 shrink-0 text-warning" aria-hidden />
          <span>
            {view.toolsOverLimit === 1
              ? "1 tool that is on does not fit in a bot turn, so the bot cannot use it."
              : `${view.toolsOverLimit} tools that are on do not fit in a bot turn, so the bot cannot use them.`}{" "}
            A turn carries at most {TURN_CATALOG_TOOLS_MAX} tools from MCP servers and plugins, so the
            platform's own tools always fit. Turn off the ones this bot does not need.
          </span>
        </p>
      ) : null}

      {groups.length === 0 ? (
        <p
          className="flex items-start gap-2.5 rounded-lg border border-dashed px-3 py-3 text-muted-foreground text-xs leading-snug"
          data-testid="tools-empty"
        >
          <Wrench className="mt-px size-3.5 shrink-0" aria-hidden />
          No tools yet — an admin can add MCP servers or marketplace plugins.
        </p>
      ) : (
        groups.map((g) => {
          const Icon = g.kind === "mcp" ? Plug : Puzzle;
          // One reason for the whole source (e.g. off for personal bots) reads once, above its tools.
          const first = g.tools[0]?.reason ?? null;
          const sourceReason =
            first && first !== "dangerous" && g.tools.every((t) => t.reason === first && !t.granted)
              ? first
              : null;
          const manageHref =
            g.kind === "mcp"
              ? canMcp
                ? "/settings/mcp-servers"
                : null
              : canPlugins
                ? "/settings/marketplace"
                : null;
          return (
            <div
              key={g.key}
              className="overflow-hidden rounded-lg border bg-card"
              data-testid="tool-source"
              data-source={g.name}
            >
              <div className="flex items-center gap-2.5 border-b bg-muted/30 px-3 py-2">
                <Icon className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                <span className="min-w-0 flex-1 truncate font-medium text-[13px]">{g.name}</span>
                <span className="shrink-0 text-[11px] text-muted-foreground">
                  {g.kind === "mcp" ? "MCP server" : "Plugin"}
                </span>
                {manageHref ? (
                  <Link
                    href={manageHref}
                    className="inline-flex shrink-0 items-center gap-0.5 text-[11px] text-primary hover:underline"
                  >
                    Manage <ArrowUpRight className="size-3" aria-hidden />
                  </Link>
                ) : null}
              </div>
              {!readOnly && !sourceReason && g.tools.length > 1 ? (
                <fieldset
                  className="flex flex-wrap items-center gap-x-1 gap-y-1 border-b px-3 py-1.5 text-xs"
                  data-testid="tool-source-bulk"
                  disabled={update.isPending}
                >
                  <legend className="sr-only">Turn on several {g.name} tools at once</legend>
                  <span className="mr-1 text-muted-foreground">Turn on:</span>
                  <BulkButton onClick={() => setSource(g.tools, "read")} testId="tools-bulk-read">
                    Read-only tools
                  </BulkButton>
                  <BulkButton onClick={() => setSource(g.tools, "all")} testId="tools-bulk-all">
                    All, including changes
                  </BulkButton>
                  <span className="mx-1 text-muted-foreground" aria-hidden>
                    ·
                  </span>
                  <BulkButton onClick={() => setSource(g.tools, "none")} testId="tools-bulk-none">
                    Turn all off
                  </BulkButton>
                </fieldset>
              ) : null}
              {sourceReason ? (
                <p
                  className="flex items-start gap-1.5 border-b bg-warning/8 px-3 py-2 text-foreground/85 text-xs leading-snug"
                  data-testid="tool-source-reason"
                >
                  <Lock className="mt-px size-3 shrink-0 text-warning" aria-hidden />
                  {reasonText(sourceReason)}
                </p>
              ) : null}
              <ul className="divide-y">
                {g.tools.map((t) => {
                  const name = shortToolName(t);
                  const blocked = t.reason !== null && !t.granted;
                  const id = `tool-${view.agentId}-${t.sourceId}-${t.tool}`;
                  return (
                    <li
                      key={t.tool}
                      className="flex items-start gap-3 px-3 py-2.5"
                      data-testid="tool-row"
                      data-tool={t.tool}
                    >
                      {/* A blocked tool reads quieter through its name only: dimming the whole row put its badge and
                          description under AA contrast (axe, 07.5-15 full gate). The lock line and the disabled switch
                          say why. */}
                      <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <label
                            htmlFor={id}
                            className={cn(
                              "font-medium font-mono text-[13px]",
                              blocked && "text-muted-foreground",
                            )}
                          >
                            {name}
                          </label>
                          <SideEffectBadge sideEffecting={t.sideEffecting} />
                        </div>
                        {t.title || t.description ? (
                          <p className="mt-0.5 line-clamp-2 text-muted-foreground text-xs leading-snug">
                            {t.description ?? t.title}
                          </p>
                        ) : null}
                        {t.reason && !sourceReason ? (
                          <span
                            className="mt-1.5 inline-flex max-w-full items-start gap-1.5 rounded-md bg-warning/12 px-2 py-1 text-foreground/85 text-xs leading-snug"
                            data-testid="tool-reason"
                          >
                            <Lock className="mt-px size-3 shrink-0 text-warning" aria-hidden />
                            <span>
                              {t.granted ? "On, but unavailable: " : ""}
                              {reasonText(t.reason)}
                            </span>
                          </span>
                        ) : null}
                      </div>
                      <Switch
                        id={id}
                        checked={t.granted}
                        onCheckedChange={(v) => toggle(t, v)}
                        disabled={readOnly || blocked || update.isPending}
                        aria-label={`Enable ${name}`}
                        data-testid="tool-switch"
                        className="mt-0.5"
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
          );
        })
      )}
    </section>
  );
}
