"use client";

import type { ModelControl, RuntimeId, SessionControls, WorkSession } from "@ocw/contracts";
import { ChevronDown, ChevronRight, Search, Star } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { toast } from "sonner";
import { Spinner } from "@/components/ui/spinner";
import { errorMessage } from "@/lib/api";
import { cn } from "@/lib/utils";
import { useSessionControls, useUpdateSessionSettings } from "@/lib/workzone-queries";
import { ControlChip, ControlSurface, useSheetSurface } from "./control-surface";
import { controlReasonText, isShown, RUNTIMES, RuntimeMark } from "./meta";

// ---------------------------------------------------------------- which catalog row the session runs

const byId = (models: ModelControl[], id: string | null | undefined) =>
  id ? models.find((m) => m.id === id) : undefined;

/**
 * The catalog row for a model id the device reported. The runtime reports the concrete id (Claude's init says
 * `claude-sonnet-5-5`) while the catalog lists aliases (`sonnet`), so a row also matches through its
 * `resolvedModel`; the requested row wins a tie, then a current (non-legacy) row.
 */
export function matchModel(
  models: ModelControl[],
  id: string | null | undefined,
  preferId?: string | null,
): ModelControl | undefined {
  if (!id) return undefined;
  const exact = byId(models, id);
  if (exact) return exact;
  const resolved = models.filter((m) => m.resolvedModel === id);
  return resolved.find((m) => m.id === preferId) ?? resolved.find((m) => !m.legacy) ?? resolved[0];
}

/** What the composer shows for the session's model, and whether the runtime runs something else (D-14). */
export function sessionModel(session: WorkSession, models: ModelControl[]) {
  const { requested, effective, pending } = session.settings;
  const requestedId = requested.model ?? null;
  const fallback = requestedId ? undefined : models.find((m) => m.isDefault);
  const wanted = byId(models, requestedId) ?? fallback;
  const running = matchModel(models, effective?.model, requestedId);
  const shown = pending ? wanted : (running ?? wanted);
  // E.g. Claude Code in Plan mode runs Haiku as Sonnet (03.2-02): say so instead of hiding it.
  const substituted = !pending && running && wanted && running.id !== wanted.id ? { running, wanted } : null;
  return { shown, wanted, substituted };
}

/** The model whose efforts / windows / fast mode the reasoning menu offers: requested while pending, else running. */
export function currentModelControl(session: WorkSession, controls: SessionControls | undefined) {
  return controls ? sessionModel(session, controls.models).shown : undefined;
}

// ---------------------------------------------------------------- favorites (localStorage, per runtime)

const FAVORITES_KEY = "ocw.wz.favorite-models";
type Favorites = Partial<Record<RuntimeId, string[]>>;
const favoriteListeners = new Set<() => void>();

function readFavorites(): string {
  try {
    return window.localStorage.getItem(FAVORITES_KEY) ?? "{}";
  } catch {
    return "{}";
  }
}

function parseFavorites(raw: string): Favorites {
  try {
    const v = JSON.parse(raw) as unknown;
    if (!v || typeof v !== "object") return {};
    const out: Favorites = {};
    for (const r of ["claude-code", "codex"] as const) {
      const ids = (v as Record<string, unknown>)[r];
      if (Array.isArray(ids)) out[r] = ids.filter((x): x is string => typeof x === "string").slice(0, 50);
    }
    return out;
  } catch {
    return {};
  }
}

/** Starred model ids per runtime, shared by every picker on the page and kept across reloads. */
function useFavoriteModels(runtime: RuntimeId) {
  const raw = useSyncExternalStore(
    (onChange) => {
      favoriteListeners.add(onChange);
      window.addEventListener("storage", onChange);
      return () => {
        favoriteListeners.delete(onChange);
        window.removeEventListener("storage", onChange);
      };
    },
    readFavorites,
    () => "{}",
  );
  const all = useMemo(() => parseFavorites(raw), [raw]);
  const ids = all[runtime] ?? [];
  const toggle = useCallback(
    (id: string) => {
      const current = parseFavorites(readFavorites());
      const list = current[runtime] ?? [];
      current[runtime] = list.includes(id) ? list.filter((x) => x !== id) : [...list, id];
      try {
        window.localStorage.setItem(FAVORITES_KEY, JSON.stringify(current));
      } catch {
        // Private mode / quota: favorites just do not persist.
      }
      for (const l of favoriteListeners) l();
    },
    [runtime],
  );
  return { ids, toggle };
}

// ---------------------------------------------------------------- the picker (ref-3)

const isApple = () => typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

type View = "favorites" | RuntimeId;

/**
 * Composer model chip and picker (D-08, D-14, D-16; owner's reference picker). The list comes ONLY from the
 * catalog the device's runtime reported (`GET /work-sessions/:id/controls`): search, a favorites star, a provider
 * rail with both runtimes (the other one listed but disabled — switching provider inside a chat is not available
 * yet), ⌘1–⌘5 for the first five rows, and the catalog's legacy rows folded into "Legacy models". A change is
 * held as pending until the device reports it.
 */
export function ModelPicker({ session, disabled = false }: { session: WorkSession; disabled?: boolean }) {
  const controls = useSessionControls(session.id);
  const update = useUpdateSessionSettings(session.id);
  const sheet = useSheetSurface();
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<View>(session.runtime);
  const [query, setQuery] = useState("");
  const [legacyOpen, setLegacyOpen] = useState(false);
  const search = useRef<HTMLInputElement>(null);
  const favorites = useFavoriteModels(session.runtime);

  const models = useMemo(() => (controls.data?.models ?? []).filter(isShown), [controls.data]);
  const { pending, requested, effective } = session.settings;
  const { shown, substituted } = sessionModel(session, models);
  const label = shown?.displayName ?? effective?.model ?? requested.model ?? "Default";
  const currentId = shown?.id ?? null;
  const noCatalog = controls.isSuccess && controls.data.catalog === null;
  const locked = disabled || noCatalog || !models.some((m) => m.available);
  const note = substituted
    ? `${RUNTIMES[session.runtime].label} is running ${substituted.running.displayName} for ${substituted.wanted.displayName}${session.permissionMode === "plan" ? " in Plan mode" : ""}.`
    : null;

  function onOpenChange(next: boolean) {
    setOpen(next);
    if (next) {
      setView(session.runtime);
      setQuery("");
      setLegacyOpen(!!shown?.legacy);
    }
  }

  function pick(m: ModelControl) {
    if (!m.available) return;
    setOpen(false);
    if (m.id === currentId && !pending) return;
    update.mutate(
      { model: m.id },
      {
        onSuccess: () =>
          toast.success(`Model set to ${m.displayName}`, {
            description:
              session.status === "running" || session.status === "waiting_approval"
                ? "Applies to the next turn"
                : undefined,
          }),
        onError: (err) => toast.error(errorMessage(err)),
      },
    );
  }

  // ---- rows of the current view
  const q = query.trim().toLowerCase();
  const matches = (name: string, id: string) =>
    !q || name.toLowerCase().includes(q) || id.toLowerCase().includes(q);
  const other = view !== "favorites" && view !== session.runtime;
  const otherModels = other
    ? (controls.data?.otherRuntimes.find((r) => r.runtime === view)?.models ?? []).filter((m) =>
        matches(m.displayName, m.id),
      )
    : [];
  const visible = models.filter((m) => matches(m.displayName, m.id));
  const rows: ModelControl[] =
    view === "favorites"
      ? visible.filter((m) => favorites.ids.includes(m.id))
      : other
        ? []
        : q
          ? visible
          : visible.filter((m) => !m.legacy);
  const legacyRows = view === session.runtime && !q ? visible.filter((m) => m.legacy) : [];
  const shortcutRows = sheet || other ? [] : rows.slice(0, 5);

  // ---- ⌘1–⌘5 / Ctrl+1–5 pick one of the first five rows while the picker is open
  const shortcutRef = useRef<{ rows: ModelControl[]; pick: (m: ModelControl) => void }>({ rows: [], pick });
  shortcutRef.current = { rows: shortcutRows, pick };
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey) return;
      const n = Number(e.key);
      if (!Number.isInteger(n) || n < 1 || n > 5) return;
      const m = shortcutRef.current.rows[n - 1];
      if (!m) return;
      e.preventDefault();
      shortcutRef.current.pick(m);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  const mod = isApple() ? "⌘" : "Ctrl ";

  const row = (m: ModelControl) => {
    const selected = m.id === currentId;
    const reason = m.available ? null : controlReasonText(m, { runtime: session.runtime });
    const starred = favorites.ids.includes(m.id);
    const shortcut = shortcutRows.indexOf(m);
    return (
      <div
        key={m.id}
        role="option"
        tabIndex={-1}
        aria-selected={selected}
        aria-disabled={!m.available}
        data-testid="model-option"
        data-model-id={m.id}
        className={cn(
          "group relative flex items-center gap-1 rounded-lg pr-1.5 transition-colors",
          selected ? "bg-accent" : "hover:bg-accent/60",
          !m.available && "hover:bg-transparent",
        )}
      >
        <button
          type="button"
          data-surface-item
          aria-disabled={!m.available}
          onClick={() => pick(m)}
          className={cn(
            "flex min-w-0 flex-1 flex-col items-start gap-0.5 rounded-lg py-2 pl-3 text-left outline-none focus-visible:ring-[3px] focus-visible:ring-ring/30",
            !m.available && "cursor-not-allowed",
          )}
          title={m.description ?? undefined}
        >
          <span
            className={cn(
              "flex max-w-full items-center gap-1.5 text-[13.5px] leading-5",
              m.available ? "text-foreground" : "text-muted-foreground",
            )}
          >
            <span className="truncate">{m.displayName}</span>
            {m.badge === "new" ? (
              <span className="shrink-0 rounded-[5px] border border-primary/40 bg-primary/8 px-1 font-semibold text-[10px] text-primary leading-4 tracking-wide">
                NEW
              </span>
            ) : null}
          </span>
          <span className="flex max-w-full items-center gap-1.5 text-[12px] text-muted-foreground leading-4">
            {reason ? (
              <span className="truncate">{reason}</span>
            ) : (
              <>
                <RuntimeMark runtime={session.runtime} className="size-3.5" />
                <span className="truncate">{RUNTIMES[session.runtime].provider}</span>
              </>
            )}
          </span>
        </button>
        {shortcut >= 0 ? (
          <kbd
            data-testid="model-shortcut"
            className={cn(
              "inline-flex h-6 min-w-8 shrink-0 items-center justify-center rounded-md px-1.5 font-sans text-[11.5px] text-muted-foreground tabular-nums",
              selected ? "bg-background shadow-xs" : "",
            )}
          >
            {mod}
            {shortcut + 1}
          </kbd>
        ) : null}
        <button
          type="button"
          data-testid="model-favorite"
          aria-pressed={starred}
          aria-label={
            starred ? `Remove ${m.displayName} from favorites` : `Add ${m.displayName} to favorites`
          }
          onClick={() => favorites.toggle(m.id)}
          className="inline-flex size-8 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/30"
        >
          <Star className={cn("size-4", starred && "fill-amber-400 text-amber-500")} />
        </button>
      </div>
    );
  };

  const railButton = (v: View, label: string, icon: ReactNode, testId: string) => (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={view === v}
      aria-label={label}
      title={label}
      onClick={() => {
        setView(v);
        search.current?.focus();
      }}
      className={cn(
        "relative inline-flex size-10 items-center justify-center rounded-lg outline-none transition-colors hover:bg-accent focus-visible:ring-[3px] focus-visible:ring-ring/30",
        view === v &&
          "bg-accent/70 after:absolute after:top-2 after:-right-[7px] after:h-6 after:w-[3px] after:rounded-full after:bg-primary",
      )}
    >
      {icon}
    </button>
  );

  const trigger = (
    <ControlChip
      disabled={locked}
      data-testid="model-chip"
      data-model-id={currentId ?? ""}
      data-pending={pending ? "true" : "false"}
      aria-label={`Model: ${label}`}
      title={noCatalog ? "This device has not reported its models yet" : (note ?? undefined)}
      className="max-w-full text-foreground/85"
    >
      <RuntimeMark runtime={session.runtime} />
      <span className="truncate">{label}</span>
      {pending ? (
        <span
          role="img"
          className="size-1.5 shrink-0 rounded-full bg-warning"
          aria-label="Applies to the next turn"
        />
      ) : null}
      {update.isPending ? (
        <Spinner className="size-3" />
      ) : locked ? null : (
        <ChevronDown data-chevron className="size-3.5 shrink-0 opacity-70" />
      )}
    </ControlChip>
  );

  return (
    <ControlSurface
      trigger={trigger}
      title="Model"
      testId="model-picker"
      open={open}
      onOpenChange={onOpenChange}
      initialFocus={sheet ? undefined : search}
      className="w-[min(22.5rem,calc(100vw-1.5rem))] p-0"
      sheetClassName="px-0"
    >
      <div className="flex min-h-0">
        <div className="flex w-14 shrink-0 flex-col items-center gap-1 border-r py-2">
          {railButton(
            "favorites",
            "Favorites",
            <Star className="size-[18px] fill-foreground" />,
            "model-rail-favorites",
          )}
          <div className="my-1 h-px w-7 bg-border" aria-hidden />
          {(["claude-code", "codex"] as const).map((r) =>
            railButton(
              r,
              RUNTIMES[r].label,
              <RuntimeMark runtime={r} className="size-5" />,
              `model-rail-${r}`,
            ),
          )}
        </div>
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="px-3 pt-2.5 pb-2">
            <label className="flex h-9 items-center gap-2 border-b-2 border-border text-[13.5px] transition-colors focus-within:border-primary">
              <Search className="size-4 shrink-0 text-muted-foreground" />
              <input
                ref={search}
                data-testid="model-search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    const first = rows.find((m) => m.available);
                    if (first) pick(first);
                  }
                }}
                placeholder="Search models..."
                aria-label="Search models"
                className="h-full min-w-0 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/80"
              />
            </label>
          </div>
          <div role="listbox" aria-label="Models" className="grid gap-0.5 px-1.5 pb-1.5">
            {other ? (
              <>
                <p
                  data-testid="model-provider-note"
                  className="px-2.5 pt-0.5 pb-1.5 text-[12px] text-muted-foreground leading-snug"
                >
                  Switching provider inside a chat is not available yet
                </p>
                {otherModels.map((m) => (
                  <div
                    key={m.id}
                    role="option"
                    tabIndex={-1}
                    data-surface-item
                    aria-selected={false}
                    aria-disabled
                    data-testid="model-option"
                    data-model-id={m.id}
                    className="flex cursor-not-allowed flex-col gap-0.5 rounded-lg py-2 pl-3"
                  >
                    <span className="truncate text-[13.5px] text-muted-foreground leading-5">
                      {m.displayName}
                    </span>
                    <span className="flex items-center gap-1.5 text-[12px] text-muted-foreground/80 leading-4">
                      <RuntimeMark runtime={view as RuntimeId} className="size-3.5 opacity-70" />
                      {RUNTIMES[view as RuntimeId].provider}
                    </span>
                  </div>
                ))}
                {otherModels.length === 0 ? (
                  <p className="px-2.5 py-3 text-[12.5px] text-muted-foreground">
                    {q ? `No models match “${query.trim()}”` : "This device reported no models for it."}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                {rows.map(row)}
                {rows.length === 0 ? (
                  <p className="px-2.5 py-3 text-[12.5px] text-muted-foreground">
                    {view === "favorites"
                      ? "Star a model to keep it here."
                      : q
                        ? `No models match “${query.trim()}”`
                        : "This device reported no models."}
                  </p>
                ) : null}
                {legacyRows.length > 0 ? (
                  <>
                    <button
                      type="button"
                      data-surface-item
                      data-testid="legacy-models"
                      aria-expanded={legacyOpen}
                      onClick={() => setLegacyOpen((v) => !v)}
                      className="flex items-center gap-2 rounded-lg py-2 pr-3 pl-3 text-left outline-none transition-colors hover:bg-accent/60 focus-visible:ring-[3px] focus-visible:ring-ring/30"
                    >
                      <span className="grid min-w-0 flex-1 gap-0.5">
                        <span className="text-[13.5px] text-foreground leading-5">Legacy models</span>
                        <span className="text-[12px] text-muted-foreground leading-4">
                          {legacyRows.length} {legacyRows.length === 1 ? "model" : "models"}
                        </span>
                      </span>
                      <ChevronRight
                        className={cn(
                          "size-4 shrink-0 text-muted-foreground transition-transform",
                          legacyOpen && "rotate-90",
                        )}
                      />
                    </button>
                    {legacyOpen ? legacyRows.map(row) : null}
                  </>
                ) : null}
              </>
            )}
          </div>
          {note ? (
            <p
              data-testid="model-note"
              className="border-t px-4 py-2 text-[11.5px] text-muted-foreground leading-snug"
            >
              {note}
            </p>
          ) : null}
        </div>
      </div>
    </ControlSurface>
  );
}
