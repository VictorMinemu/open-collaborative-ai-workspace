import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertOffline, isLoopbackUrl, OFFLINE_DIR_KEYS, offlineRecorderEnv } from "./offline-env.js";

const APP = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const TSX = join(APP, "node_modules", ".bin", "tsx");
const FAKE = "http://127.0.0.1:18999";

const under = (child: string, parent: string) => {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !rel.startsWith("/"));
};

describe("offlineRecorderEnv", () => {
  const tmp = join(tmpdir(), "ocw-offline-unit");
  const caller = {
    HOME: "/home/caller",
    PATH: "/usr/bin",
    OPENAI_API_KEY: "sk-canary-openai",
    ANTHROPIC_API_KEY: "sk-ant-canary",
    CODEX_API_KEY: "canary-codex",
    ANTHROPIC_AUTH_TOKEN: "canary-auth",
    CLAUDE_CODE_OAUTH_TOKEN: "canary-oauth",
    CODEX_HOME: "/home/caller/.codex",
    CLAUDE_CONFIG_DIR: "/home/caller/.claude",
    XDG_CONFIG_HOME: "/home/caller/.config",
    SOME_SECRET: "canary-other",
  };

  it("puts every home and config dir under tmp and keeps only fake credentials", () => {
    const env = offlineRecorderEnv({ env: caller, tmp, fakeUrl: FAKE });
    for (const key of OFFLINE_DIR_KEYS) expect(under(env[key] as string, tmp), key).toBe(true);
    expect(env.ANTHROPIC_API_KEY).toBe("ocw-fake-key");
    expect(env.OCW_FAKE_MODEL_KEY).toBe("fake");
    expect(env.ANTHROPIC_BASE_URL).toBe(FAKE);
    expect(env.OPENAI_BASE_URL).toBe(`${FAKE}/v1`);
    expect(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC).toBe("1");
    expect(env.PATH).toBe("/usr/bin");
    for (const k of ["OPENAI_API_KEY", "CODEX_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"]) {
      expect(env[k], k).toBeUndefined();
    }
    expect(env.SOME_SECRET).toBeUndefined();
    expect(JSON.stringify(env)).not.toContain("canary");
    expect(JSON.stringify(env)).not.toContain("/home/caller");
  });

  it("refuses a non-loopback fake URL", () => {
    expect(() => offlineRecorderEnv({ env: caller, tmp, fakeUrl: "https://api.openai.com" })).toThrow(
      /loopback/,
    );
    expect(() => offlineRecorderEnv({ env: caller, tmp, fakeUrl: "http://10.0.0.5:18999" })).toThrow(
      /loopback/,
    );
    expect(isLoopbackUrl("http://localhost:1/v1")).toBe(true);
    expect(isLoopbackUrl("http://[::1]:1")).toBe(true);
    expect(isLoopbackUrl("http://127.0.0.1.evil.example")).toBe(false);
  });

  it("refuses a temp dir inside the caller's home", () => {
    expect(() => offlineRecorderEnv({ env: caller, tmp: "/home/caller/tmp/ocw", fakeUrl: FAKE })).toThrow(
      /home/,
    );
  });

  it("assertOffline rejects a real key or a home dir that left tmp", () => {
    const env = offlineRecorderEnv({ env: caller, tmp, fakeUrl: FAKE });
    expect(() => assertOffline({ ...env, OPENAI_API_KEY: "x" }, caller)).toThrow(/OPENAI_API_KEY/);
    expect(() => assertOffline({ ...env, CODEX_HOME: "/home/caller/.codex" }, caller)).toThrow(/CODEX_HOME/);
    expect(() => assertOffline({ ...env, ANTHROPIC_BASE_URL: "https://api.anthropic.com" }, caller)).toThrow(
      /ANTHROPIC_BASE_URL/,
    );
  });
});

/** Runs a recorder with `args` under the canary HOME; resolves with its exit code and output. */
function runRecorder(
  script: string,
  args: string[],
  env: NodeJS.ProcessEnv,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    execFile(
      TSX,
      [join(APP, "scripts", script), ...args],
      { cwd: APP, env, timeout: 30_000 },
      (err, stdout, stderr) => {
        const code = err ? (typeof err.code === "number" ? err.code : 1) : 0;
        done({ code, stdout, stderr });
      },
    );
  });
}

describe.each([["record-codex-fixture.ts"], ["record-fixture.ts"]])(
  "%s --scenario browser-mcp (canary HOME)",
  (script) => {
    let canary: string;
    let env: NodeJS.ProcessEnv;

    beforeAll(() => {
      canary = mkdtempSync(join(tmpdir(), "ocw-canary-home-"));
      mkdirSync(join(canary, ".codex"));
      mkdirSync(join(canary, ".claude"));
      writeFileSync(join(canary, ".codex", "config.toml"), 'model = "canary-model"\n');
      writeFileSync(join(canary, ".claude", "settings.json"), '{"canary":true}\n');
      env = {
        PATH: process.env.PATH,
        HOME: canary,
        TMPDIR: process.env.TMPDIR ?? tmpdir(),
        OPENAI_API_KEY: "sk-canary-openai",
        ANTHROPIC_API_KEY: "sk-ant-canary",
        CODEX_HOME: join(canary, ".codex"),
        CLAUDE_CONFIG_DIR: join(canary, ".claude"),
      };
    });
    afterAll(() => rmSync(canary, { recursive: true, force: true }));

    it("--print-env prints only temp-dir paths, none under the canary HOME, and no caller key", async () => {
      const { code, stdout, stderr } = await runRecorder(
        script,
        ["--scenario", "browser-mcp", "--print-env", "--fake-url", FAKE],
        env,
      );
      expect(code, stderr).toBe(0);
      const printed = JSON.parse(stdout) as Record<string, string>;
      for (const key of ["HOME", "CODEX_HOME", "CLAUDE_CONFIG_DIR", "XDG_CONFIG_HOME"]) {
        expect(printed[key], key).toBeTruthy();
      }
      for (const [key, value] of Object.entries(printed)) {
        if (!value.startsWith("/")) continue;
        expect(under(value, tmpdir()), `${key} under the OS temp dir`).toBe(true);
        expect(under(value, canary), `${key} not under the canary HOME`).toBe(false);
        expect(value.includes(`${canary}/.codex`) || value.includes(`${canary}/.claude`)).toBe(false);
      }
      expect(stdout).not.toContain("canary");
      expect(printed.ANTHROPIC_API_KEY).toBe("ocw-fake-key");
      expect(printed.OPENAI_API_KEY).toBeUndefined();
    });

    it("a non-loopback --fake-url exits non-zero before spawning anything", async () => {
      const { code, stdout, stderr } = await runRecorder(
        script,
        ["--scenario", "browser-mcp", "--print-env", "--fake-url", "https://api.openai.com"],
        env,
      );
      expect(code).not.toBe(0);
      expect(stdout).toBe("");
      expect(stderr).toMatch(/loopback/);
    });
  },
);
