import type { IncomingMessage, ServerResponse } from "node:http";

/** Types for the TypeScript tests that run the fake ERP MCP server in-process (implementation: fake-erp-mcp.mjs). */

/** The bearer the fake requires when none is given (also the e2e fake server's default, `OCW_FAKE_ERP_TOKEN`). */
export const FAKE_ERP_DEFAULT_TOKEN: string;

export type FakeErpToolName = "get_record" | "update_record" | "add_note" | "list_records" | "__mutate";

/**
 * The listed tools (tools/list). The `__add { id, fields }` test hook (07.17-18: a new record made elsewhere, an existing
 * id is an error) is callable through tools/call but never listed, so connectors that record these tools are unchanged.
 */
export const FAKE_ERP_TOOLS: ReadonlyArray<{
  name: FakeErpToolName;
  title: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: {
    readOnlyHint: boolean;
    destructiveHint: boolean;
    idempotentHint: boolean;
    openWorldHint: boolean;
  };
}>;

/** A sales order. `total` is a decimal string (never a float). Seed: SO-10442 and SO-10443. */
export interface FakeErpRecord {
  id: string;
  status: string;
  /** YYYY-MM-DD */
  delivery_date: string;
  total: string;
  customer: string;
  /** ISO 8601; bumped by update_record and __mutate, never by add_note; set by __add (07.17-18). */
  updated_at: string;
}

export type FakeErpField = "status" | "delivery_date" | "total" | "customer";

export interface FakeErpState {
  /** id → record (live; mutate through the `__mutate` tool to also bump updated_at). */
  records: Map<string, FakeErpRecord>;
  /** id → note texts in order. */
  notes: Map<string, string[]>;
  /** Every tools/call exactly as received. */
  calls: { name: string; arguments: Record<string, unknown> }[];
}

export interface FakeErpMcp {
  /** Returns true when it owned the route (`/erp-mcp`). */
  handle(req: IncomingMessage, res: ServerResponse, url: URL): boolean;
  state: FakeErpState;
  /** Restores the seed and forgets notes, calls and sessions. */
  reset(): void;
}

export function createFakeErpMcp(opts?: {
  /** Default FAKE_ERP_DEFAULT_TOKEN; the fake always requires a bearer. */
  token?: string;
}): FakeErpMcp;
