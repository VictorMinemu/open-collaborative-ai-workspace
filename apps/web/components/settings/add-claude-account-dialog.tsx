"use client";

import { ClaudeSetupToken, POOL_LIMITS, PoolLabel } from "@ocw/contracts";
import { KeyRound, Terminal } from "lucide-react";
import { type FormEvent, useId, useState } from "react";
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
import { useAddClaudeAccount } from "@/lib/account-pool-queries";
import { errorMessage } from "@/lib/api";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

/** D-02: the only way a Claude subscription account joins the pool from the browser. */
export const SETUP_TOKEN_HELP =
  "Run `claude setup-token` in a terminal where you are signed in to the Claude account, then paste the token here.";
/** The sentence around its command, which renders as code. */
const [HELP_BEFORE, HELP_COMMAND, HELP_AFTER] = SETUP_TOKEN_HELP.split("`");

/**
 * What the API would refuse, refused before sending (PD-22). An API key reads the contract's own sentence (it belongs
 * in Settings › Models); an empty field is not an error yet, Save just stays off.
 */
export function claudeTokenError(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  const parsed = ClaudeSetupToken.safeParse(v);
  if (parsed.success) return null;
  const issue = parsed.error.issues[0];
  if (issue?.code === "custom" || issue?.code === "invalid_format") return issue.message;
  return "Paste the whole token.";
}

/**
 * Settings › Account pool › Add Claude account (D-01, D-02, D-13). Write-only: the token lives only in this form's
 * state, the field starts empty, and closing the dialog unmounts the form so the value leaves the page
 * (T-07.18-15-01). The API seals it and never returns it.
 */
export function AddClaudeAccountDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-claude-account-dialog" className="sm:max-w-lg">
        {open ? <ClaudeAccountForm onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

/** The form; `initial` is only for tests that render a typed state. */
export function ClaudeAccountForm({
  onDone,
  initial,
}: {
  onDone: () => void;
  initial?: { label?: string; token?: string };
}) {
  const add = useAddClaudeAccount();
  const id = useId();
  const [label, setLabel] = useState(initial?.label ?? "");
  const [token, setToken] = useState(initial?.token ?? "");
  const [refused, setRefused] = useState<string | null>(null);
  const tokenError = claudeTokenError(token) ?? refused ?? undefined;
  const labelOk = PoolLabel.safeParse(label).success;
  const tokenOk = token.trim() !== "" && claudeTokenError(token) === null;
  const canSave = labelOk && tokenOk && !add.isPending;
  const labelHint = "Usually the account's e-mail. Members see it.";
  const tokenHint = "Sealed on the server and never shown again.";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    try {
      await add.mutateAsync({ label: label.trim(), token: token.trim() });
      setToken("");
      toast.success("Claude account added", {
        description: "New Work Zone sessions and bots can use it now.",
      });
      onDone();
    } catch (err) {
      setRefused(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>Add Claude account</DialogTitle>
        <DialogDescription>
          A Claude Pro, Max or Team subscription the whole organization can use.
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        <div className="flex gap-3 rounded-xl border bg-muted/30 p-3 text-sm">
          <Terminal aria-hidden className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
          <p className="min-w-0 leading-relaxed">
            {HELP_BEFORE}
            <code className="whitespace-nowrap rounded bg-muted px-1 py-0.5 font-mono text-[12.5px]">
              {HELP_COMMAND}
            </code>
            {HELP_AFTER}
          </p>
        </div>
        <FormField id={`${id}-label`} label="Label" hint={labelHint}>
          <Input
            id={`${id}-label`}
            type="text"
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            maxLength={POOL_LIMITS.labelMax}
            placeholder="ana@acme.com"
            autoComplete="off"
            autoFocus
            aria-describedby={describedBy(`${id}-label`, undefined, labelHint)}
            className={TOUCH}
            data-testid="claude-account-label"
          />
        </FormField>
        <FormField id={`${id}-token`} label="Setup-token" hint={tokenHint} error={tokenError}>
          <Input
            id={`${id}-token`}
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              setRefused(null);
            }}
            placeholder="sk-ant-oat01-…"
            autoComplete="off"
            spellCheck={false}
            aria-invalid={!!tokenError}
            aria-describedby={describedBy(`${id}-token`, tokenError, tokenHint)}
            className={`font-mono text-[13px] ${TOUCH}`}
            data-testid="claude-account-token"
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={add.isPending} className={TOUCH}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave} className={TOUCH} data-testid="claude-account-save">
          {add.isPending ? <Spinner /> : <KeyRound />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
