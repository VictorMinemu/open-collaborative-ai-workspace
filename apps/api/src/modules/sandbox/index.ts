import type { ApiModule, Core } from "../../core";
import type { AuditService } from "../audit";
import { createPermissionService, type PermissionService } from "../organization";
import { createSandboxdClient, type SandboxdClient } from "./client";
import { registerSandboxPeopleRoutes } from "./routes";
import {
  type Availability,
  type ConfinedKind,
  killSandboxes,
  loadSandboxPolicy,
  markState,
  reserveSandbox,
  resumeSandboxes,
  sandboxAvailable,
  touchSandbox,
} from "./service";

export {
  createSandboxdClient,
  type SandboxdCallOptions,
  type SandboxdClient,
  SandboxdRefusedError,
  SandboxdUnavailableError,
} from "./client";
export {
  type Availability,
  type AvailabilityRefusal,
  type ConfinedKind,
  loadSandboxPolicy,
  markState,
  reserveSandbox,
  type SandboxContainer,
  sandboxAvailable,
  touchSandbox,
} from "./service";

/**
 * The Sandbox module (07.8-05; SBX-02, SBX-05; D-02 (b), D-09, D-11, D-12): the bots' sandboxes as a Control Plane
 * service. The API decides and audits every call before sandboxd sees it (C-01): the resolver for the agent acting for
 * the human, the organization switch and kill state, the bot's switch, then the cap. sandboxd is reached only through
 * `client` (`OCW_SANDBOX_URL` + `OCW_SANDBOX_TOKEN`); without them `client` is null and nothing runs.
 *
 * Routes (people, `/api/v1`): `POST /sandbox/kill`, `POST /sandbox/resume` (this plan); the bots' routes live in the
 * Agent Channel (`agent-channel/sandbox.ts`).
 */

export interface SandboxService {
  /** sandboxd is configured (`OCW_SANDBOX_URL` and its token); without it nothing runs (`service_down`). */
  configured: boolean;
  /** The organization's settings (switch, egress, caps, kill state). */
  loadPolicy: typeof loadSandboxPolicy;
  /** The one combined availability decision (resolver, switch, kill, per-bot switch). */
  sandboxAvailable(
    tx: Parameters<typeof sandboxAvailable>[0],
    p: { agentId: string; userId: string },
    kind: ConfinedKind,
  ): Promise<Availability>;
  reserveSandbox: typeof reserveSandbox;
  markState: typeof markState;
  touch: typeof touchSandbox;
  kill(tx: Parameters<typeof killSandboxes>[0], actor: { userId: string }): Promise<{ changed: boolean }>;
  resume(tx: Parameters<typeof resumeSandboxes>[0], actor: { userId: string }): Promise<{ changed: boolean }>;
}

export interface SandboxModule {
  module: ApiModule;
  service: SandboxService;
  /** null when `OCW_SANDBOX_URL` is not configured. */
  client: SandboxdClient | null;
}

export function createSandboxModule(
  core: Core,
  deps: { perms?: PermissionService; audit?: AuditService; client?: SandboxdClient | null } = {},
): SandboxModule {
  const perms = deps.perms ?? createPermissionService(core);
  const audit = deps.audit ?? core.audit;
  const client =
    deps.client !== undefined
      ? deps.client
      : core.env.OCW_SANDBOX_URL && core.env.OCW_SANDBOX_TOKEN
        ? createSandboxdClient({ url: core.env.OCW_SANDBOX_URL, token: core.env.OCW_SANDBOX_TOKEN })
        : null;
  const service: SandboxService = {
    configured: client !== null,
    loadPolicy: loadSandboxPolicy,
    sandboxAvailable: (tx, p, kind) => sandboxAvailable(tx, perms, p, kind),
    reserveSandbox,
    markState,
    touch: touchSandbox,
    kill: (tx, actor) => killSandboxes(tx, audit, actor),
    resume: (tx, actor) => resumeSandboxes(tx, audit, actor),
  };
  return {
    service,
    client,
    module: {
      name: "sandbox",
      register(app) {
        registerSandboxPeopleRoutes(app, core, { perms, client });
      },
    },
  };
}
