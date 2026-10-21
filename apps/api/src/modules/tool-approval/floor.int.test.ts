import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { TestClient } from "../../testing";
import {
  approvalRow,
  callFor,
  clearRequests,
  clearRules,
  decideAs,
  type Fixture,
  type Json,
  ok,
  requiredId,
  seedTurn,
  setRule,
  startToolApprovalFixture,
  stopToolApprovalFixture,
  storedAction,
} from "../../testing-tool-approvals";

/**
 * The member-session floor of `approvalForCall` (07.8, D-11, D-13; 07.8-14 broken window 7, ADR-0029): an action that
 * runs with a member's own signed-in session is decided by that member alone. A 07.5 policy that applies keeps its
 * stricter mode, but its approvers (admins, unit leads, named people) never decide in the member's place and cannot
 * relax the floor. Without the floor, 07.5 is unchanged. Real PostgreSQL + Redis with the 07.2 primitive.
 */

let f: Fixture;

beforeAll(async () => {
  f = await startToolApprovalFixture();
}, 180_000);

afterAll(async () => {
  await stopToolApprovalFixture(f);
});

beforeEach(async () => {
  await clearRequests(f);
  await clearRules(f);
});

const view = async (who: TestClient, id: string) =>
  (await ok(who.request("GET", `/api/v1/approvals/${id}`))) as Json;

/** Each 07.5 approver kind that is not the requester. */
interface PolicyCase {
  name: "admins" | "unit_leads" | "users";
  rule: Omit<Parameters<typeof setRule>[1], "mode">;
  /** The person the policy would otherwise let decide. */
  other: TestClient;
}

const POLICIES = (): PolicyCase[] => [
  { name: "admins", rule: { approverKind: "admins" }, other: f.victor },
  { name: "unit_leads", rule: { approverKind: "unit_leads", scopeUnitId: f.sales }, other: f.marta },
  { name: "users", rule: { approverKind: "users", approverUserIds: [f.victorId] }, other: f.victor },
];

describe("the member-session floor: the requesting member alone decides, whatever the 07.5 policy says", () => {
  for (const name of ["admins", "unit_leads", "users"] as const) {
    it(`a \`${name}\` policy applies: the policy's approver cannot decide; only the member's approval is a grant`, async () => {
      const p = POLICIES().find((x) => x.name === name);
      if (!p) throw new Error(name);
      await setRule(f, { mode: "always", ...p.rule });
      const turn = await seedTurn(f);

      const first = await callFor(f, turn, { action: "click", signedIn: true }, { floor: "always" });
      expect(first).toMatchObject({
        kind: "required",
        created: true,
        waitingFor: "Waiting for Sam Lee to approve",
        requesterName: "Sam Lee",
      });
      const id = requiredId(first);
      expect((await storedAction(f, id)).requester_decides).toBe(true);

      // The policy's approver: not a decider, and the request does not even show to them.
      const refused = await decideAs(f, p.other, id, "approved");
      expect(refused.status).toBe(404);
      expect((await p.other.request("GET", `/api/v1/approvals/${id}`)).status).toBe(404);
      expect(await approvalRow(f, id)).toMatchObject({ status: "pending", decided_by: null });

      // Still waiting: the same call again is the same request, never a grant.
      const again = await seedTurn(f);
      expect(await callFor(f, again, { action: "click", signedIn: true }, { floor: "always" })).toMatchObject(
        {
          kind: "required",
          approvalId: id,
          created: false,
        },
      );

      // The member reads it as theirs to decide (the policy still shows, it set the mode) and approves.
      const v = await view(f.sam, id);
      expect(v.view.approverLabel).toBe("Waiting for Sam Lee to approve");
      expect(v.viewerCan).toEqual(["decide"]);
      const approved = await decideAs(f, f.sam, id, "approved");
      expect(approved.status, JSON.stringify(approved.body)).toBe(200);
      expect((await approvalRow(f, id)).decided_by).toBe(f.samId);

      const rerun = await seedTurn(f);
      expect(await callFor(f, rerun, { action: "click", signedIn: true }, { floor: "always" })).toEqual({
        kind: "grant",
        approvalId: id,
      });
    });
  }

  it("without the floor the same policies are unchanged: their approvers decide, the member alone cannot", async () => {
    for (const p of POLICIES()) {
      await clearRequests(f);
      await setRule(f, { mode: "always", ...p.rule });
      const turn = await seedTurn(f);
      const first = await callFor(f, turn, { action: "click", signedIn: false });
      expect(first.kind).toBe("required");
      const id = requiredId(first);
      expect((await storedAction(f, id)).requester_decides).toBe(false);
      expect((first as { waitingFor: string }).waitingFor).not.toBe("Waiting for Sam Lee to approve");
      const bySam = await decideAs(f, f.sam, id, "approved");
      expect(bySam.status, p.name).toBe(403);
      const byApprover = await decideAs(f, p.other, id, "approved");
      expect(byApprover.status, p.name).toBe(200);
      const rerun = await seedTurn(f);
      expect(await callFor(f, rerun, { action: "click", signedIn: false })).toEqual({
        kind: "grant",
        approvalId: id,
      });
    }
  });

  it("no policy: the floor still asks the member (07.8-14 behaviour kept)", async () => {
    const turn = await seedTurn(f);
    const first = await callFor(f, turn, { action: "type" }, { floor: "always" });
    expect(first).toMatchObject({ kind: "required", waitingFor: "Waiting for Sam Lee to approve" });
    expect((await decideAs(f, f.sam, requiredId(first), "approved")).status).toBe(200);
  });

  it("a grant the policy's approver gave without the floor never serves the same call under the floor (the floor is in the action hash)", async () => {
    await setRule(f, { mode: "always", approverKind: "admins" });
    const turn = await seedTurn(f);
    const plain = requiredId(await callFor(f, turn, { command: ["curl", "https://evil.example/x"] }));
    expect((await decideAs(f, f.victor, plain, "approved")).status).toBe(200);

    // The same arguments, now with the member's session loaded: a new request for the member, not the admin's grant.
    const rerun = await seedTurn(f);
    const floored = await callFor(
      f,
      rerun,
      { command: ["curl", "https://evil.example/x"] },
      { floor: "always" },
    );
    expect(floored).toMatchObject({
      kind: "required",
      created: true,
      waitingFor: "Waiting for Sam Lee to approve",
    });
    const flooredId = requiredId(floored);
    expect(flooredId).not.toBe(plain);
    expect(await approvalRow(f, plain)).toMatchObject({ status: "approved", consumed_at: null });
    expect((await approvalRow(f, flooredId)).action_hash).not.toBe((await approvalRow(f, plain)).action_hash);
  });
});
