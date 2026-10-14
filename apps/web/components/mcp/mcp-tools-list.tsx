import type { McpServerTool } from "@ocw/contracts";
import { Eye, PencilLine } from "lucide-react";
import type { ReactNode } from "react";
import { Badge } from "@/components/ui/badge";

/**
 * Whether a tool can change data, from the API's view of it: only a tool the server explicitly marks read-only
 * (and not destructive) is "Read-only"; anything else may change data (the taint rule treats it the same way).
 */
export function SideEffectBadge({ sideEffecting }: { sideEffecting: boolean }) {
  return sideEffecting ? (
    <Badge variant="warning" data-testid="tool-effect" data-effect="writes">
      <PencilLine aria-hidden /> Changes data
    </Badge>
  ) : (
    <Badge variant="outline" data-testid="tool-effect" data-effect="read-only">
      <Eye aria-hidden /> Read-only
    </Badge>
  );
}

/** Tools discovered on one MCP server. Names and descriptions come from the server: plain text only. */
export function McpToolsList({ tools }: { tools: McpServerTool[] }) {
  return (
    <ul className="divide-y rounded-lg border bg-background" data-testid="mcp-tools">
      {tools.map((t) => (
        <li
          key={t.openclawName}
          className="flex items-start gap-3 px-3 py-2.5"
          data-testid="mcp-tool"
          data-tool={t.name}
        >
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-baseline gap-x-2">
              <span className="font-medium font-mono text-[13px]">{t.name}</span>
              {t.title && t.title !== t.name ? (
                <span className="truncate text-muted-foreground text-xs">{t.title}</span>
              ) : null}
            </div>
            {t.description ? (
              <p className="line-clamp-2 text-muted-foreground text-xs leading-snug">{t.description}</p>
            ) : null}
          </div>
          <SideEffectBadge sideEffecting={!t.readOnly || t.destructive} />
        </li>
      ))}
    </ul>
  );
}

/** No tools yet, with why (a per-member connector learns its tools from the first member's connection, R6). */
export function McpToolsEmpty({ children }: { children: ReactNode }) {
  return (
    <p
      className="rounded-lg border border-dashed px-3 py-6 text-center text-muted-foreground text-xs"
      data-testid="mcp-tools-empty"
    >
      {children}
    </p>
  );
}
