import { CanonicalJsonError, type CanonicalJsonErrorCode, canonicalJson } from "@ocw/contracts";
import { sha256Hex } from "./crypto";

/**
 * Phase 07.6 (AUTO-04, D-04, D-09, Pitfall 9): the hash of a watched record's projected fields, computed by the API
 * only (the model never supplies a value or a hash). sha256 over the RFC 8785 canonical JSON of 07.5's `canonicalJson`
 * (the one JCS implementation in the repo; its RFC vectors are tested in 07.5-01), so equal data in any key order hashes
 * the same.
 *
 * Known limit (Pitfall 9): JSON numbers are compared after `JSON.parse`, so `10.10` and `10.1` (numbers) hash the same
 * and integers beyond 2^53 lose precision before hashing. Money and large numbers are safer as text fields (strings
 * keep every character and hash differently).
 */

export class CanonicalHashError extends Error {
  readonly code: CanonicalJsonErrorCode;
  constructor(code: CanonicalJsonErrorCode) {
    super(`not hashable: ${code}`);
    this.name = "CanonicalHashError";
    this.code = code;
  }
}

/** `sha256Hex(canonicalJson(value))`; NaN, ±Infinity, lone surrogates and other non-JSON throw `CanonicalHashError`. */
export function canonicalHash(value: unknown): string {
  let text: string;
  try {
    text = canonicalJson(value);
  } catch (err) {
    if (err instanceof CanonicalJsonError) throw new CanonicalHashError(err.code);
    throw err;
  }
  return sha256Hex(text);
}
