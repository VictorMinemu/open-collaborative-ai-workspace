"use client";

import type { MemberConnector } from "@ocw/contracts";
import { KeyRound } from "lucide-react";
import { type FormEvent, useState } from "react";
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
import { errorMessage } from "@/lib/api";
import { useConnectSecret } from "@/lib/connector-queries";

/** 44 px touch targets below `md` (UI-SPEC: every control at 390). */
const TOUCH = "max-md:h-11";

/** "Sent as X-Api-Key with the prefix “Bearer ”." — where the key goes, never the key itself. */
export function secretHint(c: Pick<MemberConnector, "secretHeaderName" | "secretHeaderPrefix">): string {
  const header = c.secretHeaderName ?? "Authorization";
  return c.secretHeaderPrefix
    ? `Sent as ${header} with the prefix “${c.secretHeaderPrefix}”.`
    : `Sent as ${header}.`;
}

/**
 * The member's own key for a `per_member_secret` connector (UI-SPEC § 2 "Connect-key dialog"). Write-only: the field
 * starts empty in both modes, the previous value is never fetched, and closing the dialog unmounts the form so the
 * value leaves the DOM (T-07.4-13-01).
 */
export function ConnectSecretDialog({
  connector,
  mode,
  onOpenChange,
}: {
  connector: MemberConnector | null;
  mode: "add" | "replace";
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Dialog open={connector !== null} onOpenChange={onOpenChange}>
      <DialogContent data-testid="connect-secret-dialog" className="sm:max-w-md">
        {connector ? (
          <SecretForm
            key={connector.serverId}
            connector={connector}
            mode={mode}
            onDone={() => onOpenChange(false)}
          />
        ) : null}
      </DialogContent>
    </Dialog>
  );
}

function SecretForm({
  connector: c,
  mode,
  onDone,
}: {
  connector: MemberConnector;
  mode: "add" | "replace";
  onDone: () => void;
}) {
  const save = useConnectSecret();
  const [value, setValue] = useState("");
  const [error, setError] = useState<string | undefined>();
  const hint = secretHint(c);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!value.trim()) {
      setError("Enter your key");
      return;
    }
    try {
      await save.mutateAsync({ serverId: c.serverId, value });
      setValue("");
      toast.success(`${c.name} key saved`);
      onDone();
    } catch (err) {
      setError(errorMessage(err));
    }
  }

  return (
    <form onSubmit={submit} noValidate className="flex min-h-0 flex-col">
      <DialogHeader>
        <DialogTitle>
          {mode === "replace" ? `Replace your ${c.name} key` : `Add your ${c.name} key`}
        </DialogTitle>
        <DialogDescription>
          Bots send it to {c.name} for you. It's encrypted and never shown again.
        </DialogDescription>
      </DialogHeader>
      <DialogBody>
        <FormField id="connect-secret-value" label="Key" error={error} hint={hint}>
          <Input
            id="connect-secret-value"
            type="password"
            value={value}
            onChange={(e) => {
              setValue(e.target.value);
              setError(undefined);
            }}
            autoComplete="new-password"
            spellCheck={false}
            autoFocus
            aria-invalid={!!error}
            aria-describedby={describedBy("connect-secret-value", error, hint)}
            className={`font-mono text-[13px] ${TOUCH}`}
            data-testid="connect-secret-value"
          />
        </FormField>
      </DialogBody>
      <DialogFooter>
        <Button type="button" variant="outline" onClick={onDone} disabled={save.isPending} className={TOUCH}>
          Cancel
        </Button>
        <Button type="submit" disabled={save.isPending} className={TOUCH} data-testid="connect-secret-save">
          {save.isPending ? <Spinner /> : <KeyRound />}
          {mode === "replace" ? "Replace key" : "Save key"}
        </Button>
      </DialogFooter>
    </form>
  );
}
