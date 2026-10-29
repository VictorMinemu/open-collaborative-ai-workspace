"use client";

import { normalizeUserCode, type PairingRequestView } from "@ocw/contracts";
import { CheckCircle2, CircleAlert, ShieldAlert, X } from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage, isApiError } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useApprovePairing, useDenyPairing, useDevices, usePairingLookup } from "@/lib/workzone-queries";

/**
 * Settings › Devices › Pair a server (07.12, D-03, PD-14): the owner's side of terminal pairing. A server that ran
 * `ocw-runtime setup` (or `enroll` without a code) prints a code and a link to this page with `?pair=<code>`; the owner
 * compares the code, sees what asked (name, platform, request IP, age: RFC 8628 §5.4) and approves it under a name, or
 * denies it. Nothing is decided on load: approval is an explicit press (T-07.12-07-01). After approval the server picks
 * up its token on its next poll and the device appears in the list, which turns this dialog into "Device connected".
 */

export const PLATFORM_LABEL: Record<string, string> = { darwin: "macOS", linux: "Linux", win32: "Windows" };

const NOT_FOUND =
  "This code is not valid or has expired. Check the code on the server, or run the command again.";

/** The words for every refusal the three pairing routes send (and the network failure). */
export function pairErrorText(err: unknown): string {
  if (isApiError(err) && !err.isNetwork) {
    if (err.status === 404) return NOT_FOUND;
    if (err.status === 409) return "This request was already approved or denied.";
    if (err.status === 403) return "You can't pair devices in this organization.";
    if (err.status === 429) return "Too many attempts. Wait a minute and try again.";
  }
  return errorMessage(err);
}

/** "just now", "2 min ago", "2 h ago": how long ago the server asked (a request lives 10 minutes). */
export function requestAge(iso: string, now: number = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - Date.parse(iso)) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes} min ago`;
  return `${Math.floor(minutes / 60)} h ago`;
}

const TAP = "max-lg:h-11";

/** A pairing-code field and its Continue (the Server tab, and "try another code" after an error). */
export function PairCodeField({
  value,
  onChange,
  onSubmit,
  label = "Pairing code",
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (canonical: string) => void;
  label?: string;
}) {
  const canonical = normalizeUserCode(value);
  return (
    <form
      className="flex gap-2"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (canonical) onSubmit(canonical);
      }}
    >
      <Input
        aria-label={label}
        data-testid="pair-code-input"
        value={value}
        onChange={(e) => onChange(e.target.value.toUpperCase())}
        placeholder="XXXX-XXXX"
        autoComplete="off"
        autoCapitalize="characters"
        spellCheck={false}
        inputMode="text"
        maxLength={9}
        className={cn("min-w-0 flex-1 font-mono tracking-[0.12em] placeholder:tracking-[0.12em]", TAP)}
      />
      <Button type="submit" disabled={!canonical} data-testid="pair-code-continue" className={TAP}>
        Continue
      </Button>
    </form>
  );
}

/** The request as the owner checks it before approving: the code, the name to give it, the facts and the warning. */
export function PairRequestDetails({
  request,
  now,
  name,
  onNameChange,
}: {
  request: PairingRequestView;
  now: number;
  name: string;
  onNameChange: (name: string) => void;
}) {
  const nameId = useId();
  return (
    <div className="grid gap-5">
      <div className="grid justify-items-center gap-1.5 rounded-xl border bg-muted/40 px-4 py-5 text-center">
        <p
          data-testid="pair-request-code"
          className="break-all font-mono font-semibold text-3xl tracking-[0.18em]"
        >
          {request.userCode}
        </p>
        <p className="text-muted-foreground text-xs">Check that the server shows the same code</p>
      </div>

      <div className="grid gap-2">
        <Label htmlFor={nameId}>Device name</Label>
        <Input
          id={nameId}
          data-testid="pair-request-name"
          value={name}
          maxLength={80}
          autoComplete="off"
          onChange={(e) => onNameChange(e.target.value)}
          aria-invalid={name.trim() === "" || undefined}
          className={TAP}
        />
      </div>

      <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-1.5 text-sm">
        <dt className="text-muted-foreground">Platform</dt>
        <dd data-testid="pair-request-platform">{PLATFORM_LABEL[request.platform] ?? request.platform}</dd>
        {request.requestIp ? (
          <>
            <dt className="text-muted-foreground">Request from</dt>
            <dd data-testid="pair-request-ip" className="break-all font-mono text-[13px]">
              {request.requestIp}
            </dd>
          </>
        ) : null}
        <dt className="text-muted-foreground">Requested</dt>
        <dd data-testid="pair-request-age">{requestAge(request.requestedAt, now)}</dd>
        {request.runtimeVersion ? (
          <>
            <dt className="text-muted-foreground">Runtime</dt>
            <dd data-testid="pair-request-runtime" className="break-all">
              ocw-runtime {request.runtimeVersion}
            </dd>
          </>
        ) : null}
      </dl>

      <p className="flex gap-2.5 text-muted-foreground text-sm" data-testid="pair-request-warning">
        <ShieldAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
        <span>
          Only approve a code you started yourself, on a computer you control. Approving adds it to your
          devices.
        </span>
      </p>
    </div>
  );
}

type View = "loading" | "error" | "request" | "waiting" | "connected";

export function PairApproveDialog({
  code,
  open,
  onOpenChange,
  allowed = true,
}: {
  /** The code from `?pair=` or the Server tab, as typed. */
  code: string | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** False once `device.pair` is decided off: the dialog says so and never calls the API (T-07.12-07-04). */
  allowed?: boolean;
}) {
  // Each opening gets fresh content (a new key), while a closing dialog keeps showing what it showed during its fade
  // (the last code, the last state) instead of flashing an empty or error state.
  const [opening, setOpening] = useState(0);
  const [wasOpen, setWasOpen] = useState(open);
  if (open !== wasOpen) {
    setWasOpen(open);
    if (open) setOpening((n) => n + 1);
  }
  const last = useRef(code);
  if (code) last.current = code;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-testid="pair-approve-dialog">
        <PairApproveContent
          key={opening}
          code={code ?? last.current}
          active={open}
          allowed={allowed}
          onClose={() => onOpenChange(false)}
        />
      </DialogContent>
    </Dialog>
  );
}

function PairApproveContent({
  code,
  active,
  allowed,
  onClose,
}: {
  code: string | null;
  active: boolean;
  allowed: boolean;
  onClose: () => void;
}) {
  // A code typed after an error wins over the one the dialog was opened with.
  const [typed, setTyped] = useState<string | null>(null);
  const current = typed ?? code;
  const [retry, setRetry] = useState("");
  const [name, setName] = useState("");
  const [failure, setFailure] = useState<unknown>(null);
  const [approved, setApproved] = useState<{ name: string } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const baseline = useRef<Set<string>>(new Set());

  const canonical = current ? normalizeUserCode(current) : null;
  const lookup = usePairingLookup(canonical, allowed && !approved && !failure);
  const approve = useApprovePairing();
  const deny = useDenyPairing();
  const devices = useDevices();

  useEffect(() => {
    if (lookup.data) setName(lookup.data.name);
  }, [lookup.data]);

  useEffect(() => {
    if (!active) return;
    const t = setInterval(() => setNow(Date.now()), 15_000);
    return () => clearInterval(t);
  }, [active]);

  // The device row is written when the server picks up its token; match the approved name among new ids.
  const connected = approved
    ? (devices.data ?? []).find((d) => !baseline.current.has(d.id) && d.name === approved.name)
    : undefined;

  // The org topic refreshes the list when the device appears; a slow poll covers a missed frame.
  const { refetch } = devices;
  useEffect(() => {
    if (!active || !approved || connected) return;
    const t = setInterval(() => void refetch(), 3000);
    return () => clearInterval(t);
  }, [active, approved, connected, refetch]);

  const view: View = !allowed
    ? "error"
    : connected
      ? "connected"
      : approved
        ? "waiting"
        : failure || !canonical || lookup.isError
          ? "error"
          : lookup.data
            ? "request"
            : "loading";
  const errorText = !allowed
    ? "You can't pair devices in this organization."
    : failure
      ? pairErrorText(failure)
      : lookup.isError
        ? pairErrorText(lookup.error)
        : NOT_FOUND;

  const decided = (err: unknown) => {
    if (isApiError(err, 404) || isApiError(err, 409)) setFailure(err);
    else toast.error(pairErrorText(err));
  };

  function onApprove() {
    if (!canonical || !name.trim()) return;
    const chosen = name.trim();
    baseline.current = new Set((devices.data ?? []).map((d) => d.id));
    approve.mutate(
      { userCode: canonical, name: chosen },
      { onSuccess: () => setApproved({ name: chosen }), onError: decided },
    );
  }

  function onDeny() {
    if (!canonical) return;
    deny.mutate(
      { userCode: canonical },
      {
        onSuccess: () => {
          toast.success("Pairing denied");
          onClose();
        },
        onError: decided,
      },
    );
  }

  function tryAnother(next: string) {
    setFailure(null);
    setRetry("");
    setTyped(next);
  }

  const busy = approve.isPending || deny.isPending;
  const title = view === "connected" ? "Device connected" : "Pair a server";
  const description =
    view === "connected"
      ? "It is ready for Work Zone sessions."
      : view === "waiting"
        ? "The server finishes pairing on its next check, within a few seconds."
        : view === "error"
          ? "Pair a computer that asked to join from its terminal."
          : "A computer asked to join your Work Zone devices.";

  return (
    <>
      <DialogHeader>
        <DialogTitle>{title}</DialogTitle>
        <DialogDescription>{description}</DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-5">
        {view === "loading" ? (
          <div className="grid gap-5" aria-busy="true">
            <span className="sr-only">Loading the request</span>
            <Skeleton className="h-24 rounded-xl" />
            <Skeleton className="h-9" />
            <Skeleton className="h-20" />
          </div>
        ) : view === "error" ? (
          <div className="grid gap-4">
            <p
              role="alert"
              data-testid="pair-error"
              className="flex gap-2.5 rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm"
            >
              <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
              <span>{errorText}</span>
            </p>
            {allowed && !isApiError(failure ?? lookup.error, 403) ? (
              <div className="grid gap-2">
                <p className="font-medium text-[13px]">Try another code</p>
                <PairCodeField value={retry} onChange={setRetry} onSubmit={tryAnother} />
              </div>
            ) : null}
          </div>
        ) : view === "request" && lookup.data ? (
          <PairRequestDetails request={lookup.data} now={now} name={name} onNameChange={setName} />
        ) : view === "waiting" ? (
          <div
            className="flex flex-col items-center gap-3 py-6 text-center"
            data-testid="pair-approved"
            aria-live="polite"
          >
            <Spinner className="size-6 text-muted-foreground" />
            <p className="font-medium">Approved · waiting for the server</p>
            <p className="max-w-sm break-words text-muted-foreground text-sm">{approved?.name}</p>
          </div>
        ) : connected ? (
          <div
            className="flex flex-col items-center gap-3 py-6 text-center"
            data-testid="pair-connected"
            aria-live="polite"
          >
            <CheckCircle2 className="size-10 text-success" aria-hidden />
            <p className="max-w-full break-words font-medium" data-testid="pair-connected-name">
              {connected.name}
            </p>
            <p className="max-w-sm text-muted-foreground text-sm">
              Share it with members and teams from its card.
            </p>
          </div>
        ) : null}
      </DialogBody>
      <DialogFooter>
        {view === "request" ? (
          <>
            <Button
              variant="outline"
              onClick={onDeny}
              disabled={busy}
              data-testid="pair-deny"
              className={cn("w-full sm:w-auto", TAP)}
            >
              {deny.isPending ? <Spinner /> : <X />} Deny
            </Button>
            <Button
              onClick={onApprove}
              disabled={busy || !name.trim()}
              data-testid="pair-approve"
              className={cn("w-full sm:w-auto", TAP)}
            >
              {approve.isPending ? <Spinner /> : <CheckCircle2 />} Approve
            </Button>
          </>
        ) : view === "connected" ? (
          <Button onClick={onClose} data-testid="pair-done" className={cn("w-full sm:w-auto", TAP)}>
            Done
          </Button>
        ) : (
          <Button variant="outline" onClick={onClose} className={cn("w-full sm:w-auto", TAP)}>
            Close
          </Button>
        )}
      </DialogFooter>
    </>
  );
}
