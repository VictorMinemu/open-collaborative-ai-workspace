"use client";

import { Menu } from "@base-ui/react/menu";
import type { AiChatGrant, AiGrantLevel, AiGrantSubject, Member, OrgUnit } from "@ocw/contracts";
import { useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  Eye,
  Globe,
  MessageSquareText,
  Search,
  TriangleAlert,
  UserMinus,
  UserPlus,
  X,
} from "lucide-react";
import { useId, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { PrincipalAvatar } from "@/components/chat/principal-avatar";
import { KIND_META, KindIcon } from "@/components/organization/unit-meta";
import { Button } from "@/components/ui/button";
import { DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator } from "@/components/ui/dropdown-menu";
import { Spinner } from "@/components/ui/spinner";
import {
  createAiChatGrant,
  revokeAiChatGrant,
  updateAiChatGrant,
  useAiChatGrants,
} from "@/lib/ai-grant-queries";
import { errorMessage } from "@/lib/api";
import { useUnits } from "@/lib/org-queries";
import { useMe, useMembers } from "@/lib/queries";
import { cn } from "@/lib/utils";

/**
 * "People and teams" of the share dialog (06-03 → 06-12; MULTI-01, D-03, D-08, P-13). The owner shares the chat in place
 * with a person, a department, a team, a project or everyone in the organization, at Can chat or Can view; changes a
 * level and removes access from the list of who has access. What becomes visible is stated first, above the picker;
 * the whole organization always asks for a confirmation, and so does every removal. The server decides every change
 * (`ai_chat.share`, owner only); this section renders its answers. No public link exists anywhere.
 */

const LEVELS: Array<{ value: AiGrantLevel; label: string; hint: string; icon: typeof Eye }> = [
  { value: "chat", label: "Can chat", hint: "Read, write and ask the model", icon: MessageSquareText },
  { value: "view", label: "Can view", hint: "Read only", icon: Eye },
];
export const levelLabel = (level: AiGrantLevel) => LEVELS.find((l) => l.value === level)?.label ?? level;

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

/** Something the owner can share with, as the picker offers it. */
type ShareSubject =
  | { kind: "user"; member: Member }
  | { kind: "unit"; unit: OrgUnit; trail: string }
  | { kind: "org"; orgName: string };

const pickKey = (p: ShareSubject) =>
  p.kind === "user" ? `user:${p.member.userId}` : p.kind === "unit" ? `unit:${p.unit.id}` : "org";
const pickName = (p: ShareSubject) =>
  p.kind === "user" ? p.member.displayName : p.kind === "unit" ? p.unit.name : `Everyone at ${p.orgName}`;
const subjectOf = (p: ShareSubject): AiGrantSubject =>
  p.kind === "user"
    ? { kind: "user", id: p.member.userId }
    : p.kind === "unit"
      ? { kind: "unit", id: p.unit.id }
      : { kind: "org" };
const grantKey = (g: AiChatGrant) => (g.subject.kind === "org" ? "org" : `${g.subject.kind}:${g.subject.id}`);

export function SharePeople({ chatId, orgName }: { chatId: string; orgName: string }) {
  const qc = useQueryClient();
  const me = useMe();
  const grants = useAiChatGrants(chatId, true);
  const [picked, setPicked] = useState<ShareSubject | null>(null);
  const [level, setLevel] = useState<AiGrantLevel>("chat");
  const [busy, setBusy] = useState(false);
  const [confirmOrg, setConfirmOrg] = useState(false);
  const list = grants.data?.grants ?? [];
  // Widest first: the organization, then units, then people (each by name).
  const ordered = useMemo(() => {
    const rank = { org: 0, unit: 1, user: 2 } as const;
    return [...list].sort(
      (a, b) => rank[a.subject.kind] - rank[b.subject.kind] || a.label.localeCompare(b.label),
    );
  }, [list]);
  const levelOf = useMemo(() => new Map(list.map((g) => [grantKey(g), g.level])), [list]);

  async function share() {
    if (!picked || busy) return;
    // The whole organization is never one click away (T-06-12-01).
    if (picked.kind === "org" && !confirmOrg) {
      setConfirmOrg(true);
      return;
    }
    setBusy(true);
    try {
      await createAiChatGrant(qc, chatId, { subject: subjectOf(picked), level });
      toast.success(`Shared with ${pickName(picked)}`);
      setPicked(null);
      setConfirmOrg(false);
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

      <div
        data-testid="ai-share-disclosure"
        className="grid gap-2 rounded-xl border bg-muted/30 px-3.5 py-3 text-[13px] text-muted-foreground leading-snug"
      >
        <div>
          <p className="font-medium text-foreground/85">They will see:</p>
          <ul className="mt-1 grid list-disc gap-x-6 gap-y-0.5 pl-4 marker:text-muted-foreground/60 sm:grid-cols-2">
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

      <SubjectPicker
        picked={picked}
        onPick={(p) => {
          setPicked(p);
          setConfirmOrg(false);
        }}
        excludeId={me.data?.user.id ?? null}
        orgName={orgName}
        levelOf={levelOf}
      />

      {confirmOrg && picked?.kind === "org" ? (
        <div
          data-testid="ai-share-org-confirm"
          role="alertdialog"
          aria-labelledby="ai-share-org-confirm-text"
          className="grid gap-3 rounded-xl border border-warning/40 bg-warning/[0.07] px-3.5 py-3"
        >
          <div className="flex items-start gap-2.5">
            <TriangleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-warning" />
            <p id="ai-share-org-confirm-text" className="text-[13px] leading-snug">
              <span className="font-medium">Everyone in {orgName} will see this whole conversation</span>
              <span className="text-muted-foreground">
                {" "}
                — earlier messages, answers and files included —{" "}
                {level === "chat" ? "and can write in it." : "read-only."} People who join {orgName} later
                will see it too.
              </span>
            </p>
          </div>
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              variant="ghost"
              size="sm"
              data-testid="ai-share-org-cancel"
              onClick={() => setConfirmOrg(false)}
              disabled={busy}
            >
              Cancel
            </Button>
            <Button
              size="sm"
              data-testid="ai-share-org-confirm-submit"
              onClick={() => void share()}
              disabled={busy}
            >
              {busy ? <Spinner /> : <Globe />}
              Share with everyone
            </Button>
          </div>
        </div>
      ) : (
        <div className="flex flex-wrap items-center gap-2">
          <LevelToggle level={level} onChange={setLevel} />
          <Button
            data-testid="ai-share-submit"
            onClick={() => void share()}
            disabled={!picked || busy}
            className="ml-auto h-9 min-w-24"
          >
            {busy ? <Spinner /> : <UserPlus />}
            Share
          </Button>
        </div>
      )}

      <div className="grid gap-1">
        <h4 className="font-medium text-[12.5px] text-muted-foreground">Who has access</h4>
        <ul data-testid="ai-share-people-list" className="grid gap-0.5">
          {me.data ? (
            <li className="flex min-h-11 items-center gap-2.5 rounded-lg px-1 py-1">
              <PrincipalAvatar
                kind="user"
                name={me.data.user.name}
                avatarUrl={me.data.user.image}
                seed={me.data.user.id}
                className="size-7"
              />
              <span className="min-w-0 flex-1 truncate font-medium text-[13.5px]">
                {me.data.user.name}
                <span className="font-normal text-muted-foreground"> (you)</span>
              </span>
              <span className="shrink-0 px-2 text-[12.5px] text-muted-foreground">Owner</span>
            </li>
          ) : null}
          {ordered.map((g) => (
            <GrantRow key={g.id} chatId={chatId} grant={g} orgName={orgName} />
          ))}
        </ul>
        {grants.isSuccess && list.length === 0 ? (
          <p className="px-1 text-[12.5px] text-muted-foreground">Only you can see this chat.</p>
        ) : null}
      </div>
    </section>
  );
}

/** Can chat / Can view: one tap at 390 (a radio group, 06-03). */
function LevelToggle({ level, onChange }: { level: AiGrantLevel; onChange: (l: AiGrantLevel) => void }) {
  return (
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
            onClick={() => onChange(l.value)}
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
  );
}

/** The icon of a grant subject or a picker option: a person's avatar, a unit's kind icon, the organization's globe. */
function SubjectIcon({ pick, grant }: { pick?: ShareSubject; grant?: AiChatGrant }) {
  const kind = pick?.kind ?? grant?.subject.kind;
  if (kind === "user") {
    const id =
      pick?.kind === "user" ? pick.member.userId : grant?.subject.kind === "user" ? grant.subject.id : "";
    const name = pick ? pickName(pick) : (grant?.label ?? "");
    const avatar = pick?.kind === "user" ? pick.member.avatarUrl : null;
    return <PrincipalAvatar kind="user" name={name} avatarUrl={avatar} seed={id} className="size-7" />;
  }
  if (kind === "unit") {
    const unitKind = pick?.kind === "unit" ? pick.unit.kind : (grant?.unitKind ?? "team");
    return (
      <span data-testid="ai-share-unit-icon" className="inline-flex">
        <KindIcon kind={unitKind} className="size-7 rounded-full [&_svg]:size-3.5" />
      </span>
    );
  }
  return (
    <span
      aria-hidden
      className="flex size-7 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary [&_svg]:size-3.5"
    >
      <Globe />
    </span>
  );
}

/** A grant's second line: what kind of audience it is. */
function grantCaption(g: AiChatGrant, orgName: string): string | null {
  if (g.subject.kind === "org") return `Every member of ${orgName}`;
  if (g.subject.kind === "unit") return KIND_META[g.unitKind ?? "team"].label;
  return null;
}

/**
 * One grant of the list: who, their level as a menu (Can chat / Can view / Remove access). Removing asks once, in
 * place; the people it covered lose the chat at once.
 */
function GrantRow({ chatId, grant, orgName }: { chatId: string; grant: AiChatGrant; orgName: string }) {
  const qc = useQueryClient();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  async function setLevel(level: AiGrantLevel) {
    if (level === grant.level || busy) return;
    setBusy(true);
    try {
      await updateAiChatGrant(qc, chatId, grant.id, { level });
      toast.success(`${grant.label} can ${level === "chat" ? "chat" : "view"} now`);
    } catch (err) {
      toast.error("Couldn't change the access", { description: errorMessage(err) });
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (busy) return;
    setBusy(true);
    try {
      await revokeAiChatGrant(qc, chatId, grant.id);
      toast.success(`Removed access for ${grant.label}`);
    } catch (err) {
      toast.error("Couldn't remove the access", { description: errorMessage(err) });
      setBusy(false);
    }
  }

  const caption = grantCaption(grant, orgName);
  const covers =
    grant.subject.kind === "user"
      ? "They will no longer see this chat."
      : grant.subject.kind === "unit"
        ? `People in ${grant.label} lose it unless another share still covers them.`
        : `Members of ${orgName} lose it unless another share still covers them.`;

  return (
    <li data-testid="ai-share-grant" data-subject-kind={grant.subject.kind} className="grid gap-1">
      <div className="flex min-h-11 items-center gap-2.5 rounded-lg px-1 py-1">
        <SubjectIcon grant={grant} />
        <span className="grid min-w-0 flex-1 leading-tight">
          <span className="truncate font-medium text-[13.5px]">{grant.label}</span>
          {caption ? <span className="truncate text-[12px] text-muted-foreground">{caption}</span> : null}
        </span>
        <Menu.Root>
          <Menu.Trigger
            data-testid="ai-share-grant-level"
            aria-label={`Access for ${grant.label}: ${levelLabel(grant.level)}`}
            disabled={busy}
            className="inline-flex h-8 shrink-0 items-center gap-1 rounded-md px-2 font-medium text-[12.5px] text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30 disabled:opacity-60 data-popup-open:bg-accent data-popup-open:text-foreground"
          >
            {busy ? <Spinner className="size-3" /> : null}
            {levelLabel(grant.level)}
            <ChevronDown aria-hidden className="size-3.5" />
          </Menu.Trigger>
          <DropdownMenuContent align="end" className="min-w-52">
            {LEVELS.map((l) => (
              <DropdownMenuItem
                key={l.value}
                data-testid={`ai-share-grant-level-${l.value}`}
                onClick={() => void setLevel(l.value)}
                className={cn(l.value === grant.level && "font-medium")}
              >
                <l.icon />
                <span className="grid leading-tight">
                  <span>{l.label}</span>
                  <span className="text-[11.5px] text-muted-foreground">{l.hint}</span>
                </span>
              </DropdownMenuItem>
            ))}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              data-testid="ai-share-grant-remove"
              variant="destructive"
              onClick={() => setConfirming(true)}
            >
              <UserMinus />
              Remove access
            </DropdownMenuItem>
          </DropdownMenuContent>
        </Menu.Root>
      </div>
      {confirming ? (
        <div
          data-testid="ai-share-remove-confirm"
          className="mx-1 mb-1 flex flex-wrap items-center gap-x-3 gap-y-2 rounded-lg bg-destructive/[0.06] px-2.5 py-2"
        >
          <p className="min-w-0 flex-1 text-[12.5px] leading-snug">
            Remove access for <span className="font-medium">{grant.label}</span>? {covers}
          </p>
          <div className="flex shrink-0 gap-1.5">
            <Button variant="ghost" size="sm" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button
              variant="destructive"
              size="sm"
              data-testid="ai-share-remove-confirm-submit"
              onClick={() => void remove()}
              disabled={busy}
            >
              {busy ? <Spinner /> : null}
              Remove
            </Button>
          </div>
        </div>
      ) : null}
    </li>
  );
}

/**
 * One field searching the organization's active members (name or email), its departments, teams and projects (with the
 * Phase 4 unit icons and their parent trail) and "Everyone at <org>". The pick shows as a chip in the field (Backspace
 * or ✕ clears it); subjects that already have access say at which level.
 */
function SubjectPicker({
  picked,
  onPick,
  excludeId,
  orgName,
  levelOf,
}: {
  picked: ShareSubject | null;
  onPick: (p: ShareSubject | null) => void;
  excludeId: string | null;
  orgName: string;
  levelOf: ReadonlyMap<string, AiGrantLevel>;
}) {
  const members = useMembers();
  const units = useUnits();
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [q, setQ] = useState("");
  const [focused, setFocused] = useState(false);
  const [active, setActive] = useState(0);
  const needle = q.trim().toLowerCase();

  const options = useMemo((): ShareSubject[] => {
    if (!needle) return [];
    const byId = new Map((units.data?.units ?? []).map((u) => [u.id, u]));
    const people: ShareSubject[] = (members.data?.members ?? [])
      .filter((m) => m.status === "active" && m.userId !== excludeId)
      .filter(
        (m) => m.displayName.toLowerCase().includes(needle) || (m.email ?? "").toLowerCase().includes(needle),
      )
      .slice(0, 5)
      .map((member) => ({ kind: "user", member }));
    const groups: ShareSubject[] = (units.data?.units ?? [])
      .filter((u) => u.name.toLowerCase().includes(needle))
      .slice(0, 4)
      .map((unit) => ({
        kind: "unit",
        unit,
        trail: unit.path
          .slice(0, -1)
          .map((id) => byId.get(id)?.name)
          .filter((n): n is string => !!n)
          .join(" › "),
      }));
    const everyone = ["everyone", "organization", "all", orgName.toLowerCase()].some(
      (w) => w.startsWith(needle) || needle.startsWith(w),
    );
    return [...groups, ...people, ...(everyone ? [{ kind: "org", orgName } as ShareSubject] : [])];
  }, [needle, members.data, units.data, excludeId, orgName]);
  const showOptions = !picked && focused && needle.length > 0;

  const pick = (p: ShareSubject) => {
    onPick(p);
    setQ("");
    setActive(0);
  };

  return (
    <div className="relative">
      <div className="flex min-h-10 items-center gap-1.5 rounded-lg border bg-background px-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/25">
        {picked ? (
          <span
            data-testid="ai-share-person-chip"
            data-subject-kind={picked.kind}
            className="inline-flex h-7 min-w-0 max-w-full items-center gap-1.5 rounded-full bg-muted py-0.5 pr-1 pl-0.5 text-[13.5px]"
          >
            <span className="inline-flex scale-[0.86]">
              <SubjectIcon pick={picked} />
            </span>
            <span className="truncate">{pickName(picked)}</span>
            <button
              type="button"
              aria-label={`Remove ${pickName(picked)}`}
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
          aria-label="Add people, teams or everyone"
          placeholder={picked ? "" : "Add people, teams or everyone"}
          value={q}
          readOnly={!!picked}
          onChange={(e) => {
            setQ(e.target.value);
            setActive(0);
          }}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          onKeyDown={(e) => {
            if (e.key === "Backspace" && !q && picked) onPick(null);
            if (!showOptions || options.length === 0) return;
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
              e.preventDefault();
              const step = e.key === "ArrowDown" ? 1 : -1;
              setActive((i) => (i + step + options.length) % options.length);
            } else if (e.key === "Enter" && !e.nativeEvent.isComposing) {
              e.preventDefault();
              const p = options[active] ?? options[0];
              if (p) pick(p);
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
          aria-label="People, teams and the organization"
          className="absolute inset-x-0 top-full z-10 mt-1 grid max-h-72 gap-px overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-lg shadow-black/5 dark:shadow-black/40"
        >
          {members.isPending ? (
            <div className="flex justify-center py-4 text-muted-foreground">
              <Spinner />
            </div>
          ) : options.length === 0 ? (
            <p className="px-3 py-3 text-[13px] text-muted-foreground">
              Nobody and no team in {orgName} matches “{q}”.
            </p>
          ) : (
            options.map((p, i) => {
              const has = levelOf.get(pickKey(p));
              const caption =
                p.kind === "user"
                  ? p.member.email
                  : p.kind === "unit"
                    ? [
                        KIND_META[p.unit.kind].label,
                        p.unit.memberCount ? `${p.unit.memberCount} people` : null,
                        p.trail,
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    : "Everyone in the organization";
              return (
                <button
                  key={pickKey(p)}
                  type="button"
                  role="option"
                  aria-selected={i === active}
                  data-testid="ai-share-person-option"
                  data-subject-kind={p.kind}
                  onMouseDown={(e) => e.preventDefault()}
                  onMouseEnter={() => setActive(i)}
                  onClick={() => pick(p)}
                  className={cn(
                    "flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left outline-none transition-colors hover:bg-accent focus-visible:bg-accent",
                    i === active && "bg-accent/70",
                  )}
                >
                  <SubjectIcon pick={p} />
                  <span className="grid min-w-0 flex-1 leading-tight">
                    <span className="truncate font-medium text-[13.5px]">{pickName(p)}</span>
                    {caption ? (
                      <span className="truncate text-[12px] text-muted-foreground">{caption}</span>
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
