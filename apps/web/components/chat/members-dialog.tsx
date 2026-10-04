"use client";

import type { ChannelMember, ChannelSummary } from "@ocw/contracts";
import { Plus, Search } from "lucide-react";
import { useMemo, useState } from "react";
import { toast } from "sonner";
import { MemberProfileSheet } from "@/components/members/member-profile-sheet";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useAddChannelMember } from "@/lib/chat-queries";
import { BotBadge, PrincipalAvatar } from "./principal-avatar";
import { type DirEntry, dirKey } from "./use-chat-directory";

function Row({
  kind,
  id,
  name,
  handle,
  avatarUrl,
  note,
  action,
  onOpen,
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
}) {
  const body = (
    <>
      <PrincipalAvatar kind={kind} name={name} avatarUrl={avatarUrl} seed={id} className="size-8" />
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-1.5">
          <span className="truncate font-medium text-sm">{name}</span>
          {kind === "agent" ? <BotBadge /> : null}
          {note ? <span className="text-muted-foreground text-xs">{note}</span> : null}
        </div>
        <p className="truncate text-muted-foreground text-xs">@{handle}</p>
      </div>
    </>
  );
  if (onOpen) {
    return (
      <li>
        <button
          type="button"
          onClick={onOpen}
          data-testid="channel-member-person"
          aria-label={`View ${name}'s profile`}
          className="flex w-full items-center gap-3 rounded-lg px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30"
        >
          {body}
        </button>
      </li>
    );
  }
  return (
    <li className="flex items-center gap-3 rounded-lg px-2 py-1.5">
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
  const people = shown.filter((m) => m.kind === "user");
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
            {bots.length > 0 ? ` · ${bots.length} ${bots.length === 1 ? "bot" : "bots"}` : ""}. Bots reply
            when you @mention them.
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
          {canAdd && candidates.length > 0 ? (
            <section className="mb-3">
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
          {people.length > 0 ? (
            <section className="mb-3">
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
                    onOpen={() => setProfile({ userId: m.id, open: true })}
                  />
                ))}
              </ul>
            </section>
          ) : null}
          {bots.length > 0 ? (
            <section>
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
