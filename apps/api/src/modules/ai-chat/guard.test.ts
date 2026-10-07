import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

/**
 * Static guard (P-04, P-05, T-05-02-08): prompts are built only by `buildModelMessages`, models only by the model
 * gateway. `streamText` / `generateText` are imported from "ai" only in `ai-chat/run-loop.ts` and
 * `ai-chat/titles.ts` (05-10), and each of those reaches `buildModelMessages(` (directly or through `turn.ts`);
 * `@ai-sdk/*` is imported only under `modules/model-gateway/`; nothing uses the Vercel AI Gateway
 * (`@ai-sdk/gateway`, `createGateway`, `gateway` from "ai"), and no API file hands the SDK a "provider/model"
 * string, which would route through that metered gateway.
 */

const ROOT = fileURLToPath(new URL("../../../../../", import.meta.url));
const API = join(ROOT, "apps/api/src");
const SELF = "apps/api/src/modules/ai-chat/guard.test.ts";
const MODEL_CALLERS = new Set([
  "apps/api/src/modules/ai-chat/run-loop.ts",
  "apps/api/src/modules/ai-chat/titles.ts",
]);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const rel = (file: string) => relative(ROOT, file).split("\\").join("/");
const files = () => walk(API).filter((f) => rel(f) !== SELF);
const sourceFiles = () => files().filter((f) => !f.endsWith(".test.ts"));
const read = (file: string) => readFileSync(file, "utf8");

/** Names imported from module `mod` (named imports, any line layout), plus "*" for a namespace import. */
export function importedNames(code: string, mod: string): string[] {
  const esc = mod.replace(/[.*+?^${}()|[\]\\/]/gu, "\\$&");
  const names: string[] = [];
  for (const m of code.matchAll(
    new RegExp(`import\\s+(type\\s+)?\\{([^}]*)\\}\\s*from\\s*["']${esc}["']`, "gu"),
  )) {
    if (m[1]) continue; // type-only imports cannot call anything
    for (const part of (m[2] ?? "").split(",")) {
      const name = part
        .trim()
        .replace(/^type\s+/u, "")
        .split(/\s+as\s+/u)[0]
        ?.trim();
      if (name && !part.trim().startsWith("type ")) names.push(name);
    }
  }
  if (new RegExp(`import\\s+\\*\\s+as\\s+\\w+\\s+from\\s*["']${esc}["']`, "u").test(code)) names.push("*");
  if (new RegExp(`import\\(\\s*["']${esc}["']\\s*\\)`, "u").test(code)) names.push("*");
  return names;
}

const MODEL_CALLS = new Set(["streamText", "generateText", "*"]);
const IMPORTS_AI_SDK = /from\s*["']@ai-sdk\/|import\(\s*["']@ai-sdk\//u;
const VERCEL_GATEWAY = /@ai-sdk\/gateway|\bcreateGateway\b/u;
/** `model: "openai/gpt-…"` or `streamText("anthropic/…")`-style string model ids. */
const STRING_MODEL = /\bmodel\s*:\s*["'`][a-z0-9.-]+\/[^"'`\s]+["'`]/u;

describe("the guard's own patterns", () => {
  it("find named, aliased, multi-line and namespace imports, and skip type-only ones", () => {
    expect(importedNames(`import { streamText } from "ai";`, "ai")).toEqual(["streamText"]);
    expect(importedNames(`import {\n  type ModelMessage,\n  generateText as g,\n} from "ai";`, "ai")).toEqual(
      ["generateText"],
    );
    expect(importedNames(`import type { LanguageModel } from "ai";`, "ai")).toEqual([]);
    expect(importedNames(`import * as sdk from "ai";`, "ai")).toEqual(["*"]);
    expect(STRING_MODEL.test(`streamText({ model: "openai/gpt-6-astra", messages })`)).toBe(true);
    expect(STRING_MODEL.test(`model: resolved.model,`)).toBe(false);
    expect(IMPORTS_AI_SDK.test(`import { createOpenAI } from "@ai-sdk/openai";`)).toBe(true);
  });
});

describe("prompts and models stay behind their one door (P-04, P-05)", () => {
  it("only run-loop.ts and titles.ts import streamText / generateText from ai", () => {
    const offenders = sourceFiles()
      .filter((f) => importedNames(read(f), "ai").some((n) => MODEL_CALLS.has(n)))
      .map(rel)
      .filter((r) => !MODEL_CALLERS.has(r));
    expect(offenders).toEqual([]);
    // Tests may not sneak a model call in either.
    const testOffenders = files()
      .filter((f) => f.endsWith(".test.ts"))
      .filter((f) => importedNames(read(f), "ai").some((n) => n === "streamText" || n === "generateText"))
      .map(rel);
    expect(testOffenders).toEqual([]);
  });

  it("every model caller reaches buildModelMessages( directly or through turn.ts", () => {
    const callers = sourceFiles().filter((f) =>
      importedNames(read(f), "ai").some((n) => n === "streamText" || n === "generateText"),
    );
    expect(callers.map(rel)).toContain("apps/api/src/modules/ai-chat/run-loop.ts");
    const turn = read(join(API, "modules/ai-chat/turn.ts"));
    expect(turn).toContain("buildModelMessages(");
    for (const f of callers) {
      const code = read(f);
      const direct = code.includes("buildModelMessages(");
      const viaTurn = /from\s*["']\.\/turn["']/u.test(code) && /\bloadTurn\(/u.test(code);
      expect(direct || viaTurn, rel(f)).toBe(true);
    }
  });

  it("no file outside modules/model-gateway/ imports @ai-sdk/*", () => {
    const offenders = files()
      .filter((f) => !rel(f).startsWith("apps/api/src/modules/model-gateway/"))
      .filter((f) => IMPORTS_AI_SDK.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("nothing uses the Vercel AI Gateway", () => {
    const offenders = files()
      .filter((f) => VERCEL_GATEWAY.test(read(f)) || importedNames(read(f), "ai").includes("gateway"))
      .map(rel);
    expect(offenders).toEqual([]);
  });

  it("no API file passes a provider/model string as a model", () => {
    const offenders = sourceFiles()
      .filter((f) => STRING_MODEL.test(read(f)))
      .map(rel);
    expect(offenders).toEqual([]);
  });
});

/** Code lines only: `//` lines and the inside of block comments are ignored. */
export function codeLines(code: string): string {
  return code
    .replace(/\/\*[\s\S]*?\*\//gu, "")
    .split("\n")
    .filter((l) => !l.trim().startsWith("//"))
    .join("\n");
}

/**
 * A template literal that prints a name-like value, a colon and then the body: `${author.name}: ${r.body}` (with or
 * without a newline between). AGENTS.md: participant identity is structural, never a plain-text `Name:` prefix.
 */
const NAME_COLON_BODY =
  /\$\{[^}]*\b(?:name|Name|displayName|author|from|who|sender)\w*\b[^}]*\}\s*:\s*(?:\\n)?\s*\$\{[^}]*\b(?:body|text|content|message)\w*\b[^}]*\}/u;
/** A message object with the system role: `role: "system"`. */
const SYSTEM_ROLE_MESSAGE = /\brole\s*:\s*["'`]system["'`]/u;

describe("participant identity stays structural (06-05, AGENTS.md, D-04)", () => {
  const AI_CHAT = join(API, "modules/ai-chat");
  const BUILDER = "apps/api/src/modules/ai-chat/build-model-messages.ts";

  it("the patterns catch what they must and nothing else", () => {
    // Source snippets are written with `#{` for `${` so they stay plain strings here.
    const src = (s: string) => s.replaceAll("#{", "$" + "{");
    expect(NAME_COLON_BODY.test(src("`#{author.name}: #{r.body}`"))).toBe(true);
    expect(NAME_COLON_BODY.test(src("`#{promptName(a.name)}:\\n#{neutralise(r.body)}`"))).toBe(true);
    expect(NAME_COLON_BODY.test(src("`#{displayName}: #{text}`"))).toBe(true);
    expect(
      NAME_COLON_BODY.test(src('`<message from="#{promptName(a.name)}">\\n#{neutralise(r.body)}`')),
    ).toBe(false);
    expect(NAME_COLON_BODY.test(src("`#{label} (user-authored preferences: follow them`"))).toBe(false);
    expect(SYSTEM_ROLE_MESSAGE.test('{ role: "system", content: x }')).toBe(true);
    expect(SYSTEM_ROLE_MESSAGE.test('m.role === "system"')).toBe(false);
    expect(codeLines('// role: "system"\n/* role: "system" */\nconst a = 1;')).not.toMatch(
      SYSTEM_ROLE_MESSAGE,
    );
  });

  it("build-model-messages.ts has no template that prints a name, a colon and a body", () => {
    expect(codeLines(read(join(ROOT, BUILDER)))).not.toMatch(NAME_COLON_BODY);
  });

  it("no file under modules/ai-chat/ other than build-model-messages.ts builds a system-role message", () => {
    const offenders = walk(AI_CHAT)
      .map(rel)
      .filter((r) => r !== BUILDER && r !== SELF)
      .filter((r) => SYSTEM_ROLE_MESSAGE.test(codeLines(read(join(ROOT, r)))));
    expect(offenders).toEqual([]);
  });
});
