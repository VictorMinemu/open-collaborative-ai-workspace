import {
  AgentChannelAttachmentRead,
  AgentChannelAttachmentReadResponse,
  ATTACHMENT_READ_FLAGS,
  ATTACHMENT_READ_LIMITS,
  ATTACHMENT_READ_SENTENCES,
  type AttachmentReadRefusal,
  BUILTIN_TOOLS,
  modelAcceptsImages,
} from "@ocw/contracts";
import { agents, agentTurns, type Tx } from "@ocw/db";
import { eq, sql } from "drizzle-orm";
import type { App, Core } from "../../core";
import {
  type AgentRead,
  type AttachmentRow,
  attachmentKindOf,
  createObjectStorage,
  cutChars,
  EXTRACT_LIMITS,
  type ExtractRefusal,
  labelName,
  readAttachmentForAgent,
  untrustedFileBlock,
} from "../artifact";
import { attachmentAuditFields, attachmentForTurn } from "./attachment-access";
import { type CellPrincipal, cellOf } from "./auth";
import { noTrigger } from "./cards";
import {
  type AgentTurnRow,
  auditUnknownTurn,
  cellAuditBase,
  claimToolCall,
  finishToolCall,
  liveTurn,
} from "./claim";
import { turnHumanOf } from "./sandbox";

/**
 * `POST /agent-channel/v1/attachments/read` (07.15 D-03, D-07, D-08, D-16, D-17; PD-06): the API behind the plugin's
 * `ocw_attachment_read`. A bot reads a file of the conversation it answers in, decided at call time as the turn's
 * human (never a field of the request: the body is strict), counted on the turn's own attachment budget, tainting the
 * turn, audited without content. In this order:
 *   1. tx1 AS the human: the live turn (`liveTurn`, else 403 `no_trigger`, audited by `auditUnknownTurn`); the tool on
 *      the turn (`policy_changed`); the one row rule `attachmentForTurn` (`not_found`, the same rule as the import);
 *      the kind and the bot's model (`model_no_images`, `unsupported_type`, `too_large`); then the claim with the
 *      attachment budget (20 reads, 200 000 characters; `cap_reached`), which also taints the turn. A refusal decided
 *      here never reads storage and never counts or taints;
 *   2. outside any transaction: `readAttachmentForAgent` (the store with server credentials, bounded extraction), for
 *      at most what the turn has left of its characters;
 *   3. tx2 AS the human: the turn row locked, the characters granted (never past 200 000, even for parallel reads),
 *      added, the call finished and `bot.attachment_read` written.
 * Every refusal answers 200 with its code and fixed sentence (D-04); only `no_trigger` is a 403. No answer, audit row
 * or log line carries the file's name (the answer's labelled name aside), content, a storage key, a URL or a path.
 * Nothing is cached (D-06): every read re-decides and re-reads.
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];
const TOOL = BUILTIN_TOOLS.attachmentRead;

type ReadResponse = AgentChannelAttachmentReadResponse;
type Outcome = AttachmentReadRefusal | "ok";

/** Every extraction refusal as the code the bot reads (exhaustive: a new `ExtractRefusal` fails the typecheck). */
export function readRefusalOf(code: ExtractRefusal): AttachmentReadRefusal {
  switch (code) {
    case "unsupported_type":
    case "too_large":
    case "no_text_layer":
    case "encrypted":
    case "extraction_failed":
    case "timeout":
    case "busy":
    case "unavailable":
      return code;
    default: {
      const never: never = code;
      return never;
    }
  }
}

const refusedAnswer = (attachmentId: string, code: AttachmentReadRefusal): ReadResponse => ({
  kind: "refused",
  attachmentId,
  code,
  sentence: ATTACHMENT_READ_SENTENCES[code],
});

/** The bot's model sees images (`modelAcceptsImages`; fails closed for a bot that is gone). */
async function imageModel(tx: Tx, agentId: string): Promise<boolean> {
  const [bot] = await tx
    .select({ provider: agents.modelProvider, modelId: agents.modelId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .limit(1);
  return bot ? modelAcceptsImages(bot.provider, bot.modelId) : false;
}

type Decided =
  | { answer: ReadResponse }
  | { go: { turn: AgentTurnRow; row: AttachmentRow; callId: string; charsLeft: number } };

export function registerAttachmentRoutes(scope: App, core: Core): void {
  // Bytes come from the artifact storage with the server's credentials (ADR-0015); null = not configured.
  const storage = createObjectStorage(core.env, core.secretStore);
  const maxBytes = core.env.OCW_ATTACHMENT_MAX_BYTES;

  /** `bot.attachment_read` (PD-09): actor and agent the bot, user the asker, resource the attachment; no content. */
  async function auditRead(
    tx: Tx,
    cell: CellPrincipal,
    p: {
      turn: AgentTurnRow;
      attachmentId: string;
      row: AttachmentRow | null;
      outcome: Outcome;
      result: "success" | "denied" | "error";
      chars?: number;
      truncated?: boolean;
      pages?: number;
    },
  ): Promise<void> {
    const { turn } = p;
    await core.audit.record(tx, {
      ...cellAuditBase(cell),
      action: "bot.attachment_read",
      actorKind: "agent",
      actorId: turn.agentId,
      agentId: turn.agentId,
      userId: turn.userId,
      resourceType: "attachment",
      resourceId: p.attachmentId,
      result: p.result,
      metadata: {
        eventId: turn.eventId,
        ...attachmentAuditFields(p.row, {
          attachmentId: p.attachmentId,
          conversationId: turn.conversationId,
        }),
        // A refused read never returned anything: `bytes` 0 then, whatever the file's size (E10).
        ...(p.outcome === "ok" ? {} : { bytes: 0 }),
        chars: p.chars ?? 0,
        truncated: p.truncated ?? false,
        ...(p.pages !== undefined ? { pages: p.pages } : {}),
        outcome: p.outcome,
      },
    });
  }

  /** Steps before the claim (PD-06 order): the code of the first refusal, or null when the claim may go. */
  async function precheck(
    tx: Tx,
    turn: AgentTurnRow,
    attachmentId: string,
  ): Promise<{ row: AttachmentRow | null; refusal: AttachmentReadRefusal | null }> {
    if (!turn.tools.includes(TOOL)) return { row: null, refusal: "policy_changed" };
    const row = await attachmentForTurn(tx, turn, attachmentId);
    if (!row) return { row: null, refusal: "not_found" };
    switch (attachmentKindOf(row)) {
      case "image":
        if (!(await imageModel(tx, turn.agentId))) return { row, refusal: "model_no_images" };
        if (!row.hasRenditions && row.sizeBytes > EXTRACT_LIMITS.imageOriginalMaxBytes) {
          return { row, refusal: "too_large" };
        }
        break;
      case "pdf":
        if (row.sizeBytes > maxBytes) return { row, refusal: "too_large" };
        break;
      case "text":
        break;
      default:
        return { row, refusal: "unsupported_type" };
    }
    if (!storage) return { row, refusal: "unavailable" };
    return { row, refusal: null };
  }

  scope.post(
    "/attachments/read",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelAttachmentRead,
        response: { 200: AgentChannelAttachmentReadResponse },
      },
    },
    async (req): Promise<ReadResponse> => {
      const cell = cellOf(req);
      const body = req.body;
      const { attachmentId } = body;
      const human = await turnHumanOf(core, cell, { ...body, tool: TOOL });
      const ctx = { organizationId: cell.organizationId, userId: human };
      const callBase = {
        cell,
        tool: TOOL,
        flags: ATTACHMENT_READ_FLAGS,
        web: false,
        sourceKind: "builtin" as const,
      };

      // 1. tx1: everything decided as the turn's human; no storage call.
      const decided = await core.db.withTenant(ctx, async (tx): Promise<Decided | null> => {
        const turn = await liveTurn(tx, core, body);
        if (!turn || turn.userId !== human) {
          await auditUnknownTurn(tx, core, {
            cell,
            tool: TOOL,
            reason: "no_trigger",
            metadata: { eventId: body.eventId },
          });
          return null;
        }
        const pre = await precheck(tx, turn, attachmentId);
        const claim = await claimToolCall(tx, core, {
          ...callBase,
          turn,
          sourceId: null,
          target: attachmentId,
          reason: pre.refusal,
          countCall: false,
          metadata: { eventId: turn.eventId, attachmentId },
          attachmentRead: {
            maxReads: ATTACHMENT_READ_LIMITS.readsPerTurn,
            maxChars: ATTACHMENT_READ_LIMITS.charsPerTurn,
          },
        });
        if (!claim.allowed || !pre.row) {
          const code = (pre.refusal ?? claim.reason ?? "cap_reached") as AttachmentReadRefusal;
          await auditRead(tx, cell, { turn, attachmentId, row: pre.row, outcome: code, result: "denied" });
          return { answer: refusedAnswer(attachmentId, code) };
        }
        // What the turn has left at the claim (the claim's row lock is held until this transaction commits).
        const [counted] = await tx
          .select({ chars: agentTurns.attachmentChars })
          .from(agentTurns)
          .where(eq(agentTurns.eventId, turn.eventId));
        const charsLeft =
          ATTACHMENT_READ_LIMITS.charsPerTurn - (counted?.chars ?? ATTACHMENT_READ_LIMITS.charsPerTurn);
        return { go: { turn, row: pre.row, callId: claim.callId, charsLeft } };
      });
      if (!decided) throw noTrigger();
      if ("answer" in decided) return decided.answer;
      const { turn, row, callId } = decided.go;

      // 2. The store and the extraction, outside any transaction.
      const started = Date.now();
      const got: AgentRead = storage
        ? await readAttachmentForAgent(
            storage,
            row,
            {
              charsPerFile: Math.max(0, Math.min(ATTACHMENT_READ_LIMITS.charsPerFile, decided.go.charsLeft)),
              maxBytes,
            },
            { log: core.log },
          )
        : { kind: "refused", code: "unavailable" };

      // 3. tx2: the characters granted under the turn's row lock, the call finished, the read audited.
      return core.db.withTenant(ctx, async (tx) => {
        const [locked] = await tx
          .select({ chars: agentTurns.attachmentChars })
          .from(agentTurns)
          .where(eq(agentTurns.eventId, turn.eventId))
          .for("update");
        const left = Math.max(0, ATTACHMENT_READ_LIMITS.charsPerTurn - (locked?.chars ?? 0));
        const name = labelName(row.filename);
        let answer: ReadResponse;
        let outcome: Outcome = "ok";
        let chars = 0;
        let truncated = false;
        let pages: number | undefined;
        if (got.kind === "refused") {
          outcome = readRefusalOf(got.code);
          answer = refusedAnswer(attachmentId, outcome);
        } else if (got.kind === "image") {
          answer = {
            kind: "image",
            attachmentId,
            name,
            mimeType: got.mimeType,
            data: Buffer.from(got.data).toString("base64"),
            width: got.width,
            height: got.height,
          };
        } else if (left === 0 && got.chars > 0) {
          // A parallel read of this turn took the rest of the characters first.
          outcome = "cap_reached";
          answer = refusedAnswer(attachmentId, outcome);
        } else {
          const cut = cutChars(got.text, left);
          chars = cut.text.length;
          truncated = got.truncated || cut.truncated;
          pages = got.pages;
          if (chars > 0) {
            await tx
              .update(agentTurns)
              .set({ attachmentChars: sql`${agentTurns.attachmentChars} + ${chars}` })
              .where(eq(agentTurns.eventId, turn.eventId));
          }
          answer = {
            kind: "text",
            attachmentId,
            name,
            text: untrustedFileBlock(name, cut.text),
            chars,
            truncated,
            ...(pages !== undefined ? { pages } : {}),
          };
        }
        await finishToolCall(tx, core, {
          cell,
          callId,
          status: outcome === "ok" ? "ok" : outcome === "cap_reached" ? "blocked" : "error",
          durationMs: Date.now() - started,
          metadata: { eventId: turn.eventId, attachmentId, outcome, chars },
        });
        await auditRead(tx, cell, {
          turn,
          attachmentId,
          row,
          outcome,
          result: outcome === "ok" ? "success" : outcome === "cap_reached" ? "denied" : "error",
          chars,
          truncated,
          ...(pages !== undefined ? { pages } : {}),
        });
        return answer;
      });
    },
  );
}
