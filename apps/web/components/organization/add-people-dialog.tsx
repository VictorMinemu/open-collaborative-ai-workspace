"use client";

import { ROLE_LABELS } from "@ocw/contracts";
import { Plus, Search } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "sonner";
import { UserAvatar } from "@/components/ui/avatar";
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
import { Skeleton } from "@/components/ui/skeleton";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { useAddUnitMember } from "@/lib/org-queries";
import { useMembers } from "@/lib/queries";
import type { UnitNode } from "./unit-meta";

/** Active organization members not yet in the unit; one click adds a person as a member. */
export function AddPeopleDialog({
  open,
  onOpenChange,
  unit,
  existing,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  unit: UnitNode;
  existing: readonly string[];
}) {
  const members = useMembers();
  const add = useAddUnitMember(unit.id);
  const [query, setQuery] = useState("");
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => {
    if (open) setQuery("");
  }, [open]);

  const q = query.trim().toLowerCase();
  const candidates = (members.data?.members ?? [])
    .filter((m) => m.status === "active" && !existing.includes(m.userId))
    .filter((m) => !q || m.displayName.toLowerCase().includes(q) || (m.email ?? "").toLowerCase().includes(q))
    .sort((a, b) => a.displayName.localeCompare(b.displayName));
  const anyoneLeft = (members.data?.members ?? []).some(
    (m) => m.status === "active" && !existing.includes(m.userId),
  );

  function addPerson(userId: string, name: string) {
    setPending(userId);
    add.mutate(
      { userId, role: "member" },
      {
        onSuccess: () => toast.success(`Added ${name} to ${unit.name}`),
        onError: (err) => toast.error(errorMessage(err)),
        onSettled: () => setPending(null),
      },
    );
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent data-testid="add-people-dialog" className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="break-words">Add people to {unit.name}</DialogTitle>
          <DialogDescription>
            They join as members. An Organization Admin can then make a Team Lead lead it.
          </DialogDescription>
        </DialogHeader>
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            type="search"
            placeholder="Search by name or email"
            aria-label="Search people"
            data-testid="add-people-search"
            className="h-10 pl-9"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
        <DialogBody className="-mt-1 min-h-40">
          {members.isLoading ? (
            <div className="grid gap-1">
              {[0, 1, 2].map((i) => (
                <div key={i} className="flex items-center gap-3 px-2 py-2">
                  <Skeleton className="size-9 rounded-full" />
                  <Skeleton className="h-3.5 w-40" />
                </div>
              ))}
            </div>
          ) : candidates.length === 0 ? (
            <p className="px-2 py-10 text-center text-muted-foreground text-sm">
              {anyoneLeft ? `No one matches “${query.trim()}”` : `Everyone is already in ${unit.name}`}
            </p>
          ) : (
            <ul className="grid gap-0.5" aria-label="People you can add">
              {candidates.map((m) => (
                <li key={m.userId}>
                  <button
                    type="button"
                    disabled={pending !== null}
                    onClick={() => addPerson(m.userId, m.displayName)}
                    data-testid="add-person"
                    data-user-id={m.userId}
                    aria-label={`Add ${m.displayName}`}
                    className="group flex min-h-12 w-full items-center gap-3 rounded-lg px-2 py-2 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:bg-accent/60 disabled:cursor-wait"
                  >
                    <UserAvatar name={m.displayName} src={m.avatarUrl} seed={m.userId} className="size-9" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate font-medium text-sm">{m.displayName}</span>
                      <span className="block truncate text-muted-foreground text-xs">
                        {ROLE_LABELS[m.role]}
                        {m.email ? ` · ${m.email}` : ""}
                      </span>
                    </span>
                    <span className="flex h-8 shrink-0 items-center gap-1 rounded-md border px-2.5 font-medium text-[13px] transition-colors group-hover:border-primary/40 group-hover:bg-primary/8 group-hover:text-primary">
                      {pending === m.userId ? (
                        <Spinner className="size-3.5" />
                      ) : (
                        <Plus className="size-3.5" />
                      )}
                      Add
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Done
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
