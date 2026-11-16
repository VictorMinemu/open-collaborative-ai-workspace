---
quick_id: 261116-k3p
slug: connector-tools-never-take-turn-slots
date: 2026-11-16
type: fix
status: complete
subsystem: bot-capabilities, agent-channel, openclaw-channel
tags: [connectors, turn-policy, openclaw, tool-limit]
key-files:
  modified:
    - packages/contracts/src/bot-capabilities.ts
    - apps/api/src/modules/bot-capabilities/turn-policy.ts
    - apps/openclaw-channel/src/connector-tools.ts
    - apps/web/components/bots/tools-section.tsx
decisions:
  - "openClawToolCount takes the turn's set of proxied names: the m<8 hex>__ shape alone cannot tell a proxied tool from an in-cell MCP tool"
  - "Capability PATCH keeps its 200-grant bound; ocw_connector_list keeps its 64-tools-per-connector bound"
actuals:
  tasks: 4
  commits: 5
---

# Quick 261116-k3p: proxied connector tools never take turn slots; connector arguments open

Turns now carry every enabled tool of a per-member or organization-account server. Those tools no longer use up
OpenClaw's 128 slots, and `ocw_connector_call` stops failing with `schema is false` on any call that has arguments.

## What changed

- **B. Plugin** (`apps/openclaw-channel/src/connector-tools.ts`): `ocw_connector_call.arguments` is now
  `{ type: "object", additionalProperties: true }`. A grep of the plugin's other tool schemas found no other
  free-form object without `additionalProperties`. HTTP `headers` and record fields were already explicit.
- **A. Contracts** (`packages/contracts/src/bot-capabilities.ts`): new `TURN_CONNECTOR_TOOLS_MAX = 1000`.
  `TurnContext.tools` is now `.max(TURN_TOOLS_MAX + TURN_CONNECTOR_TOOLS_MAX)`. Two new helpers:
  `isConnectorLogicalTool(name)` (checks the shape) and `openClawToolCount(tools, connectorTools)`.
- **A. API** (`turn-policy.ts`): `assemble()` adds proxied logical tools through `addConnector`. They have their own
  bound and are never stopped by `TURN_CATALOG_TOOLS_MAX`. In-cell catalog tools still stop at the catalog share,
  counted in provider slots. `assemble` now also returns `connectorTools`, which flows into `ComputedTurn`. Every later
  `MAX_TURN_TOOLS` check (sandbox and browser families, consult, Work Zone room, conversation-open, task fit and
  make-room, attachment read) now uses `slotsOf()`, which counts provider slots only. Eviction (`evictable`) never
  removes a platform or proxied tool. The `toolsOverLimit` doc now says only in-cell tools can ever be over the limit.
- **Web** (`tools-section.tsx`): the over-limit warning now says that tools of connectors using a member's or the
  organization's account never count.
- The plugin needed no logic change. `mention-mapper` already keeps logical names out of `allowedTools`, and the
  guard uses `connectorTools` with no index cap. Regression tests now cover both. The plugin's own `TurnContext.tools`
  has no bound, so it needed no mirror.

## Deviations from plan

1. **[Rule 1] `openClawToolCount` signature.** The plan's version counted every name that did not match
   `/^m[0-9a-f]{8}__\S/`. In-cell (organization `org_secret`) MCP tools have exactly that shape and are real
   OpenClaw function tools: the plugin itself tells them apart with `CONNECTOR_LOGICAL_TOOL && !agentToolSet.has(t)`.
   The plan's helper would have let in-cell tools go past the provider's 128. So the helper takes the turn's set of
   proxied names, which the API builds from the catalog's `proxiedSource()`. A name is skipped only when it is in that
   set and also has the logical shape. The plugin keeps its own regex, because it does not import contracts.
2. **Test sizes: 200 grants instead of 300.** `UpdateBotCapabilitiesRequest.tools` is `.max(200)`, so a bot cannot be
   given 300 tools. The integration tests use the most one request allows:
   - `connectors-org.int.test.ts`: the real org-account server gets 197 extra tools (200 grants). The turn carries all
     200 logical names. `whoami` sorts past index 128 and is called with the organization's grant (200). The listing
     returns its 64-tool bound.
   - `work-session-offer.int.test.ts`: 100 proxied tools (`org_client_credentials`) plus 100 in-cell tools with the
     same `m<8 hex>__` shape. The turn has all 100 proxied tools, the six Work Zone tools, the task tools, and the
     in-cell share in order. `openClawToolCount` is at most 128, the ledger row has every proxied tool, and
     `toolsOverLimit` is between 1 and 100.
   The sandbox-family assertion from the plan already lives in `automation-runs.int.test.ts`, which still passes. It
   goes through the same `slotsOf` path.
3. **Web copy updated.** It said "at most 101 tools from MCP servers and plugins" with no exception, so it was changed
   (and its test) as the plan allowed.

## Not changed (follow-ups for the owner)

- **The 200-grant bound** on `PATCH /agents/:id/capabilities` stays. A server with more than 200 tools still cannot be
  fully enabled on one bot. Raising it is a separate decision about the grant model.
- **`ocw_connector_list` lists at most 64 tools per connector** (`CONNECTOR_TOOL_LIMITS.toolsPerConnector`). A tool
  past that bound is still callable by name (tested), but the model only learns its name from somewhere else. A
  "more tools not listed" hint or paging would be its own change.
- The `withheld` bookkeeping bound (`withheld.length >= MAX_TURN_TOOLS`) caps the size of the withheld list, not tool
  slots, so it was left alone.

## Tests (failing first, then green)

- Plugin `connector-tools.test.ts`: the `arguments` open test failed first (RED), then passed. A guard regression test
  checks a logical tool among 300 + 120. `mention-mapper.test.ts`: none of 300 logical tools reaches OpenClaw.
- Contracts `bot-capabilities.test.ts`: four new or updated tests failed first (RED), then passed.
- API: the new `work-session-offer` test failed first (RED). The proxied tools were cut off.
  `connectors-org` was RED on the original `turn-policy.ts`: 97 of 200 logical tools. Both pass with the fix.
- Web `tools-section.test.tsx`: the copy assertion failed first (RED), then passed.

Final runs:
- `pnpm exec vitest run apps/api/src/modules/bot-capabilities apps/api/src/modules/agent-channel`: 71 files,
  **1209 passed**. After a lint-only edit, `connectors-org.int.test.ts` was re-run: 18 passed.
- `pnpm exec vitest run packages/contracts apps/openclaw-channel apps/web/components/bots`: 84 files, **2031 passed**.
- `pnpm lint`: exit 0, 2100 files, 4 warnings, all already present in `apps/local-runtime` (untouched).
- `pnpm typecheck`: exit 0, 11/11 tasks.

Integration tests used testcontainers (ephemeral PostgreSQL and Redis) only. The owner's demo was not touched. No
e2e tests were run.

## Commits

- `1c2b4eb0` fix(openclaw-channel): ocw_connector_call arguments are explicitly open (quick 261116-k3p)
- `27901524` feat(contracts): logical connector tools have their own turn bound (quick 261116-k3p)
- `73f99462` fix(web): the tool limit warning says proxied connector tools never count (quick 261116-k3p)
- `f0776158` fix(api): proxied connector tools never take a turn's tool slots (quick 261116-k3p)

## Self-Check: PASSED
