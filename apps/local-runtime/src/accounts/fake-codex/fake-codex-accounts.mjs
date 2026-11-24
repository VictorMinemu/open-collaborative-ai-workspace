#!/usr/bin/env node
// Phase 07.18-08: a fake `codex app-server` for the account methods only, for the `ocw-runtime account` tests. Never a
// real Codex and never a real ChatGPT account: it answers `initialize`, `account/login/start` (device code),
// `account/login/cancel`, `account/read` and `account/logout` over newline-delimited JSON-RPC on stdio, and "signs in"
// by writing a dummy `auth.json` into `CODEX_HOME` (as Codex does), which `account/logout` deletes.
//
// Plain Node with no import statements (built-ins through `process.getBuiltinModule`), so a copy runs from anywhere.
//
//   FAKE_CODEX_LOGIN=success (default) | denied     how the sign-in ends, 50 ms after the code was handed over
//   FAKE_CODEX_PLAN=plus (default)                  the plan `account/read` reports once signed in

const fs = process.getBuiltinModule("node:fs");
const path = process.getBuiltinModule("node:path");

if (process.argv[2] !== "app-server") {
  process.stderr.write("fake codex: only app-server is supported\n");
  process.exit(2);
}

const home = process.env.CODEX_HOME;
if (!home) {
  process.stderr.write("fake codex: CODEX_HOME is required\n");
  process.exit(2);
}
const auth = path.join(home, "auth.json");
const outcome = process.env.FAKE_CODEX_LOGIN ?? "success";
const plan = process.env.FAKE_CODEX_PLAN ?? "plus";

const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);

function handle(m) {
  if (m.id === undefined) return;
  switch (m.method) {
    case "initialize":
      send({ id: m.id, result: { userAgent: "fake-codex/0.0.0" } });
      return;
    case "account/login/start":
      send({
        id: m.id,
        result: {
          type: "chatgptDeviceCode",
          loginId: "fake-login",
          verificationUrl: "https://auth.example.test/codex/device",
          userCode: "FAKE-0001",
        },
      });
      setTimeout(() => {
        if (outcome === "success") fs.writeFileSync(auth, JSON.stringify({ fake: true }), { mode: 0o600 });
        send({
          method: "account/login/completed",
          params: {
            loginId: "fake-login",
            success: outcome === "success",
            error: outcome === "success" ? null : "access_denied",
          },
        });
      }, 50);
      return;
    case "account/login/cancel":
      send({ id: m.id, result: { status: "canceled" } });
      return;
    case "account/read":
      send({
        id: m.id,
        result: fs.existsSync(auth)
          ? {
              account: {
                type: "chatgpt",
                email: "someone@example.test",
                planType: plan,
                workspaceName: null,
              },
              requiresOpenaiAuth: true,
            }
          : { account: null, requiresOpenaiAuth: true },
      });
      return;
    case "account/logout":
      fs.rmSync(auth, { force: true });
      send({ id: m.id, result: {} });
      return;
    default:
      send({ id: m.id, error: { code: -32601, message: `method not found: ${m.method}` } });
  }
}

let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buf += chunk;
  for (let i = buf.indexOf("\n"); i >= 0; i = buf.indexOf("\n")) {
    const line = buf.slice(0, i).trim();
    buf = buf.slice(i + 1);
    if (line) handle(JSON.parse(line));
  }
});
process.stdin.on("end", () => process.exit(0));
process.on("SIGTERM", () => process.exit(0));
