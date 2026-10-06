---
created: 2026-10-06
title: work-zone.spec retry is not idempotent and its archive cleanup can hang
area: e2e
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
