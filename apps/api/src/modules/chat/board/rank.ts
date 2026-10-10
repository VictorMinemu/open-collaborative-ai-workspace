import { generateKeyBetween, generateNKeysBetween } from "fractional-indexing";

/**
 * Board ranks (D-05, P-06): the ONLY importer of `fractional-indexing`. Keys use the library's default base-62
 * alphabet (`0-9A-Za-z`), which sorts in code-unit order; both rank columns are `COLLATE "C"`, so PostgreSQL orders
 * them exactly like JavaScript's default sort. Ranks are minted only by the server, after the conversation's stream
 * lock (`lockNextSeq`), so two writers never read the same neighbours; a client never sends a rank.
 */

/** Longer keys trigger a re-rank of the column instead of growing further (the column allows 128). */
export const RANK_KEY_MAX = 64;

/**
 * The key for an item landing after `prev` and before `next` (null = the column's start or end). `"rerank"` when the
 * neighbours tie or are out of order, when either is not a valid key (corrupt or legacy data), or when the new key
 * would exceed `RANK_KEY_MAX`: the caller then rewrites the column with `freshKeys` and asks again.
 */
export function keyBetween(prev: string | null, next: string | null): string | "rerank" {
  // fractional-indexing 4.0.0 accepts its bounds in either order; a board must not, so check first.
  if (prev !== null && next !== null && prev >= next) return "rerank";
  let key: string;
  try {
    key = generateKeyBetween(prev, next);
  } catch {
    return "rerank";
  }
  return key.length > RANK_KEY_MAX ? "rerank" : key;
}

/** `n` short, strictly increasing keys (a new board's columns, or a re-ranked column). */
export function freshKeys(n: number): string[] {
  return generateNKeysBetween(null, null, n);
}
