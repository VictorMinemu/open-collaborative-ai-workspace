
## From the 07.16 code review (deferred, 2026-11-10)

- IN-05: adding a `reason` value to `session.configure` would break older daemons; ship with a daemon release.
- IN-06: platform-card notification rule shared by every platform card (product decision).
- IN-07: the session title (from the bot's own first prompt) reaches the cell in the read model; removing it needs a plugin release.
- IN-08: a person's start without a worktree can race a bot's start on the same tree (`tree_busy` is checked in two transactions); pre-existing for human starts.
- Wake for a new approval while an earlier approval is still pending (status stays `waiting_approval`) does not re-wake the bot; the deciders already see both approvals in the session.
