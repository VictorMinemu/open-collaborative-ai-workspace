// Storage states scoped to one site (07.8 D-08, P-09; shared in 07.13 D-04, D-22). Pure, no dependencies.
//
// A sign-in is saved for one site: only the cookies that domain-match the site's host name and the origin storage of
// that exact host are kept, so an identity provider's cookies (accounts.google.com, …) or a sibling domain's
// (githubusercontent.com) are never exported with it. These are brw's `contextExportState` rules, and the API applies
// the same rules again before sealing (`keepForSite` in apps/api/src/modules/browser/sessions.ts, defence in depth).

/** RFC 6265 §5.1.3 domain-match of a request host against a cookie's domain. An IP host matches only exactly. */
export function domainMatch(host, cookieDomain) {
  const d = String(cookieDomain ?? "")
    .replace(/^\./, "")
    .toLowerCase();
  const h = String(host).toLowerCase();
  if (d === "" || h === "") return false;
  if (h === d) return true;
  if (/^[0-9.]+$/.test(h) || h.includes(":")) return false;
  return h.endsWith(`.${d}`);
}

const invalid = (message) => Object.assign(new Error(message), { code: "invalid_request" });

/**
 * A stored storage state's text as `{ cookies, origins }` (lists default to empty); undefined passes through (no
 * stored sign-in). Throws an Error with `code: "invalid_request"` when the text is not a JSON object.
 */
export function parseStorageState(blob) {
  if (blob === undefined) return undefined;
  let state;
  try {
    state = JSON.parse(blob);
  } catch {
    throw invalid("storage state is not JSON");
  }
  if (typeof state !== "object" || state === null || Array.isArray(state)) {
    throw invalid("storage state is not an object");
  }
  return {
    cookies: Array.isArray(state.cookies) ? state.cookies : [],
    origins: Array.isArray(state.origins) ? state.origins : [],
  };
}

/**
 * The part of `state` that belongs to `siteHost` ("github.com", "localhost:3000"): cookies that domain-match its host
 * name (cookies carry no port), and the origins of that host (with a port: that exact `host`; without: that exact
 * host name). Never throws; a malformed origin is dropped.
 */
export function filterStateForSite(siteHost, state) {
  const site = String(siteHost ?? "");
  const hostname = site.replace(/:\d+$/, "");
  const cookies = (Array.isArray(state?.cookies) ? state.cookies : []).filter(
    (c) => typeof c === "object" && c !== null && domainMatch(hostname, c.domain),
  );
  const origins = (Array.isArray(state?.origins) ? state.origins : []).filter((o) => {
    if (site === "") return false;
    try {
      const u = new URL(o.origin);
      return site.includes(":") ? u.host === site : u.hostname === hostname;
    } catch {
      return false;
    }
  });
  return { cookies, origins };
}
