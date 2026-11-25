// Types of site.mjs (07.13 D-04, D-22, PD-02): storage states scoped to one site (P-09).

/** A Playwright storage state cookie. */
export interface StorageCookie {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
}

/** A Playwright storage state origin (local storage of one origin). */
export interface StorageOrigin {
  origin: string;
  localStorage: { name: string; value: string }[];
}

export interface StorageState {
  cookies: StorageCookie[];
  origins: StorageOrigin[];
}

export function domainMatch(host: string, cookieDomain: unknown): boolean;
/** Throws an Error with `code: "invalid_request"` when `blob` is not a JSON object. */
export function parseStorageState(blob: string): StorageState;
export function parseStorageState(blob: undefined): undefined;
export function parseStorageState(blob: string | undefined): StorageState | undefined;
export function filterStateForSite(
  siteHost: string,
  state: { cookies?: readonly StorageCookie[]; origins?: readonly StorageOrigin[] },
): StorageState;
