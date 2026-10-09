# Phase 07.3 deferred items

- **07.3-01 (pre-existing, out of scope): hidden-bot 404 message differs from a missing bot's.**
  `GET /api/v1/agents/:id` answers `{ code: "not_found", message: "Not found" }` for a bot the caller may not read
  (`assertCan("bot.read", …, { hideAs404: true })` in `apps/api/src/modules/agent/index.ts`) but
  `{ code: "not_found", message: "Bot not found" }` for a missing id, so the message tells a caller that a hidden bot
  exists. Applies to personal bots and unit personas since Phase 3.1/6, and now to bots hidden by a Bots module rule.
  Fix: rethrow the hidden denial with the route's not-found message, as `chat/access.ts` `readableRow` does.
