# Coverage — Phase 07.13.1.1 Work Zone session owners, Assign to me, rename

> Full coverage by default. Opt-outs are explicit, reasoned decisions. Every locked decision, requirement and research
> item maps to at least one plan; nothing is unplanned.

## Locked decisions (07.13.1.1-CONTEXT.md)

| Decision | Plans | Where |
|---|---|---|
| D-01 Sessions by person view (owner, device, project, status, last activity; filters; grouped; resolver's list only; 390 + desktop, both themes) | 07, 08 | 07 T1 model + view, T2 filters + row + sidebar; 08 T3 a11y light/dark, 390/1440, screenshots |
| D-02 Owner = `created_by`, shown in the view and the header | 01, 06, 07 | 01 T1 contracts; 06 T2 owner chip / line; 07 T1 group headers |
| D-03 Assign to me = owner transfer (access rule, controls, Mine; creator kept in history) | 01, 02, 06, 08 | 01 T3 db proof; 02 T1 transfer + audit + event; 06 T2 timeline line; 08 T1 |
| D-04 Only on servers (`service`), server-checked, hidden with a one-line reason | 01, 02, 04, 06, 07, 08, 09 | 01 T1 `AssignRefusal`; 02 T1 check; 06 T1 menu reason; 07 T2 row reason; 08 T2 desktop case; 04 T2 the desktop app's daemon always announces `desktop`; 09 T1 ADR: `host_kind` is the device owner's self-reported label |
| D-05 Who may (sees it + device use, same org; not bot sessions; audited from/to; no cut turn) | 02, 08 | 02 T1 checks + audit, T2 no interrupt; 08 T1 |
| D-06 Manual rename (header + row menu; `user`, never replaced; audited; live; same length rules) | 01, 02, 06, 07, 08 | 01 T1 `TypedSessionTitle`; 02 T3 PATCH; 06 T3 header; 07 T2 row menu; 08 T2 |
| D-07 Agent rename tool (Claude in-process, Codex shim; API decides; only that session; not over `user`; bounded; audited; live) | 01, 03, 04, 05, 08 | 01 T2 contracts; 03 T1 decision; 04 T1-T3 relay + Claude; 05 T1-T2 Codex; 08 T2 |
| D-08 Naming rules (org + project, project after org, title generator + tool, untrusted bounded text; repo CLAUDE.md / AGENTS.md as today) | 01, 03, 04, 05, 07, 08 | 01 T2-T3 schema + columns; 03 T2 storage, T3 delivery; 04 T2 description; 05 T3 title instructions; 07 T3 fields; 08 T2; 03 T2 negative tests (no project access → 404, cross-org); 07 T3 no section without `namingRule`; 09 T1 ADR: stored in `session.title` `device_commands` payloads |
| D-09 Tests (TDD; real PostgreSQL incl. cross-tenant, desktop, bot refusals; offline runtime fixtures; e2e in CI; screenshots 390 + desktop, both themes) | 01-08 | every task's verify; 04 T3 / 05 T2 synthetic fixtures; 08 T3 CI screenshots; VALIDATION.md |
| D-10 One ADR; AGENTS.md row within 200 lines | 09 | T1 |
| D-11 Transfer mechanism (UPDATE `created_by` under the lock; `work_session.assigned`; `session.owner_changed`) | 01, 02 | 01 T1 event, T3 proof; 02 T1 |
| D-12 Server check `host_kind === 'service'`; prompt + `device.use`; bot and archived refused | 02, 04, 09 | 02 T1 (audit carries `hostKind`, `deviceOwnerId`); 04 T2 host-kind guard tests; 09 T1 ADR § 2 |
| D-13 No cut turns (no-interrupt reauthorize, `access_changed`; queued prompts of removed people cancelled, audited; dialog says so) | 02, 06 | 02 T2; 06 T1 dialog |
| D-14 Rename (PATCH 1–200, configure, `user`; `ocw_session` › `rename`, same device, turn in flight, not `user`, once per turn, generated shape, `auto`) | 01, 02, 03, 04 | 01 T1-T2; 02 T3; 03 T1; 04 T2 pre-checks |
| D-15 `people` visibility: previous owner not re-added; dialog warns | 02, 06, 08 | 02 T2 test + side-effect-free preview (`computeTransfer` in `withSavepoint(…, () => false)`, spies); 06 T1 warning; 08 T1 |

Deferred (CONTEXT): assigning to someone else, admin bulk reassignment, renaming AI chats, naming rules per team,
reassigning bot sponsors — not planned (ADR-0047 lists them as deferred).

Claude's discretion choices recorded in plans: the dry-run preview through `withSavepoint(…, () => false)` over a pure
`computeTransfer` (02); `assign` on the
detail only, `deviceHostKind` on every DTO, no per-row permission checks in the list (02); the project rule visible to
everyone who can open the project page (03); a rule-only policy change skips `reauthorizeOrg` (03); synthetic offline
fixtures for both runtimes (04, 05); Codex picks up a new rule at its next app-server start (05); one shared rename
dialog for the header and the row menu (06, 07); release number v0.5.3 (09).

## Requirements (REQUIREMENTS.md › WZO)

| Requirement | Plans |
|---|---|
| WZO-01 | 07, 08 |
| WZO-02 | 01, 02, 06, 08 |
| WZO-03 | 01, 02, 06, 08 |
| WZO-04 | 01, 02, 04, 06, 07, 08, 09 |
| WZO-05 | 01, 02, 06, 07, 08 |
| WZO-06 | 01, 03, 04, 05, 08 |
| WZO-07 | 01, 03, 04, 05, 07, 08 |
| WZO-08 | 01, 02, 03, 04, 05, 06, 07, 08 |
| WZO-09 | 09 |

## Research items (07.13.1.1-RESEARCH.md)

| Item | Plans | Note |
|---|---|---|
| Phase goal (ROADMAP 07.13.1.1) | 01-09 | |
| PD-01 transfer = UPDATE `created_by` | 01, 02, 09 | db proof, transfer, ADR § 1 |
| PD-02 `POST …/assign`, 8-step check | 02 | |
| PD-03 reauthorize without interrupt, wire `access_changed` | 02 | |
| PD-04 `work_session.assigned` + server-only `session.owner_changed` | 01, 02, 06 | |
| PD-05 cancel removed authors' queued prompts; conversation roles | 02 | |
| PD-06 `SessionTitlePayload.namingRules` + `titleInstructions` | 01, 03, 05 | |
| PD-07 `PATCH /work-sessions/:id`, configure, typed rule | 01, 02, 06 | |
| PD-08 `ocw_session` server (Claude sdk + Codex `session-mcp`), shared token helpers | 04, 05 | token helpers imported from `browser/shim-token.ts`, `controlCall` exported, not copied |
| PD-09 `session.rename` / `.result` via a generalized `replyOn` | 01, 03, 04 | |
| PD-10 `sessionTools` on start / prompt, no hello version | 01, 03, 04 | sent copy only (03) |
| PD-11 one rename per turn (`work_prompts.title_renamed_at`) | 01, 03, 04 | |
| PD-12 agent rename = `auto`, never over `user` | 03 | |
| PD-13 rules in the tool description | 04 | |
| PD-14 `deviceHostKind` + detail `assign` | 01, 02, 06 | |
| PD-15 `/work-zone/people`, sidebar link, `isSessionPath` | 07 | |
| PD-16 rule columns ≤ 600, project after org | 01, 03, 07 | |
| Pitfall 1 no cut turn | 02 | |
| Pitfall 2 closed configure reason | 01, 02 | |
| Pitfall 3 old owner's queued prompts | 02 | |
| Pitfall 4 null / desktop host | 02, 04 | 02 T1 refusals; 04 T2 the desktop app's daemon can never announce `service` |
| Pitfall 5 normalizer limits rules | 07, 09 | stated next to the field and in the ADR / notes |
| Pitfall 6 rules as an injection channel | 01, 03, 04, 05 | bounds, tag stripping, delimiters, framing, no tools in title calls |
| Pitfall 7 Claude approval prompt per rename | 04 | |
| Pitfall 8 shadowing `ocw_session` | 04 | |
| Pitfall 9 `/work-zone/people` as a session path | 07 | |
| Pitfall 10 AGENTS.md cap | 09 | two rows edited in place |
| Pitfall 11 secret / path in an agent title | 03, 04 | refuse, never fix |
| Open Question 1 new `work_session.assign` grain | — | research recommendation followed: none now (prompt + `device.use`; a grain later is additive) |
| Open Question 2 rename grain | 02 | `work_session.configure` |
| Open Question 3 manual title length | 01, 02 | 1–200, one line, no host path |
| Open Question 4 old owner after a transfer | 02, 06 | no auto-grant; preview + dialog warning |
| Open Question 5 "created by" in the UI | 06 | the timeline line only |
| Assumptions A1-A9 | VALIDATION.md, 09 | A7 (extra Codex child) and A8 (600 chars) recorded in ADR-0047 Consequences |
| `docs/workzone/runtime-controls-inventory.md` rows | — | OPT-OUT: not needed; the inventory gates runtime options the API offers, and the 07.13 browser tools have no row either; the title rows stay accurate (no tools, same isolation) |
| PRD edit | — | OPT-OUT: the PRD does not define session ownership or renames; nothing contradicts it |
| UI-SPEC.md | — | OPT-OUT: the layout contract lives in plans 06 and 07's objectives (reused components only); the owner reviews the CI screenshots |

## External surfaces

### Claude Agent SDK 0.3.282

| capability | decision | reason |
|---|---|---|
| `createSdkMcpServer` + `tool` (in-process MCP server) | INTEGRATE | the `ocw_session` server |
| `Options.mcpServers` at launch, `setMcpServers` between turns | INTEGRATE | always both of ours together |
| `canUseTool` with `mcpServer.source` | INTEGRATE | provenance allow |
| PreToolUse hook | INTEGRATE | deny a foreign `ocw_session` in every mode |
| `mcpServerStatus` | INTEGRATE | shadow check |
| system-prompt append for the rules | OPT-OUT | would change every turn and raise the rule's authority (PD-13) |

### Codex app-server 0.172.0

| capability | decision | reason |
|---|---|---|
| `-c mcp_servers.<name>.*` overrides (stdio command, env, `default_tools_approval_mode`, `tool_timeout_sec`) | INTEGRATE | the shim |
| `mcpServer/elicitation/request`, `item/tool/requestUserInput` answers | INTEGRATE | as for `ocw_browser` |
| `mcpToolCall` items | INTEGRATE | mapper summary only |
| live reload of an MCP server's tool list | OPT-OUT | rules apply at the next app-server start; only an offered-state change restarts |

### Model Context Protocol SDK 1.30.1

| capability | decision | reason |
|---|---|---|
| `McpServer` + `StdioServerTransport` | INTEGRATE | the shim |
| any network transport (HTTP / SSE) | OPT-OUT | no listening port (AGENTS.md security rule) |
