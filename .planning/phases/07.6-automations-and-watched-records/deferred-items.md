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

## CI e2e without GreenMail (07.6 PR #40)

The runner exports `OCW_E2E_IMAP_PORT`, `OCW_E2E_SMTP_PORT` and `greenmail` in `OCW_EGRESS_TEST_HOSTS` only with `OCW_E2E_MAIL=1`. CI's two parallel e2e viewports share one dind daemon and `scripts/e2e-greenmail.sh` uses one fixed container name, so CI runs no GreenMail and its mail specs skip (allowlisted in `scripts/e2e-env-parity.test.mjs`). IMAP is still proven against GreenMail by the integration tests in `pnpm verify` and by the phase gate's local e2e. Follow-up: a per-slot GreenMail (container name and ports per `PORT_BLOCK`) to run the mail specs in CI.
