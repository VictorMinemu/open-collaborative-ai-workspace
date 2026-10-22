---
status: awaiting_human_verify
trigger: "Woodpecker pipeline 55, sandbox-proof step 9: journey.anaFrames received ONE frame (1792699286368) while Sam controlled the page or his session was loaded; expected []. Pipeline 51 passed. Invariant F-5/U-2 (ADR-0029): during a takeover or while a member's session is loaded, frames go only to that member."
created: 2026-10-22T15:30:00Z
updated: 2026-10-22T16:20:00Z
---

## Current Focus

hypothesis: CONFIRMED H1 + H2 (two independent fail-open windows at the hand back); fixed and self-verified
next_action: human verify = the real-stack sandbox proof on CI (needs a .env; not run locally); then archive and add the KB entry
bug_class: Heisenbug in the proof (timing), Bohrbug once the ordering is forced (deterministic with the fake's delay / the state sequence)

reasoning_checkpoint:
  hypothesis: "Frames reach non-members at the hand back because (H1) endLease commits the lease release before onHandBack seals the session, so for several sandboxd round trips the row reads no-lease/no-session and any refresh opens the gate for the owner and the member's other devices; and (H2) the refresh that sees session_id appear pushes every viewer's state with the decision made before the session existed, so the owner gets `live` + frames until its redecide lands."
  confirming_evidence:
    - "RED (a): with contextLock held 2.5 s, Sam's other device got 11 frames while the request was still signing_in"
    - "RED (b): plain hand back, owner's state sequence after the take = ['live','private']"
    - "Proof p55: the owner and the other device received the same frame at the same ms, ~3.8 s after take = at the release"
  falsification_test: "If after making release+seal one transaction and gating stale decisions the RED tests still see a frame or a non-private state for the owner, or the other device gets frames before the seal, the hypothesis is incomplete"
  fix_rationale: "The row-level transition becomes atomic (lease live -> session loaded in one commit, visible the same way to every instance), and a decision is only an answer for the privacy facts it was made under (memberSession); a mismatch means no frames until the resolver answers again. The send-time gate re-evaluates the state per frame so no cached flag can let a frame through."
  blind_spots: "Multi-instance take start (another instance learns the lease via announce/poll) not exercised by the proof (one API); a lease that ends WITHOUT a hand back (closed tab, idle, dead instance) after the member typed leaves the page public by design - outside this race, reported"
  candidate_causes:
    - "code: ordering in endLease/onHandBack (release committed before seal)"
    - "code: stale per-viewer decision used by pushState at the session flip"
    - "environment: real stack paints the dashboard right after the release (login redirect) and emits `navigated` -> refresh in the window; fake emits at 8 fps (timing only, not a cause)"
    - "data/test: proof window mis-attribution (eliminated)"
  and_gate: "yes - a leak needs (a refresh landing in an open window) AND (a frame painted in that window); the windows are the code causes, the paint/refresh timing is the environment condition that made it intermittent"

## Symptoms

expected: journey.anaFrames == [] and journey.otherDeviceFrames == [] (no frame to Ana, the bot owner, or Sam's other device from takeAt until the revoke)
actual: anaFrames == [1792699286368] (2026-10-22T20:01:26.368Z); state.json (recorded after step 8) shows otherDeviceFrames == [1792699286368] too, same ms
errors: "Ana's frames while Sam controlled the page or his session was loaded" expected [] received [1792699286368]
reproduction: real-stack sandbox proof (scripts/e2e-isolated.sh --sandbox --cmd "bash scripts/sandbox-proof.sh"), intermittent (pipeline 51 passed)
started: pipeline 55 (same design passed in 51)

## Eliminated

- hypothesis: H4 reuse of a sealed session ("reused without a card") on a page whose gate is evaluated after the first frame
  evidence: the session loads only into a new context row inserted with session_id before sandboxd opens the page; every watcher's first decision already sees the session
  timestamp: 2026-10-22T15:50:00Z
- hypothesis: H5 revoke leaves a window
  evidence: revoke + endPages run in one transaction (session -> closed atomically); the leaked frame is from step 6 anyway (20:01:26, the hand back), not step 9
  timestamp: 2026-10-22T15:50:00Z
- hypothesis: the proof's window mis-attributes a pre-takeover or post-revoke frame
  evidence: frame is takeAt+3777 ms and long before privateUntil; takeAt is set after `controlling`, which is pushed in the same refresh as Ana's `private`
  timestamp: 2026-10-22T15:40:00Z

## Evidence

- timestamp: 2026-10-22T15:30:00Z
  checked: /tmp/ci55art/proof-out/state.json (recorded by step 8) and proof-step.log
  found: takeAt=1792699282591 (20:01:22.591Z); signInMs=3828 (from just after takeAt to status signed_in observed); the leaked frame at 20:01:26.368Z = takeAt+3777 ms; BOTH Ana's socket and Sam's other device received a frame at the same ms; controller got 13 frames
  implication: the leaked frame was broadcast to every non-controller viewer at once, ~100 ms before signed_in was observed, i.e. right after the test's `release` (typing ends ~takeAt+3.4-3.7 s, then release, then seal). Points at the release -> seal window, not a mis-attributed timestamp (the frame is inside [takeAt, privateUntil) by >3 s on both sides).

- timestamp: 2026-10-22T15:40:00Z
  checked: proof window (e2e/proof/sandbox.sandbox-proof.ts steps 6 and 9)
  found: takeAt is taken after the controller saw `controlling` (Ana's private is pushed in the same refresh); anaFrames = Ana's frames in [takeAt, privateUntil=revoke in step 9). The frame is 3.8 s after takeAt and tens of seconds before the revoke. The same frame (same ms) also reached Sam's other device.
  implication: the test window does not mis-attribute it: a frame went to Ana while the page held Sam's freshly typed sign-in. Product bug, assertion stays.

- timestamp: 2026-10-22T15:45:00Z
  checked: live-view.ts endLease("released") + signin.ts onHandBack
  found: endLease sets w.lease=null, COMMITS release() (controller_user_id=null), calls sandboxd contextTakeover(false), THEN onHandBack does export (sandboxd), contextLock (sandboxd), and only then the seal tx sets browser_contexts.session_id. Between the release commit and the seal commit the row reads: no lease, no session, paused_for='signin'. stateOf() for Ana (owner) and Sam's other device then answers `paused` with frames:true. Any refresh in that window (the 1 s poll, a `navigated` control from the login redirect, another instance's poll) opens the gate; the next screencast frame (the dashboard painting) is offered to them.
  implication: H1 confirmed by reading: a row-level fail-open window of several sandboxd round trips on every hand back, visible to every instance.

- timestamp: 2026-10-22T15:47:00Z
  checked: live-view.ts refresh() at the session flip
  found: when refresh sees session_id appear it calls redecide(v) (async, DB) and then IMMEDIATELY pushState(v) with the decision made before the session existed (Ana: watch=true). With no lease and paused_for cleared by the seal, stateOf answers `live`, frames:true, and the key changed so the `live` state is sent. Frames flow until Ana's decide() completes.
  implication: H2 confirmed by reading: a deterministic stale-decision window after every successful seal (and at a viewer's open if the session appears between its decide and its readView).

- timestamp: 2026-10-22T15:50:00Z
  checked: reuse / revoke / FrameSlot paths
  found: a sealed session is only ever loaded into a NEW context row inserted with session_id in the bot's decision tx before sandboxd's contextOpen (agent-channel/browser.ts decide + contextFor); revoke deletes the secret and ends the pages in ONE tx (routes.ts DELETE /browser-sessions/:id); pushState clears the slot's waiting frame when frames turn off (a frame already handed to ws.send was sent while allowed).
  implication: H4 (reuse), H5 (revoke) eliminated; H3 (slot flush) not a leak today, but the gate is only re-checked at pushState, not per frame at send time.

- timestamp: 2026-10-22T15:43:30Z
  checked: RED run, apps/api/src/modules/browser/signin.int.test.ts -t "never opens the page" (fake sandboxd /__control/browser/delay added)
  found: (a) slow hand back (contextLock held 2.5 s): Sam's other device received 11 frames while the hand back waited (expected 0; 13 vs 2). (b) plain hand back: Víctor (owner) received states ['live', 'private'] after the take (expected only private) - the `live` is the stale-decision push at the seal.
  implication: H1 and H2 both reproduced deterministically. Root cause confirmed.

- timestamp: 2026-10-22T16:00:00Z
  checked: GREEN + fix-acceptance (revert/mutation) runs
  found: the two RED tests pass; mutation "commit the release before the hand back" -> slow test RED again (other device 11 frames); mutation "stale() always false" -> both tests RED (owner gets `live`); FrameSlot gate unit test RED on ed77540b ([1,2] written), GREEN on the fix; browser module + agent-channel browser suites 113/113; signin+takeover+live-view int 5x in a row 40/40 each
  implication: each half of the fix is necessary; no regression in the browser module

## Resolution

root_cause: "(H1) live-view endLease committed the takeover lease's release BEFORE signin.onHandBack exported, locked and sealed the member's session, so the context row read 'no lease, no member session' for several sandboxd round trips; any refresh then (1 s poll, the login redirect's `navigated`, another instance) answered `paused`+frames to the bot's owner and the member's other devices; (H2) the refresh that saw session_id appear pushed every viewer's state with the decision made before the session existed (owner: `live`+frames) until its asynchronous redecide landed. Either window lets the next screencast frame (the dashboard painting) through; the real stack hit it intermittently (p55), p51 did not."
fix: "signin.onHandBack takes an endLease(tx) callback and ends the lease inside the transaction that decides the hand back (seal / card waiting again / plain takeover), so the row goes from 'controlled' to 'session loaded' in one commit; live-view endLease keeps the lease locally as `ending` (no input/keep/second end) until then, turns sandboxd's takeover off first as before, falls back to a plain release on a throw, and for non-hand-back ends releases + backToWaiting in one tx. Decision records the memberSession fact it was made under; stateOf holds (frame null: no state sent, frames off, upstream kept) any viewer whose fact differs from the row, refresh redecides changed or stale viewers, and a decision newer than the view triggers a refresh. The gate is evaluated per frame at send time: pumpFrames and focus controls use mayReceive(v) (= last pushed answer AND stateOf now), and FrameSlot asks an `allowed()` gate when it hands a waiting frame to the socket (drops it otherwise). Latest-frame-wins unchanged."
verification: "RED->GREEN: signin.int 'the hand back never opens the page to anyone else' (2 tests) and live-view.test FrameSlot gate; mutation checks for both halves; takeover.int member-session tolerance tightened from vAt+1 to exactly vAt and stable; full browser suites green; pnpm verify + typecheck --force (see commit). Real-stack proof not run locally (scripts/e2e-isolated.sh requires a .env)."
oracle_type: specified (ADR-0029 F-5/U-2: zero frames to anyone but the controlling socket / the member)
files_changed: [apps/api/src/modules/browser/live-view.ts, apps/api/src/modules/browser/signin.ts, apps/api/src/modules/browser/live-view.test.ts, apps/api/src/modules/browser/signin.int.test.ts, apps/api/src/modules/browser/takeover.int.test.ts, infra/fake-model/fake-sandboxd.mjs, infra/fake-model/fake-sandboxd.test.mjs]
residual_risks:
  - "RESOLVED by coordinator decision (separate commit): a lease that ends WITHOUT a hand back (socket closed, idle, access lost, dead instance swept) after input in that lease, or with a member session loaded, now closes the page (`takeover_abandoned`; lease_input recorded before input reaches the page). ADR-0029 updated."
  - "Multi-instance take start: other instances learn the lease by the end-of-onTake announce or their 1 s poll; input is only accepted after the holder instance's own refresh, so a frame of typed input reaching another instance's viewer first needs that instance's refresh to be slower than a full input round trip. An in-band takeover control on sandboxd's frame stream would close it fully."
  - "Proof step 6 counts Sam's other-device frames until the end of step 6, i.e. also after the seal, where ADR-0029 U-2 lets the member (any device) watch; a dashboard paint after the seal would fail it on a legit frame. Assertion left as is (not proven outside the window)."
