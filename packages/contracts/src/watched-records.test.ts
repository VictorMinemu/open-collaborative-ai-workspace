import { describe, expect, it } from "vitest";
import { AgentChannelRecordUpdate, AgentChannelRecordUpdateResponse } from "./agent-channel";
import {
  CheckWatchedRecordRequest,
  CreateWatchedRecordRequest,
  PreviewWatchedRecordRequest,
  PreviewWatchedRecordResponse,
  projectFields,
  UpdateWatchedRecordRequest,
  WATCHED_LIMITS,
  WatchedField,
  WatchedRecord,
  WatchedRecordList,
  WatchedRecordUpdatedEvent,
} from "./watched-records";

const ID = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e5f";
const ID2 = "0190d5e2-7c3a-7cc2-9d2e-6a1b2c3d4e60";
const NOW = "2026-10-30T10:00:00.000Z";

const field = (n: number) => ({ pointer: `/f${n}`, label: `Field ${n}` });

describe("projectFields (D-04, P-13)", () => {
  it("projects the watched pointers into a versioned object, missing values as null", () => {
    const record = { status: "Confirmed", lines: [{ qty: 2 }], total: "1250.00" };
    expect(
      projectFields(record, [{ pointer: "/status" }, { pointer: "/lines/0/qty" }, { pointer: "/missing" }]),
    ).toEqual({ v: 1, fields: { "/status": "Confirmed", "/lines/0/qty": 2, "/missing": null } });
  });

  it("keeps a null value and nested values as they are; key order follows the fields", () => {
    const record = { a: null, b: { c: [1, 2] } };
    const projected = projectFields(record, [{ pointer: "/b" }, { pointer: "/a" }]);
    expect(projected).toEqual({ v: 1, fields: { "/b": { c: [1, 2] }, "/a": null } });
    expect(Object.keys(projected.fields)).toEqual(["/b", "/a"]);
    // A non-object record projects every field to null.
    expect(projectFields("oops", [{ pointer: "/a" }])).toEqual({ v: 1, fields: { "/a": null } });
  });
});

describe("watched-record requests (D-04, R9)", () => {
  const create = {
    cardMessageId: ID,
    mcpServerId: ID2,
    externalRef: "SO-10442",
    readTool: "get_sales_order",
    idArg: "id",
    fields: [
      { pointer: "/status", label: "Status" },
      { pointer: "/delivery_date", label: "Delivery date" },
    ],
    checkIntervalMinutes: 60,
    agentId: ID,
  };

  it("a create parses; write and note tools are optional", () => {
    const parsed = CreateWatchedRecordRequest.parse(create);
    expect(parsed.writeTool).toBeUndefined();
    expect(CreateWatchedRecordRequest.parse({ ...create, writeTool: "update_sales_order" }).writeTool).toBe(
      "update_sales_order",
    );
  });

  it("refuses 21 fields, duplicate pointers, the whole-document pointer and a 5-minute interval", () => {
    expect(WATCHED_LIMITS.fieldsMax).toBe(20);
    const twenty = Array.from({ length: 20 }, (_, i) => field(i));
    expect(CreateWatchedRecordRequest.safeParse({ ...create, fields: twenty }).success).toBe(true);
    const many = Array.from({ length: 21 }, (_, i) => field(i));
    expect(CreateWatchedRecordRequest.safeParse({ ...create, fields: many }).success).toBe(false);
    const dup = [field(1), { ...field(1), label: "Again" }];
    expect(CreateWatchedRecordRequest.safeParse({ ...create, fields: dup }).success).toBe(false);
    expect(CreateWatchedRecordRequest.safeParse({ ...create, fields: [] }).success).toBe(false);
    expect(WatchedField.safeParse({ pointer: "", label: "Everything" }).success).toBe(false);
    expect(WatchedField.safeParse({ pointer: "status", label: "Status" }).success).toBe(false);
    expect(CreateWatchedRecordRequest.safeParse({ ...create, checkIntervalMinutes: 5 }).success).toBe(false);
    for (const minutes of WATCHED_LIMITS.intervals) {
      expect(CreateWatchedRecordRequest.safeParse({ ...create, checkIntervalMinutes: minutes }).success).toBe(
        true,
      );
    }
    expect(CreateWatchedRecordRequest.safeParse({ ...create, externalRef: "x".repeat(201) }).success).toBe(
      false,
    );
    expect(CreateWatchedRecordRequest.safeParse({ ...create, idArg: "x".repeat(65) }).success).toBe(false);
  });

  it("an update needs a change besides the version; a check names its source", () => {
    expect(UpdateWatchedRecordRequest.safeParse({ expectedVersion: 1 }).success).toBe(false);
    expect(
      UpdateWatchedRecordRequest.parse({ expectedVersion: 1, checkIntervalMinutes: 15 }).checkIntervalMinutes,
    ).toBe(15);
    expect(UpdateWatchedRecordRequest.parse({ expectedVersion: 1, writeTool: null }).writeTool).toBe(null);
    expect(CheckWatchedRecordRequest.parse({ source: "access" }).source).toBe("access");
    // `schedule` and `write` checks are the server's own.
    expect(CheckWatchedRecordRequest.safeParse({ source: "schedule" }).success).toBe(false);
  });

  it("the preview reads once and suggests labels (R9)", () => {
    expect(
      PreviewWatchedRecordRequest.parse({
        conversationId: ID,
        mcpServerId: ID2,
        externalRef: "SO-10442",
        readTool: "get_sales_order",
        idArg: "id",
      }).externalRef,
    ).toBe("SO-10442");
    const preview = PreviewWatchedRecordResponse.parse({
      label: "SO-10442 · Acme",
      values: [{ pointer: "/status", value: "Confirmed", suggestedLabel: "Status" }],
      numberHints: ["/total"],
    });
    expect(preview.values[0]?.value).toBe("Confirmed");
    expect(
      PreviewWatchedRecordResponse.safeParse({
        ...preview,
        values: [
          { pointer: "/status", value: "x".repeat(WATCHED_LIMITS.valueChars + 1), suggestedLabel: "S" },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("watched-record DTO and event", () => {
  const record = {
    id: ID,
    cardMessageId: ID2,
    conversationId: ID,
    agent: { id: ID, displayName: "Ops helper" },
    connector: { id: ID2, name: "ERP", authMode: "per_member" },
    externalRef: "SO-10442",
    readTool: "get_sales_order",
    writeTool: null,
    noteTool: null,
    idArg: "id",
    fields: [{ pointer: "/status", label: "Status" }],
    checkIntervalMinutes: 60,
    lastStatus: "changed",
    checkedAt: NOW,
    lastChangedAt: NOW,
    linkedBy: { id: ID, displayName: "Víctor Ruiz" },
    version: 1,
    viewerCan: ["edit", "check", "unlink"],
  };

  it("parses with lastChangedAt and refuses unknown statuses and auth modes", () => {
    expect(WatchedRecord.parse(record).lastChangedAt).toBe(NOW);
    expect(WatchedRecordList.parse({ records: [record] }).records).toHaveLength(1);
    expect(WatchedRecord.safeParse({ ...record, lastStatus: "stale" }).success).toBe(false);
    expect(
      WatchedRecord.safeParse({ ...record, connector: { ...record.connector, authMode: "x" } }).success,
    ).toBe(false);
  });

  it("the realtime payload is ids only", () => {
    expect(WatchedRecordUpdatedEvent.parse({ watchedRecordId: ID, cardMessageId: ID2 })).toEqual({
      watchedRecordId: ID,
      cardMessageId: ID2,
    });
    expect(
      WatchedRecordUpdatedEvent.safeParse({ watchedRecordId: ID, cardMessageId: ID2, values: { a: 1 } })
        .success,
    ).toBe(false);
  });
});

describe("ocw_record_update body (D-04, C-01)", () => {
  const body = {
    eventId: ID,
    agentId: ID2,
    changes: { "/status": "Shipped", "/qty": 3, "/rush": true, "/note": null },
  };

  it("carries only the event, the agent and the field changes", () => {
    expect(AgentChannelRecordUpdate.parse(body).changes["/qty"]).toBe(3);
    expect(AgentChannelRecordUpdate.safeParse({ ...body, changes: {} }).success).toBe(false);
    const many = Object.fromEntries(Array.from({ length: 21 }, (_, i) => [`/f${i}`, i]));
    expect(AgentChannelRecordUpdate.safeParse({ ...body, changes: many }).success).toBe(false);
    const twenty = Object.fromEntries(Array.from({ length: 20 }, (_, i) => [`/f${i}`, i]));
    expect(AgentChannelRecordUpdate.safeParse({ ...body, changes: twenty }).success).toBe(true);
    // Keys are field pointers (never the whole record); values are scalars.
    expect(AgentChannelRecordUpdate.safeParse({ ...body, changes: { "": "x" } }).success).toBe(false);
    expect(AgentChannelRecordUpdate.safeParse({ ...body, changes: { status: "x" } }).success).toBe(false);
    expect(AgentChannelRecordUpdate.safeParse({ ...body, changes: { "/a": { b: 1 } } }).success).toBe(false);
    // Never a hash, a record id, a conversation or a person of the model's choosing (T-07.6-01-01).
    for (const key of ["expectedHash", "watchedRecordId", "conversationId", "userId"]) {
      expect(AgentChannelRecordUpdate.safeParse({ ...body, [key]: ID }).success, key).toBe(false);
    }
  });

  it("answers ok with a sentence, or a code", () => {
    expect(AgentChannelRecordUpdateResponse.parse({ ok: true, code: null, sentence: "Saved." }).ok).toBe(
      true,
    );
    expect(
      AgentChannelRecordUpdateResponse.parse({ ok: false, code: "record_changed", sentence: "Changed." })
        .code,
    ).toBe("record_changed");
  });
});
