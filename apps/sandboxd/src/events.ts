import { randomUUID } from "node:crypto";
import type { SandboxdEvent, SandboxdEventsResponse } from "@ocw/contracts";
import type { Clock, SandboxdEventInput } from "./sandboxes";

export type { SandboxdEventInput };

/**
 * sandboxd's event feed (07.8-09, D-09, P-04): sandboxd never calls the API; the API long-polls
 * `GET /v1/events?after=&waitMs=` and keeps its cursor. Events live in a ring of the last 5,000 and carry ids,
 * kinds, states, reasons, sizes and hosts only: never a path, an argv or any content (T-07.8-09-04). `bootId` is
 * random per process, so a restarted sandboxd tells the API to reset its cursor.
 */

export const EVENTS_CAPACITY = 5000;
/** Events per response (the contract's maximum). */
export const EVENTS_PER_RESPONSE = 500;
/** The longest a long poll waits (the contract allows 30 s; the server caps at 25 s). */
export const EVENTS_MAX_WAIT_MS = 25_000;

export interface Events {
  readonly bootId: string;
  emit(event: SandboxdEventInput): SandboxdEvent;
  /** Events after `after`, at most 500; waits up to `waitMs` (capped at 25 s) when there are none yet. */
  since(after: number, waitMs: number): Promise<SandboxdEventsResponse>;
  /** Retained events (at most the capacity). */
  readonly size: number;
  /** Wakes every waiting poll (shutdown). */
  close(): void;
}

export function createEvents(options: { capacity?: number; clock?: Clock } = {}): Events {
  const capacity = options.capacity ?? EVENTS_CAPACITY;
  const clock = options.clock ?? { now: () => Date.now() };
  const bootId = randomUUID();
  const ring: SandboxdEvent[] = [];
  let seq = 0;
  let waiters: Array<() => void> = [];

  function wake() {
    const ready = waiters;
    waiters = [];
    for (const w of ready) w();
  }

  function pending(after: number): SandboxdEvent[] {
    // The ring is ordered by seq; find the first one after the cursor.
    const first = ring[0]?.seq ?? seq + 1;
    const start = Math.max(0, after + 1 - first);
    return ring.slice(start, start + EVENTS_PER_RESPONSE);
  }

  function response(after: number): SandboxdEventsResponse {
    const events = pending(after);
    // An empty answer keeps the cursor (never ahead of what this boot has issued).
    return { bootId, events, nextSeq: events.at(-1)?.seq ?? Math.min(after, seq) };
  }

  return {
    bootId,
    get size() {
      return ring.length;
    },

    emit(input) {
      seq += 1;
      const event = { ...input, seq, at: new Date(clock.now()).toISOString() } as SandboxdEvent;
      ring.push(event);
      if (ring.length > capacity) ring.splice(0, ring.length - capacity);
      wake();
      return event;
    },

    async since(after, waitMs) {
      const cursor = Math.max(0, Math.floor(after));
      const wait = Math.min(Math.max(0, Math.floor(waitMs)), EVENTS_MAX_WAIT_MS);
      if (pending(cursor).length > 0 || wait === 0) return response(cursor);
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          waiters = waiters.filter((w) => w !== done);
          resolve();
        }, wait);
        const done = () => {
          clearTimeout(timer);
          resolve();
        };
        waiters.push(done);
      });
      return response(cursor);
    },

    close() {
      wake();
    },
  };
}
