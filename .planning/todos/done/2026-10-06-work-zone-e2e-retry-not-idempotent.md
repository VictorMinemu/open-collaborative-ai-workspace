---
created: 2026-10-06
title: work-zone.spec retry is not idempotent and its archive cleanup can hang
area: e2e
done: 2026-10-06
---

## Problem
CI run 37413703553 (PR #15, docs-only head): `work-zone.spec.ts` desktop took 3.3 min and timed out in the
cleanup `POST /work-sessions/:id/archive` (apiRequestContext.post exceeded the 180 s test timeout). The retry then
failed with a strict-mode violation: two `device-card` elements named "E2E Mac 1440" (the first attempt's device
was still there). Same code passed in run 37412787331.

## Solution
- Make the spec idempotent: unique device name per attempt (include testInfo.retry) or revoke/delete the paired
  device in cleanup.
- Give the cleanup request its own short timeout and investigate why archive hung (API stuck on a slow runner?).

## Done (04-13 phase gate)
- `e2e/tests/work-zone.spec.ts`: a retry names its device `E2E Mac <size> retry <n>` (the first attempt keeps the old
  name and captures), and the archive cleanup has a 15 s timeout with errors swallowed, so the device revocation
  after it always runs.
- Still open: why `POST /work-sessions/:id/archive` hung on the slow CI runner (not reproduced locally; the full
  isolated suite passed twice).
