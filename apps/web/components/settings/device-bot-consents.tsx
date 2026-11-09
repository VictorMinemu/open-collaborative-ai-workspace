"use client";

import type { Device, DeviceBotConsent, DeviceBotConsentRequest } from "@ocw/contracts";
import { Check, ShieldAlert, Trash2 } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import {
  useDeviceBotConsents,
  useRevokeDeviceBotConsent,
  useSetDeviceBotConsent,
} from "@/lib/device-bot-consent-queries";
import { cn, relativeTime } from "@/lib/utils";

/** Every sentence the block shows, in one place (the tests and the e2e read them). */
export const BOT_CONSENT_COPY = {
  heading: "Bots that may run sessions here",
  description: "A bot starts Work Zone sessions on this device only after you allow it.",
  empty: "No bot runs sessions on this device.",
  requestNote: "Wants to run Work Zone sessions here",
  allow: "Allow",
  fullAccess: "Allow Full access for this bot",
  fullAccessOff: "Full access is off on this device",
  fullAccessOn: "Its sessions may run without asking, when the bot's profile and the organization allow it",
  revoke: "Revoke",
  confirmRevoke: "Confirm revoke",
  readOnly: "Only the device's owner can change which bots run sessions here.",
  loadError: "Could not load the bots for this device.",
} as const;

/**
 * Who sees the block on a device card (D-03, D-22): the device's owner always, and an admin (`work_zone.manage`) only
 * on a device reporting itself as a headless server. The API decides again on every call (`viewerCan.grant`).
 */
export function showsBotConsents(device: Device, owned: boolean, canManageWorkZone: boolean): boolean {
  return owned || (canManageWorkZone && device.hostKind === "service");
}

/**
 * Settings › Devices › a device card › Bots (07.16-13, D-03, D-04, PD-06, PD-20). The owner decides which bots may
 * run Work Zone sessions on their machine: bots asking first (their profile names this device), then allowed bots.
 * The API decides who may grant and answers every change with the whole view; the list re-renders from it.
 */
export function DeviceBotConsents({ device }: { device: Device }) {
  const q = useDeviceBotConsents(device.id);
  // Not the viewer's to see (the API refused): the block is simply absent.
  if (q.isError && isApiError(q.error) && (q.error.status === 403 || q.error.status === 404)) return null;
  return (
    <div className="grid gap-3 border-t px-4 py-3" data-testid="device-bot-consents">
      <div>
        <p className="font-medium text-sm">{BOT_CONSENT_COPY.heading}</p>
        <p className="text-muted-foreground text-xs">{BOT_CONSENT_COPY.description}</p>
      </div>
      {q.isPending ? (
        <Skeleton className="h-10" />
      ) : q.isError ? (
        <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
          {BOT_CONSENT_COPY.loadError}
          <Button size="sm" variant="outline" onClick={() => void q.refetch()}>
            Retry
          </Button>
        </div>
      ) : q.data.requests.length === 0 && q.data.consents.length === 0 ? (
        <p className="text-muted-foreground text-sm">{BOT_CONSENT_COPY.empty}</p>
      ) : (
        <ConsentList
          device={device}
          requests={q.data.requests}
          consents={q.data.consents}
          canGrant={q.data.viewerCan.grant}
        />
      )}
    </div>
  );
}

function ConsentList({
  device,
  requests,
  consents,
  canGrant,
}: {
  device: Device;
  requests: DeviceBotConsentRequest[];
  consents: DeviceBotConsent[];
  canGrant: boolean;
}) {
  return (
    <>
      <ul className="grid gap-1" aria-label={`Bots on ${device.name}`}>
        {requests.map((r) => (
          <RequestRow key={r.agentId} device={device} request={r} canGrant={canGrant} />
        ))}
        {consents.map((c) => (
          <ConsentRow key={c.agentId} device={device} consent={c} canGrant={canGrant} />
        ))}
      </ul>
      {canGrant ? null : <p className="text-muted-foreground text-xs">{BOT_CONSENT_COPY.readOnly}</p>}
    </>
  );
}

function RequestRow({
  device,
  request: r,
  canGrant,
}: {
  device: Device;
  request: DeviceBotConsentRequest;
  canGrant: boolean;
}) {
  const set = useSetDeviceBotConsent(device.id);
  return (
    <li
      className="flex items-center gap-3 py-1.5"
      data-testid="bot-consent-request"
      data-agent-id={r.agentId}
    >
      <span className="flex min-w-0 flex-1 items-center gap-2.5">
        <PrincipalAvatar kind="agent" name={r.displayName} seed={r.agentId} className="size-6" />
        <span className="min-w-0">
          <span className="block truncate text-sm">
            <span className="font-medium">{r.displayName}</span>
            <span className="text-muted-foreground"> · asked by {r.sponsor.displayName}</span>
          </span>
          <span className="block truncate text-muted-foreground text-xs">{BOT_CONSENT_COPY.requestNote}</span>
        </span>
      </span>
      {canGrant ? (
        <Button
          size="sm"
          disabled={set.isPending}
          data-testid="bot-consent-allow"
          aria-label={`Allow ${r.displayName} to run sessions on ${device.name}`}
          onClick={() =>
            set.mutate(
              { agentId: r.agentId, allowFullAccess: false },
              { onError: (err) => toast.error(errorMessage(err)) },
            )
          }
        >
          {set.isPending ? <Spinner /> : <Check />}
          {BOT_CONSENT_COPY.allow}
        </Button>
      ) : null}
    </li>
  );
}

/** Revoke asks once (T-07.16-13-03): the first press turns it into "Confirm revoke". */
export function RevokeConsentButton({
  name,
  confirming,
  pending,
  onClick,
  onBlur,
}: {
  name: string;
  confirming: boolean;
  pending: boolean;
  onClick: () => void;
  onBlur?: () => void;
}) {
  return (
    <Button
      size="sm"
      variant={confirming ? "destructive" : "ghost"}
      disabled={pending}
      onClick={onClick}
      onBlur={onBlur}
      aria-label={`${confirming ? BOT_CONSENT_COPY.confirmRevoke : BOT_CONSENT_COPY.revoke} ${name}`}
      data-testid="bot-consent-revoke"
      className={cn(!confirming && "text-muted-foreground hover:text-destructive")}
    >
      {pending ? <Spinner /> : <Trash2 aria-hidden />}
      {confirming ? BOT_CONSENT_COPY.confirmRevoke : BOT_CONSENT_COPY.revoke}
    </Button>
  );
}

/**
 * An allowed bot: who allowed it and when, its own Full access checkbox (D-04: one leg of ADR-0012's chain, live only
 * while the device's own opt-in is on, which only the device sets) and Revoke.
 */
function ConsentRow({
  device,
  consent: c,
  canGrant,
}: {
  device: Device;
  consent: DeviceBotConsent;
  canGrant: boolean;
}) {
  const set = useSetDeviceBotConsent(device.id);
  const revoke = useRevokeDeviceBotConsent(device.id);
  const [confirming, setConfirming] = useState(false);
  const optedIn = device.fullAccessOptIn;
  const live = optedIn && c.allowFullAccess;
  const onError = (err: unknown) => toast.error(errorMessage(err));

  function onRevoke() {
    if (!confirming) {
      setConfirming(true);
      return;
    }
    revoke.mutate(c.agentId, { onError, onSettled: () => setConfirming(false) });
  }

  return (
    <li className="grid gap-2 py-1.5" data-testid="bot-consent-row" data-agent-id={c.agentId}>
      <div className="flex items-center gap-3">
        <span className="flex min-w-0 flex-1 items-center gap-2.5">
          <PrincipalAvatar kind="agent" name={c.displayName} seed={c.agentId} className="size-6" />
          <span className="min-w-0">
            <span className="block truncate font-medium text-sm">{c.displayName}</span>
            <span className="block truncate text-muted-foreground text-xs">
              Allowed by {c.grantedBy.displayName} · {relativeTime(c.grantedAt)}
            </span>
          </span>
        </span>
        {canGrant ? (
          <RevokeConsentButton
            name={c.displayName}
            confirming={confirming}
            pending={revoke.isPending}
            onClick={onRevoke}
            onBlur={() => setConfirming(false)}
          />
        ) : null}
      </div>
      <label
        className={cn(
          "ml-8.5 flex items-start gap-2.5 rounded-lg border bg-background px-3 py-2",
          optedIn && canGrant ? "cursor-pointer" : "cursor-not-allowed",
          live && "border-amber-300 dark:border-amber-400/40",
        )}
      >
        <input
          type="checkbox"
          checked={c.allowFullAccess}
          disabled={!optedIn || !canGrant || set.isPending}
          onChange={(e) => set.mutate({ agentId: c.agentId, allowFullAccess: e.target.checked }, { onError })}
          data-testid="bot-consent-full-access"
          data-agent-id={c.agentId}
          className="mt-0.5 size-4 shrink-0 accent-primary disabled:cursor-not-allowed"
        />
        <span className="grid min-w-0 flex-1 gap-0.5">
          <span
            className={cn(
              "flex items-center gap-1.5 font-medium text-[13px]",
              !optedIn && "text-muted-foreground",
            )}
          >
            {live ? (
              <ShieldAlert aria-hidden className="size-3.5 shrink-0 text-amber-700 dark:text-amber-300" />
            ) : null}
            {BOT_CONSENT_COPY.fullAccess}
          </span>
          <span className="text-muted-foreground text-xs">
            {optedIn ? BOT_CONSENT_COPY.fullAccessOn : BOT_CONSENT_COPY.fullAccessOff}
          </span>
        </span>
      </label>
    </li>
  );
}
