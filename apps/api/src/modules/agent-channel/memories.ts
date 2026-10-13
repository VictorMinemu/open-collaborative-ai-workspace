import { AgentChannelMemorySave, AgentChannelMemorySaveResponse } from "@ocw/contracts";
import type { App, Core } from "../../core";
import { conflict, HttpError, notFound } from "../../lib/errors";
import { type MemoryRefusal, saveMemory } from "../bot-capabilities";
import type { MemoryService } from "../memory";
import type { PermissionService } from "../organization";
import { cellOf } from "./auth";

/**
 * `POST /agent-channel/v1/memories` (D-10): the cell's `ocw_memory_save` tool stores one note. The body names
 * only the delivered turn, the bot and the text; the owner is the human of that delivery (`agent_turns`), so a
 * model can never choose whose memory it writes (T-03.1-07-03). Unknown fields are stripped by the schema.
 * Refusals: `unknown_turn` → 404; `dm_only`, `not_in_turn`, `memory_off`, `tainted`, `cap_reached` → 409.
 * Since 07.2-11 the note is a bullet of the human's private `MEMORY.md` (`memoryId` = that file's id). A note holding a
 * secret is never stored (ADR-0023): 400 `secret_detected`, which the plugin reads as "the note was not accepted".
 */

const tags = ["agent-channel"];
const bearer = [{ cellToken: [] as string[] }];

const MESSAGES: Record<MemoryRefusal, string> = {
  unknown_turn: "No delivered turn of this bot has that id",
  dm_only: "Memory is only written in a private chat with the bot",
  not_in_turn: "Memory was not offered on this turn",
  memory_off: "Memory is turned off for this bot",
  tainted: "This turn read untrusted content and can no longer write memory",
  cap_reached: "This turn reached its tool call limit",
};

export function registerMemoryRoutes(
  scope: App,
  core: Core,
  perms: PermissionService,
  memory: MemoryService,
): void {
  scope.post(
    "/memories",
    {
      config: { authz: "cell" as const },
      schema: {
        tags,
        security: bearer,
        body: AgentChannelMemorySave,
        response: { 200: AgentChannelMemorySaveResponse },
      },
    },
    async (req) => {
      const cell = cellOf(req);
      const { eventId, agentId, text } = req.body;
      const result = await core.db.withTenant({ organizationId: cell.organizationId, userId: null }, (tx) =>
        saveMemory(tx, core, perms, memory, { eventId, agentId, text }),
      );
      if ("rejected" in result) {
        throw new HttpError(
          400,
          result.rejected,
          "This looks like a secret. Secrets can't be stored in memory.",
        );
      }
      if ("refused" in result) {
        const message = MESSAGES[result.refused];
        // The refusal is audited inside the transaction; the error only carries its code.
        if (result.refused === "unknown_turn") throw notFound(message, result.refused);
        throw conflict(message, result.refused);
      }
      return result;
    },
  );
}
