# Phase 5 deferred items (found during 05-15, out of scope)

Found by the 05-15 sweeps; outside Phase 5's surface, so logged here rather than fixed.

1. **Phase 1–4 routes validate the body before the session.** Most routes outside AI chats register
   `core.identity.requireUser` as a `preHandler`, which Fastify runs after schema validation. An anonymous request
   with a malformed body therefore answers 400 with the schema error instead of 401 (no handler runs, no data is
   read). 05-15 moved every AI chat route to `onRequest` (commit 18a27a3). Suggested follow-up: the same move for
   the rest of the API, or one `onRequest` hook for every route declared `config.authz: "user"`, with an
   OpenAPI-wide anonymous sweep like `ai-chat/security.int.test.ts`.
2. **Request logs carry query strings.** Fastify's default request log line includes the full URL, so a search
   (`GET /api/v1/search?q=…`, Phase 4) writes the member's search terms into the API log. Not prompt text, but
   personal content in logs. Suggested follow-up: a request serializer that drops or redacts the query string
   (at least `q`).
