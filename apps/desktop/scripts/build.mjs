// Builds the Electron main process, preloads and the bundled onboarding renderer with esbuild.
//   node scripts/build.mjs            → dist/{main,preload,renderer,assets}
//   node scripts/build.mjs --daemon   → also dist/daemon (self-contained apps/local-runtime for packaging)
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const withDaemon = process.argv.includes("--daemon");
const prod = withDaemon || process.env.NODE_ENV === "production";

for (const d of ["main", "preload", "renderer", "assets"])
  rmSync(join(dist, d), { recursive: true, force: true });

const common = {
  bundle: true,
  logLevel: "warning",
  sourcemap: prod ? false : "linked",
  minify: false,
  legalComments: "none",
};

await Promise.all([
  build({
    ...common,
    entryPoints: { "main/index": "src/main/index.ts" },
    outdir: dist,
    outExtension: { ".js": ".cjs" },
    platform: "node",
    format: "cjs",
    target: "node24",
    external: ["electron"],
    absWorkingDir: root,
  }),
  build({
    ...common,
    entryPoints: { "preload/main": "src/preload/main.ts", "preload/onboarding": "src/preload/onboarding.ts" },
    outdir: dist,
    outExtension: { ".js": ".cjs" },
    // Sandboxed preloads: CommonJS, only `electron` may be required at runtime.
    platform: "node",
    format: "cjs",
    target: "chrome140",
    external: ["electron"],
    absWorkingDir: root,
  }),
  build({
    ...common,
    entryPoints: {
      "renderer/onboarding/onboarding": "src/renderer/onboarding/onboarding.ts",
      "renderer/onboarding/offline": "src/renderer/onboarding/offline.ts",
    },
    outdir: dist,
    platform: "browser",
    format: "iife",
    target: "chrome140",
    absWorkingDir: root,
  }),
]);

const rendererDir = join(dist, "renderer", "onboarding");
for (const f of ["index.html", "offline.html", "styles.css", "logo.svg"]) {
  cpSync(join(root, "src", "renderer", "onboarding", f), join(rendererDir, f));
}
mkdirSync(join(dist, "assets"), { recursive: true });
cpSync(join(root, "resources", "tray"), join(dist, "assets", "tray"), { recursive: true });
cpSync(join(root, "resources", "icon.png"), join(dist, "assets", "icon.png"));

if (withDaemon) {
  // Self-contained copy of apps/local-runtime with production deps, run by Electron-as-Node.
  const out = join(dist, "daemon");
  rmSync(out, { recursive: true, force: true });
  execFileSync("pnpm", ["--filter", "@ocw/local-runtime", "deploy", "--prod", "--legacy", out], {
    cwd: root,
    stdio: "inherit",
  });
  // The SDK's bundled Claude Code binaries (~200 MB per platform) are not needed: the daemon
  // drives the user's installed `claude` CLI (their subscription login).
  const scoped = join(out, "node_modules", ".pnpm");
  if (existsSync(scoped)) {
    for (const entry of readdirSync(scoped)) {
      if (/^@anthropic-ai\+claude-agent-sdk-(darwin|linux|win32)/.test(entry)) {
        rmSync(join(scoped, entry), { recursive: true, force: true });
      }
    }
  }
  for (const junk of ["src/claude/__fixtures__", "src/codex/__fixtures__", "scripts"]) {
    rmSync(join(out, junk), { recursive: true, force: true });
  }
}

console.log(`built ${withDaemon ? "app + daemon" : "app"} → ${dist}`);
