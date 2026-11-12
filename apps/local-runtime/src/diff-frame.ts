// The bounded `diff.result` frame (07.17.1.1, D-14, PD-19, E23). The API closes the Device Link (1009) on any device
// frame over its inbound `maxPayload` (`DEVICE_LINK_MAX_DEVICE_FRAME_BYTES`); a 500 KiB patch, or thousands of changed
// files with long paths, used to do exactly that. The daemon bounds every diff frame after sanitising it: the patch is
// cut at the last newline that fits, then, when the file list alone does not fit, the list is cut too, and the frame
// says `truncated: true`. The web already shows a truncated diff as such.

import type { DiffResultFrame } from "@ocw/contracts";

/** Room kept under the limit for anything the transport adds around the JSON text. */
export const DIFF_FRAME_HEADROOM_BYTES = 4096;

function serialisedBytes(v: unknown): number {
  return Buffer.byteLength(JSON.stringify(v), "utf8");
}

/** Bytes `s` takes inside a JSON string (escapes and UTF-8 counted, the quotes not). */
function escapedBytes(s: string): number {
  return serialisedBytes(s) - 2;
}

/**
 * The longest prefix of `patch` that ends at a newline and takes at most `allowed` bytes once serialised; "" when
 * none does. A serialised prefix is never shorter (in bytes) than its UTF-16 length, so only newlines before
 * `allowed` are candidates.
 */
function cutPatch(patch: string, allowed: number): string {
  if (allowed <= 0) return "";
  const ends: number[] = [];
  for (let i = patch.indexOf("\n"); i !== -1 && i < allowed; i = patch.indexOf("\n", i + 1)) ends.push(i + 1);
  let lo = 0;
  let hi = ends.length;
  // Largest k (number of whole lines) whose prefix fits; k = 0 is the empty patch.
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (escapedBytes(patch.slice(0, ends[mid - 1])) <= allowed) lo = mid;
    else hi = mid - 1;
  }
  return lo === 0 ? "" : patch.slice(0, ends[lo - 1]);
}

/**
 * `frame` as it may be sent: unchanged when its JSON takes at most `maxBytes - DIFF_FRAME_HEADROOM_BYTES` bytes;
 * otherwise with the patch cut at a newline and, if still over, the longest prefix of `files` that fits, and
 * `truncated: true`.
 */
export function boundDiffFrame(frame: DiffResultFrame, maxBytes: number): DiffResultFrame {
  const budget = maxBytes - DIFF_FRAME_HEADROOM_BYTES;
  if (serialisedBytes(frame) <= budget) return frame;
  const marked: DiffResultFrame = { ...frame, truncated: true };
  const overhead = serialisedBytes({ ...marked, patch: "" });
  const cut: DiffResultFrame = { ...marked, patch: cutPatch(frame.patch, budget - overhead) };
  if (serialisedBytes(cut) <= budget) return cut;
  let lo = 0;
  let hi = frame.files.length;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (serialisedBytes({ ...cut, files: frame.files.slice(0, mid) }) <= budget) lo = mid;
    else hi = mid - 1;
  }
  return { ...cut, files: frame.files.slice(0, lo) };
}
