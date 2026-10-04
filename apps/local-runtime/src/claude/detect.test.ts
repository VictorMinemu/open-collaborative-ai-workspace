import { describe, expect, it } from "vitest";
import { detectCodex } from "../codex/detect.js";
import { detectClaudeCode, type ExecFn } from "./detect.js";

function fakeExec(
  outputs: Record<string, { stdout?: string; stderr?: string; code: number | null }>,
): ExecFn {
  return async (_file, args) => {
    const o = outputs[args.join(" ")] ?? { code: null };
    return { stdout: o.stdout ?? "", stderr: o.stderr ?? "", code: o.code };
  };
}

describe("detectClaudeCode", () => {
  it("reports installed + version + subscription login from `claude auth status`", async () => {
    const exec = fakeExec({
      "--version": { stdout: "2.1.287 (Claude Code)\n", code: 0 },
      "auth status": {
        stdout: '{"loggedIn":true,"authMethod":"claude.ai","email":"x@example.com"}',
        code: 0,
      },
    });
    expect(await detectClaudeCode({ exec, env: {} })).toEqual({
      id: "claude-code",
      installed: true,
      version: "2.1.287",
      loggedIn: true,
    });
  });

  it("does not treat a stray ANTHROPIC_API_KEY as a login unless useApiKey is set", async () => {
    const exec = fakeExec({
      "--version": { stdout: "2.1.287", code: 0 },
      "auth status": { stdout: '{"loggedIn":false}', code: 1 },
    });
    expect((await detectClaudeCode({ exec, env: { ANTHROPIC_API_KEY: "k" } })).loggedIn).toBe(false);
    expect(
      (await detectClaudeCode({ exec, env: { ANTHROPIC_API_KEY: "k" }, useApiKey: true })).loggedIn,
    ).toBe(true);
  });

  it("reports not installed when the binary is missing", async () => {
    expect(await detectClaudeCode({ exec: fakeExec({}), env: {} })).toEqual({
      id: "claude-code",
      installed: false,
      version: null,
      loggedIn: false,
    });
  });
});

describe("detectCodex", () => {
  it("counts only the ChatGPT login by default", async () => {
    const chatgpt = fakeExec({
      "--version": { stdout: "codex-cli 0.160.0", code: 0 },
      "login status": { stderr: "Logged in using ChatGPT", code: 0 },
    });
    expect(await detectCodex({ exec: chatgpt })).toEqual({
      id: "codex",
      installed: true,
      version: "0.160.0",
      loggedIn: true,
    });
    const apikey = fakeExec({
      "--version": { stdout: "codex-cli 0.160.0", code: 0 },
      "login status": { stdout: "Logged in using an API key", code: 0 },
    });
    expect((await detectCodex({ exec: apikey })).loggedIn).toBe(false);
    expect((await detectCodex({ exec: apikey, useApiKey: true })).loggedIn).toBe(true);
  });
});
