import { describe, expect, it } from "vitest";
import { type ApprovalFacts, type PolicyRow, resolveToolApproval } from "./resolve";

/**
 * Strictest wins (Phase 07.5, D-01, P-04): the pure resolution of one (agent, human, tool). Units: Sales (S) with its
 * team Sales East (SE), Marketing (M). A rule applies on its unit's subtree, to the agent's unit or any of the human's.
 */

const S = "00000000-0000-4000-8000-000000000001";
const SE = "00000000-0000-4000-8000-000000000002";
const M = "00000000-0000-4000-8000-000000000003";
const PATH: Record<string, string[]> = { [S]: [S], [SE]: [S, SE], [M]: [M] };

const SAFE = "m1a2b3c4d";
const CREATE = `${SAFE}__create_invoice`;
const ALL = `${SAFE}__*`;

let seq = 0;
function rule(
  scopeUnitId: string | null,
  toolPattern: string,
  mode: PolicyRow["mode"],
  approverKind: PolicyRow["approverKind"] = "admins",
  id?: string,
): PolicyRow {
  seq += 1;
  return {
    id: id ?? `00000000-0000-4000-9000-${String(seq).padStart(12, "0")}`,
    scopeUnitId,
    scopePath: scopeUnitId ? (PATH[scopeUnitId] ?? []) : [],
    toolPattern,
    mode,
    approverKind,
    approverUserIds: [],
  };
}

const human = (...units: string[]): ApprovalFacts => ({
  agentUnitPath: null,
  humanUnitPaths: units.map((u) => PATH[u] ?? []),
});

describe("resolveToolApproval", () => {
  it("an organization `always` over the server beats a Sales `when_tainted` on one tool; the org rule's approvers", () => {
    const org = rule(null, ALL, "always", "admins");
    const sales = rule(S, CREATE, "when_tainted", "unit_leads");
    expect(resolveToolApproval([org, sales], human(S), CREATE)).toEqual({
      mode: "always",
      approverKind: "admins",
      approverUserIds: [],
      policyId: org.id,
      scopeUnitId: null,
      pattern: ALL,
    });
  });

  it("a Sales `always` tightens an organization `when_tainted`, with the Sales rule's approvers", () => {
    const org = rule(null, ALL, "when_tainted", "admins");
    const sales = rule(S, CREATE, "always", "unit_leads");
    expect(resolveToolApproval([org, sales], human(S), CREATE)).toMatchObject({
      mode: "always",
      approverKind: "unit_leads",
      policyId: sales.id,
      scopeUnitId: S,
      pattern: CREATE,
    });
  });

  it("an organization `never` resolves to `never` (it never blocks)", () => {
    const org = rule(null, CREATE, "never", "requester");
    expect(resolveToolApproval([org], human(), CREATE)).toMatchObject({ mode: "never", policyId: org.id });
  });

  it("no rule for the tool → null", () => {
    expect(
      resolveToolApproval([rule(null, `${SAFE}__list_invoices`, "always")], human(S), CREATE),
    ).toBeNull();
    expect(resolveToolApproval([rule(null, "m9999aaaa__*", "always")], human(S), CREATE)).toBeNull();
    expect(resolveToolApproval([], human(S), CREATE)).toBeNull();
  });

  it("a Sales rule does not apply when neither the agent's unit nor any of the human's units is under Sales", () => {
    const sales = rule(S, CREATE, "always");
    expect(
      resolveToolApproval([sales], { agentUnitPath: PATH[M] ?? [], humanUnitPaths: [[M]] }, CREATE),
    ).toBeNull();
    // A rule on the team does not reach a member of the department above it.
    expect(resolveToolApproval([rule(SE, CREATE, "always")], human(S), CREATE)).toBeNull();
  });

  it("a human in Sales and Marketing gets the strictest of both", () => {
    const sales = rule(S, CREATE, "when_tainted", "unit_leads");
    const mkt = rule(M, CREATE, "always", "unit_leads");
    expect(resolveToolApproval([sales, mkt], human(S, M), CREATE)).toMatchObject({
      mode: "always",
      policyId: mkt.id,
    });
  });

  it("the agent's unit under Sales brings the Sales rule in, even with a human outside Sales", () => {
    const sales = rule(S, CREATE, "always", "unit_leads");
    expect(
      resolveToolApproval([sales], { agentUnitPath: PATH[SE] ?? [], humanUnitPaths: [[M]] }, CREATE),
    ).toMatchObject({ mode: "always", policyId: sales.id });
  });

  it("two organization rules of the same mode: the exact name's approvers before the server pattern's", () => {
    const pattern = rule(null, ALL, "always", "admins", "00000000-0000-4000-9000-000000000001");
    const exact = rule(null, CREATE, "always", "requester", "00000000-0000-4000-9000-000000000999");
    expect(resolveToolApproval([pattern, exact], human(), CREATE)).toMatchObject({
      approverKind: "requester",
      policyId: exact.id,
    });
  });

  it("a deeper unit rule of the same mode never changes the approvers of the rule above it", () => {
    const org = rule(null, ALL, "always", "admins");
    const sales = rule(S, CREATE, "always", "unit_leads");
    const east = rule(SE, CREATE, "always", "requester");
    expect(resolveToolApproval([east, sales, org], human(SE), CREATE)).toMatchObject({
      approverKind: "admins",
      policyId: org.id,
    });
    expect(resolveToolApproval([east, sales], human(SE), CREATE)).toMatchObject({ policyId: sales.id });
  });

  it("the answer is identical for every input order", () => {
    const rows = [
      rule(null, ALL, "when_tainted", "admins"),
      rule(null, CREATE, "when_tainted", "requester"),
      rule(S, CREATE, "always", "unit_leads"),
      rule(M, ALL, "always", "unit_leads"),
      rule(SE, ALL, "always", "admins"),
      rule(null, `${SAFE}__list_invoices`, "always"),
    ];
    const facts = human(SE, M);
    const expected = resolveToolApproval(rows, facts, CREATE);
    expect(expected).toMatchObject({ mode: "always" });
    const permutations = (xs: PolicyRow[]): PolicyRow[][] =>
      xs.length <= 1
        ? [xs]
        : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p]));
    for (const p of permutations(rows)) expect(resolveToolApproval(p, facts, CREATE)).toEqual(expected);
  });
});
