// node --test infra/sandbox/browser/redact.test.mjs
//
// The redacting snapshot serializer of the browser agent (07.8-07, D-07, P-10, E1). Pure: fixture AX trees in CDP shape
// plus the agent's per-field DOM facts and human-typed marks. No browser, no dependencies.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  backendIdFromRef,
  isSensitive,
  isSensitiveField,
  REDACTED,
  refFor,
  SENSITIVE_AUTOCOMPLETE,
  SENSITIVE_LABEL,
  serializeSnapshot,
} from "./redact.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ax-login.json", import.meta.url), "utf8"));
const facts = new Map(Object.entries(fixture.facts).map(([k, v]) => [Number(k), v]));
const byBackend = (id) => fixture.nodes.find((n) => n.backendDOMNodeId === id);
const snapshot = (marks = new Set(), options) => serializeSnapshot(fixture.nodes, marks, facts, options);
const nodeOf = (result, backendId) => result.nodes.find((n) => n.ref === refFor(backendId));

/** Every fixture value that must never leave the agent once redaction applies. */
const SECRETS = [
  "••••••••••••",
  "hunter2-current",
  "hunter2-new",
  "735190",
  "998877",
  "4321",
  "named-pwd-value",
  "aria-div-value",
];

describe("redact: the sensitive-field rules", () => {
  it("names the constants of the design", () => {
    assert.equal(REDACTED, "[redacted]");
    for (const ac of ["current-password", "new-password", "one-time-code", "section-x current-password"]) {
      assert.match(ac, SENSITIVE_AUTOCOMPLETE);
    }
    assert.doesNotMatch("username", SENSITIVE_AUTOCOMPLETE);
    for (const label of [
      "Password",
      "pwd",
      "OTP",
      "Verification code",
      "PIN",
      "Client secret",
      "API token",
    ]) {
      assert.match(label, SENSITIVE_LABEL);
    }
    assert.doesNotMatch("Email", SENSITIVE_LABEL);
  });

  it("type=password is sensitive", () => {
    assert.equal(isSensitive(byBackend(30), new Set(), facts), true);
    assert.equal(isSensitiveField({ type: "password" }, "Anything"), true);
  });

  it("autocomplete current-password, new-password and one-time-code are sensitive", () => {
    assert.equal(isSensitive(byBackend(31), new Set(), facts), true);
    assert.equal(isSensitive(byBackend(32), new Set(), facts), true);
    assert.equal(isSensitive(byBackend(40), new Set(), facts), true);
  });

  it("a -webkit-text-security other than none is sensitive", () => {
    assert.equal(isSensitive(byBackend(45), new Set(), facts), true);
    for (const ts of ["disc", "circle", "square"]) {
      assert.equal(isSensitiveField({ type: "text", textSecurity: ts }, "Field"), true);
    }
    assert.equal(isSensitiveField({ type: "text", textSecurity: "none" }, "Field"), false);
  });

  it("a name, label or field name matching pass|pwd|otp|code|pin|secret|token is sensitive", () => {
    assert.equal(isSensitive(byBackend(50), new Set(), facts), true); // "Your PIN"
    assert.equal(isSensitive(byBackend(55), new Set(), facts), true); // name="pwd"
    assert.equal(isSensitiveField({ type: "text", label: "Passphrase" }, "Field"), true);
    assert.equal(isSensitiveField({ type: "text", attrId: "otp-input" }, "Field"), true);
    assert.equal(isSensitiveField({ type: "text", placeholder: "Access token" }, ""), true);
  });

  it("any node in the human-typed marks is sensitive", () => {
    assert.equal(isSensitive(byBackend(60), new Set(), facts), false);
    assert.equal(isSensitive(byBackend(60), new Set([60]), facts), true);
    assert.equal(isSensitive(byBackend(20), new Set([20]), facts), true);
  });

  it("an ordinary search box or text field is not sensitive", () => {
    assert.equal(isSensitive(byBackend(70), new Set(), facts), false);
    assert.equal(isSensitive(byBackend(20), new Set(), facts), false);
  });

  it("defaults to redact on doubt: a text field whose type cannot be read is sensitive", () => {
    assert.equal(isSensitive(byBackend(80), new Set(), facts), true);
    assert.equal(isSensitive(byBackend(80), new Set(), new Map()), true);
    assert.equal(isSensitive(byBackend(70), new Set(), new Map()), true);
  });

  it("a button or link named like a password control carries no value and is not a field", () => {
    assert.equal(isSensitive(byBackend(100), new Set(), facts), false);
  });
});

describe("redact: serializeSnapshot", () => {
  it("replaces every sensitive value with [redacted] and marks the node redacted", () => {
    const result = snapshot();
    for (const id of [30, 31, 32, 40, 45, 50, 55, 80]) {
      const node = nodeOf(result, id);
      assert.ok(node, `node ${id} is serialized`);
      assert.equal(node.redacted, true, `node ${id} is redacted`);
      assert.equal(node.value, REDACTED, `node ${id} carries only [redacted]`);
    }
    const json = JSON.stringify(result);
    for (const secret of SECRETS) assert.equal(json.includes(secret), false, `"${secret}" never appears`);
  });

  it("an ordinary search box and an untouched text field keep their values", () => {
    const result = snapshot();
    assert.deepEqual(
      { value: nodeOf(result, 70).value, redacted: nodeOf(result, 70).redacted },
      { value: "invoices 2026", redacted: false },
    );
    assert.equal(nodeOf(result, 60).value, "Ana Lopez");
    assert.equal(nodeOf(result, 20).value, "ana@example.test");
  });

  it("a human-typed field is redacted, and so is the text inside it", () => {
    const result = snapshot(new Set([20, 60]));
    assert.equal(nodeOf(result, 20).redacted, true);
    assert.equal(nodeOf(result, 60).redacted, true);
    const json = JSON.stringify(result);
    assert.equal(json.includes("ana@example.test"), false);
    assert.equal(json.includes("Ana Lopez"), false);
  });

  it("never serializes what is inside a text field (its inner editor repeats the value)", () => {
    const result = snapshot();
    assert.equal(nodeOf(result, 21), undefined);
    assert.equal(nodeOf(result, 22), undefined);
    assert.equal(result.nodes.filter((n) => n.name === "ana@example.test").length, 0);
  });

  it("the text holds each node once with its ref, role and name", () => {
    const result = snapshot();
    const lines = result.text.split("\n").filter(Boolean);
    assert.equal(lines.length, result.nodes.length);
    for (const node of result.nodes) {
      const mine = lines.filter((l) => l.includes(`[${node.ref}] `));
      assert.equal(mine.length, 1, `${node.ref} appears once`);
      assert.ok(mine[0].includes(` ${node.role}`), `${node.ref} names its role`);
      if (node.name) assert.ok(mine[0].includes(JSON.stringify(node.name)), `${node.ref} names itself`);
    }
    assert.match(result.text, /\[e30\] textbox "Secret word" = \[redacted\]/);
    assert.match(result.text, /\[e10\] heading "Sign in"/);
  });

  it("drops ignored nodes and inline text boxes but keeps their visible children", () => {
    const result = snapshot();
    assert.equal(nodeOf(result, 25), undefined);
    assert.ok(result.nodes.some((n) => n.name === "Use your work account"));
    assert.equal(result.nodes.filter((n) => n.role === "InlineTextBox").length, 0);
    // A StaticText repeating its parent's name is not repeated.
    assert.equal(result.nodes.filter((n) => n.name === "Sign in").length, 1);
    assert.ok(result.nodes.some((n) => n.role === "StaticText" && n.name === "Welcome back"));
  });

  it("links carry no value (an href can hold a token) and buttons stay actionable", () => {
    const result = snapshot();
    assert.equal(nodeOf(result, 110).value, null);
    assert.equal(JSON.stringify(result).includes("link-token-value"), false);
    assert.equal(nodeOf(result, 100).role, "button");
    assert.equal(nodeOf(result, 100).redacted, false);
  });

  it("depth follows the tree; refs round-trip to backend node ids", () => {
    const result = snapshot();
    assert.equal(nodeOf(result, 1).depth, 0);
    assert.equal(nodeOf(result, 10).depth, 1);
    assert.equal(backendIdFromRef(refFor(4242)), 4242);
    assert.equal(backendIdFromRef("x42"), null);
    assert.equal(backendIdFromRef("e0042"), null);
    assert.equal(backendIdFromRef("e"), null);
  });

  it("caps nodes, names and values, and says when it truncated", () => {
    const many = [
      {
        nodeId: "r",
        ignored: false,
        role: { value: "RootWebArea" },
        name: { value: "x" },
        childIds: [],
        backendDOMNodeId: 1,
      },
    ];
    for (let i = 0; i < 700; i += 1) {
      many[0].childIds.push(`b${i}`);
      many.push({
        nodeId: `b${i}`,
        ignored: false,
        role: { value: "button" },
        name: { value: i % 50 === 0 ? `${"n".repeat(300)}${i}` : `b${i}` },
        childIds: [],
        backendDOMNodeId: 1000 + i,
      });
    }
    const result = serializeSnapshot(many, new Set(), new Map());
    assert.equal(result.nodes.length, 600);
    assert.equal(result.truncated, true);
    assert.ok(result.nodes.every((n) => n.name.length <= 200));
    assert.ok(result.nodes.some((n) => n.name.length === 200));
    assert.ok(result.text.length <= 32_000);

    const small = serializeSnapshot(many, new Set(), new Map(), { maxNodes: 5000, maxText: 1000 });
    assert.ok(small.text.length <= 1000);
    assert.equal(small.truncated, true);
    assert.equal(snapshot().truncated, false);
  });

  it("a cyclic or dangling child list cannot loop or crash", () => {
    const cyclic = [
      {
        nodeId: "a",
        ignored: false,
        role: { value: "RootWebArea" },
        childIds: ["b", "zz"],
        backendDOMNodeId: 1,
      },
      { nodeId: "b", ignored: false, role: { value: "group" }, childIds: ["a"], backendDOMNodeId: 2 },
    ];
    const result = serializeSnapshot(cyclic, new Set(), new Map());
    assert.equal(result.nodes.length, 2);
  });
});
