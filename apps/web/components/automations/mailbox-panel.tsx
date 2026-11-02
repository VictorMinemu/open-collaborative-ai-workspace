"use client";

import type { Automation, MailboxPollMinutes, MailboxTestResult } from "@ocw/contracts";
import { CircleCheck, CircleX, KeyRound } from "lucide-react";
import Link from "next/link";
import { useEffect, useId, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { describedBy, FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger } from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { isApiError } from "@/lib/api";
import { RESULT_TONE } from "@/lib/automation-queries";
import {
  hostNotAllowedText,
  type MailboxErrors,
  type MailboxValue,
  mailboxConfigOf,
  mailboxStatusLine,
  mailboxTestText,
  mailHostAllowed,
  POLL_MINUTES,
  useBasicKeychainItems,
  useMailbox,
  useTestMailbox,
} from "@/lib/automation-trigger-queries";
import { cn } from "@/lib/utils";

const TOUCH = "max-md:h-11";

type TestLine = { ok: boolean; text: string };

/**
 * The mailbox of a mail trigger (07.6-18, D-02, R8, UI-SPEC Surface 4): it signs in only with a Keychain
 * `Username & password` item (there is no username or password field anywhere here), on a server the key allows,
 * reading one folder every 5 to 60 minutes. Test connection tries the form's values without saving anything. Saved,
 * the status line says when it was last checked and what it found.
 */
export function MailboxPanel({
  value,
  onChange,
  errors,
  automation,
  disabled,
}: {
  value: MailboxValue;
  onChange: (next: MailboxValue) => void;
  errors: MailboxErrors;
  /** The saved automation (its mailbox status), or null before the first save. */
  automation: Automation | null;
  disabled: boolean;
}) {
  const keys = useBasicKeychainItems(!disabled);
  const saved = useMailbox(automation?.trigger.kind === "mail" ? automation.id : null);
  const test = useTestMailbox();
  const [line, setLine] = useState<TestLine | null>(null);
  const id = useId();
  const f = (k: string) => `${id}-${k}`;

  // A test result belongs to the values it tried: any change clears it.
  const tried = JSON.stringify(value);
  useEffect(() => {
    void tried;
    setLine(null);
  }, [tried]);

  const key = keys.items.find((k) => k.id === value.vaultItemId) ?? null;
  const keyName = key?.name ?? automation?.trigger.mailbox?.vaultItemName ?? "";
  const port = Number(value.port);
  const host = value.host.trim().toLowerCase();
  const hostMismatch =
    !!key && !!host && Number.isInteger(port) && port > 0 && !mailHostAllowed(key.allowedHosts, host, port);
  const set = (patch: Partial<MailboxValue>) => onChange({ ...value, ...patch });
  const noKeys = !disabled && !keys.isPending && !keys.isError && keys.items.length === 0;
  const status = saved.data ?? automation?.trigger.mailbox ?? null;

  async function runTest() {
    const cfg = mailboxConfigOf(value);
    if (!cfg) {
      setLine({ ok: false, text: "Fill in the key, server, port and folder first." });
      return;
    }
    const ctx = { folder: cfg.folder, host: cfg.host, port: cfg.port, key: keyName || "the key" };
    try {
      const r: MailboxTestResult = await test.mutateAsync({
        vaultItemId: cfg.vaultItemId,
        host: cfg.host,
        port: cfg.port,
        folder: cfg.folder,
      });
      setLine({ ok: r.ok, text: mailboxTestText(r, ctx) });
    } catch (err) {
      setLine({
        ok: false,
        text:
          isApiError(err) && err.code === "mailbox_key_not_usable"
            ? "Choose a username and password key from your Keychain."
            : "Couldn't connect. Try again.",
      });
    } finally {
      test.reset();
    }
  }

  const keychainLink = (label: string) => (
    <Link
      href="/settings/keychain"
      className={cn(buttonVariants({ variant: "link", size: "sm" }), "h-auto p-0 max-md:min-h-11")}
    >
      {label}
    </Link>
  );

  return (
    <div className="grid gap-4" data-testid="mailbox-panel">
      {noKeys ? (
        <div className="grid gap-1" data-testid="mailbox-no-keys">
          <span className="font-medium text-sm">Sign in with</span>
          <p className="flex flex-wrap items-center gap-x-2 text-sm text-muted-foreground">
            <span>You have no username and password keys.</span>
            {keychainLink("Add one in Keychain")}
          </p>
        </div>
      ) : (
        <FormField
          id={f("key")}
          label="Sign in with"
          error={errors.vaultItemId}
          hint="Keys come from Keychain. Gmail and Microsoft 365 need an app password."
        >
          <Select
            items={keys.items.map((k) => ({ value: k.id, label: `${k.name} · Username & password` }))}
            value={key ? key.id : null}
            onValueChange={(v) => v && set({ vaultItemId: String(v) })}
            disabled={disabled || keys.isPending}
          >
            <SelectTrigger
              id={f("key")}
              data-testid="mailbox-key"
              placeholder={
                keys.isPending && !disabled ? "Loading keys…" : keyName ? `${keyName}` : "Pick a key"
              }
              aria-invalid={!!errors.vaultItemId}
              aria-describedby={describedBy(f("key"), errors.vaultItemId, "hint")}
              className={TOUCH}
            />
            <SelectContent>
              {keys.items.map((k) => (
                <SelectItem
                  key={k.id}
                  value={k.id}
                  className="max-md:min-h-11"
                  data-testid="mailbox-key-option"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <KeyRound className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                    <span className="truncate">{k.name}</span>
                    <span className="shrink-0 text-muted-foreground">· Username &amp; password</span>
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {keys.isPending && !disabled ? <Spinner className="sr-only" /> : null}
        </FormField>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,1fr)_6rem] md:items-start">
        <FormField id={f("host")} label="Server" error={errors.host}>
          <Input
            id={f("host")}
            data-testid="mailbox-host"
            value={value.host}
            placeholder="imap.example.com"
            disabled={disabled}
            spellCheck={false}
            autoComplete="off"
            inputMode="url"
            aria-invalid={!!errors.host || hostMismatch}
            aria-describedby={hostMismatch ? f("host-mismatch") : describedBy(f("host"), errors.host)}
            onChange={(e) => set({ host: e.target.value })}
            className={cn("font-mono text-[13px]", TOUCH)}
          />
        </FormField>
        <FormField id={f("port")} label="Port" error={errors.port}>
          <Input
            id={f("port")}
            data-testid="mailbox-port"
            value={value.port}
            inputMode="numeric"
            disabled={disabled}
            aria-invalid={!!errors.port}
            aria-describedby={describedBy(f("port"), errors.port)}
            onChange={(e) => set({ port: e.target.value })}
            className={cn("w-24 font-mono text-[13px] md:w-full", TOUCH)}
          />
        </FormField>
      </div>
      {hostMismatch ? (
        <p
          id={f("host-mismatch")}
          role="alert"
          data-testid="mailbox-host-mismatch"
          className="-mt-2 flex flex-wrap items-center gap-x-2 text-[13px] text-destructive"
        >
          <span>{hostNotAllowedText(host, keyName)}</span>
          {keychainLink("Open Keychain")}
        </p>
      ) : null}

      <FormField id={f("folder")} label="Folder" error={errors.folder}>
        <Input
          id={f("folder")}
          data-testid="mailbox-folder"
          value={value.folder}
          disabled={disabled}
          spellCheck={false}
          aria-invalid={!!errors.folder}
          aria-describedby={describedBy(f("folder"), errors.folder)}
          onChange={(e) => set({ folder: e.target.value })}
          className={cn("font-mono text-[13px] md:max-w-xs", TOUCH)}
        />
      </FormField>

      <FormField id={f("every")} label="Check every">
        <Select
          items={POLL_MINUTES.map((p) => ({ value: p.value, label: p.label }))}
          value={value.pollIntervalMinutes}
          onValueChange={(v) => v && set({ pollIntervalMinutes: Number(v) as MailboxPollMinutes })}
          disabled={disabled}
        >
          <SelectTrigger id={f("every")} data-testid="mailbox-every" className={cn("md:max-w-xs", TOUCH)} />
          <SelectContent>
            {POLL_MINUTES.map((p) => (
              <SelectItem key={p.value} value={p.value} className="max-md:min-h-11">
                {p.label}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </FormField>

      <div className="grid gap-2">
        <Button
          type="button"
          variant="outline"
          size="sm"
          data-testid="mailbox-test"
          className={cn("justify-self-start max-md:w-full", TOUCH)}
          disabled={disabled || test.isPending || noKeys}
          onClick={() => void runTest()}
        >
          {test.isPending ? <Spinner /> : null}
          {test.isPending ? "Testing…" : "Test connection"}
        </Button>
        <p
          role="status"
          data-testid="mailbox-test-result"
          data-ok={line ? String(line.ok) : undefined}
          className={cn(
            "flex items-start gap-1.5 text-[13px] empty:hidden",
            line?.ok ? RESULT_TONE.done.text : RESULT_TONE.failed.text,
          )}
        >
          {line ? (
            <>
              {line.ok ? (
                <CircleCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              ) : (
                <CircleX className="mt-0.5 size-3.5 shrink-0" aria-hidden />
              )}
              <span className="min-w-0">{line.text}</span>
            </>
          ) : null}
        </p>
        <p className="text-muted-foreground text-xs">
          OCW only reads new mail that arrives after you save. It never marks, moves or deletes messages.
        </p>
      </div>

      {status ? <MailboxStatusRow mailbox={status} /> : null}
    </div>
  );
}

function MailboxStatusRow({ mailbox }: { mailbox: NonNullable<Automation["trigger"]["mailbox"]> }) {
  const s = mailboxStatusLine(mailbox);
  const tone =
    s.tone === "warning"
      ? { text: "text-amber-800 dark:text-amber-200", dot: "bg-amber-500 dark:bg-amber-400" }
      : RESULT_TONE[s.tone];
  return (
    <p className="flex items-center gap-3 text-sm" data-testid="mailbox-status" data-status={mailbox.status}>
      <span className="font-medium">Status</span>
      <span className="flex min-w-0 items-center gap-1.5">
        <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone.dot)} />
        <span className={cn("min-w-0", tone.text)}>{s.text}</span>
      </span>
    </p>
  );
}
