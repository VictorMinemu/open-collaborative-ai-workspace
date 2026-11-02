# Phase 07.6 — deferred items (found at the 07.6-19 gate, out of scope)

- **Shell: a long e-mail widens the app rail's bottom block.** In `digest-*-1440` screenshots the signed-in person's
  generated e-mail (`vic-digest-1440-…@ocw.test`) runs past the rail's 240 px and the active Settings item's background
  stretches with it (about 282 px). The rail (`apps/web/components/shell/app-rail.tsx` / `user-menu.tsx`) is not a 07.6
  file and real e-mails this long are rare; truncate the name and e-mail in the rail's user block in a shell polish
  plan.
- **Plan 07.6-19's isolated e2e command** lists `sandbox-tab` and `browser-tab` with `--sandbox`, but both specs are
  fake-broker-only by design (07.8: `fakeSandboxd()` refuses under the real broker; the real browser refuses the fake
  `site-N.fake.test` hosts). Future gates should run those two without `--sandbox` (done at this gate: 17 passed).
- **`OCW_JOBS_WORKER` reached the API's env (07.6-03) but not `compose.yaml`;** fixed at this gate (`e46b724a`).
