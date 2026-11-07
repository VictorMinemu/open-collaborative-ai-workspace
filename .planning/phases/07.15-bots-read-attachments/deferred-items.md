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
