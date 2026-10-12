import {
  BoardFieldDef,
  CreateRecordTemplateRequest,
  IdParams,
  Ok,
  RECORD_TEMPLATE_LIST_MAX,
  RecordTemplate,
  RecordTemplateList,
  RecordTemplateListQuery,
  recordTemplateProblems,
  TemplateColumn,
  UpdateRecordTemplateRequest,
} from "@ocw/contracts";
import { orgUnits, recordTemplates, type Tx } from "@ocw/db";
import { eq, inArray, isNull, or, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { z } from "zod";
import { type App, authOf, tenant } from "../../../core";
import { badRequest, conflict, HttpError, notFound } from "../../../lib/errors";
import { orgResource, unitResource } from "../../organization";
import type { ChatRouteCtx } from "../index";
import { iso } from "../service";
import type { BoardSettings } from "./service";

/**
 * Record templates (BOARD-06; D-06, D-07, D-08, P-08). A template belongs to a unit (or, `unitId: null`, to the whole
 * organization) and is read with `unit.read`. Writes reuse the unit grains, no new permission: `unit.members.manage`
 * on the template's unit (its leads on their subtree, admins everywhere), `unit.manage` for organization-wide ones.
 * A board channel created from a template SNAPSHOTS it (prefix, naming rule, fields; columns copied): editing or
 * deleting a template changes no existing board. Audits carry ids, versions and counts only, never names, rules or
 * labels (principle 12, T-07.1-07-05).
 */

type TemplateRow = typeof recordTemplates.$inferSelect;
type UnitRow = typeof orgUnits.$inferSelect;

const FieldDefsRow = z.array(BoardFieldDef);
const ColumnsRow = z.array(TemplateColumn);

const TEMPLATE_NOT_FOUND = "Template not found";

function toTemplate(row: TemplateRow): RecordTemplate {
  return {
    id: row.id,
    unitId: row.unitId,
    name: row.name,
    description: row.description,
    prefix: row.prefix,
    namingRule: row.namingRule,
    fields: FieldDefsRow.parse(row.fields),
    columns: ColumnsRow.parse(row.columns),
    version: row.version,
    createdAt: iso(row.createdAt),
    updatedAt: iso(row.updatedAt),
  };
}

/** A Postgres `uuid[]` literal from validated ids (drizzle would expand a JS array into a value list). */
const uuidArray = (ids: readonly string[]) => sql`${`{${ids.join(",")}}`}::uuid[]`;

function isUniqueViolation(err: unknown): boolean {
  const e = err as { code?: string; cause?: { code?: string } };
  return e?.code === "23505" || e?.cause?.code === "23505";
}

/** Inserts and updates turn the per-unit name index into a 409 (the transaction rolls back with it). */
async function uniqueName<T>(write: Promise<T>): Promise<T> {
  try {
    return await write;
  } catch (err) {
    if (isUniqueViolation(err)) {
      throw conflict("A template with this name already exists here", "template_exists");
    }
    throw err;
  }
}

/** 404 when the unit is not in the tenant (RLS hides other organizations' units). */
async function requireUnit(tx: Tx, id: string): Promise<UnitRow> {
  const [row] = await tx.select().from(orgUnits).where(eq(orgUnits.id, id)).limit(1);
  if (!row) throw notFound("Unit not found", "unit_not_found");
  return row;
}

/** The template, locked for the rest of the transaction; 404 when it does not exist in the tenant (RLS). */
async function lockTemplate(tx: Tx, id: string): Promise<TemplateRow> {
  const [row] = await tx
    .select()
    .from(recordTemplates)
    .where(eq(recordTemplates.id, id))
    .limit(1)
    .for("update");
  if (!row) throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
  return row;
}

/**
 * The write decision for a template on `unitId` (D-08): `unit.manage` organization-wide, else `unit.members.manage`
 * on the unit (the resolver grants it to the unit's leads and their ancestors' leads, and to admins).
 */
async function assertCanManage(req: FastifyRequest, tx: Tx, ctx: ChatRouteCtx, unitId: string | null) {
  if (unitId === null) {
    await ctx.perms.assertCan(req, tx, "unit.manage", orgResource());
    return;
  }
  await ctx.perms.assertCan(req, tx, "unit.members.manage", unitResource(await requireUnit(tx, unitId)));
}

const auditMetadata = (row: TemplateRow) => ({
  templateId: row.id,
  unitId: row.unitId,
  version: row.version,
  fieldCount: Array.isArray(row.fields) ? row.fields.length : 0,
  columnCount: Array.isArray(row.columns) ? row.columns.length : 0,
});

/**
 * The board settings a channel placed in `channelUnit` (null = organization level) gets from a template (P-08): the
 * template must be organization-wide or belong to a unit on the channel unit's path (self or an ancestor). Any other
 * template, another tenant's (RLS hides it) or an unknown id is the same 400 `template_not_available`: no oracle.
 */
export async function templateForChannel(
  tx: Tx,
  templateId: string,
  channelUnit: { id: string; path: readonly string[] } | null,
): Promise<BoardSettings> {
  const [row] = await tx.select().from(recordTemplates).where(eq(recordTemplates.id, templateId)).limit(1);
  const inScope = row && (row.unitId === null || (channelUnit?.path ?? []).includes(row.unitId));
  if (!row || !inScope) {
    throw badRequest("That template isn't available here", "template_not_available");
  }
  return {
    templateId: row.id,
    prefix: row.prefix,
    namingRule: row.namingRule,
    fields: FieldDefsRow.parse(row.fields),
    columns: ColumnsRow.parse(row.columns),
  };
}

/** `GET|POST /record-templates`, `PATCH|DELETE /record-templates/:id` under `/api/v1` (BOARD-06, D-08). */
export function registerRecordTemplateRoutes(app: App, ctx: ChatRouteCtx): void {
  const { core, perms } = ctx;
  const tags = ["chat"];
  const user = { config: { authz: "user" as const }, preHandler: core.identity.requireUser };

  app.get(
    "/record-templates",
    {
      ...user,
      schema: { tags, querystring: RecordTemplateListQuery, response: { 200: RecordTemplateList } },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const { unitId } = req.query;
        if (!unitId) {
          await perms.assertCan(req, tx, "unit.read", orgResource());
          const rows = await tx
            .select()
            .from(recordTemplates)
            .where(isNull(recordTemplates.unitId))
            .orderBy(sql`lower(${recordTemplates.name})`, recordTemplates.id)
            .limit(RECORD_TEMPLATE_LIST_MAX);
          return {
            templates: rows.map(toTemplate),
            canManage: await perms.can(req, tx, "unit.manage", orgResource()),
          };
        }
        const unit = await requireUnit(tx, unitId);
        await perms.assertCan(req, tx, "unit.read", unitResource(unit));
        // P-08: what a channel placed in this unit may use — organization-wide first, then root → self.
        const rows = await tx
          .select()
          .from(recordTemplates)
          .where(or(isNull(recordTemplates.unitId), inArray(recordTemplates.unitId, unit.path)))
          .orderBy(
            sql`array_position(${uuidArray(unit.path)}, ${recordTemplates.unitId}) nulls first`,
            sql`lower(${recordTemplates.name})`,
            recordTemplates.id,
          )
          .limit(RECORD_TEMPLATE_LIST_MAX);
        return {
          templates: rows.map(toTemplate),
          canManage: await perms.can(req, tx, "unit.members.manage", unitResource(unit)),
        };
      }),
  );

  app.post(
    "/record-templates",
    { ...user, schema: { tags, body: CreateRecordTemplateRequest, response: { 200: RecordTemplate } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const body = req.body;
        await assertCanManage(req, tx, ctx, body.unitId);
        const [row] = await uniqueName(
          tx
            .insert(recordTemplates)
            .values({
              organizationId: auth.organizationId,
              unitId: body.unitId,
              name: body.name,
              description: body.description,
              prefix: body.prefix,
              namingRule: body.namingRule,
              fields: body.fields,
              columns: body.columns,
              createdBy: auth.userId,
            })
            .returning(),
        );
        if (!row) throw new Error("record template insert returned no row");
        await core.audit.record(tx, {
          action: "record_template.created",
          resourceType: "record_template",
          resourceId: row.id,
          sessionId: auth.sessionId,
          metadata: auditMetadata(row),
        });
        return toTemplate(row);
      }),
  );

  app.patch(
    "/record-templates/:id",
    {
      ...user,
      schema: {
        tags,
        params: IdParams,
        body: UpdateRecordTemplateRequest,
        response: { 200: RecordTemplate },
      },
    },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const current = await lockTemplate(tx, req.params.id);
        await assertCanManage(req, tx, ctx, current.unitId);
        const { expectedVersion, ...changes } = req.body;
        if (current.version !== expectedVersion) {
          throw new HttpError(
            409,
            "template_version_conflict",
            `The template is at version ${current.version}, not ${expectedVersion}`,
            { template: toTemplate(current) },
          );
        }
        // The contract checks a partial update alone; the merged template must still fit together (D-06).
        const merged = {
          prefix: changes.prefix === undefined ? current.prefix : changes.prefix,
          namingRule: changes.namingRule === undefined ? current.namingRule : changes.namingRule,
          fields: changes.fields ?? FieldDefsRow.parse(current.fields),
        };
        const problems = recordTemplateProblems({
          prefix: merged.prefix,
          namingRule: merged.namingRule,
          fieldKeys: merged.fields.map((f) => f.key),
        });
        if (problems.length > 0) throw badRequest(problems.join("; "), "invalid_naming_rule");
        const [row] = await uniqueName(
          tx
            .update(recordTemplates)
            .set({
              ...(changes.name !== undefined ? { name: changes.name } : {}),
              ...(changes.description !== undefined ? { description: changes.description } : {}),
              ...(changes.columns !== undefined ? { columns: changes.columns } : {}),
              prefix: merged.prefix,
              namingRule: merged.namingRule,
              fields: merged.fields,
              version: current.version + 1,
              updatedAt: sql`now()`,
            })
            .where(eq(recordTemplates.id, current.id))
            .returning(),
        );
        if (!row) throw notFound(TEMPLATE_NOT_FOUND, "template_not_found");
        await core.audit.record(tx, {
          action: "record_template.updated",
          resourceType: "record_template",
          resourceId: row.id,
          sessionId: auth.sessionId,
          metadata: auditMetadata(row),
        });
        return toTemplate(row);
      }),
  );

  app.delete(
    "/record-templates/:id",
    { ...user, schema: { tags, params: IdParams, response: { 200: Ok } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        const auth = authOf(req);
        const current = await lockTemplate(tx, req.params.id);
        await assertCanManage(req, tx, ctx, current.unitId);
        // Boards made from it keep their snapshot; `boards.template_id` becomes null (FK `on delete set null`).
        await tx.delete(recordTemplates).where(eq(recordTemplates.id, current.id));
        await core.audit.record(tx, {
          action: "record_template.deleted",
          resourceType: "record_template",
          resourceId: current.id,
          sessionId: auth.sessionId,
          metadata: auditMetadata(current),
        });
        return { ok: true as const };
      }),
  );
}
