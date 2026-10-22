import { createHash } from "node:crypto";
import {
  packageTreeCanonical,
  type ReviewedTreeEntry,
  type SandboxdPackageInstall,
  SandboxdPackageInstallResult,
  SandboxdPackageReviewResult,
} from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import {
  buildCommand,
  clawhubLockfile,
  createPackages,
  DEFAULT_REGISTRIES,
  debianLockfile,
  dockerPackageRunner,
  fetchCommand,
  installPlan,
  npmTree,
  type PackageRun,
  type PackageRunner,
  parseDebianLockfile,
  parsePypiRequirements,
  pypiRequirements,
  REMOVE_COMMAND,
  type RunOutput,
  registryConfig,
  removeCommand,
  reviewCommand,
  runEnv,
  stepOf,
  treeSha256,
} from "./packages";

const ORG = "0199f0a0-0000-7000-8000-00000000000a";
const A = "0199f0a0-1111-7000-8000-00000000000a";
const B = "0199f0a0-1111-7000-8000-00000000000b";
const PKG = "0199f0a0-4444-7000-8000-000000000001";
const PKG2 = "0199f0a0-4444-7000-8000-000000000002";

const sha512 = (seed: string) => `sha512-${createHash("sha512").update(seed).digest("base64")}`;
const sha1 = (seed: string) => `sha1-${createHash("sha1").update(seed).digest("base64")}`;
const sha256hex = (seed: string) => createHash("sha256").update(seed).digest("hex");

/** A package-lock.json v3 as `npm install --package-lock-only` writes it for `ocw-smoke-cli@1.0.0`. */
function npmLock(
  over: { depIntegrity?: string; cliExtra?: Record<string, unknown>; extra?: Record<string, unknown> } = {},
) {
  return JSON.stringify({
    name: "ocw-sandbox-package",
    version: "0.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: {
      "": { name: "ocw-sandbox-package", version: "0.0.0", dependencies: { "ocw-smoke-cli": "1.0.0" } },
      "node_modules/ocw-smoke-cli": {
        version: "1.0.0",
        resolved: "http://registry.fake.test:8080/npm/ocw-smoke-cli/-/ocw-smoke-cli-1.0.0.tgz",
        integrity: sha512("cli"),
        hasInstallScript: true,
        license: "MIT",
        dependencies: { "ocw-smoke-dep": "1.0.0" },
        bin: { "ocw-smoke-cli": "bin/cli.js" },
        ...over.cliExtra,
      },
      "node_modules/ocw-smoke-dep": {
        version: "1.0.0",
        resolved: "http://registry.fake.test:8080/npm/ocw-smoke-dep/-/ocw-smoke-dep-1.0.0.tgz",
        integrity: over.depIntegrity ?? sha512("dep"),
        license: "MIT",
      },
      ...over.extra,
    },
  });
}

const npmEntries = (dep = sha512("dep")): ReviewedTreeEntry[] => [
  { name: "ocw-smoke-cli", version: "1.0.0", integrity: sha512("cli") },
  { name: "ocw-smoke-dep", version: "1.0.0", integrity: dep },
];

const hashOf = (entries: readonly ReviewedTreeEntry[]) =>
  createHash("sha256").update(packageTreeCanonical(entries)).digest("hex");

const SCRIPT_INDEX = 2;

// ---------------------------------------------------------------- configuration

describe("registryConfig and the run environment", () => {
  it("defaults to the public registries and derives the registries-only allow-list", () => {
    const cfg = registryConfig({});
    expect(cfg.npmRegistry).toBe("https://registry.npmjs.org/");
    expect(cfg.pypiIndex).toBe("https://pypi.org/simple/");
    expect(cfg.clawhubUrl).toBe("https://clawhub.ai");
    expect(cfg.registries).toEqual([...DEFAULT_REGISTRIES, "clawhub.ai"]);
    expect(DEFAULT_REGISTRIES).toEqual([
      "registry.npmjs.org",
      "pypi.org",
      "files.pythonhosted.org",
      "deb.debian.org",
      "security.debian.org",
    ]);
  });

  it("takes the test overrides and refuses a URL with credentials or a non-http scheme", () => {
    const cfg = registryConfig({
      OCW_SANDBOX_NPM_REGISTRY: "http://registry.fake.test:8080/npm/",
      OCW_SANDBOX_PYPI_INDEX: "http://registry.fake.test:8080/simple/",
      OCW_CLAWHUB_URL: "http://registry.fake.test:8080",
      OCW_SANDBOX_REGISTRIES: "registry.fake.test:8080, *.fake.test",
    });
    expect(cfg.registries).toEqual(["registry.fake.test:8080", "*.fake.test"]);
    expect(() => registryConfig({ OCW_SANDBOX_NPM_REGISTRY: "http://u:p@registry.test/" })).toThrow();
    expect(() => registryConfig({ OCW_CLAWHUB_URL: "file:///etc/passwd" })).toThrow();
    expect(() => registryConfig({ OCW_SANDBOX_REGISTRIES: "https://x.test/path" })).toThrow();
  });

  it("gives runs the proxy and registry URLs only (no token, no secret), and trusts an http index by host", () => {
    const env = runEnv(
      registryConfig({
        OCW_SANDBOX_PYPI_INDEX: "http://registry.fake.test:8080/simple/",
      }),
    );
    expect(env).toEqual(
      expect.arrayContaining([
        "HTTP_PROXY=http://sandbox-egress:3128",
        "HTTPS_PROXY=http://sandbox-egress:3128",
        "npm_config_registry=https://registry.npmjs.org/",
        "PIP_INDEX_URL=http://registry.fake.test:8080/simple/",
        "PIP_TRUSTED_HOST=registry.fake.test",
        "OCW_CLAWHUB_URL=https://clawhub.ai",
        "TMPDIR=/staging/tmp",
      ]),
    );
    for (const line of env) expect(line).not.toMatch(/TOKEN|SECRET|PASSWORD/i);
    // A run never finds a program in the packages volume, and Node and Python never load a package from it.
    expect(env).toContain("PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin");
    expect(env.join("\n")).not.toContain("/opt/ocw-packages");
    expect(runEnv(registryConfig({})).some((l) => l.startsWith("PIP_TRUSTED_HOST="))).toBe(false);
  });
});

// ---------------------------------------------------------------- command builders (argv only)

describe("command builders (argv arrays, never a shell string)", () => {
  const sources = ["npm", "pypi", "debian", "clawhub"] as const;

  it("reviews pass the exact name and version as their own argv items; the program is a constant", () => {
    for (const source of sources) {
      const argv = reviewCommand(source, "left-pad", "1.3.0");
      expect(Array.isArray(argv)).toBe(true);
      expect(["node", "python3"]).toContain(argv[0]);
      expect(argv.slice(-2)).toEqual(["left-pad", "1.3.0"]);
      expect(stepOf(argv)).toBe(`review-${source}`);
      // The package never reaches the program text.
      expect(argv[SCRIPT_INDEX]).not.toContain("left-pad");
      expect(argv[SCRIPT_INDEX]).toBe(reviewCommand(source, "other", "9.9.9")[SCRIPT_INDEX]);
      expect(argv.join(" ")).not.toMatch(/\bsh -c\b|bash/);
    }
  });

  it("npm review resolves the whole tree without running anything", () => {
    const js = reviewCommand("npm", "x", "1.0.0")[SCRIPT_INDEX] as string;
    expect(js).toContain('"--package-lock-only"');
    expect(js).toContain('"--ignore-scripts"');
    expect(js).toContain('"pack"');
  });

  it("the npm install always uses `npm ci` over the stored lockfile, never `npm install <spec>`", () => {
    const fetch = fetchCommand("npm", PKG);
    expect(fetch.slice(-1)).toEqual([PKG]);
    const js = fetch[SCRIPT_INDEX] as string;
    expect(js).toContain('["ci", "--ignore-scripts"');
    expect(js).toContain("package-lock.json");
    expect(js).not.toMatch(/"install"/);
    // Install scripts run in a second step, after the tree was verified, and only in the installer.
    const build = buildCommand("npm", PKG)[SCRIPT_INDEX] as string;
    expect(build).toContain('"rebuild"');
    expect(build).not.toMatch(/"install"/);
  });

  it("the pip install always has --no-deps and --require-hashes, and installs from the verified download only", () => {
    const fetch = fetchCommand("pypi", PKG)[SCRIPT_INDEX] as string;
    expect(fetch).toContain('"--no-deps"');
    expect(fetch).toContain('"--require-hashes"');
    const build = buildCommand("pypi", PKG)[SCRIPT_INDEX] as string;
    for (const flag of ['"--no-deps"', '"--require-hashes"', '"--no-index"', '"--target"'])
      expect(build).toContain(flag);
  });

  it("Debian resolves the download-only closure under the run's own apt state and extracts without maintainer scripts", () => {
    const review = reviewCommand("debian", "jq", "1.6-2.1")[SCRIPT_INDEX] as string;
    expect(review).toContain("Dir::State=/staging/apt/state");
    expect(review).toContain("Dir::Cache=/staging/apt/cache");
    expect(review).toContain('"--print-uris"');
    expect(review).toContain("hashlib.sha256");
    expect(review).toMatch(/preinst.*postinst/s);
    const fetch = fetchCommand("debian", PKG)[SCRIPT_INDEX] as string;
    expect(fetch).toContain("hashlib.sha256");
    expect(fetch).toContain('fail("digest_mismatch")');
    const build = buildCommand("debian", PKG)[SCRIPT_INDEX] as string;
    expect(build).toContain('"dpkg-deb", "-x"');
    expect(`${review}${fetch}${build}`).not.toMatch(/"dpkg", "-i"|"--install"|apt-get install(?! --print)/);
  });

  it("ClawHub downloads the tarball, checks its sha256 and extracts it as data", () => {
    const fetch = fetchCommand("clawhub", PKG)[SCRIPT_INDEX] as string;
    expect(fetch).toContain("hashlib.sha256");
    expect(fetch).toContain("/artifact/download");
    const build = buildCommand("clawhub", PKG)[SCRIPT_INDEX] as string;
    expect(build).toContain('"--no-same-owner"');
  });

  it("removal names only package ids, each as its own argv item", () => {
    const argv = removeCommand([PKG, PKG2]);
    expect(argv.slice(-2)).toEqual([PKG, PKG2]);
    expect(argv[SCRIPT_INDEX]).toBe(REMOVE_COMMAND[SCRIPT_INDEX]);
  });
});

// ---------------------------------------------------------------- tree parsing

describe("npmTree", () => {
  it("records every (name, version, integrity), the dependency count and install scripts", () => {
    const t = npmTree(npmLock(), { name: "ocw-smoke-cli", version: "1.0.0" });
    expect(t.entries).toEqual(npmEntries());
    expect(t.hasInstallScript).toBe(true);
    expect(t.top).toEqual({ name: "ocw-smoke-cli", version: "1.0.0", integrity: sha512("cli") });
    expect(t.license).toBe("MIT");
  });

  it("dedupes nested copies, skips bundled ones, prefers sha512 over a weaker second hash", () => {
    const lock = npmLock({
      extra: {
        "node_modules/ocw-smoke-cli/node_modules/ocw-smoke-dep": {
          version: "1.0.0",
          integrity: sha512("dep"),
        },
        "node_modules/ocw-smoke-cli/node_modules/bundled": { version: "2.0.0", inBundle: true },
        "node_modules/@scope/pkg": { version: "3.0.0", integrity: `${sha512("scoped")} ${sha1("scoped")}` },
      },
    });
    const t = npmTree(lock, { name: "ocw-smoke-cli", version: "1.0.0" });
    expect(t.entries.map((e) => `${e.name}@${e.version}`)).toEqual([
      "ocw-smoke-cli@1.0.0",
      "ocw-smoke-dep@1.0.0",
      "@scope/pkg@3.0.0",
    ]);
    expect(t.entries[2]?.integrity).toBe(sha512("scoped"));
  });

  it("carries a sha1-only entry through review (the API refuses it, WINDOWS #233)", () => {
    const t = npmTree(npmLock({ depIntegrity: sha1("dep") }), { name: "ocw-smoke-cli", version: "1.0.0" });
    expect(t.entries[1]?.integrity).toBe(sha1("dep"));
    expect(SandboxdPackageReviewResult.shape.entries.safeParse(t.entries).success).toBe(true);
  });

  it("refuses a linked or integrity-less entry and a root that is not exactly the package", () => {
    expect(() =>
      npmTree(
        npmLock({ extra: { "node_modules/evil": { version: "1.0.0", link: true, resolved: "../x" } } }),
        {
          name: "ocw-smoke-cli",
          version: "1.0.0",
        },
      ),
    ).toThrow(/link/);
    expect(() =>
      npmTree(npmLock({ extra: { "node_modules/evil": { version: "1.0.0" } } }), {
        name: "ocw-smoke-cli",
        version: "1.0.0",
      }),
    ).toThrow(/integrity/);
    expect(() => npmTree(npmLock(), { name: "ocw-smoke-cli", version: "2.0.0" })).toThrow();
    expect(() => npmTree("not json", { name: "ocw-smoke-cli", version: "1.0.0" })).toThrow();
  });
});

describe("PyPI, Debian and ClawHub recorded sets", () => {
  const py: ReviewedTreeEntry[] = [
    { name: "ocw-smoke-py", version: "1.0.0", integrity: `sha256:${sha256hex("py")}` },
    { name: "ocw-smoke-pydep", version: "1.0.0", integrity: `sha256:${sha256hex("pydep")}` },
  ];

  it("writes a requirement set with one pinned, hashed line per distribution and reads it back", () => {
    const text = pypiRequirements(py);
    expect(text.trim().split("\n")).toEqual([
      `ocw-smoke-py==1.0.0 --hash=sha256:${sha256hex("py")}`,
      `ocw-smoke-pydep==1.0.0 --hash=sha256:${sha256hex("pydep")}`,
    ]);
    expect(parsePypiRequirements(text)).toEqual(py);
    expect(() => parsePypiRequirements("requests>=2\n")).toThrow();
    expect(() => parsePypiRequirements("x==1 --hash=md5:abc\n")).toThrow();
    expect(() => parsePypiRequirements("-e git+https://evil/x\n")).toThrow();
  });

  it("writes the Debian closure with each .deb's sha256 and URL and reads it back", () => {
    const debs = [
      {
        name: "jq",
        version: "1.6-2.1",
        sha256: sha256hex("jq"),
        size: 64016,
        url: "http://deb.debian.org/debian/pool/main/j/jq/jq_1.6-2.1_arm64.deb",
      },
      {
        name: "libjq1",
        version: "1.6-2.1",
        sha256: sha256hex("libjq1"),
        size: 130000,
        url: "http://deb.debian.org/debian/pool/main/j/jq/libjq1_1.6-2.1_arm64.deb",
      },
    ];
    const text = debianLockfile(debs);
    expect(parseDebianLockfile(text)).toEqual(debs);
    expect(() => parseDebianLockfile("jq 1.6 sha256:abc 1 file:///etc/passwd\n")).toThrow();
    expect(() => parseDebianLockfile(`jq 1.6 sha256:${sha256hex("x")} 1 http://a b\n`)).toThrow();
  });

  it("records a ClawHub bundle as its single tarball", () => {
    const text = clawhubLockfile({
      name: "ocw-smoke-skill",
      version: "1.0.0",
      sha256: sha256hex("skill"),
      size: 300,
    });
    const plan = installPlan({
      id: PKG,
      source: "clawhub",
      name: "ocw-smoke-skill",
      version: "1.0.0",
      sha256: sha256hex("skill"),
      treeSha256: hashOf([
        { name: "ocw-smoke-skill", version: "1.0.0", integrity: `sha256:${sha256hex("skill")}` },
      ]),
      lockfile: text,
    });
    expect(plan.ok).toBe(true);
  });
});

describe("installPlan: only the recorded set, only strong integrity", () => {
  const npmPkg = (over: Partial<SandboxdPackageInstall["packages"][number]> = {}) => ({
    id: PKG,
    source: "npm" as const,
    name: "ocw-smoke-cli",
    version: "1.0.0",
    sha256: sha256hex("cli-tgz"),
    treeSha256: hashOf(npmEntries()),
    lockfile: npmLock(),
    ...over,
  });

  it("accepts a lockfile whose tree hashes to the approved treeSha256 and builds package.json from its root", () => {
    const plan = installPlan(npmPkg());
    expect(plan).toMatchObject({ ok: true, entries: npmEntries() });
    if (!plan.ok) throw new Error("expected a plan");
    expect(JSON.parse(plan.stdin)).toMatchObject({
      packageJson: {
        name: "ocw-sandbox-package",
        version: "0.0.0",
        dependencies: { "ocw-smoke-cli": "1.0.0" },
      },
    });
  });

  it("refuses with tree_changed when the lockfile does not hash to the approved tree", () => {
    const plan = installPlan(npmPkg({ treeSha256: hashOf(npmEntries(sha512("other"))) }));
    expect(plan).toMatchObject({ ok: false, code: "tree_changed" });
  });

  it("refuses an entry pinned by sha1 only, with a clear reason, before anything runs (WINDOWS #233)", () => {
    const weak = npmEntries(sha1("dep"));
    const plan = installPlan(
      npmPkg({ lockfile: npmLock({ depIntegrity: sha1("dep") }), treeSha256: hashOf(weak) }),
    );
    expect(plan.ok).toBe(false);
    if (plan.ok) throw new Error("unreachable");
    expect(plan.code).toBeUndefined();
    expect(plan.detail).toMatch(/sha1/);
    expect(plan.detail.length).toBeLessThanOrEqual(200);
  });

  it("refuses a lockfile of another source's shape", () => {
    expect(installPlan(npmPkg({ source: "pypi" }))).toMatchObject({ ok: false });
  });
});

// ---------------------------------------------------------------- the orchestrator over a scripted runner

interface ScriptedRun {
  calls: { step: string; argv: string[]; stdin?: string }[];
  closed: boolean;
}

/** A runner whose execs answer by step; `volume` is the bot's packages volume as the installer would leave it. */
function scripted(
  answer: (
    step: string,
    argv: string[],
    stdin: string | undefined,
    volume: Map<string, string>,
  ) => Partial<RunOutput>,
) {
  const runs: ScriptedRun[] = [];
  const volumes = new Map<string, Map<string, string>>();
  const opened: { kind: string; target: { orgId: string; agentId: string }; network: boolean }[] = [];
  const runner: PackageRunner = {
    async open(kind, target, opts) {
      opened.push({ kind, target, network: opts.network });
      const run: ScriptedRun = { calls: [], closed: false };
      runs.push(run);
      const volume = volumes.get(`${target.orgId}:${target.agentId}`) ?? new Map<string, string>();
      volumes.set(`${target.orgId}:${target.agentId}`, volume);
      const handle: PackageRun = {
        async exec(argv, o) {
          const step = stepOf(argv);
          run.calls.push({ step, argv, stdin: o?.stdin });
          await new Promise((r) => setImmediate(r));
          return {
            exitCode: 0,
            stdout: "{}",
            stderr: "",
            timedOut: false,
            overflow: false,
            ...answer(step, argv, o?.stdin, volume),
          };
        },
        async close() {
          run.closed = true;
        },
      };
      return handle;
    },
  };
  return { runner, runs, volumes, opened };
}

/** The installer as the real one behaves for an npm package whose tree npm ci reproduced as `installed`. */
function npmInstaller(installed: ReviewedTreeEntry[] = npmEntries(), fetch: Partial<RunOutput> = {}) {
  return scripted((step, argv, stdin, volume) => {
    const id = argv[argv.length - 1] as string;
    if (step === "state") return { stdout: JSON.stringify({ installed: volume.get(id) ?? null }) };
    if (step === "fetch-npm") {
      const packages: Record<string, unknown> = {};
      for (const e of installed)
        packages[`node_modules/${e.name}`] = { version: e.version, integrity: e.integrity };
      return {
        stdout: JSON.stringify({ lockfile: JSON.stringify({ lockfileVersion: 3, packages }) }),
        ...fetch,
      };
    }
    if (step === "commit") {
      volume.set(id, JSON.parse(stdin ?? "{}").treeSha256);
      return { stdout: '{"ok":true}' };
    }
    if (step === "remove") {
      let removed = 0;
      for (const x of argv.slice(4)) if (volume.delete(x)) removed++;
      return { stdout: JSON.stringify({ removed }) };
    }
    return { stdout: '{"ok":true}' };
  });
}

const install = (
  over: Partial<SandboxdPackageInstall["packages"][number]> = {},
  agentId = A,
): SandboxdPackageInstall => ({
  target: { orgId: ORG, agentId },
  packages: [
    {
      id: PKG,
      source: "npm",
      name: "ocw-smoke-cli",
      version: "1.0.0",
      sha256: sha256hex("cli-tgz"),
      treeSha256: hashOf(npmEntries()),
      lockfile: npmLock(),
      ...over,
    },
  ],
});

describe("createPackages().install", () => {
  it("runs state → npm ci → recomputed tree → rebuild → commit, in the installer on the bot's volume", async () => {
    const s = npmInstaller();
    const pk = createPackages({ runner: s.runner });
    const out = await pk.install(install());
    expect(SandboxdPackageInstallResult.parse(out)).toEqual({
      results: [{ id: PKG, status: "installed", detail: "installed" }],
    });
    expect(s.opened).toEqual([{ kind: "installer", target: { orgId: ORG, agentId: A }, network: true }]);
    expect(s.runs[0]?.calls.map((c) => c.step)).toEqual(["state", "fetch-npm", "build-npm", "commit"]);
    expect(s.runs[0]?.closed).toBe(true);
    expect(s.volumes.get(`${ORG}:${A}`)?.get(PKG)).toBe(hashOf(npmEntries()));
    // The lockfile travels on stdin, never in argv.
    const fetch = s.runs[0]?.calls[1];
    expect(fetch?.argv.join(" ")).not.toContain("ocw-smoke-dep");
    expect(JSON.parse(fetch?.stdin ?? "{}").lockfile).toBe(npmLock());
  });

  it("a recomputed tree that differs by one entry's integrity is tree_changed and nothing reaches the volume", async () => {
    const s = npmInstaller(npmEntries(sha512("republished")));
    const out = await createPackages({ runner: s.runner }).install(install());
    expect(out.results).toEqual([
      {
        id: PKG,
        status: "failed",
        detail: "the installed tree differs from the approved one",
        code: "tree_changed",
      },
    ]);
    expect(s.runs[0]?.calls.map((c) => c.step)).toEqual(["state", "fetch-npm"]);
    expect(s.volumes.get(`${ORG}:${A}`)?.size).toBe(0);
    expect(s.runs[0]?.closed).toBe(true);
  });

  it("an integrity error from npm ci (a republished dependency) is digest_mismatch, volume untouched", async () => {
    const s = npmInstaller(npmEntries(), {
      exitCode: 1,
      stdout: "",
      stderr: "npm error code EINTEGRITY\nnpm error sha512-... integrity checksum failed",
    });
    const out = await createPackages({ runner: s.runner }).install(install());
    expect(out.results[0]).toMatchObject({ status: "failed", code: "digest_mismatch" });
    expect(s.runs[0]?.calls.map((c) => c.step)).toEqual(["state", "fetch-npm"]);
    expect(s.volumes.get(`${ORG}:${A}`)?.size).toBe(0);
  });

  it("pip's hash refusal is digest_mismatch too", async () => {
    const py: ReviewedTreeEntry[] = [
      { name: "ocw-smoke-py", version: "1.0.0", integrity: `sha256:${sha256hex("py")}` },
    ];
    const s = scripted((step) =>
      step === "fetch-pypi"
        ? { exitCode: 1, stderr: "ERROR: THESE PACKAGES DO NOT MATCH THE HASHES FROM THE REQUIREMENTS FILE." }
        : { stdout: JSON.stringify({ installed: null }) },
    );
    const out = await createPackages({ runner: s.runner }).install(
      install({
        source: "pypi",
        name: "ocw-smoke-py",
        sha256: sha256hex("py"),
        treeSha256: hashOf(py),
        lockfile: pypiRequirements(py),
      }),
    );
    expect(out.results[0]).toMatchObject({ status: "failed", code: "digest_mismatch" });
  });

  it("a build step that prints an integrity word cannot fake a digest code (install scripts are untrusted)", async () => {
    const s = scripted((step, argv, _stdin, volume) => {
      const id = argv[argv.length - 1] as string;
      if (step === "state") return { stdout: JSON.stringify({ installed: volume.get(id) ?? null }) };
      if (step === "fetch-npm") {
        const packages: Record<string, unknown> = {};
        for (const e of npmEntries())
          packages[`node_modules/${e.name}`] = { version: e.version, integrity: e.integrity };
        return { stdout: JSON.stringify({ lockfile: JSON.stringify({ packages }) }) };
      }
      if (step === "build-npm") return { exitCode: 1, stderr: "EINTEGRITY" };
      return {};
    });
    const out = await createPackages({ runner: s.runner }).install(install());
    expect(out.results[0]).toEqual({ id: PKG, status: "failed", detail: "the install step failed" });
  });

  it("a step past the deadline is the timeout code and nothing is committed", async () => {
    const s = npmInstaller(npmEntries(), { exitCode: -1, timedOut: true });
    const out = await createPackages({ runner: s.runner, installDeadlineMs: 1000 }).install(install());
    expect(out.results[0]).toMatchObject({ status: "failed", code: "timeout" });
    expect(SandboxdPackageInstallResult.safeParse(out).success).toBe(true);
    expect(s.volumes.get(`${ORG}:${A}`)?.size).toBe(0);
  });

  it("is idempotent per package id: an installed tree is reported without running anything again", async () => {
    const s = npmInstaller();
    const pk = createPackages({ runner: s.runner });
    await pk.install(install());
    const again = await pk.install(install());
    expect(again.results[0]).toMatchObject({ status: "installed" });
    expect(s.runs[1]?.calls.map((c) => c.step)).toEqual(["state"]);
  });

  it("two concurrent installs of one package for one bot install it once", async () => {
    const s = npmInstaller();
    const pk = createPackages({ runner: s.runner });
    const [x, y] = await Promise.all([pk.install(install()), pk.install(install())]);
    expect(x.results[0]?.status).toBe("installed");
    expect(y.results[0]?.status).toBe("installed");
    const commits = s.runs.flatMap((r) => r.calls).filter((c) => c.step === "commit");
    expect(commits).toHaveLength(1);
  });

  it("refuses a sha1 lockfile and a mismatched tree hash without opening any container", async () => {
    const s = npmInstaller();
    const pk = createPackages({ runner: s.runner });
    const weak = await pk.install(
      install({
        lockfile: npmLock({ depIntegrity: sha1("dep") }),
        treeSha256: hashOf(npmEntries(sha1("dep"))),
      }),
    );
    expect(weak.results[0]).toMatchObject({ status: "failed" });
    expect(weak.results[0]?.detail).toMatch(/sha1/);
    const moved = await pk.install(install({ treeSha256: hashOf(npmEntries(sha512("x"))) }));
    expect(moved.results[0]).toMatchObject({ status: "failed", code: "tree_changed" });
    expect(s.opened).toHaveLength(0);
  });

  it("keeps bots apart: one bot's install opens an installer on that bot only", async () => {
    const s = npmInstaller();
    const pk = createPackages({ runner: s.runner });
    await pk.install(install({}, A));
    expect(s.volumes.get(`${ORG}:${B}`)).toBeUndefined();
  });
});

describe("createPackages().review", () => {
  it("resolves the npm tree in a review run on a fresh run id, never on a bot", async () => {
    const lock = npmLock();
    const s = scripted((step) =>
      step === "review-npm"
        ? {
            stdout: JSON.stringify({
              lockfile: lock,
              top: { sha256: sha256hex("cli-tgz"), sha512: sha512("cli"), size: 1234 },
              license: "MIT",
              publisher: "ocw-smoke <smoke@example.test>",
            }),
          }
        : {},
    );
    const out = await createPackages({ runner: s.runner }).review({
      orgId: ORG,
      source: "npm",
      name: "ocw-smoke-cli",
      version: "1.0.0",
    });
    expect(SandboxdPackageReviewResult.parse(out)).toEqual({
      source: "npm",
      name: "ocw-smoke-cli",
      version: "1.0.0",
      sha256: sha256hex("cli-tgz"),
      sizeBytes: 1234,
      license: "MIT",
      publisher: "ocw-smoke",
      hasInstallScript: true,
      dependencyCount: 1,
      treeSha256: hashOf(npmEntries()),
      entries: npmEntries(),
      lockfile: lock,
    });
    expect(treeSha256(out.entries)).toBe(out.treeSha256);
    expect(s.opened[0]?.kind).toBe("review");
    expect(s.opened[0]?.target.orgId).toBe(ORG);
    expect(s.opened[0]?.target.agentId).not.toBe(A);
    expect(s.runs[0]?.closed).toBe(true);
  });

  it("passes a sha1-only top package through review (checked against the tarball's own sha1, WINDOWS #233)", async () => {
    const lock = JSON.stringify({
      lockfileVersion: 3,
      packages: {
        "": { name: "ocw-sandbox-package", version: "0.0.0", dependencies: { "ocw-smoke-old": "1.0.0" } },
        "node_modules/ocw-smoke-old": { version: "1.0.0", integrity: sha1("old") },
      },
    });
    const s = scripted(() => ({
      stdout: JSON.stringify({
        lockfile: lock,
        top: { sha256: sha256hex("old"), sha512: sha512("old"), sha1: sha1("old"), size: 10 },
      }),
    }));
    const out = await createPackages({ runner: s.runner }).review({
      orgId: ORG,
      source: "npm",
      name: "ocw-smoke-old",
      version: "1.0.0",
    });
    expect(out.entries).toEqual([{ name: "ocw-smoke-old", version: "1.0.0", integrity: sha1("old") }]);
    const bad = scripted(() => ({
      stdout: JSON.stringify({
        lockfile: lock,
        top: { sha256: sha256hex("old"), sha512: sha512("old"), sha1: sha1("x"), size: 10 },
      }),
    }));
    await expect(
      createPackages({ runner: bad.runner }).review({
        orgId: ORG,
        source: "npm",
        name: "ocw-smoke-old",
        version: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("refuses a tarball that does not match the lockfile's top integrity", async () => {
    const s = scripted(() => ({
      stdout: JSON.stringify({
        lockfile: npmLock(),
        top: { sha256: sha256hex("x"), sha512: sha512("other"), size: 1 },
      }),
    }));
    await expect(
      createPackages({ runner: s.runner }).review({
        orgId: ORG,
        source: "npm",
        name: "ocw-smoke-cli",
        version: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "digest_mismatch" });
  });

  it("answers not_found for a package or version the registry does not have", async () => {
    const s = scripted(() => ({
      exitCode: 1,
      stdout: "",
      stderr: "npm error code E404\nnpm error 404 Not Found",
    }));
    await expect(
      createPackages({ runner: s.runner }).review({
        orgId: ORG,
        source: "npm",
        name: "nope",
        version: "1.0.0",
      }),
    ).rejects.toMatchObject({ code: "not_found", status: 404 });
  });

  it("reviews PyPI from the downloaded files: hashes, requirement set and sdist install scripts", async () => {
    const s = scripted(() => ({
      stdout: JSON.stringify({
        files: [
          {
            file: "ocw_smoke_py-1.0.0-py3-none-any.whl",
            sha256: sha256hex("py"),
            size: 900,
            sdist: false,
            name: "ocw_smoke_py",
            version: "1.0.0",
            license: "MIT",
            author: "OCW Smoke",
          },
          {
            file: "ocw_smoke_pydep-1.0.0.tar.gz",
            sha256: sha256hex("pydep"),
            size: 700,
            sdist: true,
            name: null,
            version: null,
            license: null,
            author: null,
          },
        ],
      }),
    }));
    const out = await createPackages({ runner: s.runner }).review({
      orgId: ORG,
      source: "pypi",
      name: "ocw_smoke_py",
      version: "1.0.0",
    });
    expect(out.entries).toEqual([
      { name: "ocw-smoke-py", version: "1.0.0", integrity: `sha256:${sha256hex("py")}` },
      { name: "ocw-smoke-pydep", version: "1.0.0", integrity: `sha256:${sha256hex("pydep")}` },
    ]);
    expect(out).toMatchObject({
      sha256: sha256hex("py"),
      sizeBytes: 900,
      license: "MIT",
      publisher: "OCW Smoke",
      hasInstallScript: true,
      dependencyCount: 1,
    });
    expect(parsePypiRequirements(out.lockfile)).toEqual(out.entries);
  });

  it("reviews Debian: every .deb's sha256 and maintainer scripts reported (never run)", async () => {
    const s = scripted(() => ({
      stdout: JSON.stringify({
        debs: [
          {
            url: "http://deb.debian.org/debian/pool/main/j/jq/jq_1.6-2.1_arm64.deb",
            sha256: sha256hex("jq"),
            size: 64016,
            name: "jq",
            version: "1.6-2.1",
            maintainer: "Debian Maintainers <x@example.test>",
            scripts: false,
          },
          {
            url: "http://deb.debian.org/debian/pool/main/j/jq/libjq1_1.6-2.1_arm64.deb",
            sha256: sha256hex("libjq1"),
            size: 130000,
            name: "libjq1",
            version: "1.6-2.1",
            maintainer: null,
            scripts: true,
          },
        ],
      }),
    }));
    const out = await createPackages({ runner: s.runner }).review({
      orgId: ORG,
      source: "debian",
      name: "jq",
      version: "1.6-2.1",
    });
    expect(out).toMatchObject({
      sha256: sha256hex("jq"),
      sizeBytes: 64016,
      publisher: "Debian Maintainers",
      hasInstallScript: true,
      dependencyCount: 1,
    });
    expect(parseDebianLockfile(out.lockfile).map((d) => d.name)).toEqual(["jq", "libjq1"]);
  });

  it("reviews a ClawHub bundle as one entry", async () => {
    const s = scripted(() => ({
      stdout: JSON.stringify({ sha256: sha256hex("skill"), size: 300, publisher: "ocw", license: null }),
    }));
    const out = await createPackages({ runner: s.runner }).review({
      orgId: ORG,
      source: "clawhub",
      name: "ocw-smoke-skill",
      version: "1.0.0",
    });
    expect(out.entries).toEqual([
      { name: "ocw-smoke-skill", version: "1.0.0", integrity: `sha256:${sha256hex("skill")}` },
    ]);
    expect(out).toMatchObject({ dependencyCount: 0, hasInstallScript: false, sha256: sha256hex("skill") });
  });
});

describe("createPackages().remove", () => {
  it("deletes one package's files in an installer with no network and leaves the others", async () => {
    const s = npmInstaller();
    const pk = createPackages({ runner: s.runner });
    await pk.install(install());
    await pk.install(install({ id: PKG2 }));
    const out = await pk.remove({ target: { orgId: ORG, agentId: A }, ids: [PKG] });
    expect(out).toEqual({ removed: 1 });
    expect(s.opened.at(-1)).toMatchObject({ kind: "installer", network: false });
    expect([...(s.volumes.get(`${ORG}:${A}`)?.keys() ?? [])]).toEqual([PKG2]);
  });
});

// ---------------------------------------------------------------- the Docker runner (review and installer containers)

describe("dockerPackageRunner", () => {
  async function setup() {
    const { FakeDocker } = await import("./testing/fake-docker");
    const docker = new FakeDocker();
    const attached: { target: unknown; kind: string; network: string }[] = [];
    const detached: string[] = [];
    const egress = {
      ensure: async () => undefined,
      attach: async (target: unknown, kind: string, network: string) => {
        attached.push({ target, kind, network });
        return "10.6.0.2";
      },
      detachTarget: async () => undefined,
      detachNetwork: async (network: string) => {
        detached.push(network);
      },
      setOrgPolicy: async () => undefined,
      entries: () => [],
      close: () => undefined,
    };
    const sandboxes = {
      dockerRuntime: async () => "runc" as const,
      packagesVolume: async (t: { agentId: string }) => `ocw-pkg-ocw-unit-${t.agentId.slice(-4)}`,
    };
    const runner = dockerPackageRunner({
      docker,
      sandboxes,
      egress,
      ns: "ocw-unit",
      image: "ocw-sandbox-sbx:test",
      env: ["HTTP_PROXY=http://sandbox-egress:3128"],
    });
    return { docker, runner, attached, detached };
  }

  it("opens an installer on its own labelled network through the proxy, with the bot's packages volume", async () => {
    const s = await setup();
    s.docker.onExec = (call) => ({
      exitCode: 0,
      stdout: JSON.stringify({ argv: call.cmd.slice(3), stdin: call.stdin.toString() }),
      stderr: "x".repeat(40_000),
    });
    const run = await s.runner.open(
      "installer",
      { orgId: ORG, agentId: A },
      { network: true, lifetimeMs: 600_000 },
    );
    const nets = [...s.docker.networks.values()];
    expect(nets).toHaveLength(1);
    expect(nets[0]?.Internal).toBe(true);
    expect(nets[0]?.Labels["ocw.kind"]).toBe("installer");
    expect(nets[0]?.Labels["ocw.agent"]).toBe(A);
    expect(s.attached).toEqual([
      { target: { orgId: ORG, agentId: A }, kind: "installer", network: nets[0]?.Name },
    ]);
    const created = s.docker.containerCreates[0]?.body as {
      HostConfig: { Mounts: { Source?: string; ReadOnly: boolean }[]; NetworkMode: string };
    };
    expect(created.HostConfig.NetworkMode).toBe(nets[0]?.Name);
    // The proxy by its address on the run's network (runsc answers no Docker DNS there).
    expect((created.HostConfig as { ExtraHosts?: string[] }).ExtraHosts).toEqual(["sandbox-egress:10.6.0.2"]);
    expect(created.HostConfig.Mounts[0]).toMatchObject({
      Source: `ocw-pkg-ocw-unit-${A.slice(-4)}`,
      ReadOnly: false,
    });

    const out = await run.exec(["node", "-e", "js", "state", PKG], { stdin: "hello", timeoutMs: 5_000 });
    expect(out.exitCode).toBe(0);
    expect(JSON.parse(out.stdout)).toEqual({ argv: ["state", PKG], stdin: "hello" });
    expect(out.stderr.length).toBeLessThanOrEqual(16_384);
    const exec = [...s.docker.execs.values()][0];
    expect(exec?.user).toBe("10001:10001");

    await run.close();
    expect(s.docker.containers.size).toBe(0);
    expect(s.detached).toEqual([nets[0]?.Name]);
    const deletes = s.docker.calls.filter((c) => c.method === "DELETE").map((c) => c.path);
    expect(deletes.some((p) => p.startsWith("/containers/") && p.includes("v=1"))).toBe(true);
    expect(deletes.some((p) => p.startsWith("/networks/"))).toBe(true);
  });

  it("opens a review under a run id that is no bot, with nothing persistent mounted", async () => {
    const s = await setup();
    const RUN = "0199f0a0-5555-7000-8000-00000000000e";
    const run = await s.runner.open(
      "review",
      { orgId: ORG, agentId: RUN },
      { network: true, lifetimeMs: 200_000 },
    );
    const created = s.docker.containerCreates[0]?.body as {
      Labels: Record<string, string>;
      HostConfig: { Mounts: { Source?: string }[] };
    };
    expect(created.Labels["ocw.kind"]).toBe("review");
    expect(created.HostConfig.Mounts.every((m) => m.Source === undefined)).toBe(true);
    await run.close();
  });

  it("a removal run joins no network at all", async () => {
    const s = await setup();
    const run = await s.runner.open(
      "installer",
      { orgId: ORG, agentId: A },
      { network: false, lifetimeMs: 120_000 },
    );
    expect(s.docker.networks.size).toBe(0);
    expect(s.attached).toEqual([]);
    expect(
      (s.docker.containerCreates[0]?.body as { HostConfig?: { NetworkMode?: string } } | undefined)
        ?.HostConfig?.NetworkMode,
    ).toBe("none");
    expect(
      (s.docker.containerCreates[0]?.body as { HostConfig?: { ExtraHosts?: string[] } } | undefined)
        ?.HostConfig?.ExtraHosts,
    ).toEqual([]);
    await run.close();
  });

  it("refuses a networked run without an egress proxy (no way out, nothing created)", async () => {
    const { FakeDocker } = await import("./testing/fake-docker");
    const docker = new FakeDocker();
    const runner = dockerPackageRunner({
      docker,
      sandboxes: { dockerRuntime: async () => "runc" as const, packagesVolume: async () => "v" },
      egress: null,
      ns: "ocw-unit",
      image: "img",
      env: [],
    });
    await expect(
      runner.open("review", { orgId: ORG, agentId: A }, { network: true, lifetimeMs: 1000 }),
    ).rejects.toMatchObject({ code: "docker_unavailable", status: 503 });
    expect(docker.containerCreates).toHaveLength(0);
  });

  it("cleans up what it created when the container cannot start", async () => {
    const s = await setup();
    const original = s.docker.request.bind(s.docker);
    s.docker.request = async (method, path, body, o) =>
      method === "POST" && path.endsWith("/start")
        ? { status: 500, body: null }
        : original(method, path, body, o);
    await expect(
      s.runner.open("installer", { orgId: ORG, agentId: A }, { network: true, lifetimeMs: 1000 }),
    ).rejects.toMatchObject({ status: 503 });
    expect(s.docker.containers.size).toBe(0);
    expect(s.detached).toHaveLength(1);
  });
});
