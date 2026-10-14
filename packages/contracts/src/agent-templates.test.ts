import { describe, expect, it } from "vitest";
import {
  AgentTemplate,
  AgentTemplateLink,
  AgentTemplateList,
  AgentTemplateOptions,
  AgentTemplatePreview,
  AgentTemplateUpdate,
  ApplyAgentTemplateUpdateRequest,
  CreateAgentTemplateRequest,
  InstantiateAgentTemplateResponse,
  PublishAgentTemplateVersionRequest,
  UpdateAgentTemplateRequest,
} from "./index";

const ID = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b";
const ID2 = "0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c";
const NOW = "2026-10-13T10:00:00.000Z";

const body = {
  instructions: "You help the sales team with the CRM.",
  modelProvider: "anthropic",
  modelId: "claude-sonnet-5-5",
  capabilities: { internet: false, memory: true, dailyLimit: null },
  toolGrants: [{ sourceKind: "mcp", sourceId: ID, toolName: "whoami" }],
  requiredConnectorIds: [ID],
  unitVaultItemIds: [],
};

const template = {
  id: ID,
  unitId: ID2,
  unitName: "Sales",
  name: "CRM helper",
  description: "Answers questions with your CRM account",
  currentVersion: 2,
  archivedAt: null,
  latest: { ...body, templateId: ID, version: 2, createdAt: NOW, createdBy: ID2, createdByName: "Dana" },
  canManage: true,
  requiredConnectors: [{ serverId: ID, name: "Acme CRM" }],
};

const agent = {
  id: ID2,
  organizationId: ID,
  name: "Sam's CRM helper",
  username: "sams-crm-helper",
  avatarUrl: null,
  description: null,
  instructions: body.instructions,
  modelProvider: "anthropic",
  modelId: "claude-sonnet-5-5",
  runtime: "openclaw",
  status: "ready",
  statusMessage: null,
  createdBy: ID,
  createdAt: NOW,
  updatedAt: NOW,
  scope: "personal",
  ownerUserId: ID,
};

describe("agent templates (07.4 D-05, CONN-06)", () => {
  it("a version body is bounded: 64 tool grants, 16 connectors, 16 unit keys", () => {
    expect(PublishAgentTemplateVersionRequest.parse(body)).toEqual(body);
    const grants = Array.from({ length: 65 }, () => body.toolGrants[0]);
    expect(PublishAgentTemplateVersionRequest.safeParse({ ...body, toolGrants: grants }).success).toBe(false);
    expect(
      PublishAgentTemplateVersionRequest.safeParse({ ...body, requiredConnectorIds: Array(17).fill(ID) })
        .success,
    ).toBe(false);
    expect(
      PublishAgentTemplateVersionRequest.safeParse({ ...body, unitVaultItemIds: Array(17).fill(ID) }).success,
    ).toBe(false);
    expect(PublishAgentTemplateVersionRequest.safeParse({ ...body, instructions: "  " }).success).toBe(false);
    expect(
      PublishAgentTemplateVersionRequest.safeParse({
        ...body,
        toolGrants: [{ ...body.toolGrants[0], sourceKind: "x" }],
      }).success,
    ).toBe(false);
  });

  it("an organization template has unitId null", () => {
    expect(CreateAgentTemplateRequest.parse({ unitId: null, name: "Helper", version: body })).toMatchObject({
      unitId: null,
      description: "",
    });
    expect(CreateAgentTemplateRequest.safeParse({ unitId: null, name: "", version: body }).success).toBe(
      false,
    );
    expect(UpdateAgentTemplateRequest.parse({ archived: true })).toEqual({ archived: true });
  });

  it("a template carries its latest version, the caller's rights and the needed connector names", () => {
    expect(AgentTemplate.parse(template)).toEqual(template);
    expect(
      AgentTemplateList.parse({ templates: [template], manageableUnits: [{ unitId: null, name: "Org" }] })
        .templates,
    ).toHaveLength(1);
    expect(AgentTemplate.safeParse({ ...template, requiredConnectors: undefined }).success).toBe(false);
  });

  it("instantiation returns the agent, its DM and what was left out", () => {
    const preview = {
      skipped: [
        { kind: "model", id: "claude-opus-5-5", reason: "model_not_allowed" },
        { kind: "capability", id: "dailyLimit", reason: "clamped" },
      ],
      requiredConnectors: [{ serverId: ID, name: "Acme CRM", status: "not_connected" }],
      capReached: false,
      limit: 3,
    };
    expect(AgentTemplatePreview.parse(preview)).toEqual(preview);
    const res = InstantiateAgentTemplateResponse.parse({ ...preview, agent, dmConversationId: ID });
    expect(res.agent.scope).toBe("personal");
    expect(
      AgentTemplatePreview.safeParse({ ...preview, skipped: [{ kind: "tool", id: "x", reason: "because" }] })
        .success,
    ).toBe(false);
  });

  it("an update lists only the template-owned fields it changes", () => {
    expect(
      AgentTemplateUpdate.parse({ from: 1, to: 3, changedFields: ["instructions", "vaultItems"] }),
    ).toEqual({
      from: 1,
      to: 3,
      changedFields: ["instructions", "vaultItems"],
    });
    expect(AgentTemplateUpdate.safeParse({ from: 1, to: 3, changedFields: ["name"] }).success).toBe(false);
    expect(ApplyAgentTemplateUpdateRequest.safeParse({ toVersion: 0 }).success).toBe(false);
  });

  it("an agent's template link shows the owner's connection per required connector", () => {
    const link = {
      templateId: ID,
      templateName: "CRM helper",
      version: 1,
      latestVersion: 2,
      update: { from: 1, to: 2, changedFields: ["model"] },
      requiredConnectors: [{ serverId: ID, name: "Acme CRM", status: "needs_reconnect" }],
    };
    expect(AgentTemplateLink.parse(link)).toEqual(link);
    expect(
      AgentTemplateLink.safeParse({ ...link, requiredConnectors: [{ serverId: ID, name: "Acme CRM" }] })
        .success,
    ).toBe(false);
  });

  it("the editor options list tools, connectors and unit keys", () => {
    expect(
      AgentTemplateOptions.parse({
        tools: [
          {
            sourceKind: "mcp",
            sourceId: ID,
            sourceName: "Acme CRM",
            toolName: "whoami",
            personalAllowed: true,
          },
        ],
        connectors: [{ serverId: ID, name: "Acme CRM" }],
        vaultItems: [{ id: ID2, name: "ERP", handle: "k_abcdefgh23" }],
      }).tools,
    ).toHaveLength(1);
  });
});
