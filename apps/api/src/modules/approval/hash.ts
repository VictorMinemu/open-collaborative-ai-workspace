import { sha256Hex } from "../../lib/crypto";

/**
 * One element of a kind's action tuple (ADR-0023). Numbers must be safe integers: floats have no canonical text, and
 * an unsafe integer could hash like its neighbour.
 */
export type HashAtom = string | number | boolean | null;

const DOMAIN = "ocw-approval";
const VERSION = 1;

/**
 * The hash of the exact action an approval names: SHA-256 of `JSON.stringify(["ocw-approval", 1, kind, ...tuple])`,
 * lowercase hex. Each kind fixes the order of its tuple and builds it only from the STORED action, so the server can
 * recompute it at decision time and refuse an approval whose action changed. Throws on `undefined` (a missing field
 * must never hash like `null`), on a non-atom and on a number that is not a safe integer.
 */
export function actionHash(kind: string, tuple: readonly HashAtom[]): string {
  tuple.forEach((atom, i) => {
    if (atom === undefined) throw new TypeError(`action tuple element ${i} is undefined`);
    if (typeof atom === "number") {
      if (!Number.isSafeInteger(atom)) {
        throw new TypeError(`action tuple element ${i} must be a safe integer`);
      }
      return;
    }
    if (atom !== null && typeof atom !== "string" && typeof atom !== "boolean") {
      throw new TypeError(`action tuple element ${i} is not an atom (string, safe integer, boolean or null)`);
    }
  });
  return sha256Hex(JSON.stringify([DOMAIN, VERSION, kind, ...tuple]));
}
