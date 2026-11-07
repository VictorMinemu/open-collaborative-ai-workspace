// node --test infra/sandbox/browser/world.test.mjs
//
// The browser agent's isolated world (world.mjs) against a fake CDP session whose main frame can commit a navigation
// between two calls, as the stack smoke's takeover hit once (pipeline 145: "takeover off" right after the person's
// submit click, Runtime.evaluate on the replaced document's context -> op_error "Error" -> 503).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createWorld, replaceWorldScript, WORLD, WORLD_ATTEMPTS } from "./world.mjs";

/**
 * A main frame whose document id moves on every `navigate()`; an isolated world's context belongs to the document it
 * was created in, as in Chromium. `navigateAfter` commits a navigation right after the named method answers, once
 * per entry.
 */
function fakeCdp({ navigateAfter = [] } = {}) {
  let doc = 1;
  let nextContext = 100;
  const contexts = new Map();
  const scripts = new Map();
  let nextScript = 1;
  const calls = [];
  const pending = [...navigateAfter];
  const answer = (method, result) => {
    if (pending[0] === method) {
      pending.shift();
      doc += 1;
    }
    return result;
  };
  return {
    calls,
    scripts,
    documents: () => doc,
    async send(method, params = {}) {
      calls.push(method);
      switch (method) {
        case "Page.getFrameTree":
          return answer(method, { frameTree: { frame: { id: "main" } } });
        case "Page.createIsolatedWorld": {
          assert.equal(params.worldName, WORLD);
          assert.equal(params.grantUniveralAccess, false);
          const id = nextContext++;
          contexts.set(id, doc);
          return answer(method, { executionContextId: id });
        }
        case "Runtime.evaluate":
          if (contexts.get(params.contextId) !== doc)
            throw new Error("Protocol error (Runtime.evaluate): Cannot find context with specified id");
          return answer(method, { result: { type: "undefined" } });
        case "Page.addScriptToEvaluateOnNewDocument": {
          const identifier = String(nextScript++);
          scripts.set(identifier, params.source);
          return answer(method, { identifier });
        }
        case "Page.removeScriptToEvaluateOnNewDocument":
          scripts.delete(params.identifier);
          return answer(method, {});
        default:
          throw new Error(`unexpected ${method}`);
      }
    },
  };
}

const quick = { retryMs: 1 };

describe("createWorld", () => {
  it("installs the script in the current document and returns its world's context", async () => {
    const cdp = fakeCdp();
    const id = await createWorld(cdp, false, quick);
    assert.equal(typeof id, "number");
    assert.deepEqual(cdp.calls, ["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]);
  });

  it("starts over on the new document when a navigation commits between creating the world and using it", async () => {
    const cdp = fakeCdp({ navigateAfter: ["Page.createIsolatedWorld"] });
    const id = await createWorld(cdp, false, quick);
    assert.equal(cdp.documents(), 2);
    assert.equal(cdp.calls.filter((m) => m === "Page.createIsolatedWorld").length, 2);
    assert.equal(cdp.calls.at(-1), "Runtime.evaluate");
    assert.equal(typeof id, "number");
  });

  it("gives up after WORLD_ATTEMPTS and throws the last error", async () => {
    const cdp = fakeCdp({ navigateAfter: Array(WORLD_ATTEMPTS).fill("Page.createIsolatedWorld") });
    await assert.rejects(createWorld(cdp, true, quick), /Cannot find context with specified id/u);
    assert.equal(cdp.calls.filter((m) => m === "Runtime.evaluate").length, WORLD_ATTEMPTS);
  });

  it("sets the takeover flag it is given in the document", async () => {
    const cdp = fakeCdp();
    const sent = [];
    const send = cdp.send.bind(cdp);
    cdp.send = (method, params) => {
      if (method === "Runtime.evaluate") sent.push(params.expression);
      return send(method, params);
    };
    await createWorld(cdp, true, quick);
    await createWorld(cdp, false, quick);
    assert.match(sent[0], /globalThis\.__ocw\.setActive\(true\)/u);
    assert.match(sent[1], /globalThis\.__ocw\.setActive\(false\)/u);
  });
});

describe("replaceWorldScript", () => {
  it("registers the new script before dropping the old one, so no new document goes without it", async () => {
    const cdp = fakeCdp();
    const first = await replaceWorldScript(cdp, null, true);
    assert.deepEqual(cdp.calls, ["Page.addScriptToEvaluateOnNewDocument"]);
    const second = await replaceWorldScript(cdp, first, false);
    assert.deepEqual(cdp.calls.slice(1), [
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
    ]);
    assert.notEqual(second, first);
    assert.deepEqual([...cdp.scripts.keys()], [second]);
    assert.match(cdp.scripts.get(second), /let active = false;/u);
  });
});
