import {
  type BrowserServerFrame,
  type BrowserSignInLoadFrame,
  type BrowserSignInStateFrame,
  WORK_BROWSER_AUDIT,
  type WorkBrowserRefusal,
} from "@ocw/contracts";
import { type Tx, workBrowsers, workPrompts, workSessions } from "@ocw/db";
import { and, eq, inArray, sql } from "drizzle-orm";
import type { Core } from "../../core";
import type { DeviceRef } from "../device";
import type { PermissionService } from "../organization";
import { browserGrantFor } from "../work-session";
import { announceLease } from "./lease";
import { type OpenedSignIn, openWorkSignIn, siteKeyOfOrigin } from "./signins";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
/** The statuses of the turn a session is running now (the device was handed it and has not finished it). */
const IN_FLIGHT = ["dispatched", "running"] as const;

/** What the API answers one `browser.signin.load`: nothing (not this device's session), a refusal, or the member. */
export type SignInLoadDecision =
  | { kind: "ignore" }
  | { kind: "refuse"; reason: WorkBrowserRefusal }
  | { kind: "member"; userId: string; siteKey: string };

/**
 * D-24, D-29, D-32, PD-16: whether a member's sign-in may load into the page of `frame.sessionId`, decided from the
 * API's own state in the device's tenant (no user), never from anything else the frame says. In order:
 *
 * 1. the session runs on the sending device; otherwise the frame is ignored (no answer, nothing changes,
 *    T-07.13-17-05);
 * 2. the frame names the session's in-flight prompt (`dispatched` / `running` in THIS session), else
 *    `signin_not_allowed`;
 * 3. a human session and a human turn (not started by a bot, not written by a bot), else `signin_not_allowed`;
 * 4. 07's `browserGrantFor` for the prompt's author: the organization's policy ∩ the device's opt-in ∩ its capability
 *    (`not_allowed` when off), the author may still prompt the session on that device (D-29, else
 *    `signin_not_allowed`), and the audience rule (`app.work_session_viewers` ⊆ { author, device owner }, D-32, else
 *    `signin_not_allowed`);
 *
 * The sign-in looked up is then the AUTHOR's own for the origin's site (owner-only RLS, `openWorkSignIn`): someone else's
 * sign-in can never be named.
 */
export async function decideSignInLoad(
  tx: Tx,
  perms: PermissionService,
  device: DeviceRef,
  frame: BrowserSignInLoadFrame,
): Promise<SignInLoadDecision> {
  const [session] = await tx
    .select({
      id: workSessions.id,
      deviceId: workSessions.deviceId,
      startedByAgentId: workSessions.startedByAgentId,
    })
    .from(workSessions)
    .where(eq(workSessions.id, frame.sessionId))
    .limit(1);
  if (!session || session.deviceId !== device.deviceId) return { kind: "ignore" };
  const refuse = (reason: WorkBrowserRefusal): SignInLoadDecision => ({ kind: "refuse", reason });

  if (!UUID.test(frame.promptId)) return refuse("signin_not_allowed");
  const [prompt] = await tx
    .select({ authorUserId: workPrompts.authorUserId, authorAgentId: workPrompts.authorAgentId })
    .from(workPrompts)
    .where(
      and(
        eq(workPrompts.id, frame.promptId),
        eq(workPrompts.workSessionId, session.id),
        inArray(workPrompts.status, [...IN_FLIGHT]),
      ),
    )
    .limit(1);
  if (!prompt) return refuse("signin_not_allowed");
  if (session.startedByAgentId !== null || prompt.authorAgentId !== null) return refuse("signin_not_allowed");

  const grant = await browserGrantFor(tx, perms, {
    sessionId: session.id,
    askerId: prompt.authorUserId,
    askerIsBot: false,
  });
  if (!grant) return refuse("not_allowed");
  if (!grant.allowed) return refuse(grant.reason === "no_access" ? "signin_not_allowed" : "not_allowed");
  if (!grant.signinAllowed) return refuse("signin_not_allowed");

  const siteKey = siteKeyOfOrigin(frame.origin);
  if (!siteKey) return refuse("not_allowed");
  return { kind: "member", userId: prompt.authorUserId, siteKey };
}

/**
 * The `onSignInLoad` device handler (PD-16, P7): decides in the device's tenant, then — as the member, so the
 * owner-only policy is what lets the row be read — opens the sealed state, records it on the session's page
 * (`work_browsers.signin_id` / `signin_user_id`, which the live view's privacy gate and the browser approvals read),
 * marks it used and audits `work_browser.signin_loaded { origin }`, all in one transaction. The answer goes through
 * `reply`, which sends on the requesting socket only (never Redis, never the command queue).
 *
 * The state is held only by the reply frame: it is never assigned to anything that is logged, and every failure is
 * logged by its error name only.
 */
export function onSignInLoad(
  core: Core,
  perms: PermissionService,
  /** MD-02: this instance's live view learns of the load at once (the other instances through the announcement). */
  loaded: (organizationId: string, sessionId: string, userId: string) => void = () => {},
) {
  return async (
    device: DeviceRef,
    frame: BrowserSignInLoadFrame,
    reply: (frame: BrowserServerFrame) => void,
  ): Promise<void> => {
    const answer = (result: BrowserSignInStateFrame["result"]) =>
      reply({ type: "browser.signin.state", requestId: frame.requestId, result });
    const failed = (err: unknown, step: string) => {
      core.log.warn(
        {
          deviceId: device.deviceId,
          sessionId: frame.sessionId,
          step,
          error: (err as Error | undefined)?.name,
        },
        "work browser sign-in load failed",
      );
    };

    let decision: SignInLoadDecision;
    try {
      decision = await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
        decideSignInLoad(tx, perms, device, frame),
      );
    } catch (err) {
      failed(err, "decide");
      answer({ ok: false, reason: "not_allowed" });
      return;
    }
    if (decision.kind === "ignore") return;
    if (decision.kind === "refuse") {
      answer({ ok: false, reason: decision.reason });
      return;
    }

    const member = decision;
    let opened: OpenedSignIn | "expired" | null;
    try {
      opened = await core.db.withTenant(
        { organizationId: device.organizationId, userId: member.userId },
        async (tx) => {
          const found = await openWorkSignIn(tx, core, { userId: member.userId, siteKey: member.siteKey });
          if (!found || found === "expired") return found;
          await recordLoaded(tx, device, frame, found.signinId, member.userId);
          await core.audit.record(tx, {
            action: WORK_BROWSER_AUDIT.signin_loaded,
            actorKind: "device",
            actorId: device.deviceId,
            deviceId: device.deviceId,
            sessionId: frame.sessionId,
            userId: member.userId,
            resourceType: "work_browser_signin",
            resourceId: found.signinId,
            metadata: { origin: frame.origin },
          });
          return found;
        },
      );
    } catch (err) {
      failed(err, "open");
      answer({ ok: false, reason: "not_allowed" });
      return;
    }
    if (opened === null) {
      answer({ ok: false, reason: "no_context" });
      return;
    }
    if (opened === "expired") {
      answer({ ok: false, reason: "signin_expired" });
      return;
    }
    // MD-02 (D-27): the page is private for everyone but the member BEFORE the device has the state: this instance's
    // viewers at once, every other instance on the announcement (ids only; the 1 s poll stays the backstop).
    loaded(device.organizationId, frame.sessionId, member.userId);
    await announceLease(core.bus, device.organizationId, frame.sessionId);
    try {
      answer({ ok: true, signinId: opened.signinId, state: opened.state, expiresAt: opened.expiresAt });
    } catch (err) {
      // Not sent (the frame did not validate): the page holds nothing, so nothing stays recorded as loaded.
      failed(err, "reply");
      await clearLoaded(core, device, frame.sessionId, opened.signinId).catch(() => {});
      answer({ ok: false, reason: "too_large" });
    }
  };
}

/**
 * The page of the session now has the member's sign-in: its row records which one and whose (a row is created when the
 * load comes before the page's `opened` event).
 */
async function recordLoaded(
  tx: Tx,
  device: DeviceRef,
  frame: BrowserSignInLoadFrame,
  signinId: string,
  userId: string,
): Promise<void> {
  await tx
    .insert(workBrowsers)
    .values({
      workSessionId: frame.sessionId,
      organizationId: device.organizationId,
      state: "open",
      origin: frame.origin,
      signinId,
      signinUserId: userId,
    })
    .onConflictDoUpdate({
      target: workBrowsers.workSessionId,
      set: { signinId, signinUserId: userId, updatedAt: sql`now()` },
    });
}

/** Undo of `recordLoaded` when the answer could not be sent (user-less: the page row is the session's, not the member's). */
async function clearLoaded(
  core: Core,
  device: DeviceRef,
  sessionId: string,
  signinId: string,
): Promise<void> {
  await core.db.withTenant({ organizationId: device.organizationId, userId: null }, (tx) =>
    tx
      .update(workBrowsers)
      .set({ signinId: null, signinUserId: null, updatedAt: sql`now()` })
      .where(and(eq(workBrowsers.workSessionId, sessionId), eq(workBrowsers.signinId, signinId))),
  );
}
