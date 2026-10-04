// electron-builder afterPack hook (runs before signing): copy the self-contained daemon
// (dist/daemon incl. node_modules) into the app's Resources.
const { cpSync, existsSync, rmSync } = require("node:fs");
const { join } = require("node:path");

exports.default = async function afterPack(context) {
  const src = join(context.packager.projectDir, "dist", "daemon");
  if (!existsSync(join(src, "node_modules"))) {
    throw new Error("dist/daemon is missing; run `node scripts/build.mjs --daemon` first");
  }
  const app = `${context.packager.appInfo.productFilename}.app`;
  const resources =
    context.electronPlatformName === "darwin"
      ? join(context.appOutDir, app, "Contents", "Resources")
      : join(context.appOutDir, "resources");
  const dest = join(resources, "daemon");
  rmSync(dest, { recursive: true, force: true });
  cpSync(src, dest, {
    recursive: true,
    dereference: true,
    filter: (p) => !/\.map$|\.test\.ts$|vitest\.config\.ts$/.test(p),
  });
};
