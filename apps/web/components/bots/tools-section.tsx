"use client";

import type { BotCapabilityView, CatalogTool, ToolGrant } from "@ocw/contracts";
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

/**
 * Per-bot tools from MCP servers and marketplace plugins (BOT-10, D-06): one switch per tool, grouped by
 * source. The API decides availability: a tool with a `reason` is disabled and explained (never hidden), and a
 * granted tool that lost its source stays visible so it can be switched off. Saving sends the full grant set.
 */
export function ToolsSection({ view }: { view: BotCapabilityView }) {
  const update = useUpdateBotCapabilities(view.agentId);
  const canMcp = useCan("mcp.manage");
  const canPlugins = useCan("plugin.manage");
  const readOnly = !view.viewerCan.includes("bot.configure");

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

  function toggle(tool: CatalogTool, on: boolean) {
    const others = view.tools.filter((t) => t.granted && keyOf(t) !== keyOf(tool)).map(grantOf);
    update.mutate(
      { tools: on ? [...others, grantOf(tool)] : others },
      {
        onError: (err) => toast.error("Could not change the bot's tools", { description: errorMessage(err) }),
      },
    );
  }

  return (
    <section className="grid gap-2" data-testid="tools-section" aria-labelledby={`tools-${view.agentId}`}>
      <div className="flex items-baseline justify-between gap-2">
        <h4 id={`tools-${view.agentId}`} className="font-medium text-sm">
          Tools
        </h4>
        {groups.length > 0 ? (
          <span className="text-muted-foreground text-xs tabular-nums">
            {view.tools.filter((t) => t.effective).length} of {view.tools.length} on
          </span>
        ) : null}
      </div>

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
                      <div className={cn("min-w-0 flex-1", blocked && "opacity-75")}>
                        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
                          <label htmlFor={id} className="font-medium font-mono text-[13px]">
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
