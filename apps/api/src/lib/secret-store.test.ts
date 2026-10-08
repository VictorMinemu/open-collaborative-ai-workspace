import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  createChainedSecretStore,
  createEnvFileSecretStore,
  formatSecretUri,
  MissingSecretError,
  parseSecretUri,
  type SecretReference,
  type SecretStore,
  UnsupportedReferenceError,
} from "./secret-store";

const CANARY = "canary-value-0f9e8d7c6b5a";
const dir = mkdtempSync(join(tmpdir(), "ocw-secret-store-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("parseSecretUri (openbao://<mount>/<path>#<field>, SELF-02)", () => {
  it("parses mount, path and field", () => {
    expect(parseSecretUri("openbao://secret/ocw/api#OCW_ENCRYPTION_KEY")).toEqual({
      provider: "openbao",
      mount: "secret",
      path: "ocw/api",
      field: "OCW_ENCRYPTION_KEY",
    });
    expect(parseSecretUri("openbao://kv-v2/a.b_c/d-e/f#x.y-z")).toEqual({
      provider: "openbao",
      mount: "kv-v2",
      path: "a.b_c/d-e/f",
      field: "x.y-z",
    });
  });

  it("round-trips through formatSecretUri", () => {
    const uri = "openbao://secret/ocw/api#BETTER_AUTH_SECRET";
    const ref = parseSecretUri(uri);
    expect(ref && formatSecretUri(ref)).toBe(uri);
  });

  it("rejects malformed references", () => {
    for (const bad of [
      "secret/ocw/api#KEY",
      "openbao://",
      "openbao://secret#KEY",
      "openbao://secret/ocw/api",
      "openbao://secret/ocw/api#",
      "openbao://secret//api#KEY",
      "openbao://secret/ocw/../sys#KEY",
      "openbao://secret/ocw/api#KEY#2",
      "openbao://secret/ocw/api/#KEY",
      "openbao://secret/oc w/api#KEY",
      "openbao://secret/ocw/api?x=1#KEY",
      "vault://secret/ocw/api#KEY",
    ]) {
      expect(parseSecretUri(bad), bad).toBeNull();
    }
  });
});

describe("env/file SecretStore", () => {
  it("resolves NAME, then NAME_FILE, and a file reference", () => {
    const file = join(dir, "key");
    writeFileSync(file, `${CANARY}\n`);
    expect(createEnvFileSecretStore({ K: CANARY }).resolveSync({ provider: "env", key: "K" })).toBe(CANARY);
    expect(createEnvFileSecretStore({ K_FILE: file }).resolveSync({ provider: "env", key: "K" })).toBe(
      CANARY,
    );
    expect(createEnvFileSecretStore({}).resolveSync({ provider: "file", path: file })).toBe(CANARY);
  });

  it("a missing key throws MissingSecretError naming only the key", () => {
    const store = createEnvFileSecretStore({ OTHER: CANARY });
    expect(() => store.resolveSync({ provider: "env", key: "MISSING_KEY" })).toThrow(MissingSecretError);
    try {
      store.resolveSync({ provider: "env", key: "MISSING_KEY" });
    } catch (err) {
      expect((err as Error).message).toContain("MISSING_KEY");
      expect((err as Error).message).not.toContain(CANARY);
    }
  });

  it("does not resolve openbao or db references", () => {
    const store = createEnvFileSecretStore({});
    const ref = parseSecretUri("openbao://secret/ocw/api#K") as SecretReference;
    expect(() => store.resolveSync(ref)).toThrow(UnsupportedReferenceError);
    expect(() => store.resolveSync({ provider: "db", secretId: "s", organizationId: "o" })).toThrow(
      MissingSecretError,
    );
  });
});

describe("createChainedSecretStore", () => {
  const fixed = (values: Record<string, string>): SecretStore => ({
    resolveSync(ref) {
      if (ref.provider !== "env")
        throw new UnsupportedReferenceError("fixed store resolves env references only");
      const v = values[ref.key];
      if (v === undefined) throw new MissingSecretError(`fixed store has no ${ref.key}`);
      return v;
    },
  });
  const onlyOpenBao: SecretStore = {
    resolveSync(ref) {
      if (ref.provider !== "openbao") throw new UnsupportedReferenceError("openbao references only");
      return `bao:${ref.field}`;
    },
  };

  it("asks the stores in order: the first one that has the secret wins", () => {
    const chain = createChainedSecretStore([fixed({ A: "first" }), fixed({ A: "second", B: "fallback" })]);
    expect(chain.resolveSync({ provider: "env", key: "A" })).toBe("first");
    expect(chain.resolveSync({ provider: "env", key: "B" })).toBe("fallback");
  });

  it("env/file first, then OpenBao for openbao references", () => {
    const chain = createChainedSecretStore([createEnvFileSecretStore({ K: CANARY }), onlyOpenBao]);
    expect(chain.resolveSync({ provider: "env", key: "K" })).toBe(CANARY);
    expect(chain.resolveSync(parseSecretUri("openbao://secret/ocw/api#F") as SecretReference)).toBe("bao:F");
  });

  it("when nobody has it, throws the most specific MissingSecretError", () => {
    const chain = createChainedSecretStore([createEnvFileSecretStore({}), onlyOpenBao]);
    expect(() => chain.resolveSync({ provider: "env", key: "NOPE" })).toThrow(/secret NOPE is not set/);
    const empty = createChainedSecretStore([]);
    expect(() => empty.resolveSync({ provider: "env", key: "NOPE" })).toThrow(MissingSecretError);
  });

  it("does not swallow unexpected errors", () => {
    const broken: SecretStore = {
      resolveSync() {
        throw new TypeError("boom");
      },
    };
    expect(() =>
      createChainedSecretStore([broken, fixed({ A: "x" })]).resolveSync({ provider: "env", key: "A" }),
    ).toThrow(TypeError);
  });
});
