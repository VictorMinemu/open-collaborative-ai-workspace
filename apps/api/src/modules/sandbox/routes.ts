import { SandboxSettings, SandboxSettingsView } from "@ocw/contracts";
import { z } from "zod";
import { type App, authOf, type Core, tenant } from "../../core";
import type { PermissionService } from "../organization";
import type { SandboxdClient } from "./client";
import { registerSandboxFileRoutes } from "./files";
import { killSandboxes, loadSandboxPolicy, resumeSandboxes } from "./service";
import { loadSettingsView, parseSettingsUpdate, pushPolicy, updateSandboxSettings } from "./settings";

/**
 * People's sandbox routes (07.8-05, 07.8-11; D-09, D-12): the admins' kill switch and settings, and (files.ts) the bot
 * configurers' file and lifecycle routes. `POST /api/v1/sandbox/kill` stops every sandbox and browser of the
 * organization and blocks new ones until `POST /api/v1/sandbox/resume`; `GET|PUT /api/v1/sandbox/settings` reads and
 * writes the versioned settings. All four need `bot.manage` at the organization (admins; a lead's unit rights never reach
 * it), decided by the resolver. The state is committed first; only then is sandboxd told (the organization's policy,
 * and for a kill the stop of its containers). A failure there leaves the committed state in force (fail closed) and is
 * logged with ids only. Plan 18 adds the packages routes here.
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
        // 07.8-11 (WINDOWS #241): sandboxd and its egress proxy hold `killed: true` too.
        await pushPolicy(core, deps.client, a.organizationId);
      }
      return settings;
    },
  );

  app.post(
    "/sandbox/resume",
    { ...manage, schema: { tags, response: { 200: SandboxSettings } } },
    async (req) => {
      const settings = await core.db.withTenant(tenant(req), async (tx) => {
        await resumeSandboxes(tx, core.audit, { userId: authOf(req).userId });
        return loadSandboxPolicy(tx);
      });
      await pushPolicy(core, deps.client, authOf(req).organizationId);
      return settings;
    },
  );

  // 07.8-11: the organization's settings (D-09, D-11, D-12; SBX-03).
  app.get(
    "/sandbox/settings",
    { ...manage, schema: { tags, response: { 200: SandboxSettingsView } } },
    async (req, reply) => {
      reply.header("cache-control", "no-store");
      return core.db.withTenant(tenant(req), (tx) => loadSettingsView(tx, deps.client));
    },
  );

  app.put(
    "/sandbox/settings",
    {
      ...manage,
      // Validated in the handler, so each refusal gets its own code (invalid_allow_host, limits_out_of_range, …).
      schema: { tags, body: z.record(z.string(), z.unknown()), response: { 200: SandboxSettings } },
    },
    async (req) => {
      const body = parseSettingsUpdate(req.body);
      const settings = await core.db.withTenant(tenant(req), (tx) =>
        updateSandboxSettings(tx, core.audit, { userId: authOf(req).userId }, body),
      );
      await pushPolicy(core, deps.client, authOf(req).organizationId);
      return settings;
    },
  );
}
