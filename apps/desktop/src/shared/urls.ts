// URL policy for the desktop shell: which server URLs we accept, how the API URL is derived from
// the web URL, which navigations stay in-app and which links may be handed to the OS browser.
// Pure functions only (unit-tested without Electron).

export class UrlError extends Error {}

const PRIVATE_V4 = [/^10\./, /^192\.168\./, /^172\.(1[6-9]|2\d|3[01])\./, /^127\./, /^169\.254\./];

/** Loopback, RFC 1918 or `.local` hosts: plain http is acceptable there (dev, LAN demo). */
export function isLocalHost(hostname: string): boolean {
  const h = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1") return true;
  return PRIVATE_V4.some((re) => re.test(h));
}

/**
 * Normalise a user-typed server URL to its origin (`http://localhost:3000`). Accepts a bare host
 * (`localhost:3000`), requires http(s), rejects credentials, and requires https for public hosts.
 */
export function normalizeServerUrl(input: string): string {
  const raw = input.trim();
  if (!raw) throw new UrlError("Enter the address of your OCW server.");
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let url: URL;
  try {
    url = new URL(withScheme);
  } catch {
    throw new UrlError("That does not look like a valid address.");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new UrlError("Only http:// and https:// addresses are supported.");
  }
  if (url.username || url.password) throw new UrlError("Addresses with credentials are not allowed.");
  if (!url.hostname) throw new UrlError("That does not look like a valid address.");
  if (url.protocol === "http:" && !isLocalHost(url.hostname)) {
    throw new UrlError("Use https:// for servers outside your local network.");
  }
  return url.origin;
}

/**
 * Default API origin for a web origin. The Stage A stack serves the web on :3000 and the API on
 * :4000 (no reverse proxy, deviation A-9); behind a proxy both share one origin.
 */
export function deriveApiUrl(webOrigin: string): string {
  const url = new URL(webOrigin);
  if (url.port === "3000") url.port = "4000";
  return url.origin;
}

function parse(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** In-app navigation is allowed only within the configured web origin. */
export function isAllowedNavigation(target: string, webOrigin: string): boolean {
  const url = parse(target);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return url.origin === new URL(webOrigin).origin;
}

/** Links we may hand to the OS (default browser): http(s) only, no credentials. */
export function isSafeExternalUrl(target: string): boolean {
  const url = parse(target);
  if (!url) return false;
  if (url.protocol !== "http:" && url.protocol !== "https:") return false;
  return !url.username && !url.password;
}

/** Remove `user:token@` from git remotes before they reach any web content. */
export function redactRemote(remote: string | null): string | null {
  if (!remote) return remote;
  return remote.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]+@/i, "$1");
}
