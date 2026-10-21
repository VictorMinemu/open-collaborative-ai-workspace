import type { ApiModule, Core } from "../../core";
import type { SandboxEventsConsumer } from "../sandbox";
import { onBrowserEvent } from "./contexts";

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

/**
 * The Browser module (07.8-14; D-05, D-09, D-12, BRW-01): the bots' browser contexts as Control Plane records. The bots'
 * routes live in the Agent Channel (`agent-channel/browser.ts`), which decides every call before sandboxd sees it; this
 * module owns the context rows and applies sandboxd's `browser` events to them (host updates, crashes, closes). Plan 16
 * adds the live view and takeover, plan 21 sign-in and sealed sessions, plan 27 the people's Browser tab.
 */
export interface BrowserModule {
  module: ApiModule;
  /** The `browser` events handler, registered on the sandbox events consumer (`events.onEvent("browser", …)`). */
  onBrowserEvent: ReturnType<typeof onBrowserEvent>;
}

export function createBrowserModule(
  core: Core,
  deps: { events?: Pick<SandboxEventsConsumer, "onEvent"> | null } = {},
): BrowserModule {
  const handler = onBrowserEvent(core);
  deps.events?.onEvent("browser", handler);
  return {
    onBrowserEvent: handler,
    module: {
      name: "browser",
      register() {
        // No people's routes yet: the live view (16) and the Browser tab (27) add them.
      },
    },
  };
}
