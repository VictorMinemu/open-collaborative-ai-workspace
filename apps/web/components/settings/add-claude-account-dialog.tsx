"use client";

import {
  ClaudeSetupToken,
  type ClaudeSignInStart,
  POOL_LIMITS,
  type PoolAccount,
  PoolLabel,
} from "@ocw/contracts";
import { AlertTriangle, ArrowUpRight, KeyRound, LogIn, Terminal } from "lucide-react";
import { type FormEvent, type ReactNode, useId, useState } from "react";
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
import {
  useAddClaudeAccount,
  useCompleteClaudeSignIn,
  useStartClaudeSignIn,
  useUpdatePoolAccount,
} from "@/lib/account-pool-queries";
import { errorMessage, isApiError } from "@/lib/api";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";
const LABEL_HINT = "Usually the account's e-mail. Members see it.";

/** D-02: the fallback way a Claude subscription account joins the pool (since R3.1 the panel signs in itself). */
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
 * R3.1: a paste that is clearly not what Anthropic's page shows (`code#state`, or that page's address). The API
 * checks again; empty is not an error yet.
 */
export function pastedCodeError(value: string): string | null {
  const v = value.trim();
  if (v === "") return null;
  if (/^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])[:/]/iu.test(v)) {
    return "Paste the code from Anthropic's page, not this address.";
  }
  if (/^https:\/\//iu.test(v)) return null;
  const parts = v.split("#");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return "Copy all of the code, including the # in the middle.";
  }
  return null;
}

/** The API ended the sign-in (its code is used up): only a new Connect helps. A wrong paste keeps it. */
export function claudeSignInRestarts(code: string): boolean {
  return ["code_refused", "sign_in_expired", "state_mismatch", "claude_unavailable"].includes(code);
}

type Mode = "connect" | "paste";
type Replacing = Pick<PoolAccount, "id" | "label"> | null;

/**
 * Settings › Account pool › Add Claude account (D-01, D-02, D-13; 07.18-19 R3.1). The primary way is **Connect a
 * Claude account**: Anthropic's own sign-in page opens in a new tab and the admin pastes back the code it shows; the
 * API exchanges it (`claude setup-token`'s flow) and seals the token. **Paste a setup-token instead** stays as the
 * fallback. Write-only: the code and the token live only in this form's state, and closing the dialog unmounts the
 * form so they leave the page (T-07.18-15-01). The API never returns a token.
 */
export function AddClaudeAccountDialog({
  open,
  replacing = null,
  onOpenChange,
}: {
  open: boolean;
  /** A token account whose token is replaced (a new sign-in or setup-token); null adds an account. */
  replacing?: Replacing;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-claude-account-dialog" className="sm:max-w-lg">
        {open ? (
          <ClaudeAccountForm
            key={replacing?.id ?? "new"}
            replacing={replacing}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

/** The form; `initial` is only for tests that render a chosen state. */
export function ClaudeAccountForm({
  onDone,
  replacing = null,
  initial,
}: {
  onDone: () => void;
  replacing?: Replacing;
  initial?: { mode?: Mode; label?: string; token?: string; flow?: ClaudeSignInStart; code?: string };
}) {
  const [mode, setMode] = useState<Mode>(initial?.mode ?? "connect");
  const [label, setLabel] = useState(initial?.label ?? "");
  const props = { onDone, replacing, label, setLabel };
  return mode === "paste" ? (
    <PasteTokenForm {...props} token={initial?.token} onConnect={() => setMode("connect")} />
  ) : (
    <ConnectForm {...props} flow={initial?.flow} code={initial?.code} onPaste={() => setMode("paste")} />
  );
}

interface ModeProps {
  onDone: () => void;
  replacing: Replacing;
  label: string;
  setLabel: (v: string) => void;
}

function LabelField({ id, label, setLabel }: { id: string; label: string; setLabel: (v: string) => void }) {
  return (
    <FormField id={`${id}-label`} label="Label" hint={LABEL_HINT}>
      <Input
        id={`${id}-label`}
        type="text"
        value={label}
        onChange={(e) => setLabel(e.target.value)}
        maxLength={POOL_LIMITS.labelMax}
        placeholder="ana@acme.com"
        autoComplete="off"
        autoFocus
        aria-describedby={describedBy(`${id}-label`, undefined, LABEL_HINT)}
        className={TOUCH}
        data-testid="claude-account-label"
      />
    </FormField>
  );
}

/** The other way, one click away. */
function SwitchMode({
  onClick,
  testId,
  children,
}: {
  onClick: () => void;
  testId: string;
  children: ReactNode;
}) {
  return (
    <div className="flex justify-center">
      <Button
        type="button"
        variant="link"
        onClick={onClick}
        className="text-[13px] max-md:h-auto max-md:min-h-11 max-md:py-3"
        data-testid={testId}
      >
        {children}
      </Button>
    </div>
  );
}

function StepNumber({ n }: { n: number }) {
  return (
    <span className="flex size-5 shrink-0 items-center justify-center rounded-full bg-primary text-[11px] text-primary-foreground">
      {n}
    </span>
  );
}

/** R3.1: Connect a Claude account (Anthropic's page in a new tab, then the code it shows). */
function ConnectForm({
  onDone,
  replacing,
  label,
  setLabel,
  flow: initialFlow,
  code: initialCode,
  onPaste,
}: ModeProps & { flow?: ClaudeSignInStart; code?: string; onPaste: () => void }) {
  const id = useId();
  const start = useStartClaudeSignIn();
  const complete = useCompleteClaudeSignIn();
  const [flow, setFlow] = useState<ClaudeSignInStart | null>(initialFlow ?? null);
  const [code, setCode] = useState(initialCode ?? "");
  const [codeRefused, setCodeRefused] = useState<string | null>(null);
  const [ended, setEnded] = useState<string | null>(null);
  const labelOk = replacing !== null || PoolLabel.safeParse(label).success;
  const codeError = pastedCodeError(code) ?? codeRefused ?? undefined;
  const canConnect = labelOk && !start.isPending;
  const canSave =
    labelOk && code.trim() !== "" && pastedCodeError(code) === null && flow !== null && !complete.isPending;
  const codeHint = "Anthropic shows it after you approve. It works once, for 10 minutes.";

  async function connect() {
    setEnded(null);
    setCodeRefused(null);
    // Opened inside the click so the browser allows it; it goes to Anthropic once the API answers.
    const tab = typeof window === "undefined" ? null : window.open("", "_blank");
    try {
      const started = await start.mutateAsync(replacing ? { accountId: replacing.id } : {});
      setCode("");
      setFlow(started);
      if (tab) {
        tab.opener = null;
        tab.location.href = started.authorizeUrl;
      }
    } catch (err) {
      tab?.close();
      setEnded(errorMessage(err));
    }
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!flow) {
      if (canConnect) void connect();
      return;
    }
    if (!canSave) return;
    try {
      await complete.mutateAsync({
        flowId: flow.flowId,
        code: code.trim(),
        ...(replacing ? {} : { label: label.trim() }),
      });
      setCode("");
      if (replacing) toast.success(`${replacing.label} is connected again`);
      else
        toast.success("Claude account added", {
          description: "New Work Zone sessions and bots can use it now.",
        });
      onDone();
    } catch (err) {
      if (isApiError(err) && claudeSignInRestarts(err.code)) {
        setFlow(null);
        setCode("");
        setEnded(errorMessage(err));
      } else {
        setCodeRefused(errorMessage(err));
      }
    }
  }

  const authorizeShown = flow ? flow.authorizeUrl.replace(/^https?:\/\//u, "").replace(/\?.*$/u, "") : "";
  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{replacing ? `Connect ${replacing.label} again` : "Add Claude account"}</DialogTitle>
        <DialogDescription>
          {replacing
            ? "Sign in again with that Claude account. The old token stops being used as soon as you save."
            : "A Claude Pro, Max or Team subscription the whole organization can use."}
        </DialogDescription>
      </DialogHeader>
      <DialogBody className="grid gap-4">
        {replacing ? null : <LabelField id={id} label={label} setLabel={setLabel} />}

        {ended ? (
          <div
            role="alert"
            data-testid="claude-connect-error"
            className="flex items-start gap-2 rounded-xl border border-destructive/30 bg-destructive/5 px-3.5 py-3 text-sm"
          >
            <AlertTriangle aria-hidden className="mt-0.5 size-4 shrink-0 text-destructive" />
            <span className="min-w-0">{ended}</span>
          </div>
        ) : null}

        {flow ? (
          <ol className="grid gap-4" data-testid="claude-connect-steps">
            <li className="grid gap-2">
              <span className="flex items-center gap-2 font-medium text-sm">
                <StepNumber n={1} /> Sign in on Anthropic's page
              </span>
              <a
                href={flow.authorizeUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="flex h-11 min-w-0 items-center gap-2 rounded-lg border bg-background px-3 font-mono text-[12.5px] hover:border-primary/40 md:h-9"
                data-testid="claude-authorize-link"
              >
                <span className="truncate">{authorizeShown}</span>
                <ArrowUpRight aria-hidden className="ml-auto size-3.5 shrink-0 text-muted-foreground" />
              </a>
              <p className="text-muted-foreground text-xs">
                Opened in a new tab. Use the Claude account you want to add.
              </p>
            </li>
            <li className="grid gap-2">
              <FormField
                id={`${id}-code`}
                label={
                  <span className="flex items-center gap-2">
                    <StepNumber n={2} /> Paste the code
                  </span>
                }
                hint={codeHint}
                error={codeError}
              >
                <Input
                  id={`${id}-code`}
                  type="text"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setCodeRefused(null);
                  }}
                  placeholder="Paste the code from Anthropic's page"
                  autoComplete="off"
                  spellCheck={false}
                  aria-invalid={!!codeError}
                  aria-describedby={describedBy(`${id}-code`, codeError, codeHint)}
                  className={`font-mono text-[13px] ${TOUCH}`}
                  data-testid="claude-code"
                />
              </FormField>
            </li>
          </ol>
        ) : (
          <div className="flex gap-3 rounded-xl border bg-brand-soft/30 p-3.5 text-sm">
            <LogIn aria-hidden className="mt-0.5 size-4 shrink-0 text-primary" />
            <p className="min-w-0 leading-relaxed">
              Anthropic's sign-in page opens in a new tab. Approve with the Claude account, then paste the
              code it shows here.
            </p>
          </div>
        )}

        <SwitchMode onClick={onPaste} testId="claude-use-token">
          Paste a setup-token instead
        </SwitchMode>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} className={TOUCH}>
          Cancel
        </Button>
        {flow ? (
          <Button type="submit" disabled={!canSave} className={TOUCH} data-testid="claude-code-save">
            {complete.isPending ? <Spinner /> : <KeyRound />}
            {replacing ? "Save" : "Add account"}
          </Button>
        ) : (
          <Button
            type="button"
            onClick={() => void connect()}
            disabled={!canConnect}
            className={TOUCH}
            data-testid="claude-connect-start"
          >
            {start.isPending ? <Spinner /> : <ArrowUpRight />}
            {replacing ? "Sign in again" : "Connect a Claude account"}
          </Button>
        )}
      </DialogFooter>
    </form>
  );
}

/** The fallback: a token made with `claude setup-token`, pasted once (PD-22). */
function PasteTokenForm({
  onDone,
  replacing,
  label,
  setLabel,
  token: initialToken,
  onConnect,
}: ModeProps & { token?: string; onConnect: () => void }) {
  const add = useAddClaudeAccount();
  const update = useUpdatePoolAccount();
  const pending = add.isPending || update.isPending;
  const id = useId();
  const [token, setToken] = useState(initialToken ?? "");
  const [refused, setRefused] = useState<string | null>(null);
  const tokenError = claudeTokenError(token) ?? refused ?? undefined;
  const labelOk = replacing !== null || PoolLabel.safeParse(label).success;
  const tokenOk = token.trim() !== "" && claudeTokenError(token) === null;
  const canSave = labelOk && tokenOk && !pending;
  const tokenHint = "Sealed on the server and never shown again.";

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!canSave) return;
    try {
      if (replacing) {
        await update.mutateAsync({ id: replacing.id, body: { token: token.trim() } });
        setToken("");
        toast.success(`New token saved for ${replacing.label}`);
      } else {
        await add.mutateAsync({ label: label.trim(), token: token.trim() });
        setToken("");
        toast.success("Claude account added", {
          description: "New Work Zone sessions and bots can use it now.",
        });
      }
      onDone();
    } catch (err) {
      setRefused(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>{replacing ? `New token for ${replacing.label}` : "Add Claude account"}</DialogTitle>
        <DialogDescription>
          {replacing
            ? "The old token stops being used as soon as you save."
            : "A Claude Pro, Max or Team subscription the whole organization can use."}
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
        {replacing ? null : <LabelField id={id} label={label} setLabel={setLabel} />}
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
        <SwitchMode onClick={onConnect} testId="claude-use-connect">
          Connect with Anthropic's sign-in instead
        </SwitchMode>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={pending} className={TOUCH}>
          Cancel
        </Button>
        <Button type="submit" disabled={!canSave} className={TOUCH} data-testid="claude-account-save">
          {pending ? <Spinner /> : <KeyRound />}
          Save
        </Button>
      </DialogFooter>
    </form>
  );
}
