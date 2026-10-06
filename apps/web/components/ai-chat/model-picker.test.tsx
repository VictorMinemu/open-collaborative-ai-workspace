import { type AiModelOption, type ModelRef, modelRefKey } from "@ocw/contracts";
import { isValidElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { ModelPickerList, reasonText } from "./model-picker";

/**
 * The AI chat model picker's list (05-04, P-11): grouped "Your ChatGPT plan" / "Organization models" / "Testing",
 * every organization row METERED, unavailable rows disabled with the reason in plain words. Static markup in node.
 */

const caps = { vision: true, pdf: false, webSearch: "hosted" } as const;

function option(ref: ModelRef, extra: Partial<AiModelOption> = {}): AiModelOption {
  const group = ref.backend === "chatgpt_plan" ? "chatgpt_plan" : ref.backend === "org_key" ? "organization" : "mock";
  return {
    ref,
    label: ref.modelId,
    providerLabel: group === "chatgpt_plan" ? "ChatGPT plan" : group === "mock" ? "Mock" : "Anthropic",
    group,
    metered: ref.backend === "org_key",
    caps,
    available: true,
    reason: null,
    isDefault: false,
    ...extra,
  };
}

const ASTRA: ModelRef = { backend: "chatgpt_plan", provider: "openai", modelId: "gpt-6-astra" };
const SONNET: ModelRef = { backend: "org_key", provider: "anthropic", modelId: "claude-sonnet-5-5" };
const HAIKU: ModelRef = { backend: "org_key", provider: "anthropic", modelId: "claude-haiku-4-5" };
const MOCK: ModelRef = { backend: "mock", provider: "mock", modelId: "mock-1" };

// Deliberately out of order: the picker groups them itself.
const MODELS: AiModelOption[] = [
  option(MOCK, { label: "Mock (E2E)" }),
  option(SONNET, { label: "Claude Sonnet 5.5" }),
  option(ASTRA, { label: "GPT-6 Astra", isDefault: true }),
  option(HAIKU, { label: "Claude Haiku 4.5", available: false, reason: "not_allowed" }),
];

const render = (models: AiModelOption[], value: ModelRef | null = ASTRA) =>
  renderToStaticMarkup(<ModelPickerList models={models} value={value} onChange={() => {}} />);

/** Every element of a rendered tree (host and component elements), depth first. */
function elements(node: ReactNode, out: Array<{ props: Record<string, unknown> }> = []) {
  if (Array.isArray(node)) for (const n of node) elements(n, out);
  else if (isValidElement(node)) {
    const props = node.props as Record<string, unknown>;
    out.push({ props });
    elements(props.children as ReactNode, out);
  }
  return out;
}

describe("ModelPickerList", () => {
  it("renders the groups in order: Your ChatGPT plan, Organization models, Testing", () => {
    const html = render(MODELS);
    const plan = html.indexOf("Your ChatGPT plan");
    const org = html.indexOf("Organization models");
    const testing = html.indexOf("Testing");
    expect(plan).toBeGreaterThanOrEqual(0);
    expect(org).toBeGreaterThan(plan);
    expect(testing).toBeGreaterThan(org);
    expect(html).toContain("METERED · billed to your organization");
    // Rows sit under their own group header.
    expect(html.indexOf("GPT-6 Astra")).toBeGreaterThan(plan);
    expect(html.indexOf("GPT-6 Astra")).toBeLessThan(org);
    expect(html.indexOf("Claude Sonnet 5.5")).toBeGreaterThan(org);
    expect(html.indexOf("Mock (E2E)")).toBeGreaterThan(testing);
  });

  it("every organization row carries a METERED badge and the plan and mock rows do not", () => {
    const html = render(MODELS);
    const badges = html.match(/data-testid="ai-model-metered"/g) ?? [];
    expect(badges).toHaveLength(2);
    const rowOf = (ref: ModelRef) => {
      const start = html.indexOf(`data-testid="ai-model-${modelRefKey(ref)}"`);
      expect(start).toBeGreaterThanOrEqual(0);
      const end = html.indexOf("</button>", start);
      return html.slice(start, end);
    };
    expect(rowOf(SONNET)).toContain("METERED");
    expect(rowOf(HAIKU)).toContain("METERED");
    expect(rowOf(ASTRA)).not.toContain("METERED");
    expect(rowOf(MOCK)).not.toContain("METERED");
    expect(rowOf(MOCK)).toContain("not metered");
  });

  it("unavailable rows are disabled and say why in plain words", () => {
    const html = render(MODELS);
    const start = html.indexOf(`data-testid="ai-model-${modelRefKey(HAIKU)}"`);
    const row = html.slice(html.lastIndexOf("<button", start), html.indexOf("</button>", start));
    expect(row).toContain('aria-disabled="true"');
    expect(row).toContain("Not allowed by your admin");
    expect(reasonText("no_key")).toBe("Provider not configured");
    expect(reasonText("org_keys_disabled")).toBe("Turned off by your admin");
    expect(reasonText("not_in_catalog")).toBe("Not in your plan");
    expect(reasonText("not_connected")).toBe("Not connected");
  });

  it("a member without a connected plan sees one disabled plan row: Not connected", () => {
    const html = render(
      [
        option(
          { backend: "chatgpt_plan", provider: "openai", modelId: "chatgpt" },
          { label: "ChatGPT", available: false, reason: "not_connected" },
        ),
        option(SONNET, { label: "Claude Sonnet 5.5" }),
      ],
      SONNET,
    );
    expect(html).toContain("Your ChatGPT plan");
    expect(html).toContain("Not connected");
    expect(html).not.toContain("Testing");
  });

  it("choosing an available row calls onChange with its ModelRef; a disabled row does not", () => {
    const onChange = vi.fn();
    const tree = ModelPickerList({ models: MODELS, value: ASTRA, onChange });
    const all = elements(tree);
    const button = (ref: ModelRef) =>
      all.find((e) => e.props["data-testid"] === `ai-model-${modelRefKey(ref)}`)?.props as
        | { onClick: () => void }
        | undefined;
    expect(button(SONNET)).toBeDefined();
    button(SONNET)?.onClick();
    expect(onChange).toHaveBeenCalledWith(SONNET);
    button(HAIKU)?.onClick();
    expect(onChange).toHaveBeenCalledTimes(1);
  });
});
