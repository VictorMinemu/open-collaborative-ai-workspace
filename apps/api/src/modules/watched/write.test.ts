import type { WatchedField } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { canonicalHash } from "../../lib/canonical-json";
import type { CallOutcome, ReadOutcome } from "./check";
import {
  type CasIo,
  type CasRow,
  noteArgOf,
  noteText,
  type RecordChanges,
  runCompareAndSet,
  takesExpectedUpdatedAt,
  topLevelKey,
  writePlan,
} from "./write";

/**
 * 07.6-14 (AUTO-04, D-04, P-13): the compare-and-set itself, over fake reads and calls. A record that changed since
 * the last check is never written; only watched top-level fields reach the write tool, with the id bound from the watch.
 */

const FIELDS: WatchedField[] = [
  { pointer: "/status", label: "Status" },
  { pointer: "/delivery_date", label: "Delivery date" },
];
const SEEN = {
  id: "SO-10442",
  status: "Confirmed",
  delivery_date: "2026-10-14",
  updated_at: "2026-10-01T09:00:00Z",
};
const hashOf = (r: Record<string, unknown>) =>
  canonicalHash({ v: 1, fields: { "/status": r.status ?? null, "/delivery_date": r.delivery_date ?? null } });

const row = (over: Partial<CasRow> = {}): CasRow => ({
  externalRef: "SO-10442",
  idArg: "id",
  writeTool: "update_record",
  noteTool: "add_note",
  fields: FIELDS,
  snapshotHash: hashOf(SEEN),
  ...over,
});

const ok = (content = "{}"): CallOutcome => ({
  ok: true,
  result: { content, truncated: false, isError: false },
});

/** A fake ERP: reads return `records` in turn (the last one repeats); every call is recorded. */
function fakeIo(p: {
  records: Array<Record<string, unknown>>;
  write?: CallOutcome;
  note?: CallOutcome;
  begin?: boolean;
}) {
  const log: string[] = [];
  const writes: Array<Record<string, unknown>> = [];
  const notes: string[] = [];
  let reads = 0;
  const io: CasIo = {
    async read(): Promise<ReadOutcome> {
      log.push("read");
      const r = p.records[Math.min(reads++, p.records.length - 1)];
      return { ok: true, record: r };
    },
    async write(args) {
      log.push("write");
      writes.push(args);
      return p.write ?? ok();
    },
    async note(text) {
      log.push("note");
      notes.push(text);
      return p.note ?? ok();
    },
    async begin() {
      log.push("begin");
      return p.begin ?? true;
    },
    async abort() {
      log.push("abort");
    },
    async conflict(after, _hash, by) {
      log.push(`conflict:${by}:${String(after["/delivery_date"])}`);
    },
    async written(after, hash, count) {
      log.push(
        `written:${String(after["/status"])}:${count}:${hash === hashOf({ status: after["/status"], delivery_date: after["/delivery_date"] })}`,
      );
    },
    async noted(isOk, code) {
      log.push(`noted:${isOk}:${code}`);
    },
  };
  return { io, log, writes, notes };
}

const OPTS = { botName: "Ops helper", personName: "Víctor Ruiz", expectedUpdatedAt: true };

describe("runCompareAndSet", () => {
  it("the record changed since the last check: conflict, and the write tool is never called", async () => {
    const changed = { ...SEEN, delivery_date: "2026-10-20" };
    const f = fakeIo({ records: [changed] });
    const out = await runCompareAndSet(f.io, row(), { "/status": "Shipped" }, OPTS);
    expect(out).toEqual({ kind: "conflict", recordId: "SO-10442" });
    expect(f.writes).toEqual([]);
    expect(f.log).toEqual(["read", "conflict:snapshot:2026-10-20"]);
  });

  it("unchanged: one write with the id bound from the watch and expectedUpdatedAt, then a re-read, the snapshot and the note", async () => {
    const f = fakeIo({ records: [SEEN, { ...SEEN, status: "Shipped", updated_at: "2026-10-02T00:00:00Z" }] });
    const out = await runCompareAndSet(f.io, row(), { "/status": "Shipped" }, OPTS);
    expect(out).toEqual({ kind: "written", recordId: "SO-10442" });
    expect(f.writes).toEqual([
      { id: "SO-10442", status: "Shipped", expectedUpdatedAt: "2026-10-01T09:00:00Z" },
    ]);
    expect(f.notes).toEqual(["Updated from OCW by Ops helper for Víctor Ruiz: Status"]);
    expect(f.log).toEqual([
      "read",
      "begin",
      "write",
      "read",
      "written:Shipped:1:true",
      "note",
      "noted:true:null",
    ]);
  });

  it("no expectedUpdatedAt when the record has no updated_at or the tool does not take it", async () => {
    const { updated_at: _u, ...bare } = SEEN;
    const a = fakeIo({ records: [bare] });
    await runCompareAndSet(a.io, row({ snapshotHash: hashOf(bare) }), { "/status": "Shipped" }, OPTS);
    expect(a.writes).toEqual([{ id: "SO-10442", status: "Shipped" }]);
    const b = fakeIo({ records: [SEEN] });
    await runCompareAndSet(b.io, row(), { "/status": "Shipped" }, { ...OPTS, expectedUpdatedAt: false });
    expect(b.writes).toEqual([{ id: "SO-10442", status: "Shipped" }]);
  });

  it("a changes key outside the watched fields, a nested pointer, the id or the guard: field_not_watched, nothing read", async () => {
    const cases: RecordChanges[] = [
      { "/customer": "X" },
      { "/status/code": "S" },
      { "/id": "SO-1" },
      { "/expectedUpdatedAt": "x" },
    ];
    for (const changes of cases) {
      const f = fakeIo({ records: [SEEN] });
      const withId = row({
        fields: [...FIELDS, { pointer: "/id", label: "Id" }, { pointer: "/status/code", label: "Code" }],
      });
      expect(await runCompareAndSet(f.io, withId, changes, OPTS)).toEqual({
        kind: "refused",
        code: "field_not_watched",
      });
      expect(f.log).toEqual([]);
    }
  });

  it("no write tool: no_write_tool; no snapshot yet: not_checked; nothing is read", async () => {
    const a = fakeIo({ records: [SEEN] });
    expect(await runCompareAndSet(a.io, row({ writeTool: null }), { "/status": "Shipped" }, OPTS)).toEqual({
      kind: "refused",
      code: "no_write_tool",
    });
    const b = fakeIo({ records: [SEEN] });
    expect(await runCompareAndSet(b.io, row({ snapshotHash: null }), { "/status": "Shipped" }, OPTS)).toEqual(
      {
        kind: "refused",
        code: "not_checked",
      },
    );
    expect([...a.log, ...b.log]).toEqual([]);
  });

  it("a check moved the snapshot between the read and the write: conflict, no write", async () => {
    const f = fakeIo({ records: [SEEN], begin: false });
    expect(await runCompareAndSet(f.io, row(), { "/status": "Shipped" }, OPTS)).toEqual({
      kind: "conflict",
      recordId: "SO-10442",
    });
    expect(f.writes).toEqual([]);
  });

  it("the ERP's own version guard refuses: the marker is undone and the new values are reported as a conflict", async () => {
    const f = fakeIo({
      records: [SEEN, { ...SEEN, delivery_date: "2026-10-21" }],
      write: {
        ok: true,
        result: { content: "conflict: SO-10442 changed since …", truncated: false, isError: true },
      },
    });
    expect(await runCompareAndSet(f.io, row(), { "/status": "Shipped" }, OPTS)).toEqual({
      kind: "conflict",
      recordId: "SO-10442",
    });
    expect(f.log).toEqual(["read", "begin", "write", "abort", "read", "conflict:erp:2026-10-21"]);
  });

  it("any other write error is connector_error (marker undone); a failed read is not_connected or connector_error", async () => {
    const f = fakeIo({
      records: [SEEN],
      write: {
        ok: true,
        result: { content: "update_record: total must be a string", truncated: false, isError: true },
      },
    });
    expect(await runCompareAndSet(f.io, row(), { "/status": "Shipped" }, OPTS)).toEqual({
      kind: "refused",
      code: "connector_error",
    });
    expect(f.log).toEqual(["read", "begin", "write", "abort"]);

    const noConnection: CasIo = {
      ...f.io,
      read: async () => ({ ok: false, status: "not_connected", code: "x" }),
    };
    expect(await runCompareAndSet(noConnection, row(), { "/status": "S" }, OPTS)).toEqual({
      kind: "refused",
      code: "not_connected",
    });
    const down: CasIo = {
      ...f.io,
      read: async () => ({ ok: false, status: "unreachable", code: "timeout" }),
    };
    expect(await runCompareAndSet(down, row(), { "/status": "S" }, OPTS)).toEqual({
      kind: "refused",
      code: "connector_error",
    });
  });

  it("a failing note keeps the write (noted false with its code); no note tool, no note", async () => {
    const f = fakeIo({ records: [SEEN], note: { ok: false, status: "unreachable", code: "upstream_error" } });
    expect(await runCompareAndSet(f.io, row(), { "/status": "Shipped" }, OPTS)).toEqual({
      kind: "written",
      recordId: "SO-10442",
    });
    expect(f.log.at(-1)).toBe("noted:false:upstream_error");
    const g = fakeIo({ records: [SEEN] });
    await runCompareAndSet(g.io, row({ noteTool: null }), { "/status": "Shipped" }, OPTS);
    expect(g.notes).toEqual([]);
  });
});

describe("helpers", () => {
  it("topLevelKey decodes one RFC 6901 token and refuses the whole record or a nested field", () => {
    expect(topLevelKey("/status")).toBe("status");
    expect(topLevelKey("/a~1b~0c")).toBe("a/b~c");
    expect(topLevelKey("")).toBeNull();
    expect(topLevelKey("/")).toBeNull();
    expect(topLevelKey("/a/b")).toBeNull();
    expect(topLevelKey("status")).toBeNull();
  });

  it("writePlan keeps the watch's label order", () => {
    expect(
      writePlan(
        { writeTool: "u", idArg: "id", fields: FIELDS },
        { "/delivery_date": "2026-10-20", "/status": "S" },
      ),
    ).toEqual({
      ok: true,
      fields: { delivery_date: "2026-10-20", status: "S" },
      labels: ["Status", "Delivery date"],
    });
  });

  it("noteText, noteArgOf and takesExpectedUpdatedAt", () => {
    expect(noteText("Scout", "Ana Pérez", ["Status", "Total"])).toBe(
      "Updated from OCW by Scout for Ana Pérez: Status, Total",
    );
    expect(noteArgOf(null, "id")).toBe("text");
    expect(noteArgOf({ properties: { id: {}, comment: {} } }, "id")).toBe("comment");
    expect(takesExpectedUpdatedAt(null)).toBe(true);
    expect(takesExpectedUpdatedAt({ properties: { id: {}, status: {} } })).toBe(false);
    expect(takesExpectedUpdatedAt({ properties: { expectedUpdatedAt: {} } })).toBe(true);
  });
});
