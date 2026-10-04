import type { IncomingHttpHeaders } from "node:http";

/** Clients a human session can come from (agents and the system never hold a cookie session). */
export type SessionClientKind = "web" | "desktop" | "mobile";

export interface ClientInfo {
  kind: SessionClientKind;
  /** Human label such as "Chrome on macOS"; null when the user agent says nothing useful. */
  label: string | null;
}

const KINDS: readonly SessionClientKind[] = ["web", "desktop", "mobile"];

/** Order matters: Edge and Electron UAs also contain "Chrome", iOS UAs contain "Mac OS X", Android "Linux". */
const BROWSERS: Array<[RegExp, string]> = [
  [/\bElectron\//, "Desktop app"],
  [/\bEdg(e|A|iOS)?\//, "Edge"],
  [/\b(Firefox|FxiOS)\//, "Firefox"],
  [/\b(Chrome|CriOS)\//, "Chrome"],
  [/\bVersion\/[\d.]+.*\bSafari\//, "Safari"],
];
const SYSTEMS: Array<[RegExp, string]> = [
  [/\b(iPhone|iPad|iPod)\b/, "iOS"],
  [/\bAndroid\b/, "Android"],
  [/\bWindows\b/, "Windows"],
  [/\bMac OS X\b|\bMacintosh\b/, "macOS"],
  [/\bCrOS\b/, "ChromeOS"],
  [/\bLinux\b/, "Linux"],
];

const firstMatch = (ua: string, table: Array<[RegExp, string]>) => table.find(([re]) => re.test(ua))?.[1];

/**
 * Session client from the user agent alone (AUTH-05). Only a cosmetic label: client kind is attribution
 * metadata, never an authorization input (T-02-03-05). No ua-parser dependency (research A5).
 */
export function clientFromUserAgent(ua: string | null | undefined): ClientInfo {
  if (!ua) return { kind: "web", label: null };
  const kind: SessionClientKind = /\bElectron\//.test(ua) ? "desktop" : "web";
  const browser = firstMatch(ua, BROWSERS);
  const os = firstMatch(ua, SYSTEMS);
  const label = browser && os ? `${browser} on ${os}` : (browser ?? null);
  return { kind, label };
}

function header(headers: Headers | IncomingHttpHeaders, name: string): string | undefined {
  if (typeof (headers as Headers).get === "function") return (headers as Headers).get(name) ?? undefined;
  const v = (headers as IncomingHttpHeaders)[name];
  return Array.isArray(v) ? v[0] : v;
}

/** `x-ocw-client` (web | desktop | mobile) wins over the user agent; any other value is ignored. */
export function clientFromRequest(headers: Headers | IncomingHttpHeaders | null | undefined): ClientInfo {
  if (!headers) return { kind: "web", label: null };
  const fromUa = clientFromUserAgent(header(headers, "user-agent"));
  const declared = header(headers, "x-ocw-client")?.trim().toLowerCase();
  const kind = KINDS.find((k) => k === declared);
  return kind ? { kind, label: fromUa.label } : fromUa;
}
