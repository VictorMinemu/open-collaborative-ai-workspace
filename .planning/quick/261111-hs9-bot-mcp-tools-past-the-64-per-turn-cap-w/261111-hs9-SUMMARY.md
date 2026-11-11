---
quick_id: 261111-hs9
status: complete
---

# Summary: bot MCP tools past the per-turn cap

Owner report (ocw.autofy.ing, 2026-11-11): an ERP MCP server's tools were on for the bot, but only
`consultar_guia_operativa` worked; `listar_expedientes`, `listar_pedidos_anexos` and `quien_soy` were refused. Cause:
a turn carried at most 64 tools (platform tools first, then catalog tools in name order) and dropped the rest without
a word, in the delivered turn and in the cell's `alsoAllow`.

- `TURN_TOOLS_MAX = 128` in `@ocw/contracts` (`TurnContext.tools`, `MAX_TURN_TOOLS` in `turn-policy.ts`). 128 is the
  most function tools OpenAI's API accepts in one request.
- `BotCapabilityView.toolsOverLimit`: how many usable tools do not fit in a channel turn (`toolsOverLimit()` in
  `turn-policy.ts`, computed by `assemble`). The bot sheet's Tools section warns when it is above 0.
- Tools section: per source, "Turn on: Read-only tools / All, including changes · Turn all off" (`bulkGrants`; blocked
  tools are never turned on, other sources are kept).

Verification: `capabilities.int.test.ts` 27/27 (new over-limit test), `automation-runs.int.test.ts` 30/30,
`work-session-offer.int.test.ts` 20/20, unit 1782/1782, web bots 40/40 (new `tools-section.test.tsx`), typecheck
contracts/api/web clean, biome: no new findings.
