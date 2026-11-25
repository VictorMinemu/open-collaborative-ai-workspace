import type { BrowserCloseFrame } from "@ocw/contracts";
import { workBrowsers, workSessions } from "@ocw/db";
import { and, eq, isNotNull } from "drizzle-orm";
import type { Core } from "../../core";
import type { DeviceHub } from "../device";
import type { PermissionService } from "../organization";
import { browserGrantFor } from "../work-session";

/**
 * 07.13 review MD-03 (D-24, D-29, D-32): a member's sign-in stays loaded only while the load's own decision would still
 * allow it. Whenever access may have changed in an organization (the gateway's invalidation bus: a member deactivated or
 * their role changed, a device grant, a unit, a rule, a team project or a session's audience), every open page of that
 * organization with a sign-in loaded is decided again exactly as `decideSignInLoad` decides it (`browserGrantFor` for
 * the member: the policy, the device's opt-in, their prompt right, the audience rule), and a page whose sign-in row is
 * gone (the member left the organization, or it was revoked) fails it too. A page that fails is closed on its device:
 * `browser.close { reason: "policy" }` when the organization turned the browser off, else `access_lost`. The device's
 * `closed` event then clears the row; until it does, the page stays private to the member.
 *
 * Only the instance that holds the device's link acts (`isConnectedHere`), so one close goes out per page. Coalesced per
 * organization: one check runs at a time, and one more after it when another invalidation arrived meanwhile. Each check
 * runs in the organization's own user-less transaction (RLS: no other organization's row is read).
 */
export interface AccessWatch {
  /** One check of `organizationId` now (tests; the invalidation listener calls it). */
  check(organizationId: string): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export function createAccessWatch(
  core: Core,
  perms: PermissionService,
  hub: Pick<DeviceHub, "sendBrowserFrame" | "isConnectedHere">,
): AccessWatch {
  const running = new Map<string, { again: boolean; done: Promise<void> }>();
  let unsubscribe: (() => Promise<void>) | null = null;

  async function once(organizationId: string): Promise<void> {
    const closes = await core.db.withTenant({ organizationId, userId: null }, async (tx) => {
      const pages = await tx
        .select({
          sessionId: workBrowsers.workSessionId,
          signinId: workBrowsers.signinId,
          userId: workBrowsers.signinUserId,
          deviceId: workSessions.deviceId,
        })
        .from(workBrowsers)
        .innerJoin(workSessions, eq(workSessions.id, workBrowsers.workSessionId))
        .where(and(eq(workBrowsers.state, "open"), isNotNull(workBrowsers.signinUserId)));
      const out: Array<{ deviceId: string; sessionId: string; reason: BrowserCloseFrame["reason"] }> = [];
      for (const page of pages) {
        if (!page.userId || !hub.isConnectedHere(page.deviceId)) continue;
        const grant =
          page.signinId === null
            ? null
            : await browserGrantFor(tx, perms, {
                sessionId: page.sessionId,
                askerId: page.userId,
                askerIsBot: false,
              });
        if (grant?.allowed && grant.signinAllowed) continue;
        out.push({
          deviceId: page.deviceId,
          sessionId: page.sessionId,
          reason: grant?.reason === "off_policy" ? "policy" : "access_lost",
        });
      }
      return out;
    });
    for (const c of closes) {
      await hub
        .sendBrowserFrame(c.deviceId, { type: "browser.close", sessionId: c.sessionId, reason: c.reason })
        .catch(() => {});
    }
  }

  function check(organizationId: string): Promise<void> {
    const current = running.get(organizationId);
    if (current) {
      current.again = true;
      return current.done;
    }
    const state = { again: false, done: Promise.resolve() };
    state.done = (async () => {
      try {
        do {
          state.again = false;
          await once(organizationId).catch((err: unknown) =>
            core.log.warn(
              { organizationId, error: (err as Error | undefined)?.name },
              "work browser access check failed",
            ),
          );
        } while (state.again);
      } finally {
        running.delete(organizationId);
      }
    })();
    running.set(organizationId, state);
    return state.done;
  }

  return {
    check,
    async start() {
      unsubscribe ??= await core.realtime.onSubscriptionInvalidation((ev) => {
        void check(ev.organizationId);
      });
    },
    async stop() {
      const stop = unsubscribe;
      unsubscribe = null;
      await stop?.().catch(() => {});
    },
  };
}
