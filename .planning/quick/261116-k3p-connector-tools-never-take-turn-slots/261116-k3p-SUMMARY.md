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

## Part 2: big connectors are fully usable (PLAN-2)

### What changed

- **Grant limit** (`packages/contracts/src/bot-capabilities.ts`): `UpdateBotCapabilitiesRequest.tools` is now bounded
  by `TURN_CONNECTOR_TOOLS_MAX` (1000), up from 200. The constant moved above that schema so it is defined before use.
  No other bound on a grant set exists: the API route, the DB, the web sheet's `bulkGrants` and the cell snapshot have
  none. The web needed no change.
- **Listing contracts** (`agent-channel.ts`):
  - `AgentChannelConnectorList` takes optional filters: `connector` (safe name), `query` (trimmed, 1 to 100
    characters) and `tool` (1 to 128 characters). `tool` requires `connector`, checked with a refine.
  - `AgentChannelConnectorEntry` gets optional `toolCount` and `more` fields.
  - The response gets an optional `schemas` boolean (see deviation 1).
  - New `CONNECTOR_LIST_LIMITS` = `{ queryChars: 100, schemasUpTo: 8 }`.
  - A request without the new fields parses exactly as before.
- **API** (`agent-channel/connectors.ts`, `listedConnectors`):
  - The `connector` filter narrows the turn's offered names.
  - `tool` matches the exact name first, then the one case-insensitive match `ocw_connector_call` would resolve.
  - `query` is a case-insensitive substring match over the tool name plus its description or title.
  - With `query` or `tool`, only connectors that have a match are listed. Without them, every connector of the turn is
    listed with its `toolCount`.
  - Each connector lists at most `toolsPerConnector` tools (still 64), sets `more` when it cuts, and always reports
    `toolCount`.
  - Schemas are sent only for a named `tool`, or when the whole listing has 8 tools or fewer.
  - The route now lists only tools that are both in the delivered turn and in the current decision. Before, it used the
    current decision alone. This narrows what is listed; a call already needed both.
  - Tool-call metadata is unchanged: counts only, never the query.
- **Plugin** (`connector-tools.ts`, `agent-channel-protocol.ts`):
  - `ocw_connector_list` has closed, typed parameters `connector` (pattern), `query` (maxLength 100) and `tool`
    (maxLength 128, described as the exact tool name to get its argument schema).
  - `listFiltersOf` checks them locally (`bad_params`, nothing posted) and forwards them.
  - The rendered list shows `N tools, M listed (search the rest with query)`. When `schemas === false` it drops
    `Arguments: {}` and adds one line on how to get a tool's arguments.
  - `LIST_DESCRIPTION` and `CALL_DESCRIPTION` explain the flow: list, search with `query`, get the schema with
    `connector` + `tool`, call.
  - Taint and flags logic is untouched.
  - The protocol mirror gained the request fields and the optional `toolCount`, `more` and `schemas`, each with
    `.catch(undefined)`.

### Deviations (part 2)

1. **`schemas` flag added to the list response.** The plan did not ask for it. Without it, a null `inputSchema` left
   out on purpose would look exactly like a tool with no arguments: the plugin used to render that as `Arguments: {}`.
   The flag is optional and additive.
2. **When schemas are sent.** I read "the filtered result has ≤ 8 tools" as the whole listing having 8 tools or fewer,
   whether or not a filter is used. A small setup (for example 3 tools) therefore keeps getting its schemas in one call,
   as it did before. Every existing test that expected schemas still passes. A big connector without filters never gets
   schemas.
3. **Search across connectors.** `query` also works without `connector` and searches every connector of the turn.
   `tool` still requires `connector`.
4. **Listing intersects the delivered turn with the current decision**, as described above. This is a tightening, not a
   loosening.

### Not changed (follow-up)

- **Probe cap of 256 tools per server.** The API-side MCP probe for proxied servers
  (`apps/api/src/modules/connectors/mcp-client.ts`, `MAX_TOOLS = 256`, `MAX_PAGES = 10`) stores at most 256 tools per
  server. A server with more tools than that is truncated in the catalog itself, so its extra tools can never be
  enabled. Raising this touches the probe and storage bounds, so I left it out of this plan.
- The rule-dialog and watched-record tool listings already cut each server at 200 (`GROUP_TOOLS_MAX`, `own.slice`).
  That is a display bound only and has no effect on grants or calls.

### Tests (part 2, failing first then green)

- Contracts: request filters, the 100-character query cap, `tool` without `connector` refused, `toolCount`/`more`/
  `schemas`, grant sets of 300 and 1000 accepted and 1001 refused. All red first.
- API `connectors-org.int.test.ts`: a new describe with 297 extra tools, so 300 grants are accepted. It covers:
  - no filter: `toolCount` 300, 64 tools, no schemas, `schemas: false`, `more`;
  - `query` "expedientes" finds `b150` (position 151) through its description, with its schema;
  - `query` "WHOAMI" without a connector finds `whoami`;
  - a broad query is cut and sets `more`;
  - `tool` returns that tool's schema, an unknown tool lists nothing, and `tool` without `connector` gets 400;
  - an ungranted proxied server and a made-up connector id are never listed.
  All four tests were red first.
- Plugin `connector-tools.test.ts`: parameter schema, descriptions, forwarding plus local refusals, and the big-listing
  rendering. All red first.

Final runs (part 2):
- `pnpm exec vitest run apps/api/src/modules/bot-capabilities apps/api/src/modules/agent-channel`: 71 files,
  **1213 passed**. After a lint-only test edit, `connectors-org.int.test.ts` was re-run: 22 passed.
- `pnpm exec vitest run packages/contracts apps/openclaw-channel apps/web/components/bots`: 84 files, **2037 passed**.
- `pnpm lint`: exit 0. The only 4 warnings are the existing ones in `apps/local-runtime`, which this work did not touch.
- `pnpm typecheck`: exit 0, 11/11.

### Commits (part 2)

- `39bde77c` docs(quick-261116-k3p): plan part 2: grant limit and a connector listing that scales (cherry-picked)
- `59e48d6e` feat(contracts): connector listing filters and a grant set up to 1000 tools (quick 261116-k3p part 2)
- `7122e9fd` feat(contracts): the connector listing says whether it carries argument schemas (quick 261116-k3p part 2)
- `caf5379e` feat(api): ocw_connector_list scales to big connectors (quick 261116-k3p part 2)
- `cf68bb14` feat(openclaw-channel): ocw_connector_list searches big connectors and fetches one tool's arguments (quick 261116-k3p part 2)
- `cb50067f` test(api): connector listing assertions without unsafe optional chaining (quick 261116-k3p part 2)
