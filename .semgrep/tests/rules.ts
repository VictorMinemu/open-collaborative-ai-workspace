// Semgrep rule fixtures for .semgrep/rules.yml (`node scripts/guard/run.mjs --rule-tests`). Never compiled, linted or
// scanned by the main guard run: each `ruleid:` line must match on the next line, each `ok:` line must not.

// ruleid: ocw.permission-bypass-token
const claudeMode = "bypassPermissions";
// ruleid: ocw.permission-bypass-token
const codexSandbox = "danger-full-access";
// ruleid: ocw.permission-bypass-token
const options = { allowDangerouslySkipPermissions: true };
// ruleid: ocw.permission-bypass-token
const argv = ["--dangerously-skip-permissions"];
// ruleid: ocw.permission-bypass-token
const flag = { dangerouslySkipPermissions: true };
// ok: ocw.permission-bypass-token
const safeMode = "default";
// ok: ocw.permission-bypass-token
const sandbox = "workspace-write";
