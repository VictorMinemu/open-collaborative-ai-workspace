/** Where sign-in goes when `?next=` is missing or refused. */
const FALLBACK = "/chat";

// biome-ignore lint/suspicious/noControlCharactersInRegex: matching control characters is the point.
const CONTROL = /[\u0000-\u001f\u007f]/;

/** This page's origin; any fixed origin works on the server, where only the same-origin check matters. */
function currentOrigin(): string {
  return typeof window === "undefined" ? "http://localhost" : window.location.origin;
}

/**
 * The login page's `?next=` as a same-origin path (07.12 review ME-04), else `/chat`. The WHATWG URL parser treats `\`
 * as `/` and drops tabs and newlines, so `/\evil.example` or `/\t/evil.example` would leave this origin: any backslash
 * or control character is refused, the value must start with a single `/`, and it must still be a same-origin path
 * once parsed (`/..//evil.example` normalises to `//evil.example`).
 */
export function safeNext(next: string | null, origin: string = currentOrigin()): string {
  if (!next?.startsWith("/") || next.startsWith("//")) return FALLBACK;
  if (next.includes("\\") || CONTROL.test(next)) return FALLBACK;
  let url: URL;
  try {
    url = new URL(next, origin);
  } catch {
    return FALLBACK;
  }
  if (url.origin !== new URL(origin).origin || url.pathname.startsWith("//")) return FALLBACK;
  return `${url.pathname}${url.search}${url.hash}`;
}
