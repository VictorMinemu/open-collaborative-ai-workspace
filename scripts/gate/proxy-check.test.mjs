// node --test scripts/gate/proxy-check.test.mjs
//
// The runtime file body step of the proxy gate (07.17.1.1-15, A-02), without Docker: the verdict on what the proxy
// answered, the streamed body (never one 30 MiB buffer), and the request against loopback servers that behave like
// the API (an early 401) and like a proxy with a body limit (nginx's 413).
import assert from "node:assert/strict";
import http from "node:http";
import { describe, it } from "node:test";
import {
  bodyChunks,
  putRuntimeFileBody,
  RUNTIME_FILE_BODY_BYTES,
  runtimeFileBodyVerdict,
} from "./proxy-check.mjs";

const UNAUTHORIZED = JSON.stringify({ error: { code: "unauthorized", message: "Invalid device token" } });
const JSON_TYPE = "application/json; charset=utf-8";

/** A loopback server; `handler(req, res, seen)` where `seen` records the request line, headers and bytes read. */
async function server(handler) {
  const seen = [];
  const srv = http.createServer((req, res) => {
    const entry = { method: req.method, url: req.url, headers: req.headers, received: 0 };
    seen.push(entry);
    handler(req, res, entry);
  });
  await new Promise((resolve) => srv.listen(0, "127.0.0.1", resolve));
  const { port } = srv.address();
  return {
    origin: `http://127.0.0.1:${port}`,
    seen,
    close: () =>
      new Promise((resolve) => {
        srv.closeAllConnections();
        srv.close(resolve);
      }),
  };
}

describe("runtimeFileBodyVerdict", () => {
  it("passes only the API's own JSON 401", () => {
    assert.deepEqual(runtimeFileBodyVerdict({ status: 401, contentType: JSON_TYPE, body: UNAUTHORIZED }), {
      ok: true,
      reason: "api_401",
    });
  });

  it("fails a proxy's 413, 502 and 504, naming them", () => {
    for (const [status, reason] of [
      [413, "proxy_body_limit"],
      [502, "proxy_error"],
      [504, "proxy_error"],
    ]) {
      const verdict = runtimeFileBodyVerdict({ status, contentType: "text/html", body: "<html>nope</html>" });
      assert.deepEqual(verdict, { ok: false, reason }, `status ${status}`);
    }
  });

  it("fails a 401 that is not the API's JSON (a proxy's own page or an empty body)", () => {
    assert.equal(
      runtimeFileBodyVerdict({ status: 401, contentType: "text/html", body: "<h1>401</h1>" }).ok,
      false,
    );
    assert.equal(runtimeFileBodyVerdict({ status: 401, contentType: JSON_TYPE, body: "" }).ok, false);
    assert.equal(runtimeFileBodyVerdict({ status: 401, contentType: JSON_TYPE, body: "{}" }).ok, false);
    assert.equal(
      runtimeFileBodyVerdict({ status: 401, contentType: JSON_TYPE, body: "not json" }).reason,
      "not_json",
    );
  });

  it("fails any other answer and a request that got none", () => {
    assert.deepEqual(runtimeFileBodyVerdict({ status: 200, contentType: JSON_TYPE, body: "{}" }), {
      ok: false,
      reason: "unexpected_status",
    });
    assert.deepEqual(
      runtimeFileBodyVerdict({ status: null, contentType: null, body: "", error: "ECONNRESET" }),
      {
        ok: false,
        reason: "no_answer",
      },
    );
  });
});

describe("bodyChunks", () => {
  it("yields exactly the requested bytes in chunks of at most 1 MiB", () => {
    let total = 0;
    let largest = 0;
    let count = 0;
    for (const chunk of bodyChunks(RUNTIME_FILE_BODY_BYTES)) {
      total += chunk.length;
      largest = Math.max(largest, chunk.length);
      count += 1;
    }
    assert.equal(RUNTIME_FILE_BODY_BYTES, 30 * 1024 * 1024);
    assert.equal(total, RUNTIME_FILE_BODY_BYTES);
    assert.ok(largest <= 1024 * 1024, `largest chunk ${largest}`);
    assert.equal(count, 30);
  });

  it("handles a size that is not a whole number of chunks", () => {
    const sizes = [...bodyChunks(2.5 * 1024 * 1024)].map((c) => c.length);
    assert.deepEqual(sizes, [1024 * 1024, 1024 * 1024, 512 * 1024]);
  });
});

describe("putRuntimeFileBody", () => {
  it("PUTs the declared length to /api/v1/runtime/files/<uuid>, octet-stream, with no authorization", async () => {
    const srv = await server((req, res, entry) => {
      req.on("data", (c) => {
        entry.received += c.length;
      });
      req.on("end", () => {
        res.writeHead(401, { "content-type": JSON_TYPE });
        res.end(UNAUTHORIZED);
      });
    });
    try {
      const bytes = 3 * 1024 * 1024 + 7;
      const res = await putRuntimeFileBody(srv.origin, { bytes, timeoutMs: 20_000 });
      const [req] = srv.seen;
      assert.equal(req.method, "PUT");
      assert.match(
        req.url,
        /^\/api\/v1\/runtime\/files\/[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
      );
      assert.equal(req.headers["content-type"], "application/octet-stream");
      assert.equal(req.headers["content-length"], String(bytes));
      assert.equal(req.headers.authorization, undefined);
      assert.equal(req.received, bytes);
      assert.equal(res.status, 401);
      assert.equal(res.sentBytes, bytes);
      assert.equal(runtimeFileBodyVerdict(res).ok, true);
    } finally {
      await srv.close();
    }
  });

  it("returns the API's early 401 even when it answers before reading the body", async () => {
    const srv = await server((_req, res) => {
      res.writeHead(401, { "content-type": JSON_TYPE });
      res.end(UNAUTHORIZED);
    });
    try {
      const res = await putRuntimeFileBody(srv.origin, { bytes: 8 * 1024 * 1024, timeoutMs: 20_000 });
      assert.equal(res.status, 401);
      assert.deepEqual(runtimeFileBodyVerdict(res), { ok: true, reason: "api_401" });
    } finally {
      await srv.close();
    }
  });

  it("a proxy that limits bodies (413 on the declared length, connection closed) fails the verdict", async () => {
    const srv = await server((req, res) => {
      if (Number(req.headers["content-length"]) > 1024 * 1024) {
        res.writeHead(413, { "content-type": "text/html", connection: "close" });
        res.end("<html><body>413 Request Entity Too Large</body></html>");
        req.socket.end();
        return;
      }
      res.writeHead(401, { "content-type": JSON_TYPE });
      res.end(UNAUTHORIZED);
    });
    try {
      const res = await putRuntimeFileBody(srv.origin, { bytes: 4 * 1024 * 1024, timeoutMs: 20_000 });
      assert.equal(res.status, 413);
      assert.deepEqual(runtimeFileBodyVerdict(res), { ok: false, reason: "proxy_body_limit" });
    } finally {
      await srv.close();
    }
  });
});
