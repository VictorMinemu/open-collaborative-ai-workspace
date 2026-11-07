# Deferred items (out of scope for the plan that found them)

## Found during 07.15-07

- **A persona-only message in a shared AI chat skips the model's attachment gate.** In a multiplayer chat
  (`sendShared`, `apps/api/src/modules/ai-chat/service.ts`), a message that only addresses a persona (`@backend …`,
  202, the chat model not asked) accepts a file the chat's model cannot read (a `.zip`), while the same file on a
  message that asks the model is refused with 400 `attachment_not_supported`. This predates 07.15 (06-06/06-10 code);
  07.15 does not widen what the persona can do with it: the turn lists such a file as `other` (`none` or `import` by the
  usual rules) and the read route re-decides. D-14 says "a persona never widens" the chat model's gate, so the phase gate
  (07.15-11) or a follow-up should decide whether the shared send route applies `assertReadableBy` to persona-only
  messages too. The web composer's `attachment-gate.ts` already offers only the chat model's types.

## Found during 07.15-08

- **An import with the default path shows the file name in the activity tab.** `ocw_sandbox_import` without a `path`
  lands at `downloads/<sanitized name>` (`importPathOf`, 07.8-25), and its activity step's target is that workspace path
  (`stepFor` → `displayPath(input.path)`). So with the default path, the file's name appears in `bot_turn_activity`. P1
  lists activity among the records that never carry a name. The activity tab is read by the same people who see the
  attachment in the conversation, and 07.8 shows workspace paths there on purpose, so 08 did not change it (that would
  remove visible behaviour). The 08 leak sweep imports to an explicit `inbox/p.txt`, and proves that the read and the
  API's own records carry neither the name nor the content. The gate (07.15-11, ADR-0037) should decide: keep it (the
  workspace path is the person's own view), or show only the folder for a derived path.
- **D-14 at read time (from 07.15-07's item): not enforced in 08.** An AI chat has no single governing model: every
  message is answered by the model its sender picked (`resolveOr409(tx, body.model, userId)`), so the read route has no
  "conversation's model" to check against cheaply. The `.zip` from 07-07's item is already refused at read time
  (`unsupported_type`, kind `other`). The remaining gap is the shared send route's persona-only branch skipping
  `assertReadableBy`, and it stays for 07.15-11.

## Found during 07.15-10

- **The real-cell smoke can race OpenClaw's boot hot reload when the first scenario starts at once.** One of six
  `SMOKE_ONLY=bot_attachments` runs (host loaded by a parallel `pnpm test`) failed its first case: the first turn
  arrived while OpenClaw 2026.9.7 hot-reloaded the config the plugin wrote at sync, the plugin's per-run load reported
  `Plugin source changed while preparing its reload; retry after the edit finishes`, the run had no callable tools
  (`No callable tools remain after resolving explicit tool allowlist`), and the plugin's three turn attempts within 8 s
  all failed. The rerun passed. Nothing in it is attachment-specific; any scenario that runs first (`mention` in a full
  run) is exposed the same way. A follow-up could make the smoke wait for the boot reload to settle (e.g. the first
  `tool gate registered (discovery registry …)` line after `config hot reload applied`) before its first turn.

## Found during 07.15-09

- **The chat composer's Send (and @ mention) buttons are 32 × 32 on phones.** 09 made the paperclip 44 × 44 below
  `md` (the control this phase turns on in bot DMs) without changing the composer's height. Send and @ predate the
  phase and are shared by every channel, thread and DM composer; growing the filled Send square is a visible change
  across all chats, so it was left for a UI pass (the same `max-md:size-11 max-md:-my-1.5` would do it).
