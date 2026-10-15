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
