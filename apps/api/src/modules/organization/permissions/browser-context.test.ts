import { describe, expect, it } from "vitest";
import { type BrowserContextFacts, browserContextResource, orgResource } from "./policy";
import { decide, type PrincipalFacts, type RuleFact } from "./resolve";

/**
 * 07.8-16 (D-06, D-07, D-11 F-5, D-12 U-2, P-08): who may watch a bot's browser page and who may take control, decided
 * by the resolver alone (07.4 N5). Pure: the facts a live view loads, the role grants and the 07.3 module rule.
 */

const person = (id = "u-1", orgRole: PrincipalFacts["orgRole"] = "standard"): PrincipalFacts => ({
  kind: "user",
  id,
  orgRole,
  deactivated: false,
  memberUnitPaths: [],
  leadOfUnitIds: new Set(),
});

const ctx = (f: Partial<BrowserContextFacts>) =>
  browserContextResource({ reader: false, botOwner: false, requester: false, memberSession: false, ...f });

const moduleOff: RuleFact = {
  id: "rule-browser-off",
  scopeUnitId: null,
  subjectKind: "everyone",
  subjectId: null,
  tool: null,
  pathPrefix: null,
  permission: "browser.*",
  effect: "deny",
};

const can = (p: PrincipalFacts, f: Partial<BrowserContextFacts>, rules: RuleFact[] = []) => ({
  watch: decide(p, ctx(f), rules, "browser.watch"),
  control: decide(p, ctx(f), rules, "browser.control"),
});

describe("browser.watch and browser.control on a browser context (resolver preconditions)", () => {
  it("a reader of the conversation watches; only the requester controls", () => {
    const reader = can(person(), { reader: true });
    expect(reader.watch.allowed).toBe(true);
    expect(reader.control).toMatchObject({ allowed: false, denial: { reason: "not_browser_requester" } });
    const requester = can(person(), { reader: true, requester: true });
    expect(requester.watch.allowed).toBe(true);
    expect(requester.control.allowed).toBe(true);
  });

  it("the bot's owner watches without reading the conversation; nobody else does", () => {
    expect(can(person(), { botOwner: true }).watch.allowed).toBe(true);
    const stranger = can(person("u-9", "admin"), {});
    expect(stranger.watch).toMatchObject({ allowed: false, denial: { reason: "not_conversation_reader" } });
    expect(stranger.control.allowed).toBe(false);
  });

  it("while a member's session is loaded only that member watches (U-2); others learn `member_session`", () => {
    const owner = can(person("owner"), { botOwner: true, memberSession: true });
    expect(owner.watch).toMatchObject({ allowed: false, denial: { reason: "member_session" } });
    const reader = can(person("ana"), { reader: true, memberSession: true });
    expect(reader.watch).toMatchObject({ allowed: false, denial: { reason: "member_session" } });
    const member = can(person("sam"), { reader: true, requester: true, memberSession: true });
    expect(member.watch.allowed).toBe(true);
    expect(member.control.allowed).toBe(true);
  });

  it("a requester who lost the conversation neither watches nor controls", () => {
    const lost = can(person(), { requester: true });
    expect(lost.watch.allowed).toBe(false);
    expect(lost.control).toMatchObject({ allowed: false, denial: { reason: "not_browser_watcher" } });
  });

  it("the Browser module turned off (07.3 deny `browser.*`) wins over every relation, at both scopes", () => {
    const off = can(person(), { reader: true, requester: true, botOwner: true }, [moduleOff]);
    expect(off.watch.allowed).toBe(false);
    expect(off.control.allowed).toBe(false);
    expect(decide(person(), orgResource(), [moduleOff], "browser.watch").allowed).toBe(false);
    expect(decide(person(), orgResource(), [], "browser.watch").allowed).toBe(true);
  });

  it("agents never watch or control a page", () => {
    const agent: PrincipalFacts = { ...person("a-1", null), kind: "agent" };
    const r = can(agent, { reader: true, requester: true, botOwner: true });
    expect(r.watch.allowed).toBe(false);
    expect(r.control.allowed).toBe(false);
  });
});
