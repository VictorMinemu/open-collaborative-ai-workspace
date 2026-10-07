"use client";

import type { AiChatGrant, AiChatShare, AiGrantLevel, Member, Permission } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  Check,
  Copy,
  Eye,
  Link2,
  Link2Off,
  Lock,
  MessageSquareText,
  Search,
  UserPlus,
  X,
} from "lucide-react";
import { useId, useRef, useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Separator } from "@/components/ui/separator";
import { Spinner } from "@/components/ui/spinner";
import { useCopy } from "@/hooks/use-copy";
import { createAiChatGrant, useAiChatGrants } from "@/lib/ai-grant-queries";
import { createAiShare, revokeAiShare, shareUrl, useAiChatShares } from "@/lib/ai-share-queries";
import { errorMessage } from "@/lib/api";
import { useMe, useMembers } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * Share an AI chat (D-03, D-08, P-13). Two ways, one dialog — a centered dialog on a desktop, a bottom sheet at 390
 * (the dialog primitive does both):
 * - "People and teams" (06-03, MULTI-01): give a colleague access to this very chat, to write ("Can chat") or to
 *   read ("Can view"). The dialog says exactly what they will see before anything is shared. Owner only
 *   (`ai_chat.share`, decided by the server). 06-12 adds teams, departments, the organization, level changes and
 *   removal.
 * - "Read-only link (frozen copy)" (05-13, AICHAT-09): a snapshot link for colleagues signed in to the same
 *   organization, never public. "Create link" freezes the chat as it is now; the chat's existing links are listed.
 */
export function ShareDialog({
  chatId,
  open,
  onOpenChange,
  viewerCan,
}: {
  chatId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The server's decisions for the viewer on this chat (`AiChatDetail.viewerCan`). */
  viewerCan: readonly Permission[];
}) {
  const [resetKey, setResetKey] = useState(0);
  const canShare = viewerCan.includes("ai_chat.share");
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) setResetKey((k) => k + 1);
      }}
    >
      <DialogContent data-testid="ai-share-dialog" className="gap-5 sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Share this chat</DialogTitle>
          <DialogDescription className="text-[13.5px] leading-snug">
            Bring colleagues into this conversation, or send a read-only copy of it.
          </DialogDescription>
        </DialogHeader>
        {canShare ? <PeopleSection key={`people-${resetKey}`} chatId={chatId} open={open} /> : null}
        {canShare ? <Separator /> : null}
        <LinkSection key={`link-${resetKey}`} chatId={chatId} open={open} />
      </DialogContent>
    </Dialog>
  );
}

// ---------------------------------------------------------------- people and teams (06-03)

const LEVELS: Array<{ value: AiGrantLevel; label: string; hint: string; icon: typeof Eye }> = [
  { value: "chat", label: "Can chat", hint: "Read, write and ask the model", icon: MessageSquareText },
  { value: "view", label: "Can view", hint: "Read only", icon: Eye },
];
const levelLabel = (level: AiGrantLevel) => LEVELS.find((l) => l.value === level)?.label ?? level;

/** P-13, verbatim: what people given access will see. */
const VISIBLE = [
  "the whole conversation, including earlier messages and answers",
  "every attached file and artifact",
  "this chat's instructions (context)",
  "the model behind each answer",
  "tool settings (Web search on or off)",
  "who has access and at which level (permissions)",
  "the other participants",
];

function PeopleSection({ chatId, open }: { chatId: string; open: boolean }) {
  const qc = useQueryClient();
  const me = useMe();
  const grants = useAiChatGrants(chatId, open);
  const [person, setPerson] = useState<Member | null>(null);
  const [level, setLevel] = useState<AiGrantLevel>("chat");
  const [busy, setBusy] = useState(false);
  const people = (grants.data?.grants ?? []).filter((g) => g.subject.kind === "user");
  const levelOf = new Map(people.map((g) => [g.subject.kind === "user" ? g.subject.id : "", g.level]));

  async function share() {
    if (!person || busy) return;
    setBusy(true);
    try {
      await createAiChatGrant(qc, chatId, { subject: { kind: "user", id: person.userId }, level });
      toast.success(`Shared with ${person.displayName}`);
      setPerson(null);
    } catch (err) {
      toast.error("Couldn't share the chat", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <section data-testid="ai-share-people" aria-labelledby="ai-share-people-heading" className="grid gap-3">
      <h3 id="ai-share-people-heading" className="font-semibold text-[14px] tracking-tight">
        People and teams
      </h3>
      <PersonPicker
        picked={person}
        onPick={setPerson}
        excludeId={me.data?.user.id ?? null}
        levelOf={levelOf}
      />
      <div className="flex flex-wrap items-center gap-2">
        <div
          role="radiogroup"
          aria-label="Access level"
          data-testid="ai-share-level"
          className="inline-flex h-9 shrink-0 items-center rounded-lg border bg-muted/40 p-0.5"
        >
          {LEVELS.map((l) => {
            const on = level === l.value;
            const Icon = l.icon;
            return (
              <button
                key={l.value}
                type="button"
                role="radio"
                aria-checked={on}
                title={l.hint}
                onClick={() => setLevel(l.value)}
                className={cn(
                  "inline-flex h-full items-center gap-1.5 rounded-md px-2.5 font-medium text-[13px] outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30",
                  on
                    ? "bg-background text-foreground shadow-xs dark:bg-input/60"
                    : "text-muted-foreground hover:text-foreground",
                )}
              >
                <Icon aria-hidden className="size-3.5" />
                {l.label}
              </button>
            );
          })}
        </div>
        <Button
          data-testid="ai-share-submit"
          onClick={() => void share()}
          disabled={!person || busy}
          className="ml-auto h-9 min-w-24"
        >
          {busy ? <Spinner /> : <UserPlus />}
          Share
        </Button>
      </div>

      <div
        data-testid="ai-share-disclosure"
        className="grid gap-2 rounded-xl border bg-muted/30 px-3.5 py-3 text-[13px] text-muted-foreground leading-snug"
      >
        <div>
          <p className="font-medium text-foreground/85">They will see:</p>
          <ul className="mt-1 grid list-disc gap-0.5 pl-4 marker:text-muted-foreground/60">
            {VISIBLE.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
        <p>
          Your personal instructions stop being used in this chat from now on. Earlier answers may reflect
          them.
        </p>
        {level === "chat" ? (
          <p data-testid="ai-share-billing">
            Each person's messages are answered on their own ChatGPT plan or an organization model they pick —
            never on yours.
          </p>
        ) : null}
      </div>

      <div className="grid gap-1">
        <h4 className="font-medium text-[12.5px] text-muted-foreground">Who has access</h4>
        <ul data-testid="ai-share-people-list" className="grid gap-0.5">
          {me.data ? (
            <AccessRow
              id={me.data.user.id}
              name={me.data.user.name}
              avatarUrl={me.data.user.image}
              detail={me.data.user.email}
              level="Owner"
              you
            />
          ) : null}
          {people.map((g) => (
            <GrantRow key={g.id} grant={g} />
          ))}
        </ul>
        {grants.isSuccess && people.length === 0 ? (
          <p className="px-1 text-[12.5px] text-muted-foreground">Only you can see this chat.</p>
        ) : null}
      </div>
    </section>
  );
}

function GrantRow({ grant }: { grant: AiChatGrant }) {
  const id = grant.subject.kind === "user" ? grant.subject.id : grant.id;
  return (
    <AccessRow
      testId="ai-share-grant"
      id={id}
      name={grant.label}
      detail={`Shared by ${grant.grantedBy.displayName}`}
      level={levelLabel(grant.level)}
    />
  );
}

function AccessRow({
  id,
  name,
  avatarUrl,
  detail,
  level,
  you = false,
  testId,
}: {
  id: string;
  name: string;
  avatarUrl?: string | null;
  detail: string;
  level: string;
  you?: boolean;
  testId?: string;
}) {
  return (
    <li data-testid={testId} className="flex min-h-11 items-center gap-2.5 rounded-lg px-1 py-1">
      <PrincipalAvatar kind="user" name={name} avatarUrl={avatarUrl} seed={id} className="size-8" />
      <span className="grid min-w-0 flex-1 leading-tight">
        <span className="truncate font-medium text-[13.5px]">
          {name}
          {you ? <span className="font-normal text-muted-foreground"> (you)</span> : null}
        </span>
        <span className="truncate text-[12px] text-muted-foreground">{detail}</span>
      </span>
      <span className="shrink-0 text-[12.5px] text-muted-foreground">{level}</span>
    </li>
  );
}

/**
 * Search the organization's active members by name or email and pick one. The pick shows as a chip in the field
 * (Backspace or ✕ clears it); people who already have access say at which level.
 */
function PersonPicker({
  picked,
  onPick,
  excludeId,
  levelOf,
}: {
  picked: Member | null;
  onPick: (m: Member | null) => void;
  excludeId: string | null;
  levelOf: ReadonlyMap<string, AiGrantLevel>;
}) {
  const members = useMembers();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const needle = q.trim().toLowerCase();
  const options = (members.data?.members ?? [])
    .filter((m) => m.status === "active" && m.userId !== excludeId)
    .filter(
      (m) =>
        needle.length > 0 &&
        (m.displayName.toLowerCase().includes(needle) || (m.email ?? "").toLowerCase().includes(needle)),
    )
    .slice(0, 6);
  const showOptions = !picked && focused && needle.length > 0;

  const pick = (m: Member) => {
    onPick(m);
    setQ("");
  };

  return (
    <div className="relative">
      <div className="flex min-h-10 items-center gap-1.5 rounded-lg border bg-background px-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/25">
        {picked ? (
          <span
            data-testid="ai-share-person-chip"
            className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-muted py-0.5 pr-1 pl-0.5 text-[13.5px]"
          >
            <PrincipalAvatar
              kind="user"
              name={picked.displayName}
              avatarUrl={picked.avatarUrl}
              seed={picked.userId}
              compact
              className="size-6 text-[10px]"
            />
            <span className="truncate">{picked.displayName}</span>
            <button
              type="button"
              aria-label={`Remove ${picked.displayName}`}
              onClick={() => {
                onPick(null);
                requestAnimationFrame(() => inputRef.current?.focus());
              }}
              className="inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X className="size-3" />
            </button>
          </span>
        ) : (
          <Search aria-hidden className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          data-testid="ai-share-person-input"
          role="combobox"
          aria-expanded={showOptions}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-label="Add people by name or email"
          placeholder={picked ? "" : "Add people by name or email"}
          value={q}
          readOnly={!!picked}
          onChange={(e) => setQ(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !q && picked) onPick(null);
            if (e.key === "Enter" && !e.nativeEvent.isComposing && options[0] && !picked) {
              e.preventDefault();
              pick(options[0]);
            }
          }}
          autoComplete="off"
          spellCheck={false}
          className={cn(
            "h-9 min-w-0 flex-1 bg-transparent text-base outline-none placeholder:text-muted-foreground/70 sm:text-[13.5px]",
            picked && "w-0 caret-transparent",
          )}
        />
      </div>
      {showOptions ? (
        <div
          id={listId}
          role="listbox"
          aria-label="People"
          className="absolute inset-x-0 top-full z-10 mt-1 grid max-h-64 gap-px overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/5 dark:shadow-black/40"
        >
          {members.isPending ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Spinner />
            </div>
          ) : options.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-muted-foreground">
              Nobody in your organization matches “{q}”.
            </p>
          ) : (
            options.map((m) => {
              const has = levelOf.get(m.userId);
              return (
                <button
                  key={m.userId}
                  type="button"
                  role="option"
                  aria-selected={false}
                  data-testid="ai-share-person-option"
                  onMouseDown={(e) => e.preventDefault()}
                  onClick={() => pick(m)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent"
                >
                  <PrincipalAvatar
                    kind="user"
                    name={m.displayName}
                    avatarUrl={m.avatarUrl}
                    seed={m.userId}
                    className="size-7"
                  />
                  <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate font-medium text-[13.5px]">{m.displayName}</span>
                    {m.email ? (
                      <span className="truncate text-[12px] text-muted-foreground">{m.email}</span>
                    ) : null}
                  </span>
                  {has ? (
                    <span className="shrink-0 text-[12px] text-muted-foreground">{levelLabel(has)}</span>
                  ) : null}
                </button>
              );
            })
          )}
        </div>
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------- read-only link (05-13)

/** The Phase 5 snapshot-link flow, unchanged, under its Phase 6 name. */
function LinkSection({ chatId, open }: { chatId: string; open: boolean }) {
  const qc = useQueryClient();
  const me = useMe();
  const shares = useAiChatShares(chatId, open);
  const [creating, setCreating] = useState(false);
  const [fresh, setFresh] = useState<AiChatShare | null>(null);
  const orgName = me.data?.organization.name ?? "your organization";

  async function create() {
    if (creating) return;
    setCreating(true);
    try {
      setFresh(await createAiShare(qc, chatId));
    } catch (err) {
      toast.error("Couldn't create the link", { description: errorMessage(err) });
    } finally {
      setCreating(false);
    }
  }

  // The link just made, kept current from the list (a revoke updates it there).
  const current = fresh ? (shares.data?.shares.find((s) => s.id === fresh.id) ?? fresh) : null;
  const others = (shares.data?.shares ?? []).filter((s) => s.id !== fresh?.id);

  return (
    <section data-testid="ai-share-links" aria-labelledby="ai-share-links-heading" className="grid gap-3">
      <div className="grid gap-1">
        <h3 id="ai-share-links-heading" className="font-semibold text-[14px] tracking-tight">
          Read-only link (frozen copy)
        </h3>
        <p data-testid="ai-share-audience" className="text-[13px] text-muted-foreground leading-snug">
          Anyone signed in to {orgName} with the link can read this snapshot. It is never public.
        </p>
      </div>

      <div className="flex items-start gap-2.5 rounded-xl border bg-muted/30 px-3.5 py-3 text-[13px] text-muted-foreground leading-snug">
        <Lock aria-hidden className="mt-0.5 size-3.5 shrink-0" />
        <p>
          The link shows the chat as it is now, read-only. Messages sent later are not included, and the link
          gives no access to the chat itself.
        </p>
      </div>

      {current ? (
        <LinkRow chatId={chatId} share={current} highlight />
      ) : (
        <Button
          variant="outline"
          data-testid="ai-share-create"
          onClick={() => void create()}
          disabled={creating}
          className="h-10 w-full sm:h-9 sm:w-fit"
        >
          {creating ? <Spinner /> : <Link2 />}
          Create link
        </Button>
      )}

      {others.length > 0 ? (
        <section className="grid gap-1.5" data-testid="ai-share-list">
          <h4 className="font-medium text-[12.5px] text-muted-foreground">
            {current ? "Earlier links" : "Links to this chat"}
          </h4>
          <ul className="grid gap-1.5">
            {others.map((s) => (
              <li key={s.id}>
                <LinkRow chatId={chatId} share={s} />
              </li>
            ))}
          </ul>
        </section>
      ) : null}
    </section>
  );
}

const when = (iso: string) =>
  new Date(iso).toLocaleString("en", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

/**
 * One link: its URL (read-only, selectable), when it was taken and how many messages it holds, Copy and Revoke.
 * Revoke asks once, in place; a revoked link stays listed, struck through, with nothing left to copy.
 */
function LinkRow({
  chatId,
  share,
  highlight = false,
}: {
  chatId: string;
  share: AiChatShare;
  highlight?: boolean;
}) {
  const qc = useQueryClient();
  const { copy, copied } = useCopy();
  const [confirming, setConfirming] = useState(false);
  const [revoking, setRevoking] = useState(false);
  const url = shareUrl(share.path);
  const revoked = share.revokedAt !== null;

  async function revoke() {
    if (revoking) return;
    setRevoking(true);
    try {
      await revokeAiShare(qc, chatId, share.id);
      setConfirming(false);
      toast.success("Link revoked");
    } catch (err) {
      toast.error("Couldn't revoke the link", { description: errorMessage(err) });
    } finally {
      setRevoking(false);
    }
  }

  return (
    <div
      data-testid="ai-share-link"
      data-share-id={share.id}
      data-revoked={revoked || undefined}
      className={cn(
        "grid gap-2 rounded-xl border px-3 py-2.5",
        highlight && "border-primary/30 bg-primary/[0.04]",
        revoked && "bg-muted/30",
      )}
    >
      <div className="flex min-w-0 items-center gap-2">
        <input
          readOnly
          value={url}
          aria-label="Share link"
          data-testid="ai-share-url"
          onFocus={(e) => e.currentTarget.select()}
          className={cn(
            "h-9 min-w-0 flex-1 truncate rounded-md border bg-background px-2.5 font-mono text-[12.5px] outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/25 dark:bg-input/25",
            revoked && "text-muted-foreground line-through",
          )}
        />
        {revoked ? null : (
          <Button
            variant={highlight ? "default" : "outline"}
            data-testid="ai-share-copy"
            onClick={() =>
              void copy(url).then(
                () => toast.success("Link copied"),
                () => toast.error("Couldn't copy the link"),
              )
            }
            className="h-9 shrink-0"
          >
            {copied === url ? <Check /> : <Copy />}
            {copied === url ? "Copied" : "Copy"}
          </Button>
        )}
      </div>
      {confirming && !revoked ? (
        <div
          data-testid="ai-share-revoke-confirmation"
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive/[0.06] px-2.5 py-2"
        >
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
            Revoke this link? Anyone who opens it will see that it isn't available.
          </p>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={revoking}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="ai-share-revoke-confirm"
              onClick={() => void revoke()}
              disabled={revoking}
            >
              {revoking ? <Spinner /> : null}
              Revoke link
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex min-h-7 items-center gap-2">
          <p className="flex min-w-0 flex-1 flex-wrap items-center gap-x-1.5 text-[12px] text-muted-foreground">
            <span>{when(share.createdAt)}</span>
            <span aria-hidden>·</span>
            <span>
              {share.messageCount} {share.messageCount === 1 ? "message" : "messages"}
            </span>
            {revoked ? (
              <>
                <span aria-hidden>·</span>
                <span data-testid="ai-share-revoked" className="font-medium text-foreground/70">
                  Revoked
                </span>
              </>
            ) : null}
          </p>
          {revoked ? null : (
            <button
              type="button"
              data-testid="ai-share-revoke"
              onClick={() => setConfirming(true)}
              className="-mr-1 inline-flex h-7 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-destructive/10 hover:text-destructive focus-visible:ring-[3px] focus-visible:ring-ring/30"
            >
              <Link2Off className="size-3.5" />
              Revoke
            </button>
          )}
        </div>
      )}
    </div>
  );
}
