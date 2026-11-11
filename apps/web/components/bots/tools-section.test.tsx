import type { BotCapabilityView, CatalogTool } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { bulkGrants, ToolsSection } from "./tools-section";

/**
 * The bot's Tools section (owner report 2026-11-11): per-source "Turn on: Read-only tools / All, including changes /
 * Turn all off", and a warning when more tools are on than one bot turn carries (`toolsOverLimit`).
 */

const AGENT = "00000000-0000-4000-8000-0000000000aa";
const ERP = "00000000-0000-4000-8000-0000000000e1";
const DOCS = "00000000-0000-4000-8000-0000000000d1";

function tool(sourceId: string, name: string, over: Partial<CatalogTool> = {}): CatalogTool {
  return {
    sourceKind: "mcp",
    sourceId,
    sourceName: sourceId === ERP ? "ERP" : "Docs",
    tool: `${sourceId === ERP ? "erp" : "docs"}__${name}`,
    title: null,
    description: null,
    sideEffecting: false,
    granted: false,
    effective: false,
    reason: null,
    ...over,
  } as CatalogTool;
}

const erp = [
  tool(ERP, "listar_expedientes"),
  tool(ERP, "quien_soy"),
  tool(ERP, "crear_pedido", { sideEffecting: true }),
  tool(ERP, "borrar_pedido", { sideEffecting: true, granted: true, effective: true }),
  tool(ERP, "bloqueada", { reason: "denied_for_you" }),
];
const docs = [tool(DOCS, "search", { granted: true, effective: true })];
const all = [...erp, ...docs];
const names = (g: Array<{ tool: string }>) => g.map((t) => t.tool).sort();

describe("bulkGrants", () => {
  it("read: the source's read-only tools on, its tools that change data off, other sources kept", () => {
    expect(names(bulkGrants(all, erp, "read"))).toEqual(
      ["docs__search", "erp__listar_expedientes", "erp__quien_soy"].sort(),
    );
  });

  it("all: every available tool of the source on, never a blocked one", () => {
    expect(names(bulkGrants(all, erp, "all"))).toEqual(
      [
        "docs__search",
        "erp__borrar_pedido",
        "erp__crear_pedido",
        "erp__listar_expedientes",
        "erp__quien_soy",
      ].sort(),
    );
  });

  it("none: the source's tools off, other sources kept", () => {
    expect(names(bulkGrants(all, erp, "none"))).toEqual(["docs__search"]);
  });
});

function view(over: Partial<BotCapabilityView> = {}): BotCapabilityView {
  return {
    agentId: AGENT,
    scope: "team",
    tools: all,
    viewerCan: ["bot.read", "bot.configure"],
    ...over,
  } as BotCapabilityView;
}

function render(v: BotCapabilityView, readOnly = false): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}>
      <ToolsSection view={v} readOnly={readOnly} />
    </QueryClientProvider>,
  );
}

describe("ToolsSection", () => {
  it("offers the bulk actions on a source with several tools, not on a single-tool source", () => {
    const html = render(view());
    expect(html.match(/data-testid="tool-source-bulk"/g)).toHaveLength(1);
    expect(html).toContain("Read-only tools");
    expect(html).toContain("All, including changes");
    expect(html).toContain("Turn all off");
  });

  it("no bulk actions for someone who cannot configure the bot", () => {
    expect(render(view(), true)).not.toContain('data-testid="tool-source-bulk"');
  });

  it("warns when tools that are on do not fit in a turn, and stays quiet when they fit", () => {
    const html = render(view({ toolsOverLimit: 12 }));
    expect(html).toContain('data-testid="tools-over-limit"');
    expect(html).toContain("12 tools that are on do not fit in a bot turn");
    expect(html).toContain("at most 128 tools");
    expect(render(view({ toolsOverLimit: 0 }))).not.toContain("tools-over-limit");
    expect(render(view())).not.toContain("tools-over-limit");
  });
});
