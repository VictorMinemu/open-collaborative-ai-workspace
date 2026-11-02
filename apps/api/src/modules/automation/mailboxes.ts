import {
  type AutomationTriggerInput,
  IdParams,
  Mailbox,
  type MailboxConfigInput,
  MailboxTestRequest,
  MailboxTestResult,
} from "@ocw/contracts";
import { automationEvents, automations, mailboxes, type Tx, tenantOf, vaultItems } from "@ocw/db";
import { eq, sql } from "drizzle-orm";
import type { FastifyRequest } from "fastify";
import { type App, authOf, type Core, tenant } from "../../core";
import { type EgressResolver, egressFor } from "../../lib/egress";
import { HttpError, notFound } from "../../lib/errors";
import { type BasicCredentials, basicCredentialsFor } from "../keychain";
import type { PermissionService } from "../organization";
import { canCreate } from "./access";
import type { AutomationSeamDeps, TriggerAdapter } from "./actions";
import {
  type ImapClientFactory,
  type MailboxErrorCode,
  type MailboxTarget,
  mailErrorCode,
  mailHostAllowed,
  type ReadResult,
  readNewMail,
  tryMailbox,
  uidKey,
  withMailbox,
} from "./imap";
import { parseMail } from "./mail-parse";

/**
 * Mail triggers (07.6-11; AUTO-02, D-02, D-07, R3, R8, P-09, P-17; research Pattern 5). One mailbox per mail
 * automation, created, changed and deleted with it in its transaction (R3). Credentials come only from a Keychain
 * `Username & password` item the owner may `vault.use`, sent only to a host that item allows (R8); the connection is
 * pinned and verified in `imap.ts`.
 *
 * Polling: `mailbox.tick` (every minute) claims each due mailbox (`app.due_mailboxes`, ids only) and queues
 * `mailbox.poll`. A poll runs as the mailbox's owner: decide and open the key, connect outside any transaction, read
 * only mail newer than the cursor (read-only, PEEK), then in one transaction store each new mail as an `accepted`
 * `automation_events` row (unique by Message-ID, else by a UIDVALIDITY:UID hash) with its `automation.inbound` job, and
 * advance the cursor. Paused automations, the hourly cap and posting are 21's (`inbound.ts`). Loop filters skip mail
 * before it is stored. Failures are fixed codes on the row: `auth_failed` (also a key that is gone, not usable or no
 * longer allows the host) backs off 30 minutes and retries at once when the Keychain item changes; anything else is
 * `unreachable` and keeps trying at the interval.
 *
 * Audit (ids, host, port and codes only; never a username, password, folder content, subject or body):
 * `mailbox.created`, `mailbox.updated`, `mailbox.deleted`, `mailbox.tested`, `mailbox.poll_failed` (on a change of
 * status or code), `mail.received` (`{ mailboxId, count, skipped, duplicates }`).
 */

type MailboxRow = typeof mailboxes.$inferSelect;

const TICK_BATCH = 200;
const AUTH_BACKOFF_MINUTES = 30;
const MINUTE_MS = 60_000;

/** How a poll ended, as the row and the audit record it. */
type PollOutcome =
  | { ok: true; read: ReadResult; count: number; skipped: number; duplicates: number; notStored: number }
  | { ok: false; status: "auth_failed" | "unreachable"; code: string };

// ---------------------------------------------------------------- the Keychain side

type KeyCheck =
  | { ok: true; creds: Extract<BasicCredentials, { ok: true }> }
  | { ok: false; code: "mailbox_key_not_usable" | "mailbox_host_not_allowed"; keyName?: string };

/** The owner's key for this host: usable by them (resolver) and allowing `host:port` (R8). */
async function checkKey(
  core: Core,
  tx: Tx,
  perms: PermissionService,
  p: { userId: string; vaultItemId: string | null; host: string; port: number; req?: FastifyRequest },
): Promise<KeyCheck> {
  if (!p.vaultItemId) return { ok: false, code: "mailbox_key_not_usable" };
  const creds = await basicCredentialsFor(core, tx, perms, {
    vaultItemId: p.vaultItemId,
    userId: p.userId,
    ...(p.req ? { req: p.req } : {}),
  });
  if (!creds.ok) return { ok: false, code: "mailbox_key_not_usable" };
  if (!mailHostAllowed(creds.allowedHosts, p.host, p.port)) {
    return { ok: false, code: "mailbox_host_not_allowed", keyName: creds.name };
  }
  return { ok: true, creds };
}

function keyError(check: Extract<KeyCheck, { ok: false }>, host: string): HttpError {
  return check.code === "mailbox_host_not_allowed"
    ? new HttpError(
        400,
        "mailbox_host_not_allowed",
        `Add ${host} to the allowed hosts of “${check.keyName ?? "the key"}” in Keychain.`,
        { host, key: check.keyName ?? null },
      )
    : new HttpError(400, "mailbox_key_not_usable", "Choose a username and password key from your Keychain.");
}

const targetOf = (
  cfg: { host: string; port: number; folder: string },
  creds: Extract<BasicCredentials, { ok: true }>,
): MailboxTarget => ({
  host: cfg.host,
  port: cfg.port,
  folder: cfg.folder,
  username: creds.username,
  password: creds.password,
  privateAllow: creds.privateAllow,
});

// ---------------------------------------------------------------- the trigger adapter (R3)

const mailboxOf = (input: AutomationTriggerInput): MailboxConfigInput => {
  if (input.kind !== "mail") throw new HttpError(400, "bad_request", "A mail trigger needs a mailbox");
  return input.mailbox;
};

async function rowOf(tx: Tx, automationId: string, lock = false): Promise<MailboxRow | null> {
  const q = tx.select().from(mailboxes).where(eq(mailboxes.automationId, automationId)).limit(1);
  const [row] = lock ? await q.for("update") : await q;
  return row ?? null;
}

const inMinutes = (now: Date, minutes: number) => new Date(now.getTime() + minutes * MINUTE_MS).toISOString();

/** After the save commits: the first poll sets the cursor to the newest message (only new mail is read). */
function baselineAfterCommit(core: Core, perms: PermissionService, tx: Tx, mailboxId: string) {
  const { organizationId } = tenantOf(tx);
  tenantOf(tx).afterCommit(() => pollMailbox(core, perms, { organizationId, mailboxId }));
}

/** The mail trigger the automation service calls in the automation's own transaction (`service.ts`, R3). */
export const mailTrigger: TriggerAdapter<Mailbox> = {
  async onCreate(tx, a, input, deps) {
    const cfg = mailboxOf(input);
    const check = await checkKey(deps.core, tx, deps.perms, {
      userId: a.runAsUserId,
      vaultItemId: cfg.vaultItemId,
      host: cfg.host,
      port: cfg.port,
    });
    if (!check.ok) throw keyError(check, cfg.host);
    const now = new Date();
    const [row] = await tx
      .insert(mailboxes)
      .values({
        organizationId: a.organizationId,
        automationId: a.id,
        ownerUserId: a.runAsUserId,
        vaultItemId: cfg.vaultItemId,
        host: cfg.host,
        port: cfg.port,
        folder: cfg.folder,
        pollIntervalMinutes: cfg.pollIntervalMinutes,
        nextPollAt: inMinutes(now, cfg.pollIntervalMinutes),
      })
      .returning();
    const made = row as MailboxRow;
    await deps.core.audit.record(tx, {
      action: "mailbox.created",
      resourceType: "mailbox",
      resourceId: made.id,
      userId: a.runAsUserId,
      metadata: {
        mailboxId: made.id,
        automationId: a.id,
        vaultItemId: made.vaultItemId,
        host: made.host,
        port: made.port,
        pollIntervalMinutes: made.pollIntervalMinutes,
      },
    });
    baselineAfterCommit(deps.core, deps.perms, tx, made.id);
    return {};
  },

  async onUpdate(tx, _before, after, input, deps) {
    const cfg = mailboxOf(input);
    const row = await rowOf(tx, after.id, true);
    if (!row) return mailTrigger.onCreate(tx, after, input, deps);
    const check = await checkKey(deps.core, tx, deps.perms, {
      userId: after.runAsUserId,
      vaultItemId: cfg.vaultItemId,
      host: cfg.host,
      port: cfg.port,
    });
    if (!check.ok) throw keyError(check, cfg.host);
    const changed = [
      ...(row.vaultItemId !== cfg.vaultItemId ? ["vaultItemId"] : []),
      ...(row.host !== cfg.host ? ["host"] : []),
      ...(row.port !== cfg.port ? ["port"] : []),
      ...(row.folder !== cfg.folder ? ["folder"] : []),
      ...(row.pollIntervalMinutes !== cfg.pollIntervalMinutes ? ["pollIntervalMinutes"] : []),
    ];
    // Another account, server or folder is another mailbox: read only what arrives from now on.
    const reset = changed.some((f) => f !== "pollIntervalMinutes");
    const now = new Date();
    // Saving is the owner's action: a failing mailbox is tried again right away.
    const retry = reset || row.status !== "active";
    await tx
      .update(mailboxes)
      .set({
        vaultItemId: cfg.vaultItemId,
        host: cfg.host,
        port: cfg.port,
        folder: cfg.folder,
        pollIntervalMinutes: cfg.pollIntervalMinutes,
        status: "active",
        lastErrorCode: null,
        ...(reset ? { uidValidity: null, lastUid: null, lastNewCount: 0 } : {}),
        nextPollAt: retry ? now.toISOString() : inMinutes(now, cfg.pollIntervalMinutes),
        updatedAt: now.toISOString(),
      })
      .where(eq(mailboxes.id, row.id));
    if (changed.length > 0) {
      await deps.core.audit.record(tx, {
        action: "mailbox.updated",
        resourceType: "mailbox",
        resourceId: row.id,
        userId: after.runAsUserId,
        metadata: {
          mailboxId: row.id,
          automationId: after.id,
          vaultItemId: cfg.vaultItemId,
          host: cfg.host,
          port: cfg.port,
          changed,
        },
      });
    }
    if (reset) baselineAfterCommit(deps.core, deps.perms, tx, row.id);
    return {};
  },

  async onDelete(tx, a, deps) {
    const row = await rowOf(tx, a.id, true);
    if (!row) return;
    // Its events go with it (FK cascade); a queued poll for it finds nothing and does nothing.
    await tx.delete(mailboxes).where(eq(mailboxes.id, row.id));
    await deps.core.audit.record(tx, {
      action: "mailbox.deleted",
      resourceType: "mailbox",
      resourceId: row.id,
      metadata: { mailboxId: row.id, automationId: a.id, host: row.host, port: row.port },
    });
  },

  async view(tx, a) {
    const row = await rowOf(tx, a.id);
    if (!row) return null;
    // The item's name only (RLS hides another member's personal key from a manager: no name then).
    const [item] = row.vaultItemId
      ? await tx
          .select({ name: vaultItems.name })
          .from(vaultItems)
          .where(eq(vaultItems.id, row.vaultItemId))
          .limit(1)
      : [];
    return {
      vaultItemId: row.vaultItemId,
      vaultItemName: item?.name ?? "",
      host: row.host,
      port: row.port,
      folder: row.folder,
      pollIntervalMinutes: row.pollIntervalMinutes as Mailbox["pollIntervalMinutes"],
      status: a.status === "active" ? row.status : "paused",
      lastPolledAt: row.lastPolledAt ? new Date(row.lastPolledAt).toISOString() : null,
      lastNewCount: row.lastNewCount,
      lastErrorCode: row.lastErrorCode,
    };
  },
};

// ---------------------------------------------------------------- polling

interface PollOptions {
  now?: Date;
  egress?: EgressResolver;
  createClient?: ImapClientFactory;
}

/** Where a failure leaves the row: sign-in problems wait (30 minutes or a Keychain change), the rest keeps trying. */
function failureOf(code: MailboxErrorCode | "key_not_usable" | "host_not_allowed"): PollOutcome {
  if (code === "auth_failed" || code === "key_not_usable" || code === "host_not_allowed") {
    return { ok: false, status: "auth_failed", code };
  }
  return { ok: false, status: "unreachable", code };
}

/**
 * One poll of one mailbox (the `mailbox.poll` job, and the baseline after a save). Idempotent: a mail already stored
 * (same Message-ID or UID hash) is counted as a duplicate, never stored twice. A gone mailbox or an inactive
 * automation is a no-op. Never throws for a mail-side failure (it is recorded on the row).
 */
export async function pollMailbox(
  core: Core,
  perms: PermissionService,
  data: { organizationId: string; mailboxId: string },
  opts: PollOptions = {},
): Promise<void> {
  const now = opts.now ?? new Date();
  const head = await core.db.withTenant({ organizationId: data.organizationId }, async (tx) => {
    const [row] = await tx
      .select({ mailbox: mailboxes, automationStatus: automations.status })
      .from(mailboxes)
      .innerJoin(automations, eq(automations.id, mailboxes.automationId))
      .where(eq(mailboxes.id, data.mailboxId))
      .limit(1);
    return row ?? null;
  });
  if (head?.automationStatus !== "active") return;
  const owner = head.mailbox.ownerUserId;
  const ctx = { organizationId: data.organizationId, userId: owner };

  // The key, decided for the owner and opened in a transaction that ends before any connection.
  const prepared = await core.db.withTenant(ctx, async (tx) => {
    const [m] = await tx.select().from(mailboxes).where(eq(mailboxes.id, data.mailboxId)).limit(1);
    if (!m) return null;
    const check = await checkKey(core, tx, perms, {
      userId: owner,
      vaultItemId: m.vaultItemId,
      host: m.host,
      port: m.port,
    });
    return { m, check };
  });
  if (!prepared) return;
  const { m, check } = prepared;

  let outcome: PollOutcome;
  let parsed: Array<{ uid: number; mail: Awaited<ReturnType<typeof parseMail>> }> = [];
  if (!check.ok) {
    outcome = failureOf(check.code === "mailbox_host_not_allowed" ? "host_not_allowed" : "key_not_usable");
  } else {
    const egress = opts.egress ?? egressFor(core.env);
    try {
      const read = await withMailbox(
        egress,
        targetOf(m, check.creds),
        (client, box) => readNewMail(client, box, { uidValidity: m.uidValidity, lastUid: m.lastUid }),
        opts.createClient,
      );
      const address = check.creds.username.includes("@") ? check.creds.username : "";
      parsed = [];
      for (const fetched of read.mails) {
        parsed.push({ uid: fetched.uid, mail: await parseMail(fetched.source, { mailboxAddress: address }) });
      }
      outcome = { ok: true, read, count: 0, skipped: 0, duplicates: 0, notStored: 0 };
    } catch (err) {
      outcome = failureOf(mailErrorCode(err));
    }
  }

  try {
    await core.db.withTenant(ctx, async (tx) => {
      const [cur] = await tx
        .select()
        .from(mailboxes)
        .where(eq(mailboxes.id, data.mailboxId))
        .for("update")
        .limit(1);
      if (!cur) return;
      // A save changed the mailbox while this poll ran: its result belongs to the old one.
      const sameMailbox =
        cur.vaultItemId === m.vaultItemId &&
        cur.host === m.host &&
        cur.port === m.port &&
        cur.folder === m.folder &&
        cur.uidValidity === m.uidValidity;
      if (!sameMailbox) return;

      if (!outcome.ok) {
        const backoff =
          outcome.status === "auth_failed"
            ? Math.max(AUTH_BACKOFF_MINUTES, cur.pollIntervalMinutes)
            : cur.pollIntervalMinutes;
        await tx
          .update(mailboxes)
          .set({
            status: outcome.status,
            lastErrorCode: outcome.code,
            lastPolledAt: now.toISOString(),
            nextPollAt: inMinutes(now, backoff),
            updatedAt: now.toISOString(),
          })
          .where(eq(mailboxes.id, cur.id));
        if (cur.status !== outcome.status || cur.lastErrorCode !== outcome.code) {
          await core.audit.record(tx, {
            action: "mailbox.poll_failed",
            resourceType: "mailbox",
            resourceId: cur.id,
            result: "error",
            actorKind: "system",
            userId: owner,
            metadata: {
              mailboxId: cur.id,
              automationId: cur.automationId,
              host: cur.host,
              port: cur.port,
              status: outcome.status,
              code: outcome.code,
            },
          });
        }
        return;
      }

      const { read } = outcome;
      for (const { uid, mail } of parsed) {
        if (mail.skipReason) {
          outcome.skipped++;
          continue;
        }
        // Each mail in its own savepoint: one the database refuses (the parser already strips U+0000) is skipped and
        // counted, and the cursor still moves past it, so it can never hold the mailbox (07.6 review A CR-01).
        let stored: { id: string; inserted: boolean } | undefined;
        try {
          stored = await tx.transaction(async (sp) => {
            const [row] = await sp
              .insert(automationEvents)
              .values({
                organizationId: cur.organizationId,
                source: "mail",
                mailboxId: cur.id,
                externalId: mail.messageId ?? uidKey(read.uidValidity, uid),
                threadKey: mail.threadKey,
                subject: mail.subject || null,
                sender: mail.from,
                bodyText: mail.text,
                result: "accepted",
                receivedAt: now.toISOString(),
              })
              .onConflictDoUpdate({
                target: [automationEvents.mailboxId, automationEvents.externalId],
                set: {
                  duplicateCount: sql`${automationEvents.duplicateCount} + 1`,
                  lastDuplicateAt: now.toISOString(),
                },
              })
              .returning({ id: automationEvents.id, inserted: sql<boolean>`(xmax = 0)` });
            return row;
          });
        } catch (err) {
          outcome.notStored++;
          // The code only: a database error's detail can quote the refused value.
          core.log.warn(
            { mailboxId: cur.id, uid, code: (err as { code?: unknown })?.code },
            "a polled mail could not be stored; skipped",
          );
          continue;
        }
        if (!stored) continue;
        if (!stored.inserted) {
          outcome.duplicates++;
          continue;
        }
        outcome.count++;
        // Ids only; 21 decides paused, the hourly cap and access, then posts it (`inbound.ts`).
        await core.jobs.sendInTx(tx, "automation.inbound", {
          organizationId: cur.organizationId,
          eventId: stored.id,
        });
      }
      // A concurrent poll that read further keeps its cursor (a baseline always takes the newest message).
      await tx
        .update(mailboxes)
        .set({
          uidValidity: read.uidValidity,
          lastUid: read.baseline ? read.lastUid : Math.max(read.lastUid, cur.lastUid ?? 0),
          status: "active",
          // The mailbox works; a mail it had to skip is said on the row until the next clean poll.
          lastErrorCode: outcome.notStored > 0 ? "mail_not_stored" : null,
          lastPolledAt: now.toISOString(),
          lastNewCount: outcome.count,
          // A backlog beyond this poll's cap continues at the next tick.
          nextPollAt: read.more ? now.toISOString() : inMinutes(now, cur.pollIntervalMinutes),
          updatedAt: now.toISOString(),
        })
        .where(eq(mailboxes.id, cur.id));
      if (outcome.count + outcome.skipped + outcome.duplicates + outcome.notStored > 0) {
        await core.audit.record(tx, {
          action: "mail.received",
          resourceType: "mailbox",
          resourceId: cur.id,
          actorKind: "system",
          userId: owner,
          metadata: {
            mailboxId: cur.id,
            automationId: cur.automationId,
            count: outcome.count,
            skipped: outcome.skipped,
            duplicates: outcome.duplicates,
            ...(outcome.notStored > 0 ? { notStored: outcome.notStored } : {}),
          },
        });
      }
      if (read.validityChanged) {
        core.log.info(
          { mailboxId: cur.id },
          "mailbox UIDVALIDITY changed; cursor reset to the newest message",
        );
      }
    });
  } catch (err) {
    // Nothing of this poll was kept (the job is retried); the row says so instead of looking healthy (CR-01).
    await core.db
      .withTenant(ctx, (tx) =>
        tx
          .update(mailboxes)
          .set({ lastErrorCode: "poll_failed", updatedAt: new Date().toISOString() })
          .where(eq(mailboxes.id, data.mailboxId)),
      )
      .catch(() => {});
    throw err;
  }
}

/**
 * One minute of mail polling: each due mailbox (`app.due_mailboxes`, ids only) is claimed (its next poll moves one
 * interval ahead, so the next tick does not queue it again) and gets one `mailbox.poll` job. Safe on several replicas.
 */
export async function mailboxTick(core: Core, now: Date = new Date()): Promise<number> {
  const due = await core.db.pool.query<{ id: string; organization_id: string }>(
    "select id, organization_id from app.due_mailboxes($1, $2)",
    [TICK_BATCH, now.toISOString()],
  );
  let queued = 0;
  for (const row of due.rows) {
    try {
      const sent = await core.db.withTenant({ organizationId: row.organization_id }, async (tx) => {
        const [claimed] = await tx
          .update(mailboxes)
          .set({
            nextPollAt: sql`${now.toISOString()}::timestamptz + make_interval(mins => ${mailboxes.pollIntervalMinutes})`,
            updatedAt: now.toISOString(),
          })
          .where(eq(mailboxes.id, row.id))
          .returning({ id: mailboxes.id });
        if (!claimed) return false;
        await core.jobs.sendInTx(tx, "mailbox.poll", {
          organizationId: row.organization_id,
          mailboxId: claimed.id,
        });
        return true;
      });
      if (sent) queued++;
    } catch (err) {
      core.log.warn(
        { mailboxId: row.id, err: { name: (err as Error)?.name, message: (err as Error)?.message } },
        "mailbox tick failed",
      );
    }
  }
  return queued;
}

// ---------------------------------------------------------------- routes

/**
 * `POST /mailboxes/test` (R8): the caller's key, the caller's rights; nothing is saved. A key that is not theirs to use
 * is 403; a host the key does not allow answers `host_not_allowed` without connecting.
 */
export async function testMailbox(
  core: Core,
  perms: PermissionService,
  req: FastifyRequest,
  body: MailboxTestRequest,
  opts: { egress?: EgressResolver; createClient?: ImapClientFactory } = {},
): Promise<MailboxTestResult> {
  const userId = authOf(req).userId;
  const check = await core.db.withTenant(tenant(req), async (tx) => {
    if (!(await canCreate(perms, tx, { userId, req }))) {
      throw new HttpError(403, "not_allowed", "You can't create automations. Ask an admin.");
    }
    return checkKey(core, tx, perms, {
      userId,
      vaultItemId: body.vaultItemId,
      host: body.host,
      port: body.port,
      req,
    });
  });
  if (!check.ok && check.code === "mailbox_key_not_usable") {
    throw new HttpError(403, "mailbox_key_not_usable", "You can't use that key.");
  }
  const result: MailboxTestResult = check.ok
    ? await tryMailbox(opts.egress ?? egressFor(core.env), targetOf(body, check.creds), opts.createClient)
    : { ok: false, code: "host_not_allowed" };
  await core.db.withTenant(tenant(req), (tx) =>
    core.audit.record(tx, {
      action: "mailbox.tested",
      resourceType: "vault_item",
      resourceId: body.vaultItemId,
      result: result.ok ? "success" : "error",
      metadata: {
        vaultItemId: body.vaultItemId,
        host: body.host,
        port: body.port,
        code: result.ok ? null : result.code,
      },
    }),
  );
  return result;
}

/** The mailbox routes and jobs (07.6-11): `POST /mailboxes/test`, `GET /automations/:id/mailbox`, the poller. */
export function registerMailboxRoutes(app: App, core: Core, deps: AutomationSeamDeps): void {
  const user = { config: { authz: "user" as const }, preHandler: [core.identity.requireUser] };
  const tags = ["automations"];

  app.post(
    "/mailboxes/test",
    { ...user, schema: { tags, body: MailboxTestRequest, response: { 200: MailboxTestResult } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return testMailbox(core, deps.perms, req, req.body);
    },
  );

  app.get(
    "/automations/:id/mailbox",
    { ...user, schema: { tags, params: IdParams, response: { 200: Mailbox } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      const dto = await core.db.withTenant(tenant(req), (tx) =>
        deps.service.get(tx, { userId: authOf(req).userId, req }, req.params.id),
      );
      if (!dto.trigger.mailbox) throw notFound("This automation has no mailbox", "not_found");
      return dto.trigger.mailbox;
    },
  );

  core.jobs.schedule("mailbox.tick", "* * * * *");
  core.jobs.work("mailbox.tick", async () => {
    const queued = await mailboxTick(core);
    if (queued > 0) core.log.info({ queued }, "mailbox tick");
  });
  core.jobs.work("mailbox.poll", (data) => pollMailbox(core, deps.perms, data));
}
