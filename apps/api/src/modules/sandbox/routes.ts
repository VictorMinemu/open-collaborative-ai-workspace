import { SandboxSettings } from "@ocw/contracts";
import { type App, authOf, type Core, tenant } from "../../core";
import type { PermissionService } from "../organization";
import type { SandboxdClient } from "./client";
import { registerSandboxFileRoutes } from "./files";
import { killSandboxes, loadSandboxPolicy, resumeSandboxes } from "./service";

/**
 * People's sandbox routes of this plan (07.8-05, D-09): the admins' kill switch. `POST /api/v1/sandbox/kill` stops every
 * sandbox and browser of the organization and blocks new ones until `POST /api/v1/sandbox/resume`. Both need
 * `bot.manage` at the organization (admins; a lead's unit rights never reach it), decided by the resolver. The state is
 * committed first; only then is sandboxd asked to stop the organization's containers, and a failure there leaves the
 * organization killed (fail closed) and is logged with ids only. Plans 11 and 18 add the settings, files and packages
 * routes here.
 */

const tags = ["sandbox"];
/** sandboxd stops containers by label; give it a little longer than a normal call. */
const KILL_TIMEOUT_MS = 30_000;

export function registerSandboxPeopleRoutes(
  app: App,
  core: Core,
  deps: { perms: PermissionService; client: SandboxdClient | null },
): void {
  // 07.8-11: people's file routes for the bots they configure (the resolver's `sandbox.files`).
  registerSandboxFileRoutes(app, core, { perms: deps.perms, client: deps.client });

  const manage = {
    config: { authz: "user" as const },
    preHandler: [core.identity.requireUser, deps.perms.requirePermission("bot.manage")],
  };

  app.post(
    "/sandbox/kill",
    { ...manage, schema: { tags, response: { 200: SandboxSettings } } },
    async (req) => {
      const a = authOf(req);
      const settings = await core.db.withTenant(tenant(req), async (tx) => {
        await killSandboxes(tx, core.audit, { userId: a.userId });
        return loadSandboxPolicy(tx);
      });
      // After the commit, every time (a retry of a kill whose sandboxd call failed stops what is still running).
      if (deps.client) {
        try {
          await deps.client.call("killOrg", { orgId: a.organizationId }, { timeoutMs: KILL_TIMEOUT_MS });
        } catch (err) {
          req.log.warn(
            { organizationId: a.organizationId, error: err instanceof Error ? err.name : "unknown" },
            "sandboxd did not confirm the organization kill; the organization stays killed",
          );
        }
      }
      return settings;
    },
  );

  app.post(
    "/sandbox/resume",
    { ...manage, schema: { tags, response: { 200: SandboxSettings } } },
    async (req) =>
      core.db.withTenant(tenant(req), async (tx) => {
        await resumeSandboxes(tx, core.audit, { userId: authOf(req).userId });
        return loadSandboxPolicy(tx);
      }),
  );
}
