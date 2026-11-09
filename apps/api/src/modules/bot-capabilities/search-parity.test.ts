import { describe, expect, it } from "vitest";
import { loadEnv } from "../../config/env";
import { searchProvidersFor } from "./policy";

/**
 * API ↔ cell parity for the bundled search plugins. Compose hands the SAME `OCW_BUNDLED_PLUGINS` and `OCW_SEARXNG_URL`
 * (often `${VAR:-}`, i.e. empty) to the api and openclaw services. The API decides whether Internet is `configured`
 * from them (availableSearchProviders); the cell decides which search plugins it loads (render-config.mjs). If they
 * read one value differently, bots show "Not set up yet" while the cell can search, or offer a search it cannot run.
 */
describe("bundled search plugins: API ↔ cell parity (render-config.mjs)", () => {
  // Non-literal specifier: the cell's config renderer lives outside this package and is not type-checked from here.
  const renderConfigPath = new URL("../../../../../infra/openclaw/render-config.mjs", import.meta.url).href;
  const base = {
    DATABASE_URL: "postgres://app:x@localhost:5432/ocw",
    AUTH_DATABASE_URL: "postgres://auth:x@localhost:5432/ocw",
    REDIS_URL: "redis://localhost:6379",
    BETTER_AUTH_SECRET: "b".repeat(32),
    OCW_SETUP_TOKEN: "s".repeat(16),
    OCW_ENCRYPTION_KEY: "a".repeat(64),
  };
  const cellBase = { OCW_API_URL: "http://api:4000", OCW_CELL_TOKEN_FILE: "/run/secrets/ocw_cell_token" };
  const bundledValues = [
    undefined,
    "",
    "   ",
    "none",
    "duckduckgo",
    "searxng",
    "duckduckgo,searxng",
    " DuckDuckGo , SEARXNG ",
  ];
  const searxngUrls = [undefined, "", "http://searxng:8080"];

  it("for every compose value (unset, empty, none, lists) the API offers exactly the providers the cell loads", async () => {
    type Rendered = {
      config: { plugins: { allow: string[]; entries: Record<string, unknown> } };
      errors: string[];
    };
    const { renderConfig } = (await import(renderConfigPath)) as {
      renderConfig: (env: Record<string, string | undefined>) => Rendered;
    };
    for (const bundled of bundledValues) {
      for (const url of searxngUrls) {
        const vars = { OCW_BUNDLED_PLUGINS: bundled, OCW_SEARXNG_URL: url };
        const defined = Object.fromEntries(Object.entries(vars).filter(([, v]) => v !== undefined));

        const api = [...searchProvidersFor(loadEnv({ ...base, ...defined }))].sort();

        const { config, errors } = renderConfig({ ...cellBase, ...defined });
        expect(errors).toEqual([]);
        const cell = [
          ...(config.plugins.allow.includes("duckduckgo") ? ["duckduckgo"] : []),
          // The cell only configures SearXNG with a base URL; without one the plugin loads but cannot search.
          ...(config.plugins.entries.searxng ? ["searxng"] : []),
        ].sort();

        expect({ vars, providers: api }).toEqual({ vars, providers: cell });
      }
    }
  });

  it("compose's empty OCW_BUNDLED_PLUGINS offers DuckDuckGo (the self-hosted default)", () => {
    expect([...searchProvidersFor(loadEnv({ ...base, OCW_BUNDLED_PLUGINS: "" }))]).toEqual(["duckduckgo"]);
  });
});
