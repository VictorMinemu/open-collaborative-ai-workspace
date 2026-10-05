# Stdio MCP sandbox (`ocw-mcp-sandbox`)

Optional sidecar (decision D-13, research B1) that lets admins offer **stdio** MCP servers to bots without running
third-party code inside the OpenClaw gateway container. Remote MCP servers (`streamable-http` / `sse`) do not need it.

```text
OpenClaw cell ──streamable HTTP──▶ mcp-sandbox:8080/<id>/mcp ──stdio──▶ baked, pinned MCP server (one child per session)
   (internal network `mcp-sandbox`, no egress, no published port)
```

`bridge.mjs` is built on the official SDK transports (`StreamableHTTPServerTransport` ↔ `StdioClientTransport`,
`@modelcontextprotocol/sdk` 1.30.0, the same version as the cell and OpenClaw). It serves only the ids in
`servers.json`. Each MCP session (`initialize`) spawns one child; messages are pumped both ways unchanged.

## Enabling it

```bash
OCW_MCP_SANDBOX_URL=http://mcp-sandbox:8080 OCW_MCP_SANDBOX_SERVERS=everything \
  docker compose --profile mcp-sandbox up -d
```

The API then lets admins register a server with transport `sandboxed-stdio` and one of the vetted ids
(Settings › MCP servers). The cell renders it as the remote server `http://mcp-sandbox:8080/<id>/mcp`, so probing,
the per-tool enable list, `toolFilter`, the call-time tool gate, the taint rule and the `bot.tool_call` audit are the
same as for any remote server. `OCW_MCP_SANDBOX_SERVERS` must only list ids that the image bakes.

## Threat model

| Threat | Mitigation |
|---|---|
| A stdio server reads the gateway's secrets (ChatGPT subscription tokens, cell token, transcripts) | It never runs in the gateway container. The sidecar has no state volume, no secrets and no gateway or provider variables |
| Container escape or abuse | Non-root `node` user, read-only root filesystem, `cap_drop: [ALL]`, `no-new-privileges`, `init`, `pids_limit` 128, 512 MB memory, 1 CPU, `/tmp` the only writable path (tmpfs, `noexec`, 64 MB) |
| Exfiltration by a compromised server | Its only network is `mcp-sandbox` (`internal: true`, no egress), shared with the cell alone. The cell's gateway binds loopback, so nothing in the cell listens on that network |
| Runtime installs, mutable `latest` | Packages are baked at build time with `npm ci` from the committed `package-lock.json` (exact pins, sha512 integrity, `--ignore-scripts`). `npx`, `npm`, `uvx`, `pip` and `-y` are refused by the allowlist validation; the build fails if an entry file is missing (`node bridge.mjs --check`) |
| Process explosion (one child per session) | At most 16 sessions (`MCP_SANDBOX_MAX_SESSIONS`); the 17th gets HTTP 503. A session with no open request for 10 minutes (`MCP_SANDBOX_SESSION_IDLE_MS`) is reaped and its child killed, as on DELETE, child exit and shutdown |
| Server output | Untrusted. The bridge forwards it unchanged (≤ 4 MB per message); the cell marks MCP output as untrusted and the taint rule blocks side-effecting tools after it in the same turn |
| Leaks through the log | One line per session start/end (id prefix, server id, pid, reason); never a payload. A child's stderr is discarded because it may echo payloads |

Child environment: `PATH`, `HOME=/tmp` and only the variables its `servers.json` entry names (copied from the
sidecar's own environment). Everything else the sidecar has (and the SDK's default `USER`, `SHELL`, `TERM`, `LOGNAME`)
is removed. Loader and interpreter hooks (`NODE_OPTIONS`, `LD_*`, `PYTHONPATH`, …) cannot be named.

**Residual risk.** All children run as the same user in one container, so a malicious server could read another
session's process environment or memory. Bake only servers you would trust together, and give servers that need
mutually distrusting secrets separate sidecars. Host paths never reach the cell: the cell only ever sees
`http://mcp-sandbox:8080/<id>/mcp`.

## Adding a server

1. Review the package: source repository, maintainers, release history, what it does on the network and file system,
   and its lifecycle scripts (they never run here, so it must work without them).
2. Pin it: add the exact version to `package.json` `dependencies`, then regenerate the lock with versions at least
   7 days old (the repo's `minimumReleaseAge`):

   ```bash
   cd infra/mcp-sandbox
   npm install --package-lock-only --ignore-scripts --before="$(date -u -v-7d +%F 2>/dev/null || date -u -d '7 days ago' +%F)"
   ```

3. Add an entry to `servers.json`: `id` (lowercase `[a-z0-9_-]`), `package`, `version`, `command: "node"`, `args`
   starting with the entry file under `node_modules/<package>/`, and `env` (names only; values come from the
   sidecar's environment, set them on the compose service).
4. Run the tests, rebuild the image and list the id in `OCW_MCP_SANDBOX_SERVERS`:

   ```bash
   npm ci --prefix infra/mcp-sandbox --ignore-scripts && node --test infra/mcp-sandbox/bridge.test.mjs
   docker compose --profile mcp-sandbox build mcp-sandbox
   ```

**Why runtime installs are forbidden.** `npx -y <pkg>` resolves whatever the registry serves at that moment
(mutable `latest`, typosquats, compromised releases) and runs its install scripts, inside a container the cell talks
to. Baking from a reviewed lockfile makes what runs auditable and reproducible.

The shipped allowlist contains only `everything` (`@modelcontextprotocol/server-everything` 2026.8.31, the MCP
reference test server, legitimacy audit [OK]). It is meant for testing: enable only the tools you need, such as `echo`.

## Tests

```bash
npm ci --prefix infra/mcp-sandbox --ignore-scripts
node --test infra/mcp-sandbox/bridge.test.mjs        # bridge (in process, test/stdio-echo.mjs), lock, compose profile
SMOKE_ONLY=sandbox bash infra/openclaw/test/run-container-smoke.sh   # a bot calls `echo` through the real cell
```

Without `npm ci` the bridge tests are skipped with a hint; the lock and compose checks always run.
