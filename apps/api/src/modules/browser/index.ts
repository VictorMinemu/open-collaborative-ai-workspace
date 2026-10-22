import type { ActivityStep } from "@ocw/contracts";
import type { ApiModule, Core } from "../../core";
import { createConversationAccess } from "../chat";
import { createPermissionService } from "../organization";
import type { SandboxdClient, SandboxEventsConsumer } from "../sandbox";
import { onBrowserEvent } from "./contexts";
import { type LiveViewHub, registerLiveView } from "./live-view";

export {
  auditClosed,
  type BrowserContextRecord,
  type ContextTurn,
  closeContext,
  closeOrganizationContexts,
  contextById,
  contextFor,
  holdContext,
  hostOf,
  type LoadedContext,
  onBrowserEvent,
  openContextOf,
  releaseHold,
  sessionLoadedFor,
  takeoverActive,
  updateHost,
  validHost,
} from "./contexts";
export { FrameSlot, LIVE_CLOSE, type LiveViewHub, type LiveViewStats } from "./live-view";
export { LEASE_CHANNEL, TAKEOVER_MS, TAKEOVER_WARN_MS } from "./takeover";

/**
 * The Browser module (07.8-14, 07.8-16; D-05…D-07, D-09, D-11, D-12, BRW-01…03): the bots' browser contexts as Control
 * Plane records, and the people's live view. The bots' routes live in the Agent Channel (`agent-channel/browser.ts`),
 * which decides every call before sandboxd sees it; this module owns the context rows, applies sandboxd's `browser`
 * events to them (host updates, crashes, closes) and serves `GET /api/v1/live/browser/:contextId` (watch, take control,
 * hand back; 16). Plan 21 adds sign-in and sealed sessions, plan 27 the people's Browser tab.
 */
export interface BrowserModule {
  module: ApiModule;
  /** The `browser` events handler, registered on the sandbox events consumer (`events.onEvent("browser", …)`). */
  onBrowserEvent: ReturnType<typeof onBrowserEvent>;
  /** This instance's live-view hub once the routes are registered (tests: `sweep`, `stats`). */
  live(): LiveViewHub | null;
}

export function createBrowserModule(
  core: Core,
  deps: {
    events?: Pick<SandboxEventsConsumer, "onEvent"> | null;
    /** sandboxd (null when not configured: watchers see the page's state but no frame). */
    client?: SandboxdClient | null;
    /** The browser origins every WebSocket accepts (the realtime gateway's list). */
    allowedOrigins?: Set<string>;
    /** The Agent Channel's live phrase of a step, for the live view's activity line. */
    activityPhrase?(step: ActivityStep): string;
  } = {},
): BrowserModule {
  const handler = onBrowserEvent(core);
  deps.events?.onEvent("browser", handler);
  let hub: LiveViewHub | null = null;
  return {
    onBrowserEvent: handler,
    live: () => hub,
    module: {
      name: "browser",
      register(app) {
        hub = registerLiveView(app, {
          core,
          perms: createPermissionService(core),
          access: createConversationAccess(core),
          client: deps.client ?? null,
          allowedOrigins: deps.allowedOrigins ?? new Set(),
          ...(deps.activityPhrase ? { activityPhrase: deps.activityPhrase } : {}),
        });
      },
      async close() {
        await hub?.close();
      },
    },
  };
}
