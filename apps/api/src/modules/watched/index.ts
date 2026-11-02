import { WATCHED_LIMITS } from "@ocw/contracts";
import { watchedRecords } from "@ocw/db";
import { eq } from "drizzle-orm";
import type { ApiModule, Core } from "../../core";
import { createConversationAccess } from "../chat";
import type { PermissionService } from "../organization";
import { registerWatchedJobs } from "./check";
import { registerWatchedRoutes } from "./routes";

export { changeCard, conflictCard } from "./cards";
export { callWith, checkWatchedRecord, readRecord, readWith, watchedTick } from "./check";
export {
  type CasRefusal,
  type CasResult,
  type CompareAndSetInput,
  compareAndSet,
  createRecordWrites,
  type RecordChanges,
  type RecordWrites,
} from "./write";

/**
 * Phase 07.6 (AUTO-04, D-04, ADR-0028): watched records. A board card linked to an external record through a 07.4
 * connector; the API hashes the watched fields (07.5's `canonicalJson`), checks on access and on schedule
 * (`watched.check` jobs) and reports before → after in the card thread (07.6-07). Writes (compare-and-set) are 07.6-14.
 *
 * Routes (`authz: "user"`): GET `/watched-records?conversationId=`, POST `/watched-records/preview`, POST
 * `/watched-records`, PATCH and DELETE `/watched-records/:id`, POST `/watched-records/:id/check`.
 * Jobs: `watched.tick` (every five minutes, UTC) and `watched.check`. Observer: a person's reply in a watched card's
 * thread enqueues an access check (one per minute per watch).
 * Writes (07.6-14): `compareAndSet` (`write.ts`), reached only from the Agent Channel route `POST /records/update`
 * (`ocw_record_update`) through `createRecordWrites`, injected into the agent-channel module (no module cycle).
 */
export interface WatchedDeps {
  perms: PermissionService;
}

export function createWatchedModule(core: Core, deps: WatchedDeps): ApiModule {
  const ctx = { core, perms: deps.perms, access: createConversationAccess(core) };
  return {
    name: "watched",
    register(app) {
      registerWatchedRoutes(app, core, ctx);
      // Workers and ticks register during module registration, before `core.jobs` starts (onReady).
      registerWatchedJobs(core, { perms: deps.perms });
      // Check on access (D-04): a person's reply in the thread of a watched card, inside the message transaction (the
      // job exists only if the message commits). Bot posts never trigger one (the change card itself is a bot post).
      core.chatEvents.onMessagePosted(async (tx, input) => {
        if (input.author.kind !== "user" || input.conv.kind !== "channel" || !input.threadRootId) return;
        const [watched] = await tx
          .select({ id: watchedRecords.id })
          .from(watchedRecords)
          .where(eq(watchedRecords.cardMessageId, input.threadRootId))
          .limit(1);
        if (!watched) return;
        await core.jobs.sendInTx(
          tx,
          "watched.check",
          { organizationId: input.conv.organizationId, watchedRecordId: watched.id, source: "access" },
          { singletonKey: `watched:${watched.id}`, singletonSeconds: WATCHED_LIMITS.checkSingletonSeconds },
        );
      });
    },
  };
}
