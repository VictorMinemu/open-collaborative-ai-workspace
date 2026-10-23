import type { ActivityStep } from "@ocw/contracts";
import type { Tx } from "@ocw/db";
import type { ApiModule, Core } from "../../core";
import { createConversationAccess } from "../chat";
import { createPermissionService } from "../organization";
import type { SandboxdClient, SandboxEventsConsumer } from "../sandbox";
import { onBrowserEvent } from "./contexts";
import { type LiveViewHub, registerLiveView } from "./live-view";
import { registerBrowserRoutes } from "./routes";
import { purgeBotSessions } from "./sessions";
import { signInCardsProvider } from "./signin";
import { type BrowserSweeper, createBrowserSweeper } from "./sweep";

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
export {
  type DownloadDiscard,
  type DownloadTurn,
  downloadPaths,
  downloadPlace,
  type RoutedDownload,
  routeDownload,
} from "./downloads";
export { FrameSlot, LIVE_CLOSE, type LiveViewHub, type LiveViewStats } from "./live-view";
export {
  browserSessionAad,
  type KeptState,
  keepForSite,
  type LoadedSession,
  loadSessionFor,
  PURGE_AFTER_MS,
  resealSession,
  siteKeyOf,
} from "./sessions";
export { onHandBack, requestSignIn, SIGNIN_HOLD_MS, type SignInTurn, signInCard } from "./signin";
export { cardStatusOf } from "./signin-card";
export { BROWSER_SWEEP_MS, type BrowserSweeper } from "./sweep";
export { LEASE_CHANNEL, TAKEOVER_MS, TAKEOVER_WARN_MS } from "./takeover";

/**
 * The Browser module (07.8-14, 07.8-16; D-05…D-07, D-09, D-11, D-12, BRW-01…03): the bots' browser contexts as Control
 * Plane records, and the people's live view. The bots' routes live in the Agent Channel (`agent-channel/browser.ts`),
 * which decides every call before sandboxd sees it; this module owns the context rows, applies sandboxd's `browser`
 * events to them (host updates, crashes, closes) and serves `GET /api/v1/live/browser/:contextId` (watch, take control,
 * hand back; 16), the sign-in card, sealed member sessions, the people's `/browser-sessions` and the bot page's
 * Browser tab (21).
 */
export interface BrowserModule {
  module: ApiModule;
  /** The `browser` events handler, registered on the sandbox events consumer (`events.onEvent("browser", …)`). */
  onBrowserEvent: ReturnType<typeof onBrowserEvent>;
  /** This instance's live-view hub once the routes are registered (tests: `sweep`, `stats`). */
  live(): LiveViewHub | null;
  /** The sign-in expiry and session purge (07.8-21; tests call `runOnce(nowMs)`). */
  sweeper: BrowserSweeper;
  /** 07.8-28 (WINDOWS #287): a bot's (soft) deletion removes every member's sealed session with it, in its transaction. */
  onBotDeleted(tx: Tx, agentId: string): Promise<void>;
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
  const client = deps.client ?? null;
  // 07.8-21: chat reads the sign-in cards (their link, "Not now") through the bridge, never by importing this module.
  core.chatAgent.registerSignInCards(signInCardsProvider({ core, client }));
  const sweeper = createBrowserSweeper(core, client);
  let hub: LiveViewHub | null = null;
  return {
    onBrowserEvent: handler,
    live: () => hub,
    sweeper,
    async onBotDeleted(tx, agentId) {
      await purgeBotSessions(tx, core, agentId);
    },
    module: {
      name: "browser",
      register(app) {
        const perms = createPermissionService(core);
        const access = createConversationAccess(core);
        hub = registerLiveView(app, {
          core,
          perms,
          access,
          client,
          allowedOrigins: deps.allowedOrigins ?? new Set(),
          ...(deps.activityPhrase ? { activityPhrase: deps.activityPhrase } : {}),
        });
        // 07.8-21: the member's own sessions (Keychain) and the bot page's Browser tab.
        registerBrowserRoutes(app, { core, perms, access, client });
        sweeper.start();
      },
      async close() {
        sweeper.stop();
        await hub?.close();
      },
    },
  };
}
