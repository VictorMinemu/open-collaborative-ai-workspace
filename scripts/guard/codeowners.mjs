// CODEOWNERS lint for `pnpm guard` (D-15, FOUND-07). Node builtins only.
//   lint(codeownersText, trackedFiles, requiredAreas) → failures[]
// Every pattern must match at least one tracked file (so the file cannot rot as code moves), every rule names an
// owner, and every required area (one representative tracked file each) is owned by the rule that wins for it.

/** The sensitive areas FOUND-07 requires an owner for, each pinned to a file that must stay owned. */
export const REQUIRED_AREAS = [
  { area: "db policies (RLS, grants, roles)", file: "packages/db/sql/post-migrate.sql" },
  { area: "db policies (bootstrap roles)", file: "packages/db/sql/bootstrap.sql" },
  { area: "db tenant context", file: "packages/db/src/tenant.ts" },
  { area: "auth", file: "apps/api/src/modules/identity/auth.ts" },
  { area: "authorization", file: "apps/api/src/authz.ts" },
  { area: "policy (permission resolver)", file: "apps/api/src/modules/organization/permissions/resolve.ts" },
  { area: "policy (permission contracts)", file: "packages/contracts/src/permissions.ts" },
  { area: "adapters (Claude Code)", file: "apps/local-runtime/src/claude/claude-runtime.ts" },
  { area: "adapters (Codex)", file: "apps/local-runtime/src/codex/codex-runtime.ts" },
  { area: "guardrails", file: ".semgrep/rules.yml" },
  // Phase 07.4 (07.4-14, WINDOWS #190): the outbound guard, member credentials, keys and the proxies that use them.
  { area: "egress guard", file: "apps/api/src/lib/egress.ts" },
  { area: "member connector credentials", file: "apps/api/src/modules/connectors/credentials.ts" },
  { area: "keychain (secrets by handle)", file: "apps/api/src/modules/keychain/service.ts" },
  { area: "connector proxy", file: "apps/api/src/modules/agent-channel/connectors.ts" },
  { area: "keychain proxy", file: "apps/api/src/modules/agent-channel/http-requests.ts" },
  { area: "agent templates (caps)", file: "apps/api/src/modules/agent/templates.ts" },
  // Phase 07.5 (ADR-0026): who must approve a bot's call, the one-use grant, and the cell's params pin.
  { area: "tool approval policies and grants", file: "apps/api/src/modules/tool-approval/request.ts" },
  { area: "approve-and-apply primitive", file: "apps/api/src/modules/approval/service.ts" },
  { area: "Work Zone proposals", file: "apps/api/src/modules/work-session/proposals.ts" },
  { area: "cell tool gate and params pin", file: "apps/openclaw-channel/src/tool-guard.ts" },
  // Phase 07.8 (ADR-0029, WINDOWS #236, #242): the only Docker socket holder, the single shared egress hop, the browser
  // agent that redacts every page view, sealed member sessions and the live view that decides who sees a frame.
  { area: "sandbox broker (Docker socket holder)", file: "apps/sandboxd/src/sandboxes.ts" },
  { area: "sandbox egress proxy", file: "apps/sandboxd/src/egress/proxy.ts" },
  { area: "egress policy rules", file: "packages/egress-policy/src/index.ts" },
  { area: "browser agent (redaction, site lock)", file: "infra/sandbox/browser/agent.mjs" },
  { area: "browser live view and takeover", file: "apps/api/src/modules/browser/live-view.ts" },
  { area: "sealed browser sessions", file: "apps/api/src/modules/browser/sessions.ts" },
  { area: "confined sandbox and browser calls", file: "apps/api/src/modules/agent-channel/sandbox.ts" },
  // 07.8 verification: the refused-tool table and confined flags (D-13 exec floor), and the Docker socket mount.
  { area: "bot tool refusals and confined flags", file: "packages/contracts/src/bot-capabilities.ts" },
  { area: "compose (Docker socket mount)", file: "compose.yaml" },
  // Phase 07.9 (ADR-0030): the one builder of a session's audience facts and the path that changes an audience.
  { area: "session audience facts", file: "apps/api/src/modules/work-session/facts.ts" },
  { area: "session audience changes", file: "apps/api/src/modules/work-session/visibility.ts" },
  // 07.9 verification (W1): the `ws:` authorizer decides who may subscribe to a session's live view.
  { area: "session live-view authorizer (ws:)", file: "apps/api/src/modules/work-session/index.ts" },
  // Phase 07.11 (ADR-0032): the on-device update command table, the runner that executes it, and who may ask.
  {
    area: "runtime CLI update commands (on-device table)",
    file: "apps/local-runtime/src/maintenance/install-method.ts",
  },
  { area: "runtime CLI update runner", file: "apps/local-runtime/src/maintenance/runner.ts" },
  { area: "runtime update requests (device.maintain)", file: "apps/api/src/modules/device/maintenance.ts" },
  // Phase 07.12 (ADR-0033): device-code pairing, the enroll transaction both pairing paths share, and what a server
  // runs as an installer and as a service.
  { area: "device-code pairing", file: "apps/api/src/modules/device/pairing.ts" },
  { area: "device enrollment", file: "apps/api/src/modules/device/enroll.ts" },
  { area: "runtime install script", file: "apps/api/src/modules/device/install-script.sh" },
  { area: "runtime distribution", file: "apps/api/src/modules/device/distribution.ts" },
  { area: "runtime service units", file: "apps/local-runtime/src/service/systemd.ts" },
  // Phase 07.14 (ADR-0036): the organization's connector sign-in routes and the OAuth flow state both principals share.
  { area: "organization connector sign-in", file: "apps/api/src/modules/connectors/org-routes.ts" },
  { area: "connector OAuth flow state", file: "apps/api/src/modules/connectors/flow.ts" },
  // Phase 07.15 (ADR-0037): the bot attachment read route and the row rule shared by reads and sandbox imports.
  { area: "bot attachment reads", file: "apps/api/src/modules/agent-channel/attachments.ts" },
  { area: "bot attachment access rule", file: "apps/api/src/modules/agent-channel/attachment-access.ts" },
  // Phase 07.16 (ADR-0038): bots run Work Zone sessions as their sponsor, read a redacted model, are woken, and the
  // profile and consent decide the bypass chain; people and bots share the prompt and archive bodies.
  {
    area: "bot Work Zone start, prompt and stop",
    file: "apps/api/src/modules/agent-channel/work-sessions.ts",
  },
  { area: "bot Work Zone read model route", file: "apps/api/src/modules/agent-channel/work-session-read.ts" },
  { area: "bot Work Zone wake-ups", file: "apps/api/src/modules/agent-channel/work-session-wakes.ts" },
  { area: "bot Work Zone profile and consent", file: "apps/api/src/modules/work-session/bot-profile.ts" },
  {
    area: "bot Work Zone sessions (sponsor transaction)",
    file: "apps/api/src/modules/work-session/bot-sessions.ts",
  },
  { area: "bot Work Zone redacted read model", file: "apps/api/src/modules/work-session/bot-read.ts" },
  {
    area: "prompt and archive bodies people and bots share",
    file: "apps/api/src/modules/work-session/controller.ts",
  },
  // Phase 07.17 (ADR-0039): a fan-out run opens conversations in its own target (hashed-key dedupe, caps, taint), each
  // item gets one turn, escalation targets are re-validated, and a team mention reaches only readers of the subtree.
  { area: "automation fan-out open route", file: "apps/api/src/modules/agent-channel/conversations-open.ts" },
  { area: "automation item turns", file: "apps/api/src/modules/agent-channel/automation-items.ts" },
  { area: "automation fan-out dedupe and caps", file: "apps/api/src/modules/automation/fan-out.ts" },
  { area: "automation escalation targets", file: "apps/api/src/modules/automation/escalation.ts" },
  { area: "team mention audience", file: "apps/api/src/modules/notification/team-mentions.ts" },
  // Phase 07.17.1.1 (ADR-0041): bots move files between a thread and their own session: the device's containment and
  // deny list, the device-JWT transfer route, the sponsor's transaction with its ledger and budgets, the two bot
  // routes, and the device JWT check the transfer route shares with the Device Link.
  { area: "device file containment", file: "apps/local-runtime/src/session-files.ts" },
  { area: "device file transfer route", file: "apps/api/src/modules/work-session/file-transfer-routes.ts" },
  {
    area: "bot file transfers (sponsor transaction)",
    file: "apps/api/src/modules/work-session/bot-files.ts",
  },
  { area: "bot file exchange routes", file: "apps/api/src/modules/agent-channel/work-session-files.ts" },
  { area: "device JWT authentication", file: "apps/api/src/modules/device/auth.ts" },
];

/** GitHub CODEOWNERS pattern (gitignore subset) → RegExp over repo-relative paths. */
export function patternToRegExp(pattern) {
  let p = pattern;
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  // A leading slash or a slash in the middle anchors the pattern at the repository root.
  const anchored = p.startsWith("/") || p.includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += c.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  }
  // A pattern naming a directory also owns everything below it.
  return new RegExp(`${anchored ? "^" : "^(?:.*/)?"}${re}${dirOnly ? "/.*" : "(?:/.*)?"}$`);
}

function parse(text) {
  const rules = [];
  text.split("\n").forEach((line, index) => {
    const content = line.replace(/(^|\s)#.*$/, "").trim();
    if (content === "") return;
    const [pattern, ...owners] = content.split(/\s+/);
    rules.push({ pattern, owners, line: index + 1, re: patternToRegExp(pattern) });
  });
  return rules;
}

export function lint(text, trackedFiles, requiredAreas = REQUIRED_AREAS) {
  const failures = [];
  const rules = parse(text);
  for (const rule of rules) {
    if (rule.owners.length === 0) failures.push(`CODEOWNERS:${rule.line} ${rule.pattern} has no owner`);
    else if (!rule.owners.every((o) => /^@[\w-]+(\/[\w.-]+)?$|^[^@\s]+@[^@\s]+$/.test(o))) {
      failures.push(`CODEOWNERS:${rule.line} ${rule.pattern} has an invalid owner: ${rule.owners.join(" ")}`);
    }
    if (!trackedFiles.some((f) => rule.re.test(f))) {
      failures.push(`CODEOWNERS:${rule.line} ${rule.pattern} matches no tracked file`);
    }
  }
  for (const { area, file } of requiredAreas) {
    // The last matching rule wins, as on GitHub; a rule without owners leaves the path unowned.
    const winner = rules.filter((r) => r.re.test(file)).at(-1);
    if (!winner || winner.owners.length === 0) {
      failures.push(`required area "${area}" (${file}) has no owner`);
    }
  }
  return failures;
}
