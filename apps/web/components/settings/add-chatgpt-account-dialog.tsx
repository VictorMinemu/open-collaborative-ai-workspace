"use client";

import {
  type Device,
  type DeviceSignIn,
  POOL_LIMITS,
  PoolLabel,
  type PoolSignInErrorCode,
  type ProviderAuthErrorCode,
  type ProviderAuthStatus,
} from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowUpRight,
  Bot,
  Check,
  Copy,
  LogIn,
  type LucideIcon,
  RefreshCw,
  Server,
  Terminal,
} from "lucide-react";
import { type FormEvent, useEffect, useId, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/panel-dialog";
import { Spinner } from "@/components/ui/spinner";
import { useCopy } from "@/hooks/use-copy";
import {
  cancelBotPoolSignInMutation,
  cancelDeviceSignInMutation,
  forgetSignIn,
  onSignInConnected,
  useBotPoolSignIn,
  useCancelBotPoolSignIn,
  useCancelDeviceSignIn,
  useDeviceSignIn,
  useStartBotPoolSignIn,
  useStartDeviceSignIn,
} from "@/lib/account-pool-queries";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useDevices } from "@/lib/workzone-queries";
import { CopyLine } from "./copy-line";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

export const WHERE_QUESTION = "Where will this account be used?";
const LABEL_HINT = "Usually the account's e-mail. Members see it.";

export type Where = "bots" | "device";

const WHERE_OPTIONS: Array<{ value: Where; label: string; description: string; icon: LucideIcon }> = [
  { value: "bots", label: "For bots", description: "Signs in inside the bots runtime.", icon: Bot },
  {
    value: "device",
    label: "On a device",
    description: "Work Zone sessions on one device.",
    icon: Server,
  },
];

export interface DeviceChoice {
  id: string;
  name: string;
  /** Offline: nothing to do there now. */
  disabled: boolean;
  /** R3.2: a laptop this admin may not use: the dialog shows the command to run on it instead of Start. */
  command: boolean;
  reason: string | null;
}

/**
 * Live devices (07.18-19 R3.2): first those this admin may sign in on from here (an online server device, or a laptop
 * the admin owns or that is shared with them: `device.use`), then laptops that are not shared (the command to run on
 * them), then offline ones, disabled with the reason. The API decides again on Start.
 */
export function deviceChoices(devices: readonly Device[]): DeviceChoice[] {
  const choices = devices
    .filter((d) => d.revokedAt === null)
    .map((d): DeviceChoice => {
      if (d.status !== "online") {
        return { id: d.id, name: d.name, disabled: true, command: false, reason: "Offline" };
      }
      const command = d.hostKind !== "service" && !(d.viewerCan?.includes("device.use") ?? false);
      return {
        id: d.id,
        name: d.name,
        disabled: false,
        command,
        reason: command ? "Not shared with you" : null,
      };
    });
  const rank = (c: DeviceChoice) => (c.disabled ? 2 : c.command ? 1 : 0);
  return [...choices].sort((a, b) => rank(a) - rank(b));
}

/** A shell word: double quotes when nothing in it expands there, else single quotes. */
function shellQuote(value: string): string {
  if (!/["$`\\!]/.test(value)) return `"${value}"`;
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/**
 * R3.2: the exact command that adds a ChatGPT account on the device itself (`ocw-runtime account add codex`, run as
 * the user the runtime runs as); null until there is a label to put in it.
 */
export function codexAddCommand(label: string): string | null {
  const parsed = PoolLabel.safeParse(label);
  if (!parsed.success) return null;
  return `ocw-runtime account add codex --label ${shellQuote(parsed.data)}`;
}

/** One sign-in as this dialog shows it, whichever route runs it. */
export interface SignInView {
  state: "starting" | "pending" | "connected" | "error";
  verificationUrl: string | null;
  userCode: string | null;
  expiresAt: string | null;
  error: { code: PoolSignInErrorCode | ProviderAuthErrorCode; message: string } | null;
}

export function viewOfDeviceSignIn(s: DeviceSignIn | null): SignInView | null {
  if (!s) return null;
  return {
    state: s.state,
    verificationUrl: s.verificationUrl,
    userCode: s.userCode,
    expiresAt: s.expiresAt,
    error: s.error,
  };
}

/** Only the flow this dialog started (the route is shared with Settings › Models); idle is nothing to show. */
export function viewOfBotSignIn(s: ProviderAuthStatus | null, flowId: string | null): SignInView | null {
  if (!s || !flowId || s.flowId !== flowId || s.state === "idle") return null;
  return {
    state: s.state,
    verificationUrl: s.verificationUrl,
    userCode: s.userCode,
    expiresAt: s.expiresAt,
    error: s.error,
  };
}

/** Every way a sign-in ends without an account, in plain words; `failed` keeps the API's own sentence. */
export function signInErrorText(
  code: PoolSignInErrorCode | ProviderAuthErrorCode,
  message: string,
  where: Where,
): string {
  switch (code) {
    case "expired":
      return "The code expired before it was used.";
    case "denied":
      return "The sign-in was declined.";
    case "cancelled":
      return "Sign-in cancelled.";
    case "device_offline":
      return "The device went offline. Check that it's running, then try again.";
    case "runtime_too_old":
      return "Update the OCW runtime on this device, then try again.";
    case "cell_offline":
      return "The bots runtime is offline. Start it in Settings › Bots runtime, then try again.";
    case "unsupported":
      return where === "device"
        ? "Update Codex on this device and try again."
        : "ChatGPT doesn't allow sign-in with a code for this account.";
    case "failed":
      return message || "The sign-in did not finish. Try again.";
  }
}

function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** Ticks every second while `active` (the code's countdown). */
function useNow(active: boolean, fixed?: number): number {
  const [now, setNow] = useState(() => fixed ?? Date.now());
  useEffect(() => {
    if (!active || fixed !== undefined) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [active, fixed]);
  return fixed ?? now;
}

/**
 * Settings › Account pool › Add ChatGPT account (D-02, D-10): for bots (the sign-in runs inside the bots runtime) or
 * on a server device (Codex's device code runs there). The dialog shows the verification link and the one-time code
 * and closes once the account is connected. Closing it while a sign-in runs cancels the sign-in, and the code leaves
 * the page (T-07.18-15-02).
 */
export function AddChatgptAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-chatgpt-account-dialog" className="sm:max-w-lg">
        {open ? <ChatgptAccountForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** The whole flow; `initial` is only for tests that render a chosen state. */
export function ChatgptAccountForm({
  onDone,
  initial,
}: {
  onDone: () => void;
  initial?: { where?: Where; label?: string; deviceId?: string };
}) {
  const qc = useQueryClient();
  const id = useId();
  const devices = useDevices();
  const startBot = useStartBotPoolSignIn();
  const startDevice = useStartDeviceSignIn();
  const cancelBot = useCancelBotPoolSignIn();
  const cancelDevice = useCancelDeviceSignIn();

  const [where, setWhere] = useState<Where>(initial?.where ?? "bots");
  const [label, setLabel] = useState(initial?.label ?? "");
  const [picked, setPicked] = useState<string | null>(initial?.deviceId ?? null);
  const [signing, setSigning] = useState(false);
  const [flowId, setFlowId] = useState<string | null>(null);
  const [startError, setStartError] = useState<string | null>(null);

  const choices = deviceChoices(devices.data ?? []);
  const usable = choices.filter((c) => !c.disabled);
  const deviceId = picked && usable.some((c) => c.id === picked) ? picked : (usable[0]?.id ?? null);
  const chosen = choices.find((c) => c.id === deviceId) ?? null;
  const deviceName = chosen?.name ?? "the device";
  // R3.2: a laptop not shared with this admin gets the command to run there, not a sign-in from here.
  const byCommand = where === "device" && chosen?.command === true;
  const command = byCommand ? codexAddCommand(label) : null;

  const botFlow = useBotPoolSignIn(signing && where === "bots");
  const deviceFlow = useDeviceSignIn(deviceId, signing && where === "device");
  const view =
    where === "bots"
      ? viewOfBotSignIn(botFlow.data ?? null, flowId)
      : viewOfDeviceSignIn(deviceFlow.data ?? null);
  const shown: SignInView = view ?? {
    state: "starting",
    verificationUrl: null,
    userCode: null,
    expiresAt: null,
    error: null,
  };
  const running = signing && (shown.state === "starting" || shown.state === "pending");
  const starting = startBot.isPending || startDevice.isPending;
  const labelOk = PoolLabel.safeParse(label).success;
  const canStart = labelOk && (where === "bots" || (deviceId !== null && !byCommand)) && !starting;

  // Closing the dialog mid-flow (Escape, the X, the backdrop) cancels the sign-in and drops the code.
  const live = useRef({ running, where, deviceId, stopped: false });
  live.current = { ...live.current, running, where, deviceId };
  const done = useRef(onDone);
  done.current = onDone;
  useEffect(
    () => () => {
      const { running: wasRunning, where: w, deviceId: d, stopped } = live.current;
      if (wasRunning && !stopped) {
        const cancel =
          w === "bots"
            ? cancelBotPoolSignInMutation(qc).mutationFn()
            : d
              ? cancelDeviceSignInMutation(qc).mutationFn(d)
              : null;
        void cancel?.catch(() => undefined);
      }
      forgetSignIn(qc, d);
    },
    [qc],
  );

  const connected = signing && shown.state === "connected";
  useEffect(() => {
    if (!connected) return;
    onSignInConnected(qc);
    toast.success("ChatGPT account added", { description: "It's in the pool and ready to use." });
    const t = setTimeout(() => done.current(), 1200);
    return () => clearTimeout(t);
  }, [connected, qc]);

  async function start(restart = false) {
    setStartError(null);
    try {
      if (where === "bots") {
        const status = await startBot.mutateAsync({ label: label.trim(), ...(restart ? { restart } : {}) });
        setFlowId(status.flowId);
      } else if (deviceId) {
        await startDevice.mutateAsync({ deviceId, label: label.trim() });
      }
      setSigning(true);
    } catch (err) {
      setSigning(false);
      setStartError(errorMessage(err));
    }
  }

  async function cancel() {
    live.current.stopped = true;
    try {
      if (where === "bots") await cancelBot.mutateAsync();
      else if (deviceId) await cancelDevice.mutateAsync(deviceId);
    } catch {
      // The sign-in ends on its own when its code expires.
    }
    onDone();
  }

  function submit(e: FormEvent) {
    e.preventDefault();
    if (canStart) void start();
  }

  if (signing) {
    return (
      <div className="flex min-h-0 flex-col">
        <DialogHeader>
          <DialogTitle>Sign in {label.trim()}</DialogTitle>
          <DialogDescription>
            {where === "bots" ? "In the bots runtime." : `On ${deviceName}.`} Use the ChatGPT account you want
            to add.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          <SignInCodeView
            view={shown}
            where={where}
            cancelling={cancelBot.isPending || cancelDevice.isPending}
            retrying={starting}
            onCancel={() => void cancel()}
            onRetry={() => void start(true)}
          />
        </DialogBody>
        {running ? null : (
          <DialogFooter>
            <Button variant="outline" onClick={onDone} className={TOUCH} data-testid="chatgpt-sign-in-close">
              Close
            </Button>
          </DialogFooter>
        )}
      </div>
    );
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>Add ChatGPT account</DialogTitle>
        <DialogDescription>
          A ChatGPT Plus, Pro or Business subscription the organization can use.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-5">
        <fieldset className="grid gap-2">
          <legend className="mb-2 font-medium text-sm">{WHERE_QUESTION}</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {WHERE_OPTIONS.map((o) => {
              const on = where === o.value;
              return (
                <label
                  key={o.value}
                  data-testid={`chatgpt-where-${o.value}`}
                  className={cn(
                    "flex cursor-pointer items-start gap-3 rounded-xl border bg-card p-3.5 shadow-xs transition-colors has-focus-visible:ring-[3px] has-focus-visible:ring-ring/40",
                    on && "border-primary/50 bg-brand-soft/40 ring-1 ring-primary/30",
                  )}
                >
                  <input
                    type="radio"
                    name={`${id}-where`}
                    value={o.value}
                    checked={on}
                    onChange={() => {
                      setWhere(o.value);
                      setStartError(null);
                    }}
                    className="sr-only"
                  />
                  <o.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                  <span className="min-w-0">
                    <span className="block font-medium text-sm">{o.label}</span>
                    <span className="mt-0.5 block text-muted-foreground text-xs leading-snug">
                      {o.description}
                    </span>
                  </span>
                </label>
              );
            })}
          </div>
        </fieldset>

        {where === "device" ? (
          <fieldset className="grid gap-2" data-testid="chatgpt-devices">
            <legend className="mb-2 font-medium text-sm">Device</legend>
            {devices.isPending ? (
              <p className="text-muted-foreground text-sm">Loading devices…</p>
            ) : usable.length === 0 ? (
              <p className="rounded-xl border border-dashed px-3 py-3 text-muted-foreground text-sm">
                No device is online. Start the OCW runtime on a server or a computer, then come back (Settings
                › Devices).
              </p>
            ) : null}
            {choices.length > 0 ? (
              <div className="grid gap-1.5">
                {choices.map((c) => (
                  <label
                    key={c.id}
                    className={cn(
                      "flex min-h-11 items-center gap-3 rounded-lg border px-3 py-2 text-sm has-focus-visible:ring-[3px] has-focus-visible:ring-ring/40",
                      c.disabled ? "cursor-not-allowed bg-muted/30 text-muted-foreground" : "cursor-pointer",
                      c.id === deviceId && "border-primary/50 bg-brand-soft/40",
                    )}
                  >
                    <input
                      type="radio"
                      name={`${id}-device`}
                      value={c.id}
                      checked={c.id === deviceId}
                      disabled={c.disabled}
                      onChange={() => setPicked(c.id)}
                      className="size-4 shrink-0 accent-primary"
                    />
                    <span className="min-w-0 flex-1 truncate">{c.name}</span>
                    {c.reason ? <span className="shrink-0 text-xs">{c.reason}</span> : null}
                  </label>
                ))}
              </div>
            ) : null}
          </fieldset>
        ) : null}

        <FormField id={`${id}-label`} label="Label" hint={LABEL_HINT} error={startError ?? undefined}>
          <Input
            id={`${id}-label`}
            type="text"
            value={label}
            onChange={(e) => {
              setLabel(e.target.value);
              setStartError(null);
            }}
            maxLength={POOL_LIMITS.labelMax}
            placeholder="ops@acme.com"
            autoComplete="off"
            aria-invalid={!!startError}
            aria-describedby={describedBy(`${id}-label`, startError ?? undefined, LABEL_HINT)}
            className={TOUCH}
            data-testid="chatgpt-account-label"
          />
        </FormField>
        {byCommand ? <DeviceCommand deviceName={deviceName} command={command} /> : null}
      </DialogBody>
      <DialogFooter>
        {byCommand ? (
          <Button type="button" onClick={onDone} className={TOUCH} data-testid="chatgpt-command-done">
            Done
          </Button>
        ) : (
          <>
            <Button type="button" variant="outline" onClick={onDone} className={TOUCH}>
              Cancel
            </Button>
            <Button type="submit" disabled={!canStart} className={TOUCH} data-testid="chatgpt-account-start">
              {starting ? <Spinner /> : <LogIn />}
              Start sign-in
            </Button>
          </>
        )}
      </DialogFooter>
    </form>
  );
}

/**
 * R3.2: the command for a laptop this admin may not sign in on from here. It runs there as the user the runtime runs
 * as; the account then appears in the pool turned off, for an admin to turn on.
 */
function DeviceCommand({ deviceName, command }: { deviceName: string; command: string | null }) {
  return (
    <div
      className="grid gap-2.5 rounded-xl border bg-muted/30 p-3.5 text-sm"
      data-testid="chatgpt-device-command"
    >
      <p className="flex items-start gap-2.5 leading-relaxed">
        <Terminal aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
        <span className="min-w-0">
          <span className="font-medium">Run this on {deviceName}.</span>{" "}
          <span className="text-muted-foreground">
            Its owner hasn't shared it with you, so the sign-in runs there.
          </span>
        </span>
      </p>
      {command ? (
        <CopyLine text={command} wrap buttonClassName="max-md:size-11" testId="chatgpt-command-line" />
      ) : (
        <p className="rounded-lg border border-dashed px-3 py-2 text-muted-foreground text-xs">
          Type a label first.
        </p>
      )}
      <p className="text-muted-foreground text-xs leading-snug">
        It arrives off. Turn it on here once it's listed.
      </p>
    </div>
  );
}

/** The device-code view (as on Settings › Models): starting, the link and the code, connected, or the error. */
export function SignInCodeView({
  view,
  where,
  now: fixedNow,
  cancelling = false,
  retrying = false,
  onCancel,
  onRetry,
}: {
  view: SignInView;
  where: Where;
  /** Tests pin the clock; the page ticks every second. */
  now?: number;
  cancelling?: boolean;
  retrying?: boolean;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const pending = view.state === "pending" && !!view.userCode && !!view.verificationUrl;
  const now = useNow(pending, fixedNow);
  const { copy, copied } = useCopy();

  async function copyText(value: string, what: string) {
    try {
      await copy(value);
    } catch {
      toast.error(`Could not copy the ${what}`);
    }
  }

  if (view.state === "connected") {
    return (
      <div
        data-testid="chatgpt-sign-in-connected"
        className="flex items-center gap-3 rounded-xl border border-success/30 bg-success/5 px-4 py-4 text-sm"
        aria-live="polite"
      >
        <Check aria-hidden className="size-5 shrink-0 text-success" />
        <p className="min-w-0">
          <span className="font-medium">Connected.</span>{" "}
          <span className="text-muted-foreground">The account is in the pool.</span>
        </p>
      </div>
    );
  }

  if (view.state === "error") {
    return (
      <div
        data-testid="chatgpt-sign-in-error"
        role="alert"
        className="grid gap-3 rounded-xl border border-destructive/30 bg-destructive/5 px-4 py-4 text-sm sm:flex sm:items-center"
      >
        <span className="flex min-w-0 flex-1 items-start gap-2">
          <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
          <span>
            {view.error ? signInErrorText(view.error.code, view.error.message, where) : "Sign-in failed."}
          </span>
        </span>
        <Button
          size="sm"
          onClick={onRetry}
          disabled={retrying}
          className={TOUCH}
          data-testid="chatgpt-sign-in-retry"
        >
          {retrying ? <Spinner /> : <RefreshCw />} Try again
        </Button>
      </div>
    );
  }

  if (!pending) {
    return (
      <div
        className="flex items-center gap-3 rounded-xl border bg-brand-soft/30 px-4 py-4 text-sm"
        data-testid="chatgpt-sign-in-starting"
      >
        <Spinner className="text-primary" />
        <p className="min-w-0 flex-1 text-muted-foreground" aria-live="polite">
          {where === "bots"
            ? "Asking the bots runtime for a sign-in code…"
            : "Asking the device for a sign-in code…"}
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={cancelling}
          className={TOUCH}
          data-testid="chatgpt-sign-in-cancel"
        >
          Cancel
        </Button>
      </div>
    );
  }

  const url = view.verificationUrl ?? "";
  const code = view.userCode ?? "";
  const left = view.expiresAt ? new Date(view.expiresAt).getTime() - now : null;
  return (
    <div className="grid gap-4" data-testid="chatgpt-sign-in-pending">
      <ol className="grid gap-4">
        <li className="grid gap-2">
          <span className="flex items-center gap-2 font-medium text-sm">
            <StepNumber n={1} /> Open the sign-in page
          </span>
          <div className="flex items-center gap-1.5">
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="flex h-11 min-w-0 flex-1 items-center gap-2 rounded-lg border bg-background px-3 font-mono text-[12.5px] hover:border-primary/40 md:h-9"
              data-testid="chatgpt-verification-url"
            >
              <span className="truncate">{url.replace(/^https?:\/\//, "")}</span>
              <ArrowUpRight aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
            </a>
            <Button
              variant="outline"
              size="icon"
              className="size-11 md:size-9"
              aria-label="Copy the sign-in link"
              onClick={() => void copyText(url, "link")}
            >
              {copied === url ? <Check className="text-success" /> : <Copy />}
            </Button>
          </div>
        </li>
        <li className="grid gap-2">
          <span className="flex items-center gap-2 font-medium text-sm">
            <StepNumber n={2} /> Enter this code
          </span>
          <div className="flex items-center gap-1.5">
            <code
              className="flex h-12 min-w-0 flex-1 items-center justify-center rounded-lg border border-primary/30 bg-background px-3 font-mono font-semibold text-xl tracking-[0.18em]"
              data-testid="chatgpt-user-code"
            >
              {code}
            </code>
            <Button
              variant="outline"
              className="h-12"
              onClick={() => void copyText(code, "code")}
              data-testid="chatgpt-copy-code"
            >
              {copied === code ? <Check className="text-success" /> : <Copy />}
              {copied === code ? "Copied" : "Copy"}
            </Button>
          </div>
          <p className="text-muted-foreground text-xs" data-testid="chatgpt-code-expiry">
            {left !== null && left > 0 ? `Expires in ${formatCountdown(left)}` : "Expired"} · works once,
            never share it
          </p>
        </li>
      </ol>
      <div className="flex items-center gap-3 rounded-lg border bg-muted/30 px-3 py-2 text-sm">
        <span aria-hidden className="relative flex size-2.5 shrink-0">
          <span className="absolute inset-0 animate-ping rounded-full bg-primary opacity-60 motion-reduce:animate-none" />
          <span className="relative size-2.5 rounded-full bg-primary" />
        </span>
        <p className="min-w-0 flex-1 text-muted-foreground" aria-live="polite">
          Waiting for the sign-in… this updates by itself.
        </p>
        <Button
          size="sm"
          variant="ghost"
          onClick={onCancel}
          disabled={cancelling}
          className={TOUCH}
          data-testid="chatgpt-sign-in-cancel"
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex size-5 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
      {n}
    </span>
  );
}
