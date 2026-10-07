import { describe, expect, it } from "vitest";
import { parsePlanCatalog } from "./catalog";

describe("parsePlanCatalog", () => {
  it("reads the documented SIWC shape: a top-level models array, visibility list only", () => {
    // developers.openai.com/siwc/token-sharing-open-source/models-and-inference: `.models[] | select(.visibility == "list")`
    expect(
      parsePlanCatalog({
        models: [
          { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list" },
          {
            slug: "gpt-6-luna",
            display_name: "GPT-6 Luna",
            visibility: "list",
            input_modalities: ["Text", "image"],
          },
          { slug: "gpt-internal", visibility: "hide" },
        ],
      }),
    ).toEqual([
      { slug: "gpt-6-astra", label: "GPT-6 Astra" },
      { slug: "gpt-6-luna", label: "GPT-6 Luna", inputModalities: ["text", "image"] },
    ]);
  });

  it("still reads a data array", () => {
    expect(parsePlanCatalog({ data: [{ id: "gpt-6-astra" }] })).toEqual([
      { slug: "gpt-6-astra", label: "gpt-6-astra" },
    ]);
  });

  it("returns an empty list for an unknown shape", () => {
    expect(parsePlanCatalog({ items: [{ slug: "x" }] })).toEqual([]);
    expect(parsePlanCatalog(null)).toEqual([]);
  });
});
