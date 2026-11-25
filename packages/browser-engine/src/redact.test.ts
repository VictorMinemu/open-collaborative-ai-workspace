// The redacting snapshot serializer of the browser agent (07.8-07, D-07, P-10, E1), from the shared package (07.13
// D-04). Ported case for case from infra/sandbox/browser/redact.test.mjs (node:test) to vitest, same fixture: AX trees
// in CDP shape plus the agent's per-field DOM facts and human-typed marks. No browser, no dependencies.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  type AXNode,
  backendIdFromRef,
  type FieldFacts,
  isSensitive,
  isSensitiveField,
  REDACTED,
  refFor,
  SENSITIVE_AUTOCOMPLETE,
  SENSITIVE_LABEL,
  type Snapshot,
  type SnapshotOptions,
  serializeSnapshot,
} from "./redact.mjs";

const fixture = JSON.parse(readFileSync(new URL("./fixtures/ax-login.json", import.meta.url), "utf8")) as {
  nodes: AXNode[];
  facts: Record<string, FieldFacts>;
};
const facts = new Map(Object.entries(fixture.facts).map(([k, v]) => [Number(k), v]));
const byBackend = (id: number): AXNode => {
  const node = fixture.nodes.find((n) => n.backendDOMNodeId === id);
  if (!node) throw new Error(`no fixture node ${id}`);
  return node;
};
const snapshot = (marks = new Set<number>(), options?: SnapshotOptions) =>
  serializeSnapshot(fixture.nodes, marks, facts, options);
const nodeOf = (result: Snapshot, backendId: number) => result.nodes.find((n) => n.ref === refFor(backendId));

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
    expect(REDACTED).toBe("[redacted]");
    for (const ac of ["current-password", "new-password", "one-time-code", "section-x current-password"]) {
      expect(ac).toMatch(SENSITIVE_AUTOCOMPLETE);
    }
    expect("username").not.toMatch(SENSITIVE_AUTOCOMPLETE);
    for (const label of [
      "Password",
      "pwd",
      "OTP",
      "Verification code",
      "PIN",
      "Client secret",
      "API token",
    ]) {
      expect(label).toMatch(SENSITIVE_LABEL);
    }
    expect("Email").not.toMatch(SENSITIVE_LABEL);
  });

  it("type=password is sensitive", () => {
    expect(isSensitive(byBackend(30), new Set(), facts)).toBe(true);
    expect(isSensitiveField({ type: "password" }, "Anything")).toBe(true);
  });

  it("autocomplete current-password, new-password and one-time-code are sensitive", () => {
    expect(isSensitive(byBackend(31), new Set(), facts)).toBe(true);
    expect(isSensitive(byBackend(32), new Set(), facts)).toBe(true);
    expect(isSensitive(byBackend(40), new Set(), facts)).toBe(true);
  });

  it("a -webkit-text-security other than none is sensitive", () => {
    expect(isSensitive(byBackend(45), new Set(), facts)).toBe(true);
    for (const ts of ["disc", "circle", "square"]) {
      expect(isSensitiveField({ type: "text", textSecurity: ts }, "Field")).toBe(true);
    }
    expect(isSensitiveField({ type: "text", textSecurity: "none" }, "Field")).toBe(false);
  });

  it("a name, label or field name matching pass|pwd|otp|code|pin|secret|token is sensitive", () => {
    expect(isSensitive(byBackend(50), new Set(), facts)).toBe(true); // "Your PIN"
    expect(isSensitive(byBackend(55), new Set(), facts)).toBe(true); // name="pwd"
    expect(isSensitiveField({ type: "text", label: "Passphrase" }, "Field")).toBe(true);
    expect(isSensitiveField({ type: "text", attrId: "otp-input" }, "Field")).toBe(true);
    expect(isSensitiveField({ type: "text", placeholder: "Access token" }, "")).toBe(true);
  });

  it("any node in the human-typed marks is sensitive", () => {
    expect(isSensitive(byBackend(60), new Set(), facts)).toBe(false);
    expect(isSensitive(byBackend(60), new Set([60]), facts)).toBe(true);
    expect(isSensitive(byBackend(20), new Set([20]), facts)).toBe(true);
  });

  it("an ordinary search box or text field is not sensitive", () => {
    expect(isSensitive(byBackend(70), new Set(), facts)).toBe(false);
    expect(isSensitive(byBackend(20), new Set(), facts)).toBe(false);
  });

  it("defaults to redact on doubt: a text field whose type cannot be read is sensitive", () => {
    expect(isSensitive(byBackend(80), new Set(), facts)).toBe(true);
    expect(isSensitive(byBackend(80), new Set(), new Map())).toBe(true);
    expect(isSensitive(byBackend(70), new Set(), new Map())).toBe(true);
  });

  it("a button or link named like a password control carries no value and is not a field", () => {
    expect(isSensitive(byBackend(100), new Set(), facts)).toBe(false);
  });
});

describe("redact: serializeSnapshot", () => {
  it("replaces every sensitive value with [redacted] and marks the node redacted", () => {
    const result = snapshot();
    for (const id of [30, 31, 32, 40, 45, 50, 55, 80]) {
      const node = nodeOf(result, id);
      expect(node, `node ${id} is serialized`).toBeDefined();
      expect(node?.redacted, `node ${id} is redacted`).toBe(true);
      expect(node?.value, `node ${id} carries only [redacted]`).toBe(REDACTED);
    }
    const json = JSON.stringify(result);
    for (const secret of SECRETS) expect(json.includes(secret), `"${secret}" never appears`).toBe(false);
  });

  it("an ordinary search box and an untouched text field keep their values", () => {
    const result = snapshot();
    expect({ value: nodeOf(result, 70)?.value, redacted: nodeOf(result, 70)?.redacted }).toEqual({
      value: "invoices 2026",
      redacted: false,
    });
    expect(nodeOf(result, 60)?.value).toBe("Ana Lopez");
    expect(nodeOf(result, 20)?.value).toBe("ana@example.test");
  });

  it("a human-typed field is redacted, and so is the text inside it", () => {
    const result = snapshot(new Set([20, 60]));
    expect(nodeOf(result, 20)?.redacted).toBe(true);
    expect(nodeOf(result, 60)?.redacted).toBe(true);
    const json = JSON.stringify(result);
    expect(json.includes("ana@example.test")).toBe(false);
    expect(json.includes("Ana Lopez")).toBe(false);
  });

  it("never serializes what is inside a text field (its inner editor repeats the value)", () => {
    const result = snapshot();
    expect(nodeOf(result, 21)).toBeUndefined();
    expect(nodeOf(result, 22)).toBeUndefined();
    expect(result.nodes.filter((n) => n.name === "ana@example.test").length).toBe(0);
  });

  it("the text holds each node once with its ref, role and name", () => {
    const result = snapshot();
    const lines = result.text.split("\n").filter(Boolean);
    expect(lines.length).toBe(result.nodes.length);
    for (const node of result.nodes) {
      const mine = lines.filter((l) => l.includes(`[${node.ref}] `));
      expect(mine.length, `${node.ref} appears once`).toBe(1);
      expect(mine[0]?.includes(` ${node.role}`), `${node.ref} names its role`).toBe(true);
      if (node.name)
        expect(mine[0]?.includes(JSON.stringify(node.name)), `${node.ref} names itself`).toBe(true);
    }
    expect(result.text).toMatch(/\[e30\] textbox "Secret word" = \[redacted\]/);
    expect(result.text).toMatch(/\[e10\] heading "Sign in"/);
  });

  it("drops ignored nodes and inline text boxes but keeps their visible children", () => {
    const result = snapshot();
    expect(nodeOf(result, 25)).toBeUndefined();
    expect(result.nodes.some((n) => n.name === "Use your work account")).toBe(true);
    expect(result.nodes.filter((n) => n.role === "InlineTextBox").length).toBe(0);
    // A StaticText repeating its parent's name is not repeated.
    expect(result.nodes.filter((n) => n.name === "Sign in").length).toBe(1);
    expect(result.nodes.some((n) => n.role === "StaticText" && n.name === "Welcome back")).toBe(true);
  });

  it("links carry no value (an href can hold a token) and buttons stay actionable", () => {
    const result = snapshot();
    expect(nodeOf(result, 110)?.value).toBeNull();
    expect(JSON.stringify(result).includes("link-token-value")).toBe(false);
    expect(nodeOf(result, 100)?.role).toBe("button");
    expect(nodeOf(result, 100)?.redacted).toBe(false);
  });

  it("depth follows the tree; refs round-trip to backend node ids", () => {
    const result = snapshot();
    expect(nodeOf(result, 1)?.depth).toBe(0);
    expect(nodeOf(result, 10)?.depth).toBe(1);
    expect(backendIdFromRef(refFor(4242))).toBe(4242);
    expect(backendIdFromRef("x42")).toBeNull();
    expect(backendIdFromRef("e0042")).toBeNull();
    expect(backendIdFromRef("e")).toBeNull();
  });

  it("caps nodes, names and values, and says when it truncated", () => {
    const root: AXNode & { childIds: string[] } = {
      nodeId: "r",
      ignored: false,
      role: { value: "RootWebArea" },
      name: { value: "x" },
      childIds: [],
      backendDOMNodeId: 1,
    };
    const many: AXNode[] = [root];
    for (let i = 0; i < 700; i += 1) {
      root.childIds.push(`b${i}`);
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
    expect(result.nodes.length).toBe(600);
    expect(result.truncated).toBe(true);
    expect(result.nodes.every((n) => n.name.length <= 200)).toBe(true);
    expect(result.nodes.some((n) => n.name.length === 200)).toBe(true);
    expect(result.text.length <= 32_000).toBe(true);

    const small = serializeSnapshot(many, new Set(), new Map(), { maxNodes: 5000, maxText: 1000 });
    expect(small.text.length <= 1000).toBe(true);
    expect(small.truncated).toBe(true);
    expect(snapshot().truncated).toBe(false);
  });

  it("a cyclic or dangling child list cannot loop or crash", () => {
    const cyclic: AXNode[] = [
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
    expect(result.nodes.length).toBe(2);
  });
});

describe("redact: the Work Zone's three must-redact fields (07.13 D-04)", () => {
  it("a typed password, an OTP field and a field without facts serialize as [redacted]", () => {
    const tree: AXNode[] = [
      {
        nodeId: "r",
        role: { value: "RootWebArea" },
        name: { value: "Sign in" },
        childIds: ["p", "o", "u"],
        backendDOMNodeId: 1,
      },
      {
        nodeId: "p",
        role: { value: "textbox" },
        name: { value: "Account" },
        value: { value: "typed-pw-1" },
        backendDOMNodeId: 2,
      },
      {
        nodeId: "o",
        role: { value: "textbox" },
        name: { value: "Code" },
        value: { value: "112233" },
        backendDOMNodeId: 3,
      },
      {
        nodeId: "u",
        role: { value: "textbox" },
        name: { value: "Notes" },
        value: { value: "no-facts-value" },
        backendDOMNodeId: 4,
      },
    ];
    const known = new Map<number, FieldFacts>([
      [2, { tag: "input", type: "password" }],
      [3, { tag: "input", type: "text", autocomplete: "one-time-code" }],
    ]);
    const result = serializeSnapshot(tree, new Set(), known);
    for (const id of [2, 3, 4]) expect(nodeOf(result, id)?.value, `node ${id}`).toBe(REDACTED);
    const json = JSON.stringify(result);
    for (const secret of ["typed-pw-1", "112233", "no-facts-value"]) expect(json).not.toContain(secret);
  });
});
