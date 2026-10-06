"use client";

import { type DmParticipant, MAX_GROUP_PARTICIPANTS, userHandle } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import { Check, Search, X } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { createDm, useAgents } from "@/lib/chat-queries";
import { useMe, useMembers } from "@/lib/queries";
import { cn } from "@/lib/utils";
import { BotBadge, PrincipalAvatar } from "./principal-avatar";

/** The others a group may hold besides you (D-06: 9 participants, you included). */
const MAX_OTHERS = MAX_GROUP_PARTICIPANTS - 1;

interface Pickable {
  kind: "user" | "agent";
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  /** Your own personal bot: it only ever chats one-to-one (D-06). */
  personal: boolean;
}

const keyOf = (p: { kind: string; id: string }) => `${p.kind}:${p.id}`;

/** Who you can message: active people first (you excluded), then team bots, then your own personal bots. */
function usePickable(): { list: Pickable[]; loading: boolean } {
  const me = useMe({ enabled: false });
  const members = useMembers();
  const agents = useAgents();
  const meId = me.data?.user.id;
  const list = useMemo(() => {
    const people: Pickable[] = (members.data?.members ?? [])
      .filter((m) => m.status === "active" && m.userId !== meId)
      .map((m) => ({
        kind: "user",
        id: m.userId,
        name: m.displayName,
        handle: userHandle(m),
        avatarUrl: m.avatarUrl,
        personal: false,
      }));
    const live = (agents.data?.agents ?? []).filter((a) => a.status !== "disabled");
    const bot = (a: (typeof live)[number]): Pickable => ({
      kind: "agent",
      id: a.id,
      name: a.name,
      handle: a.username.toLowerCase(),
      avatarUrl: a.avatarUrl,
      personal: a.scope === "personal",
    });
    const team = live.filter((a) => a.scope !== "personal").map(bot);
    const mine = live.filter((a) => a.scope === "personal" && a.ownerUserId === meId).map(bot);
    return [...people, ...team, ...mine];
  }, [members.data, agents.data, meId]);
  return { list, loading: members.isPending };
}

/**
 * "New message" (CHAT-04): pick one person or bot for a DM, or up to eight others for a group DM. Opening an
 * existing combination lands in the same conversation (the API is insert-or-get). Full-height sheet on phones.
 */
export function NewDmDialog({
  open,
  onOpenChange,
  initial,
}: {
  open: boolean;
  onOpenChange(o: boolean): void;
  initial?: DmParticipant[];
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-testid="new-dm-dialog"
        className={cn(
          "gap-4 sm:max-w-lg",
          // Phones: a full-height sheet, so the list and the keyboard both fit.
          "max-sm:top-0 max-sm:h-dvh max-sm:max-h-dvh max-sm:rounded-none max-sm:border-0",
        )}
      >
        {open ? <Picker initial={initial} onDone={() => onOpenChange(false)} /> : null}
      </DialogContent>
    </Dialog>
  );
}

function Picker({ initial, onDone }: { initial?: DmParticipant[] | undefined; onDone(): void }) {
  const qc = useQueryClient();
  const router = useRouter();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const { list, loading } = usePickable();
  const [q, setQ] = useState("");
  const [picked, setPicked] = useState<string[]>(() => (initial ?? []).map(keyOf));
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const t = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(t);
  }, []);

  const byKey = useMemo(() => new Map(list.map((p) => [keyOf(p), p])), [list]);
  const selected = picked.map((k) => byKey.get(k)).filter((p): p is Pickable => !!p);
  const personalPicked = selected.some((p) => p.personal);
  const full = selected.length >= MAX_OTHERS;

  const needle = q.trim().toLowerCase();
  const shown = list.filter(
    (p) => !needle || p.name.toLowerCase().includes(needle) || p.handle.includes(needle),
  );
  const people = shown.filter((p) => p.kind === "user");
  const bots = shown.filter((p) => p.kind === "agent");

  /** Why a row cannot be added right now (null = it can). */
  const blockedReason = (p: Pickable): string | null => {
    if (picked.includes(keyOf(p))) return null;
    if (p.personal && selected.length > 0) return "Personal bots only chat one-to-one";
    if (personalPicked) return "Personal bots only chat one-to-one";
    if (full) return `Groups hold up to ${MAX_GROUP_PARTICIPANTS}, you included`;
    return null;
  };

  const toggle = (p: Pickable) => {
    const k = keyOf(p);
    if (picked.includes(k)) {
      setPicked((prev) => prev.filter((x) => x !== k));
    } else if (!blockedReason(p)) {
      setPicked((prev) => [...prev, k]);
      setQ("");
    }
    inputRef.current?.focus();
  };

  const go = async () => {
    if (selected.length === 0 || busy) return;
    setBusy(true);
    try {
      const dm = await createDm(
        qc,
        selected.map((p) => ({ kind: p.kind, id: p.id })),
      );
      onDone();
      router.push(`/chat/dm/${dm.id}`);
    } catch (err) {
      toast.error(errorMessage(err));
      setBusy(false);
    }
  };

  const hint =
    selected.length === 0
      ? "Pick a person or a bot. Add more to start a group."
      : selected.length === 1
        ? personalPicked
          ? "Direct message · personal bots chat one-to-one"
          : "Direct message"
        : `Group of ${selected.length + 1}, you included${full ? ` · that's the maximum` : ""}`;

  const row = (p: Pickable) => {
    const on = picked.includes(keyOf(p));
    const reason = blockedReason(p);
    return (
      <li key={keyOf(p)}>
        <button
          type="button"
          role="option"
          aria-selected={on}
          aria-disabled={reason ? true : undefined}
          title={reason ?? undefined}
          data-testid="new-dm-option"
          data-kind={p.kind}
          data-name={p.name}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => toggle(p)}
          className={cn(
            "flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors focus-visible:ring-[3px] focus-visible:ring-ring/30",
            reason ? "cursor-not-allowed opacity-50" : "hover:bg-accent",
            on && "bg-accent/70",
          )}
        >
          <PrincipalAvatar
            kind={p.kind}
            name={p.name}
            avatarUrl={p.avatarUrl}
            seed={p.id}
            className="size-8"
          />
          <span className="min-w-0 flex-1">
            <span className="flex items-center gap-1.5">
              <span className="truncate font-medium text-sm">{p.name}</span>
              {p.kind === "agent" ? <BotBadge /> : null}
              {p.personal ? <span className="shrink-0 text-muted-foreground text-xs">· yours</span> : null}
            </span>
            <span className="block truncate text-muted-foreground text-xs">
              {reason && !on ? reason : `@${p.handle}`}
            </span>
          </span>
          <span
            aria-hidden
            className={cn(
              "flex size-5 shrink-0 items-center justify-center rounded-full border",
              on ? "border-primary bg-primary text-primary-foreground" : "border-border",
            )}
          >
            {on ? <Check className="size-3" strokeWidth={3} /> : null}
          </span>
        </button>
      </li>
    );
  };

  return (
    <>
      <DialogHeader>
        <DialogTitle>New message</DialogTitle>
        <DialogDescription>Message a colleague or a bot, or start a group of up to 9.</DialogDescription>
      </DialogHeader>

      <div className="flex min-h-11 flex-wrap items-center gap-1.5 rounded-lg border bg-background px-2 py-1.5 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/30">
        <span className="pl-1 text-muted-foreground text-sm">To:</span>
        {selected.map((p) => (
          <span
            key={keyOf(p)}
            data-testid="new-dm-chip"
            className="inline-flex h-7 max-w-full items-center gap-1.5 rounded-full bg-muted py-0.5 pr-1 pl-0.5 text-sm"
          >
            <PrincipalAvatar
              kind={p.kind}
              name={p.name}
              avatarUrl={p.avatarUrl}
              seed={p.id}
              compact
              className="size-5 text-[10px]"
            />
            <span className="truncate">{p.name}</span>
            <button
              type="button"
              aria-label={`Remove ${p.name}`}
              onClick={() => toggle(p)}
              className="inline-flex size-5 items-center justify-center rounded-full text-muted-foreground outline-none hover:bg-background hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              <X className="size-3" />
            </button>
          </span>
        ))}
        <div className="relative flex min-w-[8rem] flex-1 items-center">
          {selected.length === 0 ? (
            <Search
              className="pointer-events-none absolute left-1 size-4 text-muted-foreground"
              aria-hidden
            />
          ) : null}
          <input
            ref={inputRef}
            data-testid="new-dm-input"
            role="combobox"
            aria-expanded
            aria-controls={listId}
            aria-label="Search people and bots"
            placeholder={selected.length === 0 ? "Search people and bots" : "Add more"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Backspace" && !q && picked.length > 0) setPicked((prev) => prev.slice(0, -1));
              if (e.key === "Enter" && !e.nativeEvent.isComposing) {
                e.preventDefault();
                const first = shown.find((p) => !picked.includes(keyOf(p)) && !blockedReason(p));
                if (q.trim() && first) toggle(first);
                else if (!q.trim()) void go();
              }
            }}
            autoComplete="off"
            spellCheck={false}
            className={cn(
              "h-8 w-full min-w-0 bg-transparent text-base outline-none placeholder:text-muted-foreground/70 sm:text-sm",
              selected.length === 0 && "pl-7",
            )}
          />
        </div>
      </div>
      <p data-testid="new-dm-hint" className="-mt-2 px-1 text-muted-foreground text-xs" aria-live="polite">
        {hint}
      </p>

      <div
        id={listId}
        role="listbox"
        aria-multiselectable
        aria-label="People and bots"
        className="scrollbar-thin -mx-2 min-h-0 flex-1 overflow-y-auto px-0 sm:max-h-[50dvh]"
      >
        {loading ? (
          <div className="flex justify-center py-8 text-muted-foreground">
            <Spinner />
          </div>
        ) : people.length === 0 && bots.length === 0 ? (
          <p className="px-4 py-8 text-center text-muted-foreground text-sm">Nobody matches “{q}”.</p>
        ) : (
          <>
            {people.length > 0 ? (
              <section className="mb-3 last:mb-0">
                <h3 className="px-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                  People
                </h3>
                <ul className="px-2">{people.map(row)}</ul>
              </section>
            ) : null}
            {bots.length > 0 ? (
              <section className="mb-3 last:mb-0">
                <h3 className="px-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                  Bots
                </h3>
                <ul className="px-2">{bots.map(row)}</ul>
              </section>
            ) : null}
          </>
        )}
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onDone} className="max-sm:hidden">
          Cancel
        </Button>
        <Button data-testid="new-dm-go" disabled={selected.length === 0 || busy} onClick={() => void go()}>
          {busy ? <Spinner /> : null}
          {selected.length > 1 ? "Start group" : "Go"}
        </Button>
      </DialogFooter>
    </>
  );
}
