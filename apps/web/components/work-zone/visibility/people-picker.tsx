"use client";

import type { WorkProjectPerson } from "@ocw/contracts";
import { Search, X } from "lucide-react";
import { useId, useRef, useState } from "react";
import { UserAvatar } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import {
  addPeopleLabel,
  inactiveLine,
  noMatchLine,
  ownerRowName,
  PICK_PERSON_HINT,
  type PlaceContext,
} from "@/lib/session-visibility";
import { cn } from "@/lib/utils";

export interface PickerPerson extends WorkProjectPerson {
  /** Still has project access (someone who left stays stored but grants nothing, §1.5). */
  active: boolean;
}

export interface PeopleSearch {
  q: string;
  onQuery: (q: string) => void;
  /** The API's matches (people with project access only); undefined while nothing was asked yet. */
  results: readonly WorkProjectPerson[] | undefined;
  searching: boolean;
}

/**
 * The People picker (UI-SPEC §1.3), under the People row: the owner first (always sees it), then the chosen people
 * with a remove button, then one search field restricted by the API to people with project access, whose options
 * render inline (never an overlay, so nothing clips inside the popover or the sheet). Every pick and remove applies at
 * once (the panel saves it); nobody chosen yet shows the hint and saves nothing. The combobox markup is the AI-chat
 * share picker's (`share-people.tsx`), without teams or "Everyone".
 */
export function PeoplePicker({
  owner,
  chosen,
  place,
  search,
  busy,
  sheet,
  onPick,
  onRemove,
  initialOpen = false,
}: {
  owner: { userId: string; name: string | null; viewerIsOwner: boolean };
  chosen: readonly PickerPerson[];
  place: PlaceContext;
  search: PeopleSearch;
  /** The person whose change is being saved. */
  busy: string | null;
  sheet: boolean;
  onPick: (p: WorkProjectPerson) => void;
  onRemove: (userId: string) => void;
  /** Tests render the option list without focus. */
  initialOpen?: boolean;
}) {
  const listId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [open, setOpen] = useState(initialOpen);
  const [active, setActive] = useState(0);
  const taken = new Set([owner.userId, ...chosen.map((p) => p.userId)]);
  const options = (search.results ?? []).filter((p) => !taken.has(p.userId));
  // Nothing to show for an empty field with nobody left to add; a typed name that matches nobody says so.
  const showOptions = open && search.results !== undefined && (options.length > 0 || search.q.trim() !== "");
  const label = addPeopleLabel(place);
  const anyActive = chosen.some((p) => p.active);

  const pick = (p: WorkProjectPerson) => {
    onPick(p);
    search.onQuery("");
    setActive(0);
  };

  return (
    <div data-testid="people-picker" className="grid min-w-0 gap-1 pr-4 pb-2 pl-16">
      <ul aria-label="People who can see it" className="grid min-w-0 gap-px">
        <li className="flex min-h-11 min-w-0 items-center gap-2 px-1.5 md:min-h-9">
          <UserAvatar name={owner.name ?? "Owner"} seed={owner.userId} className="size-6 text-[10px]" />
          <span className="min-w-0 flex-1 truncate text-sm" title={owner.name ?? undefined}>
            {ownerRowName({ ownerName: owner.name, viewerIsOwner: owner.viewerIsOwner })}
          </span>
          <span className="shrink-0 text-muted-foreground text-xs">Owner</span>
        </li>
        {chosen.map((p) =>
          p.active ? (
            <li
              key={p.userId}
              data-user-id={p.userId}
              className="flex min-h-11 min-w-0 items-center gap-2 px-1.5 md:min-h-9"
            >
              <UserAvatar name={p.name} src={p.avatarUrl} seed={p.userId} className="size-6 text-[10px]" />
              <span className="min-w-0 flex-1 truncate text-sm" title={p.name}>
                {p.name}
              </span>
              <RemoveButton
                name={p.name}
                busy={busy === p.userId}
                onClick={() => onRemove(p.userId)}
                id={p.userId}
              />
            </li>
          ) : (
            <li
              key={p.userId}
              data-testid="visibility-inactive"
              data-user-id={p.userId}
              className="flex min-h-11 min-w-0 items-center gap-2 px-1.5 md:min-h-9"
            >
              <UserAvatar
                name={p.name}
                src={p.avatarUrl}
                seed={p.userId}
                className="size-6 text-[10px] opacity-50 grayscale"
              />
              <span className="grid min-w-0 flex-1 leading-tight">
                <span
                  className="truncate text-muted-foreground text-sm line-through decoration-muted-foreground/40"
                  title={p.name}
                >
                  {p.name}
                </span>
                <span className="truncate text-muted-foreground text-xs">
                  {inactiveLine("person", place.projectName)}
                </span>
              </span>
              <RemoveButton
                name={p.name}
                busy={busy === p.userId}
                onClick={() => onRemove(p.userId)}
                id={p.userId}
              />
            </li>
          ),
        )}
      </ul>
      <div className="flex min-w-0 items-center gap-1.5 rounded-lg border bg-background px-2 focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/25 dark:bg-input/25">
        {search.searching ? (
          <Spinner className="ml-0.5 size-4 text-muted-foreground" />
        ) : (
          <Search aria-hidden className="ml-0.5 size-4 shrink-0 text-muted-foreground" />
        )}
        <input
          ref={inputRef}
          data-testid="people-input"
          role="combobox"
          aria-expanded={showOptions}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showOptions && options[active] ? `${listId}-${active}` : undefined}
          aria-label={label}
          placeholder={label}
          value={search.q}
          onChange={(e) => {
            search.onQuery(e.target.value);
            setActive(0);
            setOpen(true);
          }}
          onFocus={(e) => {
            setOpen(true);
            // A phone's keyboard covers the lower half of the sheet: keep the field in view (§1.6).
            const el = e.currentTarget;
            if (sheet) window.setTimeout(() => el.scrollIntoView({ block: "nearest" }), 300);
          }}
          onBlur={() => setOpen(false)}
          onKeyDown={(e) => {
            if (e.key === "Escape" && open) {
              // The first Escape closes the options; the next one closes the panel.
              if (showOptions) {
                e.stopPropagation();
                setOpen(false);
              }
              return;
            }
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
            "min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70",
            sheet ? "h-11 text-base" : "h-9 text-sm max-md:h-11 max-md:text-base",
          )}
        />
      </div>
      {showOptions ? (
        <div
          id={listId}
          role="listbox"
          aria-label={label}
          className="scrollbar-thin grid max-h-48 gap-px overflow-y-auto rounded-lg border bg-popover p-1"
        >
          {options.length === 0 ? (
            search.searching ? (
              <div className="flex justify-center py-2 text-muted-foreground">
                <Spinner className="size-4" />
              </div>
            ) : (
              <p className="px-2 py-2 text-muted-foreground text-xs">{noMatchLine(place, search.q)}</p>
            )
          ) : (
            options.map((p, i) => (
              <button
                key={p.userId}
                id={`${listId}-${i}`}
                type="button"
                role="option"
                aria-selected={i === active}
                data-testid={`people-option-${p.userId}`}
                tabIndex={-1}
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActive(i)}
                onClick={() => pick(p)}
                className={cn(
                  "flex min-h-11 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left outline-none transition-colors hover:bg-accent md:min-h-9",
                  i === active && "bg-accent/70",
                )}
              >
                <UserAvatar name={p.name} src={p.avatarUrl} seed={p.userId} className="size-6 text-[10px]" />
                <span className="min-w-0 flex-1 truncate text-sm" title={p.name}>
                  {p.name}
                </span>
              </button>
            ))
          )}
        </div>
      ) : null}
      {anyActive ? null : <p className="px-1.5 text-muted-foreground text-xs">{PICK_PERSON_HINT}</p>}
    </div>
  );
}

function RemoveButton({
  id,
  name,
  busy,
  onClick,
}: {
  id: string;
  name: string;
  busy: boolean;
  onClick: () => void;
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon-xs"
      data-testid={`people-remove-${id}`}
      aria-label={`Remove ${name}`}
      onClick={onClick}
      className="text-muted-foreground max-md:size-11"
    >
      {busy ? <Spinner className="size-3" /> : <X />}
    </Button>
  );
}
