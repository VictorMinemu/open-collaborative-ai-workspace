"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

/**
 * Which Work Zone sidebar sections are collapsed (Phase 07.10, UI-SPEC § 2, D-01): one map `{ [key]: boolean }`
 * (true = collapsed) in this browser's localStorage, read once on mount like the chat sidebar's. A key that is absent
 * takes its default: every section expanded except Settled. Corrupt JSON means defaults; a storage that refuses writes
 * (private mode, quota) keeps the state for this page only. Nothing in it leaves the browser.
 */

export const SIDEBAR_STORAGE_KEY = "ocw.workzone.sidebar.v1";

/** Sections collapsed until the viewer opens them. */
const COLLAPSED_BY_DEFAULT: ReadonlySet<string> = new Set(["settled"]);

export type CollapseMap = Readonly<Record<string, boolean>>;

/** The stored map, keeping only boolean values; anything else reads as no preference. */
export function parseCollapseMap(raw: string | null): CollapseMap {
  if (!raw) return {};
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
    const out: Record<string, boolean> = {};
    for (const [k, v] of Object.entries(value)) if (typeof v === "boolean") out[k] = v;
    return out;
  } catch {
    return {};
  }
}

const isCollapsed = (map: CollapseMap, key: string) => map[key] ?? COLLAPSED_BY_DEFAULT.has(key);

/** The collapsed keys, defaults applied. */
export function collapsedKeys(map: CollapseMap): ReadonlySet<string> {
  const out = new Set<string>();
  for (const key of COLLAPSED_BY_DEFAULT) if (isCollapsed(map, key)) out.add(key);
  for (const [key, value] of Object.entries(map)) if (value) out.add(key);
  return out;
}

/** The map after flipping one section's effective state. */
export function toggledMap(map: CollapseMap, key: string): CollapseMap {
  return { ...map, [key]: !isCollapsed(map, key) };
}

export function useSidebarCollapse(): { collapsed: ReadonlySet<string>; toggle: (key: string) => void } {
  const [map, setMap] = useState<CollapseMap>({});
  useEffect(() => {
    try {
      setMap(parseCollapseMap(window.localStorage.getItem(SIDEBAR_STORAGE_KEY)));
    } catch {
      // No storage: defaults.
    }
  }, []);
  const toggle = useCallback((key: string) => {
    setMap((prev) => {
      const next = toggledMap(prev, key);
      try {
        window.localStorage.setItem(SIDEBAR_STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Private mode or quota: the state still applies on this page.
      }
      return next;
    });
  }, []);
  const collapsed = useMemo(() => collapsedKeys(map), [map]);
  return { collapsed, toggle };
}
