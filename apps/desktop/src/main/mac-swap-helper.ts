// Entry of the detached macOS swap helper (07.13.1, D-05), bundled to dist/main/mac-swap-helper.cjs and copied beside
// the staged app by mac-update.ts. The app starts it as `process.execPath <helper> <argv…>` with
// ELECTRON_RUN_AS_NODE=1, detached, no shell, no stdio. It prints nothing: the outcome goes to update-result.json.
// Exit codes: 0 installed, 1 failed (the result says why), 2 refused arguments.

import { parseHelperArgs, runSwap } from "./mac-swap";

void (async () => {
  try {
    const result = await runSwap(parseHelperArgs(process.argv.slice(2)));
    process.exitCode = result.outcome === "installed" ? 0 : 1;
  } catch {
    process.exitCode = 2;
  }
})();
