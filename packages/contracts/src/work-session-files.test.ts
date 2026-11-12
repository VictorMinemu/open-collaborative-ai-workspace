import { describe, expect, it } from "vitest";
import { ATTACHMENT_DEFAULT_MAX_BYTES } from "./attachments";
import { CommandFrame, CommandKind, DEVICE_LINK_MAX_DEVICE_FRAME_BYTES } from "./device-link";
import {
  BOT_FILE_LIMIT_SOURCE_LABELS,
  BOT_FILE_LIMITS,
  BotFileLimit,
  BotFileLimitSource,
  botFileTooLargeSentence,
  canonicalFileName,
  effectiveBotFileMaxBytes,
  fileSizeLabel,
  isSecretBasename,
  isWindowsReservedName,
  parseSessionFileAck,
  RUNTIME_FILE_ROUTE,
  RuntimeFilePutAnswer,
  SessionFileFailure,
  SessionFileReadPayload,
  SessionFileWritePayload,
  sessionFileAckError,
  transferDeadlineMs,
  WorkSessionFileDenyReason,
  WorkSessionFilePath,
  workSessionFilePathRefusal,
} from "./work-session-files";

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe("bot file limits (07.17.1.1 D-06, D-07, PD-05, PD-18)", () => {
  it("are the hub's numbers", () => {
    expect(BOT_FILE_LIMITS).toEqual({
      defaultMaxBytes: ATTACHMENT_DEFAULT_MAX_BYTES,
      minMaxBytes: MiB,
      ceilingMaxBytes: GiB,
      filesPerTurnEachWay: 5,
      pathMaxChars: 1024,
      segmentMaxChars: 255,
      partBytes: 8 * MiB,
      transferBaseMs: 30_000,
      transferBytesPerSecond: MiB,
      transferMaxMs: 600_000,
      concurrentTransfersPerProcess: 4,
    });
    expect(BOT_FILE_LIMITS.defaultMaxBytes).toBe(25 * MiB);
  });

  it("the transfer deadline grows with the size and stops at ten minutes", () => {
    expect(transferDeadlineMs(0)).toBe(30_000);
    expect(transferDeadlineMs(1)).toBe(31_000);
    expect(transferDeadlineMs(10 * MiB)).toBe(40_000);
    expect(transferDeadlineMs(GiB)).toBe(600_000);
  });
});

describe("WorkSessionFilePath (07.17.1.1 D-02, D-03, principle 7)", () => {
  const ok = (p: string) => WorkSessionFilePath.safeParse(p).success;

  it("accepts repo-relative file paths", () => {
    for (const p of [
      "docs/spec v2.pdf",
      "src/a.b/c.ts",
      ".env.example",
      "README.md",
      "a",
      "x".repeat(255),
      `${"a/".repeat(511)}bc`,
    ]) {
      expect(ok(p), p).toBe(true);
    }
  });

  it("refuses absolute, home, drive, backslash and traversal forms", () => {
    for (const p of [
      "",
      "/etc/passwd",
      "~/x",
      "~",
      "C:/x",
      "c:x",
      "a\\b",
      "C:\\x",
      "a//b",
      "./a",
      "a/..",
      "a/./b",
      "../x",
      "a/",
      "/",
    ]) {
      expect(ok(p), JSON.stringify(p)).toBe(false);
    }
  });

  it("refuses control and bidi characters", () => {
    const bidi = [0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2066, 0x2067, 0x2068, 0x2069, 0x200e, 0x200f];
    for (const cp of [0, 1, 9, 10, 13, 0x1f, 0x7f, ...bidi]) {
      const p = `docs/a${String.fromCodePoint(cp)}b.txt`;
      expect(ok(p), cp.toString(16)).toBe(false);
    }
  });

  it("refuses a segment ending in a dot or a space, a segment over 255 characters and a path over 1 024", () => {
    expect(ok("notes.")).toBe(false);
    expect(ok("notes ")).toBe(false);
    expect(ok("dir./a")).toBe(false);
    expect(ok("dir /a")).toBe(false);
    expect(ok("x".repeat(256))).toBe(false);
    expect(ok(`a/${"x".repeat(256)}`)).toBe(false);
    expect(ok("a".repeat(1025))).toBe(false);
    expect(ok(`${"a/".repeat(511)}abc`)).toBe(false);
  });

  it("refuses NTFS stream names and 8.3 short names anywhere in the path (review CR-02)", () => {
    const dotEnv = [".", "env"].join("");
    for (const p of [
      `${dotEnv}::$DATA`,
      `${dotEnv}:secret`,
      "docs/a:b.txt",
      "a/b:",
      "ENV~1",
      "GIT~1/config",
      "x/PROGRA~1/a.md",
      "notes~2.md",
    ]) {
      expect(ok(p), p).toBe(false);
    }
    // A tilde not followed by a digit is an ordinary name; a leading one is still the home shortcut.
    expect(ok("docs/notes~.md")).toBe(true);
    expect(ok("docs/a~b.md")).toBe(true);
    expect(ok("docs/~x")).toBe(true);
  });

  it("names the Windows device names, with any extension and in any case (review CR-02)", () => {
    for (const name of ["CON", "con", "nul.txt", "Aux.c", "prn", "COM1", "com9.log", "LPT1", `COM${"¹"}`]) {
      expect(isWindowsReservedName(name), name).toBe(true);
    }
    for (const name of ["console.log", "aux2", "nullable.ts", "com", "com10", "lpt0x", "docs"]) {
      expect(isWindowsReservedName(name), name).toBe(false);
    }
  });
});

describe("the limit that applies (07.17.1.1 D-07)", () => {
  it("names the bot, the organization or the server", () => {
    expect([...BotFileLimitSource.options]).toEqual(["bot", "organization", "server"]);
    expect(BOT_FILE_LIMIT_SOURCE_LABELS).toEqual({
      bot: "this bot's limit",
      organization: "the organization's limit",
      server: "the server's limit",
    });
    expect(BotFileLimit.parse({ bytes: 25 * MiB, source: "organization" })).toEqual({
      bytes: 25 * MiB,
      source: "organization",
    });
    expect(BotFileLimit.safeParse({ bytes: 25 * MiB, source: "user" }).success).toBe(false);
    expect(BotFileLimit.safeParse({ bytes: 0, source: "bot" }).success).toBe(false);
    expect(BotFileLimit.safeParse({ bytes: 1.5, source: "bot" }).success).toBe(false);
  });
});

describe("the shared deny list (07.17.1.1 D-09, PD-09)", () => {
  it("names why a path is refused, case-insensitively, anywhere in the path", () => {
    expect([...WorkSessionFileDenyReason.options]).toEqual(["git", "worktrees", "runtime_config", "secret"]);
    const cases: Array<[string, string | null]> = [
      [".git/config", "git"],
      [".GIT/hooks/pre-commit", "git"],
      ["sub/.git", "git"],
      ["vendor/lib/.Git/HEAD", "git"],
      [".ocw-worktrees/abc/x", "worktrees"],
      ["a/.OCW-WORKTREES/b", "worktrees"],
      [".claude/settings.json", "runtime_config"],
      [".Claude/settings.json", "runtime_config"],
      [".codex/config.toml", "runtime_config"],
      [".Codex/config.toml", "runtime_config"],
      [".mcp.json", "runtime_config"],
      ["pkg/.mcp.json", "runtime_config"],
      [".env", "secret"],
      ["config/.env.local", "secret"],
      [".ENV", "secret"],
      ["id_ed25519", "secret"],
      ["keys/id_rsa.pub", "secret"],
      ["deploy.pem", "secret"],
      ["server.key", "secret"],
      ["credentials.json", "secret"],
      [".npmrc", "secret"],
      [".env.example", null],
      ["README.md", null],
      ["src/claude.ts", null],
      ["docs/git.md", null],
      ["gitignore.txt", null],
      [".gitignore", null],
      ["docs/.mcp.json.md", null],
      ["mcp.json", null],
    ];
    for (const [path, reason] of cases) expect(workSessionFilePathRefusal(path), path).toBe(reason);
  });

  it("compares every segment in its folded form: APFS and NTFS case folding cannot alias a denied name (review CR-01)", () => {
    const longS = String.fromCharCode(0x17f); // LATIN SMALL LETTER LONG S, folds to "s"
    const kelvin = String.fromCharCode(0x212a); // KELVIN SIGN, folds to "k"
    const dotlessI = String.fromCharCode(0x131); // LATIN SMALL LETTER DOTLESS I, upper-cases to "I" (NTFS upcase)
    const ligatureSt = String.fromCharCode(0xfb06); // LATIN SMALL LIGATURE ST, NFKC "st"
    const cases: Array<[string, string]> = [
      [`id_r${longS}a`, "secret"],
      [`keys/ID_R${longS}A.pub`, "secret"],
      [`credential${longS}`, "secret"],
      [`.mcp.j${longS}on`, "runtime_config"],
      [`.ocw-worktree${longS}/other/x`, "worktrees"],
      [`.g${dotlessI}t/config`, "git"],
      [`server.${kelvin}ey`, "secret"],
      [`.\uff43laude/settings.json`, "runtime_config"],
      [`.env.te${ligatureSt}`, "secret"],
    ];
    for (const [path, reason] of cases) expect(workSessionFilePathRefusal(path), path).toBe(reason);
    expect(isSecretBasename(`id_r${longS}a`)).toBe(true);
    expect(canonicalFileName(`ID_R${longS}A`)).toBe("id_rsa");
    expect(canonicalFileName(`${kelvin}eys`)).toBe("keys");
    // A folded form that is not a plain segment any more is not a file name: the path rule refuses it.
    const fullwidthSolidus = String.fromCharCode(0xff0f); // NFKC "/"
    const twoDotLeader = String.fromCharCode(0x2025); // NFKC ".."
    const fullwidthColon = String.fromCharCode(0xff1a); // NFKC ":"
    for (const p of [
      `a${fullwidthSolidus}.git`,
      twoDotLeader,
      `x/${twoDotLeader}/y`,
      `a${fullwidthColon}b`,
    ]) {
      expect(WorkSessionFilePath.safeParse(p).success, p).toBe(false);
    }
    // Ordinary letters, accents and other scripts still pass, in either normalization form.
    for (const p of ["docs/résumé.md", "docs/résumé.md", "notas/año.txt", "x/日本.md"]) {
      expect(WorkSessionFilePath.safeParse(p).success, p).toBe(true);
      expect(workSessionFilePathRefusal(p), p).toBeNull();
    }
  });

  it("the secret base names are the Claude adapter's rules, unchanged (20-name fixture)", () => {
    // Expected answers of `SECRET_BASENAME` / `ENV_TEMPLATE_ALLOW` in apps/local-runtime/src/claude/tool-policy.ts.
    const fixture: Array<[string, boolean]> = [
      [".env", true],
      [".env.local", true],
      [".env.production", true],
      [".env.example", false],
      [".env.sample", false],
      [".env.template", false],
      [".env.dist", false],
      ["cert.pem", true],
      ["bundle.p12", true],
      ["store.pfx", true],
      ["tls.key", true],
      ["id_rsa", true],
      ["id_ecdsa.pub", true],
      ["login.keychain-db", true],
      [".netrc", true],
      [".pypirc", true],
      ["credentials", true],
      [".credentials.json", true],
      ["device-token", true],
      ["environment.ts", false],
      ["id_rsa.txt", false],
      ["keys.md", false],
    ];
    for (const [name, secret] of fixture) expect(isSecretBasename(name), name).toBe(secret);
  });
});

describe("the effective per-file limit and its sentence (07.17.1.1 D-07, PD-11)", () => {
  it("the lowest level wins; a tie names the outer level", () => {
    expect(effectiveBotFileMaxBytes({ bot: 10 * MiB, organization: 25 * MiB, server: 25 * MiB })).toEqual({
      bytes: 10 * MiB,
      source: "bot",
    });
    expect(effectiveBotFileMaxBytes({ bot: null, organization: 40 * MiB, server: 25 * MiB })).toEqual({
      bytes: 25 * MiB,
      source: "server",
    });
    expect(effectiveBotFileMaxBytes({ bot: 25 * MiB, organization: 25 * MiB, server: GiB })).toEqual({
      bytes: 25 * MiB,
      source: "organization",
    });
    expect(effectiveBotFileMaxBytes({ bot: undefined, organization: undefined, server: GiB })).toEqual({
      bytes: 25 * MiB,
      source: "organization",
    });
    expect(effectiveBotFileMaxBytes({ bot: 30 * MiB, organization: 25 * MiB, server: GiB })).toEqual({
      bytes: 25 * MiB,
      source: "organization",
    });
    expect(effectiveBotFileMaxBytes({ bot: 10 * MiB, organization: 25 * MiB, server: 20 * MiB })).toEqual({
      bytes: 10 * MiB,
      source: "bot",
    });
    expect(effectiveBotFileMaxBytes({ bot: 25 * MiB, organization: 25 * MiB, server: 25 * MiB })).toEqual({
      bytes: 25 * MiB,
      source: "server",
    });
  });

  it("sizes read like the chat's (binary units, one decimal at most)", () => {
    expect(fileSizeLabel(26214400)).toBe("25 MB");
    expect(fileSizeLabel(1536)).toBe("1.5 KB");
    expect(fileSizeLabel(1073741824)).toBe("1 GB");
    expect(fileSizeLabel(0)).toBe("0 B");
    expect(fileSizeLabel(1023)).toBe("1023 B");
    expect(fileSizeLabel(40 * MiB)).toBe("40 MB");
  });

  it("the too-large sentence names the size, the limit and its level", () => {
    const limit = { bytes: 25 * MiB, source: "organization" } as const;
    expect(botFileTooLargeSentence({ sizeBytes: 40 * MiB, limit })).toBe(
      "That file is 40 MB. This bot moves files up to 25 MB (the organization's limit).",
    );
    expect(botFileTooLargeSentence({ limit })).toBe(
      "That file is larger than this bot may move: up to 25 MB (the organization's limit).",
    );
    expect(botFileTooLargeSentence({ sizeBytes: null, limit: { bytes: 10 * MiB, source: "bot" } })).toBe(
      "That file is larger than this bot may move: up to 10 MB (this bot's limit).",
    );
    for (const source of BotFileLimitSource.options) {
      const l = { bytes: GiB, source };
      expect(botFileTooLargeSentence({ sizeBytes: 1023 * GiB, limit: l }).length).toBeLessThanOrEqual(300);
      expect(botFileTooLargeSentence({ limit: l }).length).toBeLessThanOrEqual(300);
    }
  });
});

describe("device commands, payloads and acks (07.17.1.1 D-04, D-08, D-14, PD-05, PD-15)", () => {
  const SHA = "a".repeat(64);

  it("the two kinds parse; every earlier kind still parses", () => {
    for (const kind of [
      "session.start",
      "prompt",
      "interrupt",
      "approval.resolve",
      "session.stop",
      "diff.request",
      "session.configure",
      "session.title",
      "runtime.update",
      "session.file.write",
      "session.file.read",
    ]) {
      expect(CommandKind.safeParse(kind).success, kind).toBe(true);
    }
    const frame = { type: "command", id: "c1", kind: "session.file.read", sessionId: "s1", payload: {} };
    expect(CommandFrame.safeParse(frame).success).toBe(true);
  });

  it("the write payload carries a path, a size, a hash and overwrite; never a URL or bytes", () => {
    const write = { path: "docs/spec.pdf", sizeBytes: 1234, sha256: SHA, overwrite: false };
    expect(SessionFileWritePayload.parse(write)).toEqual(write);
    expect(SessionFileWritePayload.parse({ ...write, sha256: null })).toEqual({ ...write, sha256: null });
    // A plain object: a newer API's extra key is stripped, so an older daemon never breaks on it.
    expect(SessionFileWritePayload.parse({ ...write, url: "https://x.test/f", bytes: "aGk=" })).toEqual(
      write,
    );
    expect(SessionFileWritePayload.safeParse({ ...write, sha256: "A".repeat(64) }).success).toBe(false);
    expect(SessionFileWritePayload.safeParse({ ...write, sha256: "a".repeat(63) }).success).toBe(false);
    expect(SessionFileWritePayload.safeParse({ ...write, sizeBytes: GiB + 1 }).success).toBe(false);
    expect(SessionFileWritePayload.safeParse({ ...write, sizeBytes: GiB }).success).toBe(true);
    expect(SessionFileWritePayload.safeParse({ ...write, sizeBytes: -1 }).success).toBe(false);
    expect(SessionFileWritePayload.safeParse({ ...write, path: "../x" }).success).toBe(false);
  });

  it("the read payload carries a path and a bound", () => {
    expect(SessionFileReadPayload.parse({ path: "README.md", maxBytes: 25 * MiB })).toEqual({
      path: "README.md",
      maxBytes: 25 * MiB,
    });
    expect(SessionFileReadPayload.safeParse({ path: "README.md", maxBytes: 0 }).success).toBe(false);
    expect(SessionFileReadPayload.safeParse({ path: "README.md", maxBytes: GiB + 1 }).success).toBe(false);
    expect(SessionFileReadPayload.safeParse({ path: "/etc/passwd", maxBytes: MiB }).success).toBe(false);
  });

  it("ack errors: one code and an optional one-line detail; an old daemon reads as runtime_too_old", () => {
    expect([...SessionFileFailure.options]).toEqual([
      "invalid_path",
      "path_not_allowed",
      "not_found",
      "not_a_file",
      "exists",
      "too_large",
      "busy",
      "not_running",
      "no_space",
      "mismatch",
      "expired",
      "transfer_failed",
    ]);
    expect(parseSessionFileAck("invalid command frame")).toEqual({ code: "runtime_too_old" });
    expect(parseSessionFileAck("too_large: 41943040")).toEqual({ code: "too_large", sizeBytes: 41943040 });
    expect(parseSessionFileAck("too_large")).toEqual({ code: "too_large" });
    expect(parseSessionFileAck("too_large: lots")).toEqual({ code: "too_large" });
    expect(parseSessionFileAck("exists")).toEqual({ code: "exists" });
    expect(parseSessionFileAck("mismatch: size")).toEqual({ code: "mismatch" });
    expect(parseSessionFileAck("something else")).toEqual({ code: "unknown" });
    expect(parseSessionFileAck(null)).toEqual({ code: "unknown" });
    expect(parseSessionFileAck(undefined)).toEqual({ code: "unknown" });
    expect(sessionFileAckError("mismatch", "size")).toBe("mismatch: size");
    expect(sessionFileAckError("exists")).toBe("exists");
    expect(sessionFileAckError("transfer_failed", "first line\nsecond line")).toBe(
      "transfer_failed: first line",
    );
    expect(sessionFileAckError("transfer_failed", "x".repeat(500))).toBe(
      `transfer_failed: ${"x".repeat(120)}`,
    );
    expect(sessionFileAckError("too_large", String(41943040))).toBe("too_large: 41943040");
  });

  it("the device frame bound is the API's inbound limit; the transfer route and its answer", () => {
    expect(DEVICE_LINK_MAX_DEVICE_FRAME_BYTES).toBe(262144);
    expect(RUNTIME_FILE_ROUTE).toBe("/api/v1/runtime/files");
    expect(RuntimeFilePutAnswer.parse({ ok: true, sizeBytes: 12 })).toEqual({ ok: true, sizeBytes: 12 });
    expect(RuntimeFilePutAnswer.safeParse({ ok: false, sizeBytes: 12 }).success).toBe(false);
  });
});
