"use client";

import type { ChannelMember, ChannelSummary } from "@ocw/contracts";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MemberProfileSheet } from "@/components/members/member-profile-sheet";
import { PresenceDot } from "@/components/presence/presence-stack";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useAddChannelMember } from "@/lib/chat-queries";
import { usePresence } from "@/lib/realtime";
import { cn } from "@/lib/utils";
import { BotBadge, PrincipalAvatar } from "./principal-avatar";
import { type DirEntry, dirKey } from "./use-chat-directory";

type MemberPresence = "online" | "away" | "offline";
const PRESENCE_LABEL = { online: "Active", away: "Away" } as const;
/** Present-first order (D-08): Active, then Away, then everyone else. */
const PRESENCE_RANK: Record<MemberPresence, number> = { online: 0, away: 1, offline: 2 };

function Row({
  kind,
  id,
  name,
  handle,
  avatarUrl,
  note,
  action,
  onOpen,
  presence,
}: {
  kind: "user" | "agent";
  id: string;
  name: string;
  handle: string;
  avatarUrl: string | null;
  note?: string | null;
  action?: React.ReactNode;
  /** People open their profile (ORG-06); bots keep their current behaviour. */
  onOpen?: () => void;
  /** People only: whether they are here now in this channel (RT-04, D-08). */
  presence?: MemberPresence;
}) {
  const here = presence === "online" || presence === "away" ? presence : null;
  const body = (
    <>
      <span className="relative inline-flex shrink-0">
        <PrincipalAvatar
          kind={kind}
          name={name}
          avatarUrl={avatarUrl}
          seed={id}
          className={cn("size-8", here === "away" && "opacity-70")}
        />
        {here ? <PresenceDot state={here} className="absolute -right-0.5 -bottom-0.5" /> : null}
      </span>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-sm">{name}</span>
          {kind === "agent" ? <BotBadge /> : null}
          {note ? <span className="shrink-0 text-muted-foreground text-xs">{note}</span> : null}
        </div>
        <p className="truncate text-muted-foreground text-xs">
          @{handle}
          {here ? <span data-testid="member-presence-label"> · {PRESENCE_LABEL[here]}</span> : null}
        </p>
      </div>
    </>
  );
  const presenceAttrs = presence
    ? { "data-testid": "member-presence", "data-user-id": id, "data-state": presence }
    : {};
  if (onOpen) {
    return (
      <li {...presenceAttrs}>
        <button
          type="button"
          onClick={onOpen}
          data-testid="channel-member-person"
          aria-label={`View ${name}'s profile${here ? ` · ${PRESENCE_LABEL[here]}` : ""}`}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30"
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-1.5" {...presenceAttrs}>
      {body}
      {action}
    </li>
  );
}

/** Channel members (people + bots) and "add people or bots" for members of the channel. */
export function MembersDialog({
  channel,
  members,
  directory,
  open,
  onOpenChange,
  meId,
}: {
  channel: ChannelSummary;
  members: ChannelMember[];
  directory: DirEntry[];
  open: boolean;
  onOpenChange: (o: boolean) => void;
  meId: string;
}) {
  const [q, setQ] = useState("");
  const add = useAddChannelMember(channel.id);
  const [pendingKey, setPendingKey] = useState<string | null>(null);
  const [profile, setProfile] = useState<{ userId: string; open: boolean } | null>(null);
  const memberKeys = useMemo(() => new Set(members.map((m) => dirKey(m.kind, m.id))), [members]);
  const needle = q.trim().toLowerCase();
  const match = (name: string, handle: string) =>
    !needle || name.toLowerCase().includes(needle) || handle.includes(needle);
  const candidates = directory.filter(
    (e) => !memberKeys.has(dirKey(e.kind, e.id)) && match(e.displayName, e.handle),
  );
  const shown = members.filter((m) => match(m.displayName, m.handle));
  // Presence comes from the channel view's own `conv:` subscription (opt-in `presence: true`, 03-01).
  const present = usePresence(`conv:${channel.id}`);
  const presenceOf = useMemo(() => {
    const m = new Map<string, "online" | "away">();
    for (const p of present) m.set(p.userId, p.state);
    return (userId: string): MemberPresence => m.get(userId) ?? "offline";
  }, [present]);
  const hereNow = present.filter((p) => p.userId !== meId).length;
  // Array.prototype.sort is stable: each group keeps the current order.
  const people = shown
    .filter((m) => m.kind === "user")
    .sort((a, b) => PRESENCE_RANK[presenceOf(a.id)] - PRESENCE_RANK[presenceOf(b.id)]);
  const bots = shown.filter((m) => m.kind === "agent");
  const canAdd = channel.isMember && !channel.archivedAt;

  const onAdd = (e: DirEntry) => {
    const key = dirKey(e.kind, e.id);
    setPendingKey(key);
    add.mutate(
      { kind: e.kind, id: e.id },
      {
        onSuccess: () => toast.success(`${e.displayName} added to #${channel.name}`),
        onError: (err) => toast.error(errorMessage(err)),
        onSettled: () => setPendingKey(null),
      },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-lg" data-testid="members-dialog">
        <DialogHeader>
          <DialogTitle>Members of #{channel.name}</DialogTitle>
          <DialogDescription>
            {members.length} {members.length === 1 ? "member" : "members"}
            {bots.length > 0 ? ` · ${bots.length} ${bots.length === 1 ? "bot" : "bots"}` : ""}
            {hereNow > 0 ? (
              <span className="whitespace-nowrap" data-testid="members-here-now">
                {" "}
                · {hereNow} here now
              </span>
            ) : null}
            . Bots reply when you @mention them.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            placeholder={canAdd ? "Find or add people and bots" : "Find members"}
            value={q}
            onChange={(e) => setQ(e.target.value)}
            className="pl-9"
            aria-label="Search members"
          />
        </div>
        <div className="scrollbar-thin -mx-2 max-h-[55dvh] overflow-y-auto px-0">
          {people.length > 0 ? (
            <section className="mb-3 last:mb-0">
              <h3 className="px-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                People
              </h3>
              <ul className="px-2">
                {people.map((m) => (
                  <Row
                    key={m.id}
                    kind="user"
                    id={m.id}
                    name={m.displayName}
                    handle={m.handle}
                    avatarUrl={m.avatarUrl}
                    note={m.id === meId ? "(you)" : m.role === "owner" ? "· owner" : null}
                    presence={presenceOf(m.id)}
                    onOpen={() => setProfile({ userId: m.id, open: true })}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {bots.length > 0 ? (
            <section className="mb-3 last:mb-0">
              <h3 className="px-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                Bots
              </h3>
              <ul className="px-2">
                {bots.map((m) => (
                  <Row
                    key={m.id}
                    kind="agent"
                    id={m.id}
                    name={m.displayName}
                    handle={m.handle}
                    avatarUrl={m.avatarUrl}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {canAdd && candidates.length > 0 ? (
            // After the channel's own people and bots, so who is here now stays in view in a large organization.
            <section className="mb-3 last:mb-0">
              <h3 className="px-4 pb-1 font-medium text-[11px] text-muted-foreground uppercase tracking-wider">
                Add to channel
              </h3>
              <ul className="px-2">
                {candidates.slice(0, 20).map((e) => (
                  <Row
                    key={dirKey(e.kind, e.id)}
                    kind={e.kind}
                    id={e.id}
                    name={e.displayName}
                    handle={e.handle}
                    avatarUrl={e.avatarUrl}
                    action={
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onAdd(e)}
                        disabled={pendingKey !== null}
                        data-testid="add-member"
                      >
                        {pendingKey === dirKey(e.kind, e.id) ? <Spinner /> : <Plus />}
                        Add
                      </Button>
                    }
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {shown.length === 0 && candidates.length === 0 ? (
            <p className="px-4 py-6 text-center text-muted-foreground text-sm">Nobody matches “{q}”.</p>
          ) : null}
        </div>
      </DialogContent>
      <MemberProfileSheet
        userId={profile?.userId ?? null}
        open={profile?.open ?? false}
        onOpenChange={(open) => setProfile((p) => (p ? { ...p, open } : p))}
      />
    </Dialog>
  );
}
