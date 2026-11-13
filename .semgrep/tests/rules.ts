// Semgrep rule fixtures for .semgrep/rules.yml (`node scripts/guard/run.mjs --rule-tests`). Never compiled, linted or
// scanned by the main guard run: each `ruleid:` line must match on the next line, each `ok:` line must not.

// ruleid: ocw.permission-bypass-token
const claudeMode = "bypassPermissions";
// ruleid: ocw.permission-bypass-token
const codexSandbox = "danger-full-access";
// ruleid: ocw.permission-bypass-token
const options = { allowDangerouslySkipPermissions: true };
// ruleid: ocw.permission-bypass-token
const argv = ["--dangerously-skip-permissions"];
// ruleid: ocw.permission-bypass-token
const flag = { dangerouslySkipPermissions: true };
// ok: ocw.permission-bypass-token
const safeMode = "default";
// ok: ocw.permission-bypass-token
const sandbox = "workspace-write";

// ruleid: ocw.focused-test
it.only("narrows the suite", () => {});
// ruleid: ocw.focused-test
describe.only("narrows the suite", () => {});
// ruleid: ocw.focused-test
test.only.each([1])("narrows %s", () => {});
// ok: ocw.focused-test
it("runs with the rest of the suite", () => {});

// ruleid: ocw.skipped-policy-test
it.skip("denies cross-tenant reads", () => {});
// ruleid: ocw.skipped-policy-test
describe.todo("denies cross-tenant reads");
// ruleid: ocw.skipped-policy-test
it.skipIf(process.env.CI)("denies cross-tenant reads", () => {});
// ruleid: ocw.skipped-policy-test
describe.runIf(false)("denies cross-tenant reads", () => {});
// ruleid: ocw.skipped-policy-test
xit("denies cross-tenant reads", () => {});
// ruleid: ocw.skipped-policy-test
xdescribe("denies cross-tenant reads", () => {});
// ok: ocw.skipped-policy-test
it("denies cross-tenant reads", () => {});

// ruleid: ocw.ai-telemetry-records-prompts
streamText({ model, messages, experimental_telemetry: { isEnabled: true } });
// ruleid: ocw.ai-telemetry-records-prompts
generateText({ model, prompt, experimental_telemetry: { isEnabled: true, recordInputs: false } });
// ruleid: ocw.ai-telemetry-records-prompts
generateText({ model, prompt, experimental_telemetry: telemetrySettings });
// ruleid: ocw.ai-telemetry-records-prompts
streamText({ model, messages, telemetry: { functionId: "chat" } });
// ok: ocw.ai-telemetry-records-prompts
streamText({ model, messages, experimental_telemetry: { isEnabled: true, recordInputs: false, recordOutputs: false } });
// ok: ocw.ai-telemetry-records-prompts
streamText({ model, messages, experimental_telemetry: { recordOutputs: false, functionId: "x", recordInputs: false } });
// ok: ocw.ai-telemetry-records-prompts
streamText({ model, messages, telemetry: { recordInputs: false, recordOutputs: false } });
// ok: ocw.ai-telemetry-records-prompts
generateText({ model, prompt, experimental_telemetry: { isEnabled: false } });
// ok: ocw.ai-telemetry-records-prompts
const sdk = new NodeSDK({ telemetry: { serviceName: "ocw-api" } });

// ruleid: ocw.raw-egress
const r1 = await fetch("https://example.com");
// ruleid: ocw.raw-egress
const r2 = await globalThis.fetch(url);
// ruleid: ocw.raw-egress
import { Agent } from "undici";
// ruleid: ocw.raw-egress
import https from "node:https";
// ruleid: ocw.raw-egress
import { request } from "http";
// ruleid: ocw.raw-egress
import * as net from "node:net";
// ruleid: ocw.raw-egress
import { connect } from "node:net";
// ruleid: ocw.raw-egress
const tls = require("node:tls");
// ruleid: ocw.raw-egress
const lazy = await import("undici");
// ruleid: ocw.raw-egress
import { createConnection } from "node:net";
// ruleid: ocw.raw-egress
import http from "node:http";
// ok: ocw.raw-egress
import { createEgressProxy } from "./proxy.ts";
// ok: ocw.raw-egress
const r3 = await egressFor(env).fetch("https://example.com");
// ok: ocw.raw-egress
const r4 = await egress.bound(policy)(url);
// ok: ocw.raw-egress
import { BlockList, isIP } from "node:net";
// ok: ocw.raw-egress
import type { Socket } from "node:net";

// ruleid: ocw.raw-auth-mode
const inCell = server.authMode === "org_secret";
// ruleid: ocw.raw-auth-mode
const proxied = server.authMode !== "org_secret";
// ruleid: ocw.raw-auth-mode
const leftSide = "org_secret" === mode;
// ruleid: ocw.raw-auth-mode
const leftSideNot = "org_secret" !== input.authMode;
// ruleid: ocw.raw-auth-mode
const cellRows = await tx.select().from(mcpServers).where(eq(mcpServers.authMode, "org_secret"));
// ruleid: ocw.raw-auth-mode
const proxyRows = await tx.select().from(mcpServers).where(ne(mcpServers.authMode, "org_secret"));
// ok: ocw.raw-auth-mode
const rendered = rendersInCell(server.authMode);
// ok: ocw.raw-auth-mode
const perMember = isPerMemberMode(m);
// ok: ocw.raw-auth-mode
const cellModes = await tx.select().from(mcpServers).where(inArray(mcpServers.authMode, CELL_MODES));
// ok: ocw.raw-auth-mode
const defaultMode: ConnectorAuthMode = "org_secret";
// ok: ocw.raw-auth-mode
const memberKey = server.authMode === "per_member_secret";
// ok: ocw.raw-auth-mode
setAuthMode("org_secret");
// 07.14 review IN-03: the loose operators, switch cases and list membership are raw comparisons too.
// ruleid: ocw.raw-auth-mode
const loose = server.authMode == "org_secret";
// ruleid: ocw.raw-auth-mode
const looseNot = "org_secret" != server.authMode;
switch (server.authMode) {
  // ruleid: ocw.raw-auth-mode
  case "org_secret":
    break;
  // ok: ocw.raw-auth-mode
  case "per_member_oauth":
    break;
}
// ruleid: ocw.raw-auth-mode
const listed = ["org_secret", "per_member_secret"].includes(server.authMode);
// ruleid: ocw.raw-auth-mode
const listedRows = await tx.select().from(mcpServers).where(inArray(mcpServers.authMode, ["org_secret"]));
// ruleid: ocw.raw-auth-mode
const notListedRows = await tx.select().from(mcpServers).where(notInArray(mcpServers.authMode, ["org_secret"]));
// ok: ocw.raw-auth-mode
const memberListed = ["per_member_oauth", "per_member_secret"].includes(server.authMode);
// ok: ocw.raw-auth-mode
const modes: ConnectorAuthMode[] = ["org_secret", "org_oauth"];

// 07.17.1.1.2 PD-19, P1 (ADR-0042 § 14): a task audit carries ids, counts, reasons and durations, never the bot's text.
// ruleid: ocw.bot-task-text-in-audit
await core.audit.record(tx, { action: "bot.task_started", actorKind: "agent", metadata: { taskId, goal } });
// ruleid: ocw.bot-task-text-in-audit
await core.audit.record(tx, { action: "bot.task_continued", metadata: { taskId: task.id, progress: body.progress } });
// ruleid: ocw.bot-task-text-in-audit
await core.audit.record(tx, { metadata: { taskId, summary: body.summary }, action: "bot.task_finished" });
// ruleid: ocw.bot-task-text-in-audit
await core.audit.record(tx, { ...auditBase, action: "bot.task_refused", metadata: { ...ids, nextStep } });
// ruleid: ocw.bot-task-text-in-audit
await core.audit.record(tx, {
  action: "bot.task_stopped",
  resourceType: "bot_task",
  metadata: { taskId: task.id, turnsUsed, goal: task.goal },
});
// ruleid: ocw.bot-task-text-in-audit
await auditTask(tx, core, "bot.task_finished", task, { turnsUsed, summary: body.summary });
// ok: ocw.bot-task-text-in-audit
await core.audit.record(tx, { action: "bot.task_started", metadata: { taskId, turnsUsed } });
// ok: ocw.bot-task-text-in-audit
await core.audit.record(tx, { action: "bot.task_stopped", metadata: { taskId, reason: "budget_turns", byUserId } });
// ok: ocw.bot-task-text-in-audit
await auditTask(tx, core, "bot.task_continued", task, { eventId, turnsUsed, maxTurns, waitKind });
// ok: ocw.bot-task-text-in-audit
await core.audit.record(tx, { action: "bot.work_session_started", metadata: { sessionId, goal: profile.goal } });
// ok: ocw.bot-task-text-in-audit
const taskRow = { goal: body.goal, progress: body.progress, nextStep: body.nextStep, summary: null };
export async function auditTask(tx: Tx, core: Core, action: TaskAction, task: BotTaskRow, metadata: object) {
  // ruleid: ocw.bot-task-text-in-audit
  await core.audit.record(tx, { action, metadata: { taskId: task.id, goal: task.goal, ...metadata } });
}
async function auditTaskRefused(tx: Tx, core: Core, p: Refusal) {
  // ok: ocw.bot-task-text-in-audit
  await core.audit.record(tx, { action: "bot.task_refused", metadata: { taskId: p.task?.id ?? null, code: p.code } });
}
