import { CreateRecordTemplateRequest, type RecordTemplate } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  emptyDraft,
  type FieldDraft,
  fromTemplate,
  keyFromLabel,
  previewTitle,
  type TemplateDraft,
  toRequest,
  validateDraft,
} from "./record-template-form";

const RULE = "{prefix}-{seq:0000} · {field:customer} · {summary}";

const customer: FieldDraft = {
  id: "f1",
  label: "Customer",
  key: "customer",
  keyLocked: false,
  type: "text",
  required: true,
  options: [],
};

const caseFile = (patch: Partial<TemplateDraft> = {}): TemplateDraft => ({
  ...emptyDraft("00000000-0000-4000-8000-0000000000a1"),
  name: "Case file",
  prefix: "EXP",
  namingRule: RULE,
  fields: [customer],
  columns: [
    { id: "c1", name: "Intake", category: "backlog", defaultWaitingOn: null },
    { id: "c2", name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
    { id: "c3", name: "Closed", category: "done", defaultWaitingOn: null },
    { id: "c4", name: "Dropped", category: "cancelled", defaultWaitingOn: null },
  ],
  ...patch,
});

describe("keyFromLabel", () => {
  it("turns a label into a field key", () => {
    expect(keyFromLabel("Customer name")).toBe("customer_name");
    expect(keyFromLabel("  Número de pedido ")).toBe("numero_de_pedido");
  });

  it("always starts with a letter and stays a valid key", () => {
    const key = keyFromLabel("2nd ref");
    expect(key).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    expect(key).toContain("2nd_ref");
    expect(keyFromLabel("")).toMatch(/^[a-z][a-z0-9_]{0,39}$/);
    expect(keyFromLabel("x".repeat(80))).toHaveLength(40);
  });
});

describe("previewTitle", () => {
  it("renders the rule with card number 1 and the given sample", () => {
    expect(previewTitle(caseFile(), { fields: { customer: "Acme" }, summary: "Broken pump" })).toBe(
      "EXP-0001 · Acme · Broken pump",
    );
  });

  it("uses each field's label and Summary by default", () => {
    expect(previewTitle(caseFile())).toBe("EXP-0001 · Customer · Summary");
  });

  it("is the summary without a rule, and never numbers a board without a prefix", () => {
    expect(previewTitle(caseFile({ namingRule: "" }))).toBe("Summary");
    expect(previewTitle(caseFile({ prefix: "", namingRule: "{seq} {summary}" }))).toBe("Summary");
  });
});

describe("validateDraft", () => {
  it("accepts the Case file", () => {
    expect(validateDraft(caseFile())).toEqual({});
  });

  it("reports a lowercase prefix on the prefix", () => {
    expect(validateDraft(caseFile({ prefix: "exp" })).prefix).toBe("Use 1–8 capital letters or digits");
  });

  it("reports an unknown field token on the rule", () => {
    expect(validateDraft(caseFile({ namingRule: "{field:missing} {summary}" })).namingRule).toBe(
      "No field with key “missing”",
    );
  });

  it("reports an unknown token on the rule", () => {
    expect(validateDraft(caseFile({ namingRule: "{nope}" })).namingRule).toBe(
      "Unknown token {nope}. Use {prefix}, {seq}, {seq:0000}, {summary} or {field:key}",
    );
  });

  it("reports duplicate column names on the repeated column", () => {
    const d = caseFile();
    const columns = [
      ...d.columns,
      { id: "c5", name: "closed", category: "done" as const, defaultWaitingOn: null },
    ];
    const errors = validateDraft({ ...d, columns });
    expect(errors["columns.4.name"]).toBe("Column names must be unique");
  });

  it("reports a missing name", () => {
    expect(validateDraft(caseFile({ name: "  " })).name).toBe("Give the template a name");
  });
});

describe("toRequest / fromTemplate", () => {
  const template: RecordTemplate = {
    id: "00000000-0000-4000-8000-000000000001",
    unitId: "00000000-0000-4000-8000-000000000002",
    name: "Case file",
    description: "Customer cases",
    prefix: "EXP",
    namingRule: RULE,
    fields: [
      { key: "customer", label: "Customer", type: "text", required: true },
      { key: "priority", label: "Priority", type: "select", required: false, options: ["Low", "High"] },
    ],
    columns: [
      { name: "Intake", category: "backlog", defaultWaitingOn: null },
      { name: "Waiting for customer", category: "started", defaultWaitingOn: "customer" },
    ],
    version: 3,
    createdAt: "2026-10-12T09:00:00.000Z",
    updatedAt: "2026-10-12T09:00:00.000Z",
  };

  it("round-trips a template", () => {
    const req = toRequest(fromTemplate(template));
    expect(req).toEqual({
      unitId: template.unitId,
      name: template.name,
      description: template.description,
      prefix: template.prefix,
      namingRule: template.namingRule,
      fields: template.fields,
      columns: template.columns,
    });
    expect(CreateRecordTemplateRequest.safeParse(req).success).toBe(true);
  });

  it("keeps the keys of saved fields when their label changes", () => {
    const draft = fromTemplate(template);
    expect(draft.fields.every((f) => f.keyLocked)).toBe(true);
  });

  it("sends empty prefix and rule as null", () => {
    const req = toRequest(caseFile({ prefix: "", namingRule: "  " }));
    expect(req.prefix).toBeNull();
    expect(req.namingRule).toBeNull();
  });
});
