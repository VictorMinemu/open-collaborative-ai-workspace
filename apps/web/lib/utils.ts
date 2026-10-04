import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}

/** "Ada Lovelace" → "AL", "acme" → "A". */
export function initials(name: string, max = 2): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts
    .slice(0, max)
    .map((p) => p[0]?.toUpperCase() ?? "")
    .join("");
}

const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
const UNITS: [Intl.RelativeTimeFormatUnit, number][] = [
  ["year", 31_536_000],
  ["month", 2_592_000],
  ["week", 604_800],
  ["day", 86_400],
  ["hour", 3600],
  ["minute", 60],
];

/** "in 3 days", "2 hours ago", "now". */
export function relativeTime(iso: string, now: number = Date.now()): string {
  const diff = Math.round((new Date(iso).getTime() - now) / 1000);
  for (const [unit, secs] of UNITS) {
    if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  }
  return "just now";
}

export function formatDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en", { month: "short", day: "numeric", year: "numeric" });
}
