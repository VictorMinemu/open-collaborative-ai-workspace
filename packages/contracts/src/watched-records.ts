import { z } from "zod";
import { JsonPointer, resolveJsonPointer } from "./automations";
import { Id, IsoDateTime } from "./common";

/**
 * Watched records (Phase 07.6, AUTO-04, D-04, P-13). A board card linked to a record in an outside system (read through
 * an MCP connector): the API reads the watched fields, hashes their RFC 8785 canonical projection (07.5's
 * `canonicalJson` over `projectFields`) and reports a change made elsewhere as before → after, on access and on
 * schedule. Writes go through `ocw_record_update` with compare-and-set only: nothing is ever overwritten blindly.
 */

export const WATCHED_LIMITS = {
  fieldsMax: 20,
  /** Fields shown on the card tile. */
  cardFieldsMax: 10,
  /** Characters of one displayed value. */
  valueChars: 500,
  /** An access check of one record runs at most once per this many seconds (singleton). */
  checkSingletonSeconds: 60,
  intervals: [15, 30, 60, 240, 1440],
} as const;

/** A watched field: one pointer into the record (never the whole document) and its label. */
export const WatchedField = z.object({
  pointer: JsonPointer.refine((p) => p !== "", { message: "a field, not the whole record" }),
  label: z.string().trim().min(1).max(60),
});
export type WatchedField = z.infer<typeof WatchedField>;

const WatchedFields = z
  .array(WatchedField)
  .min(1)
  .max(WATCHED_LIMITS.fieldsMax)
  .refine((fields) => new Set(fields.map((f) => f.pointer)).size === fields.length, {
    message: "each field once",
  });

export const WatchedStatus = z.enum(["ok", "changed", "not_connected", "unreachable", "error"]);
export type WatchedStatus = z.infer<typeof WatchedStatus>;

/** What triggered a check: a reader opening the thread, the schedule, our own write, or "Check now". */
export const WatchedCheckSource = z.enum(["access", "schedule", "write", "manual"]);
export type WatchedCheckSource = z.infer<typeof WatchedCheckSource>;

export const WatchedCheckInterval = z.union([
  z.literal(15),
  z.literal(30),
  z.literal(60),
  z.literal(240),
  z.literal(1440),
]);
export type WatchedCheckInterval = z.infer<typeof WatchedCheckInterval>;

export const WatchedErrorCode = z.enum([
  "member_account",
  "not_connected",
  "record_not_found",
  "connector_error",
  "unreadable",
  "agent_not_member",
  "not_a_board_card",
  "already_watched",
  "check_rate_limited",
  "record_changed",
  "not_watched",
]);
export type WatchedErrorCode = z.infer<typeof WatchedErrorCode>;

const ExternalRef = z.string().trim().min(1).max(200);
const ToolName = z.string().trim().min(1).max(128);
const IdArg = z.string().trim().min(1).max(64);
const PersonRef = z.object({ id: Id, displayName: z.string() });

export const WatchedRecord = z.object({
  id: Id,
  cardMessageId: Id,
  conversationId: Id,
  /** The bot that reports changes and may write (through `ocw_record_update`). */
  agent: PersonRef,
  connector: z.object({ id: Id, name: z.string(), authMode: z.enum(["org_secret", "per_member"]) }),
  externalRef: ExternalRef,
  readTool: ToolName,
  writeTool: ToolName.nullable(),
  noteTool: ToolName.nullable(),
  idArg: IdArg,
  fields: WatchedFields,
  checkIntervalMinutes: WatchedCheckInterval,
  lastStatus: WatchedStatus,
  checkedAt: IsoDateTime.nullable(),
  /** The tile shows "Changed" for 24 h after this (R9). */
  lastChangedAt: IsoDateTime.nullable(),
  linkedBy: PersonRef,
  version: z.number().int().positive(),
  viewerCan: z.array(z.enum(["edit", "check", "unlink"])),
});
export type WatchedRecord = z.infer<typeof WatchedRecord>;

export const WatchedRecordListQuery = z.object({ conversationId: Id });
export type WatchedRecordListQuery = z.infer<typeof WatchedRecordListQuery>;

export const WatchedRecordList = z.object({ records: z.array(WatchedRecord) });
export type WatchedRecordList = z.infer<typeof WatchedRecordList>;

/** `POST /watched-records/preview` (R9): read the record once, no save, under the same share rule as a link. */
export const PreviewWatchedRecordRequest = z.object({
  conversationId: Id,
  mcpServerId: Id,
  externalRef: ExternalRef,
  readTool: ToolName,
  idArg: IdArg,
});
export type PreviewWatchedRecordRequest = z.infer<typeof PreviewWatchedRecordRequest>;

export const PreviewWatchedRecordResponse = z.object({
  /** A human label for the record when the connector gives one. */
  label: z.string().max(200).nullable(),
  values: z
    .array(
      z.object({
        pointer: JsonPointer,
        /** Display text of the value (cut to `valueChars`); null for null. */
        value: z.string().max(WATCHED_LIMITS.valueChars).nullable(),
        suggestedLabel: z.string().max(60),
      }),
    )
    .max(200),
  /** Pointers whose values look numeric (the picker suggests number formatting). */
  numberHints: z.array(JsonPointer).max(200),
});
export type PreviewWatchedRecordResponse = z.infer<typeof PreviewWatchedRecordResponse>;

export const CreateWatchedRecordRequest = z.object({
  /** A 07.1 board card (its thread root message). */
  cardMessageId: Id,
  mcpServerId: Id,
  externalRef: ExternalRef,
  readTool: ToolName,
  idArg: IdArg,
  writeTool: ToolName.optional(),
  noteTool: ToolName.optional(),
  fields: WatchedFields,
  checkIntervalMinutes: WatchedCheckInterval,
  agentId: Id,
});
export type CreateWatchedRecordRequest = z.infer<typeof CreateWatchedRecordRequest>;

export const UpdateWatchedRecordRequest = z
  .object({
    expectedVersion: z.number().int().positive(),
    fields: WatchedFields.optional(),
    checkIntervalMinutes: WatchedCheckInterval.optional(),
    agentId: Id.optional(),
    /** `null` removes the tool. */
    writeTool: ToolName.nullable().optional(),
    noteTool: ToolName.nullable().optional(),
  })
  .refine(
    ({ expectedVersion: _version, ...changes }) => Object.values(changes).some((v) => v !== undefined),
    { message: "nothing to update" },
  );
export type UpdateWatchedRecordRequest = z.infer<typeof UpdateWatchedRecordRequest>;

/** `POST /watched-records/:id/check`: `schedule` and `write` checks are the server's own. */
export const CheckWatchedRecordRequest = z.object({ source: z.enum(["access", "manual"]) });
export type CheckWatchedRecordRequest = z.infer<typeof CheckWatchedRecordRequest>;

/** `watched_record.updated` on `conv:<board>`: ids only (never values). */
export const WatchedRecordUpdatedEvent = z.strictObject({ watchedRecordId: Id, cardMessageId: Id });
export type WatchedRecordUpdatedEvent = z.infer<typeof WatchedRecordUpdatedEvent>;

export interface WatchedProjection {
  v: 1;
  fields: Record<string, unknown>;
}

/**
 * The versioned projection the watched hash is computed over: each field's value at its pointer, `null` when the
 * pointer names nothing. Keys follow `fields` order (the canonical JSON sorts them anyway).
 */
export function projectFields(
  record: unknown,
  fields: ReadonlyArray<Pick<WatchedField, "pointer">>,
): WatchedProjection {
  const projected: Record<string, unknown> = {};
  for (const { pointer } of fields) {
    const value = resolveJsonPointer(record, pointer);
    projected[pointer] = value === undefined ? null : value;
  }
  return { v: 1, fields: projected };
}
