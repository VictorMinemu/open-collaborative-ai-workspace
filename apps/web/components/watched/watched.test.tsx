import type { WatchedRecord, WatchOptionConnector } from "@ocw/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { permissionKeys } from "@/lib/permissions";
import {
  CHECK_COOLDOWN_MS,
  checkNowState,
  connectHref,
  connectorLabel,
  fieldsError,
  preselectedPointers,
  shareHref,
  shareNotice,
  wantsAccessCheck,
  watchDescription,
  watchedKeys,
  watchLine,
  watchRefusal,
  watchState,
} from "@/lib/watched-queries";
import { defaultConnector, FieldsBox, readTools, writeTools } from "./watch-record-dialog";
import { WatchStripRow } from "./watch-strip-row";
import { WatchedIndicatorView } from "./watched-indicator";

/**
 * Watched records in the web (07.6-17, AUTO-04, D-07, UI-SPEC Surface 7, Pitfall 8, T-07.6-17-01/02): the indicator's
 * states and sentences, the strip's lines, Check now's minute, the dialog's field rules, number hint, connector
 * labels, share notice and refusals in words. Static markup in node; the browser flows are in
 * e2e/tests/watched-records.spec.ts.
 */

const ID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const BOARD = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
const CARD = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e61";
const OPS = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e62";
const NOW = Date.parse("2026-11-02T10:00:00.000Z");
const ago = (ms: number) => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;

function watch(over: Partial<WatchedRecord> = {}): WatchedRecord {
  return {
    id: ID,
    cardMessageId: CARD,
    conversationId: BOARD,
    agent: { id: OPS, displayName: "Ops helper" },
    connector: { id: ID, name: "ERP", authMode: "org_secret" },
    externalRef: "SO-10442",
    readTool: "get_record",
    writeTool: null,
    noteTool: null,
    idArg: "id",
    fields: [{ pointer: "/status", label: "Status" }],
    checkIntervalMinutes: 60,
    lastStatus: "ok",
    checkedAt: ago(20_000),
    lastChangedAt: null,
    linkedBy: { id: OPS, displayName: "Víctor Ruiz" },
    version: 1,
    viewerCan: ["edit", "check", "unlink"],
    ...over,
  };
}

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();

function render(node: ReactNode, seed?: (qc: QueryClient) => void): string {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  seed?.(qc);
  return renderToStaticMarkup(<QueryClientProvider client={qc}>{node}</QueryClientProvider>);
}

describe("watched indicator (UI-SPEC 7b)", () => {
  it("Watching (icon only), Changed for 24 h, Paused for a reconnect, Last check failed", () => {
    expect(watchState(watch(), NOW)).toBe("watching");
    expect(watchState(watch({ lastStatus: "changed", lastChangedAt: ago(23 * HOUR) }), NOW)).toBe("changed");
    expect(watchState(watch({ lastStatus: "ok", lastChangedAt: ago(25 * HOUR) }), NOW)).toBe("watching");
    expect(watchState(watch({ lastStatus: "not_connected", lastChangedAt: ago(HOUR) }), NOW)).toBe("paused");
    expect(watchState(watch({ lastStatus: "unreachable" }), NOW)).toBe("failed");
    expect(watchState(watch({ lastStatus: "error" }), NOW)).toBe("failed");
  });

  it("renders the right icon, aria-hidden; only Changed shows a word, in amber", () => {
    const watching = renderToStaticMarkup(<WatchedIndicatorView watch={watch()} now={NOW} />);
    expect(watching).toContain("lucide-eye");
    expect(watching).toContain('aria-hidden="true"');
    expect(text(watching)).toBe("");

    const changed = renderToStaticMarkup(
      <WatchedIndicatorView watch={watch({ lastChangedAt: ago(2 * HOUR) })} now={NOW} />,
    );
    expect(text(changed)).toBe("Changed");
    expect(changed).toContain("text-amber-800");
    expect(changed).toContain("dark:text-amber-300");

    const paused = renderToStaticMarkup(
      <WatchedIndicatorView watch={watch({ lastStatus: "not_connected" })} now={NOW} />,
    );
    expect(paused).toContain("lucide-eye-off");
    const failed = renderToStaticMarkup(
      <WatchedIndicatorView watch={watch({ lastStatus: "error" })} now={NOW} />,
    );
    expect(failed).toMatch(/lucide-circle-alert|lucide-alert-circle/);
  });

  it("the tile's accessible sentence says the state (the icon is hidden)", () => {
    expect(watchDescription(watch(), NOW)).toBe("Watching ERP record SO-10442.");
    expect(watchDescription(watch({ lastChangedAt: ago(2 * HOUR) }), NOW)).toBe(
      "Changed in ERP 2 hours ago.",
    );
    expect(watchDescription(watch({ lastStatus: "not_connected" }), NOW)).toBe(
      "Paused: Víctor Ruiz needs to reconnect ERP.",
    );
  });
});

describe("strip row lines (UI-SPEC Copy › Indicator / strip)", () => {
  it("Watching · Changed (amber lead) · Paused · Last check failed", () => {
    expect(watchLine(watch(), NOW)).toEqual({ lead: "", rest: "Watching ERP · SO-10442 · checked just now" });
    expect(watchLine(watch({ checkedAt: ago(5 * MIN) }), NOW).rest).toBe(
      "Watching ERP · SO-10442 · checked 5 minutes ago",
    );
    expect(watchLine(watch({ lastChangedAt: ago(3 * HOUR), checkedAt: ago(10 * MIN) }), NOW)).toEqual({
      lead: "Changed in ERP 3 hours ago",
      rest: " · checked 10 minutes ago",
    });
    expect(watchLine(watch({ lastStatus: "not_connected" }), NOW).rest).toBe(
      "Paused: Víctor Ruiz needs to reconnect ERP.",
    );
    expect(watchLine(watch({ lastStatus: "unreachable", checkedAt: ago(2 * HOUR) }), NOW).rest).toBe(
      "Last check failed 2 hours ago. OCW tries again at the next check.",
    );
  });

  it("Check now: disabled with “Checked just now” for 60 s after a check", () => {
    const at = NOW;
    expect(checkNowState({ now: at, cooldownUntil: 0, busy: false })).toEqual({
      label: "Check now",
      disabled: false,
    });
    expect(checkNowState({ now: at, cooldownUntil: at + CHECK_COOLDOWN_MS, busy: false })).toEqual({
      label: "Checked just now",
      disabled: true,
    });
    expect(
      checkNowState({ now: at + CHECK_COOLDOWN_MS - 1, cooldownUntil: at + CHECK_COOLDOWN_MS, busy: false }),
    ).toMatchObject({ disabled: true });
    expect(
      checkNowState({ now: at + CHECK_COOLDOWN_MS, cooldownUntil: at + CHECK_COOLDOWN_MS, busy: false }),
    ).toEqual({ label: "Check now", disabled: false });
    expect(checkNowState({ now: at, cooldownUntil: 0, busy: true }).disabled).toBe(true);
  });

  it("opening the thread asks for a check only when the last one is a minute old (the link queues the first)", () => {
    expect(wantsAccessCheck(watch({ checkedAt: null }), NOW)).toBe(false);
    expect(wantsAccessCheck(watch({ checkedAt: ago(30_000) }), NOW)).toBe(false);
    expect(wantsAccessCheck(watch({ checkedAt: ago(61_000) }), NOW)).toBe(true);
  });

  const withList = (records: WatchedRecord[], permissions: string[]) => (qc: QueryClient) => {
    qc.setQueryData(watchedKeys.list(BOARD), { records });
    qc.setQueryData(permissionKeys.mine, { permissions });
  };

  it("a poster sees the line, Check now and the ⋯ menu; a viewer who cannot post sees the line only", () => {
    const poster = render(
      <WatchStripRow card={{ messageId: CARD, conversationId: BOARD }} canPost />,
      withList([watch({ checkedAt: new Date(Date.now() - 20_000).toISOString() })], ["record.watch"]),
    );
    expect(text(poster)).toContain("Watching ERP · SO-10442 · checked just now");
    expect(poster).toContain('data-testid="watch-check-now"');
    expect(poster).toContain('aria-label="Watch actions"');

    const reader = render(
      <WatchStripRow card={{ messageId: CARD, conversationId: BOARD }} canPost={false} />,
      withList([watch({ viewerCan: [] })], ["record.watch"]),
    );
    expect(text(reader)).toContain("Watching ERP · SO-10442");
    expect(reader).not.toContain("watch-check-now");
    expect(reader).not.toContain("Watch actions");
  });

  it("an unwatched card: “Watch record” only with record.watch and post rights", () => {
    const card = { messageId: CARD, conversationId: BOARD };
    expect(render(<WatchStripRow card={card} canPost />, withList([], ["record.watch"]))).toContain(
      "Watch record",
    );
    expect(render(<WatchStripRow card={card} canPost />, withList([], []))).toBe("");
    expect(render(<WatchStripRow card={card} canPost={false} />, withList([], ["record.watch"]))).toBe("");
  });

  it("record values are plain text: markup in an ERP value is never HTML (T-07.6-17-01)", () => {
    const html = renderToStaticMarkup(
      <FieldsBox
        title="Found: <b>SO-1</b>"
        rows={[{ pointer: "/customer", label: "Customer", value: '<img src=x onerror="alert(1)">' }]}
        selected={["/customer"]}
        numberHints={[]}
        errorId="e"
        onToggle={() => {}}
      />,
    );
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<b>");
    expect(html).toContain("&lt;img");
  });
});

describe("watch dialog rules (UI-SPEC 7a)", () => {
  it("at least one field and at most 20", () => {
    expect(fieldsError(0)).toBe("Pick at least one field");
    expect(fieldsError(1)).toBeNull();
    expect(fieldsError(20)).toBeNull();
    expect(fieldsError(21)).toBe("Up to 20 fields");
  });

  it("the number hint shows on fields whose value is a JSON number, nowhere else", () => {
    const html = renderToStaticMarkup(
      <FieldsBox
        title="Found: SO-10442"
        rows={[
          { pointer: "/total", label: "Total", value: "1250.5" },
          { pointer: "/status", label: "Status", value: "Confirmed" },
          { pointer: "/note", label: "Note", value: null },
        ]}
        selected={["/total"]}
        numberHints={["/total"]}
        errorId="e"
        onToggle={() => {}}
      />,
    );
    expect(html.match(/Money and large numbers are safer as text fields\./g)?.length).toBe(1);
    expect(html).toMatch(/data-pointer="\/total"[\s\S]*Money and large numbers/);
    expect(text(html)).toContain("(empty)");
    expect(html).toContain('type="checkbox"');
    expect(html).toContain("Fields to watch");
  });

  it("connector labels: workspace access, your account, connect it first", () => {
    expect(connectorLabel({ name: "ERP", authMode: "org_secret", connection: null })).toBe(
      "ERP · workspace access",
    );
    expect(connectorLabel({ name: "ERP", authMode: "per_member", connection: "connected" })).toBe(
      "ERP · your account",
    );
    expect(connectorLabel({ name: "ERP", authMode: "per_member", connection: "not_connected" })).toBe(
      "ERP · your account · connect it first",
    );
    expect(connectorLabel({ name: "ERP", authMode: "per_member", connection: "needs_reconnect" })).toBe(
      "ERP · your account · connect it first",
    );
    expect(connectHref("abc")).toBe("/settings/connections?connector=abc");
  });

  it("the share notice and its link to the 07.4 shared-use dialog (Pitfall 8, T-07.6-17-02)", () => {
    expect(shareNotice("ERP", "orders", 12)).toBe(
      "ERP uses your own account, so everyone in #orders (12 people) would see what it reads. Allow ERP in #orders first.",
    );
    expect(shareNotice("ERP", "orders", 1)).toContain("(1 person)");
    expect(shareHref(BOARD, ID)).toBe(`/settings/connections?share=${BOARD}&connector=${ID}`);
  });

  it("refusals in words, each where it belongs; never the connector's own text", () => {
    const ctx = { connector: "ERP", recordId: "SO-99999", channel: "orders" };
    const err = (status: number, code: string) => new ApiRequestError(status, code, "upstream said <x>");
    expect(watchRefusal(err(404, "record_not_found"), ctx)).toEqual({
      at: "recordId",
      text: "No record SO-99999 in ERP.",
    });
    expect(watchRefusal(err(409, "member_account"), ctx)).toEqual({ at: "share" });
    expect(watchRefusal(err(409, "not_connected"), ctx)).toEqual({ at: "form", text: "Connect ERP first." });
    expect(watchRefusal(err(502, "connector_error"), ctx)).toEqual({
      at: "form",
      text: "ERP didn't answer. Try again later.",
    });
    expect(watchRefusal(err(502, "unreadable"), ctx)).toEqual({
      at: "form",
      text: "ERP returned something OCW can't read.",
    });
    expect(watchRefusal(err(400, "agent_not_member"), ctx)).toEqual({
      at: "bot",
      text: "Pick a bot that's a member of #orders",
    });
  });

  const erp: WatchOptionConnector = {
    id: ID,
    name: "ERP",
    authMode: "org_secret",
    connection: null,
    shared: true,
    tools: [
      { name: "list_records", title: null, readOnly: true, destructive: false, idArg: null, agentIds: [OPS] },
      { name: "get_record", title: null, readOnly: true, destructive: false, idArg: "id", agentIds: [OPS] },
      { name: "purge", title: null, readOnly: true, destructive: true, idArg: "id", agentIds: [OPS] },
      { name: "peek", title: null, readOnly: true, destructive: false, idArg: "id", agentIds: [] },
      {
        name: "update_record",
        title: null,
        readOnly: false,
        destructive: true,
        idArg: "id",
        agentIds: [OPS],
      },
      { name: "add_note", title: null, readOnly: false, destructive: false, idArg: "id", agentIds: [] },
    ],
  };

  it("Advanced: read tools are read-only, non-destructive and usable by a board bot, get_* first", () => {
    expect(readTools(erp).map((t) => t.name)).toEqual(["get_record", "list_records"]);
    expect(writeTools(erp, OPS).map((t) => t.name)).toEqual(["update_record"]);
    expect(writeTools(erp, ID)).toEqual([]);
  });

  it("the default connector is the first the viewer can use now", () => {
    const off = { ...erp, id: CARD, authMode: "per_member" as const, connection: "not_connected" as const };
    const opts = (connectors: WatchOptionConnector[]) => ({
      channel: { id: BOARD, name: "orders", readers: 3 },
      connectors,
      bots: [],
    });
    expect(defaultConnector(opts([off, erp]))?.id).toBe(ID);
    expect(defaultConnector(opts([off]))?.id).toBe(CARD);
    expect(defaultConnector(opts([]))).toBeUndefined();
  });

  it("fields are preselected from the board's template fields by key or label", () => {
    const values = [
      { pointer: "/status", suggestedLabel: "Status" },
      { pointer: "/delivery_date", suggestedLabel: "Delivery date" },
      { pointer: "/customer", suggestedLabel: "Customer" },
    ];
    expect(
      preselectedPointers(values, [
        { key: "status", label: "State" },
        { key: "eta", label: "Delivery date" },
      ]),
    ).toEqual(["/status", "/delivery_date"]);
    expect(preselectedPointers(values, [])).toEqual([]);
  });
});
