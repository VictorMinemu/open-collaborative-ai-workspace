# Long bot conversations

A bot's conversation (a DM, a thread) keeps its history in the OpenClaw cell. When the history no longer fits the bot's
model, OpenClaw summarizes the older part and keeps the recent messages word for word (its *compaction*). An admin
chooses how in **Settings › Bot policy › Conversations**; the API sends the choice to the cell with the rest of the bot
policy (`GET /agent-channel/v1/cell`), and the cell applies it from the next turn. Nothing else to configure.

| Setting | Default | What it does | OpenClaw key (2026.9.7) |
| --- | --- | --- | --- |
| Strict summaries | off | Refuses a summary that drops required facts (headings, the latest ask, identifiers). A long conversation whose required facts outgrow the summary can then get stuck on every message. | `agents.defaults.compaction.qualityGuard.enabled` |
| Keep exact identifiers in summaries | off | Asks summaries to keep ids, codes and order numbers word for word; summaries get longer. | `agents.defaults.compaction.identifierPolicy` (`strict` / `off`) |
| Recent history kept | 20 000 tokens (2 000 to 100 000) | How much of the latest conversation is kept word for word rather than summarized. | `agents.defaults.compaction.keepRecentTokens` |
| Start a fresh session when a summary fails | on | When OpenClaw still cannot summarize, the bot starts that conversation over in a fresh session, once per message, and answers from the recent messages of the chat. If that fails too, it says so and asks for a new thread. | The OCW plugin (`deleteSessionEntry`, transcript archived) |

The cell always summarizes in chunks (`compaction.mode: "safeguard"`) and never runs a background memory flush
(`compaction.memoryFlush.enabled: false`). Until the cell has read the policy (right after it starts), it uses the
defaults above (`infra/openclaw/render-config.mjs`).

**Why strict summaries are off by default.** OpenClaw 2026.9.7 turns its summary quality guard on unless it is set to
`false`. A bot with many tools and large tool results (an ERP connector, for example) can need more required facts than
a summary may hold; the guard then refuses every summary and each message answers "Context is too large and
auto-compaction could not recover this turn". Turn it on only if your bots' conversations stay short.

A fresh session archives the old transcript in the cell's state volume (it is not deleted). The chat history in the
workspace never changes.
