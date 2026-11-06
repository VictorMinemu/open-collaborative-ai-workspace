// Renders resources/icon.svg and the tray templates to PNG (Playwright Chromium) and builds
// resources/icon.icns with macOS iconutil (Windows and Linux use icon.png). Outputs are committed;
// rerun only when the art changes.
//   pnpm --filter @ocw/desktop icons
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const res = join(root, "resources");

// Menu-bar template icons: black + alpha only (macOS tints them). 16pt, drawn on a 32 grid.
// Online: solid rings. Offline / paused / unpaired: faded rings.
const tray = (opacity) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="32" height="32">
  <g fill="none" stroke="#000" stroke-width="2.8" opacity="${opacity}">
    <circle cx="11.5" cy="16" r="7.4"/><circle cx="20.5" cy="16" r="7.4"/>
  </g>
</svg>`;

const browser = await chromium.launch();
const page = await browser.newPage({ deviceScaleFactor: 1 });

async function render(svg, size, out) {
  await page.setViewportSize({ width: size, height: size });
  const b64 = Buffer.from(svg).toString("base64");
  await page.setContent(
    `<html><body style="margin:0;background:transparent"><img src="data:image/svg+xml;base64,${b64}" style="width:${size}px;height:${size}px;display:block"></body></html>`,
  );
  await page.locator("img").evaluate((img) => img.decode());
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: size, height: size } });
}

const appSvg = readFileSync(join(res, "icon.svg"), "utf8");
await render(appSvg, 1024, join(res, "icon.png"));

const iconset = join(tmpdir(), `ocw-${process.pid}.iconset`);
mkdirSync(iconset, { recursive: true });
for (const s of [16, 32, 128, 256, 512]) {
  await render(appSvg, s, join(iconset, `icon_${s}x${s}.png`));
  await render(appSvg, s * 2, join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", join(res, "icon.icns")]);
rmSync(iconset, { recursive: true, force: true });

mkdirSync(join(res, "tray"), { recursive: true });
for (const [name, svg] of [
  ["trayTemplate", tray(1)],
  ["trayOfflineTemplate", tray(0.45)],
]) {
  await render(svg, 16, join(res, "tray", `${name}.png`));
  await render(svg, 32, join(res, "tray", `${name}@2x.png`));
}
// Windows and Linux do not tint tray icons, and black rings vanish on a dark taskbar: they get the
// coloured app icon instead (faded when the runtime is offline).
const faded = (opacity) => appSvg.replace("<svg ", `<svg opacity="${opacity}" `);
for (const [name, svg] of [
  ["trayColor", appSvg],
  ["trayColorOffline", faded(0.45)],
]) {
  await render(svg, 16, join(res, "tray", `${name}.png`));
  await render(svg, 32, join(res, "tray", `${name}@2x.png`));
}
await browser.close();
console.log("icons written to", res);
