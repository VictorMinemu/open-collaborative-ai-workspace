// The browser agent's isolated world (world.mjs) from the shared package (07.13 D-04), ported case for case from
// infra/sandbox/browser/world.test.mjs (node:test) to vitest: a fake CDP session whose main frame can commit a
// navigation between two calls, as the stack smoke's takeover hit once (pipeline 145: "takeover off" right after the
// person's submit click, Runtime.evaluate on the replaced document's context -> op_error "Error" -> 503).
import { describe, expect, it } from "vitest";
import { createWorld, replaceWorldScript, WORLD, WORLD_ATTEMPTS } from "./world.mjs";

interface Params {
  worldName?: string;
  grantUniveralAccess?: boolean;
  contextId?: number;
  source?: string;
  identifier?: string;
  expression?: string;
}

/**
 * A main frame whose document id moves on every navigation; an isolated world's context belongs to the document it
 * was created in, as in Chromium. `navigateAfter` commits a navigation right after the named method answers, once
 * per entry.
 */
function fakeCdp({ navigateAfter = [] as string[] } = {}) {
  let doc = 1;
  let nextContext = 100;
  const contexts = new Map<number, number>();
  const scripts = new Map<string, string | undefined>();
  let nextScript = 1;
  const calls: string[] = [];
  const pending = [...navigateAfter];
  const answer = <T>(method: string, result: T): T => {
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
    async send(method: string, params: Params = {}): Promise<unknown> {
      calls.push(method);
      switch (method) {
        case "Page.getFrameTree":
          return answer(method, { frameTree: { frame: { id: "main" } } });
        case "Page.createIsolatedWorld": {
          expect(params.worldName).toBe(WORLD);
          expect(params.grantUniveralAccess).toBe(false);
          const id = nextContext++;
          contexts.set(id, doc);
          return answer(method, { executionContextId: id });
        }
        case "Runtime.evaluate":
          if (params.contextId === undefined || contexts.get(params.contextId) !== doc)
            throw new Error("Protocol error (Runtime.evaluate): Cannot find context with specified id");
          return answer(method, { result: { type: "undefined" } });
        case "Page.addScriptToEvaluateOnNewDocument": {
          const identifier = String(nextScript++);
          scripts.set(identifier, params.source);
          return answer(method, { identifier });
        }
        case "Page.removeScriptToEvaluateOnNewDocument":
          if (params.identifier !== undefined) scripts.delete(params.identifier);
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
    expect(typeof id).toBe("number");
    expect(cdp.calls).toEqual(["Page.getFrameTree", "Page.createIsolatedWorld", "Runtime.evaluate"]);
  });

  it("starts over on the new document when a navigation commits between creating the world and using it", async () => {
    const cdp = fakeCdp({ navigateAfter: ["Page.createIsolatedWorld"] });
    const id = await createWorld(cdp, false, quick);
    expect(cdp.documents()).toBe(2);
    expect(cdp.calls.filter((m) => m === "Page.createIsolatedWorld").length).toBe(2);
    expect(cdp.calls.at(-1)).toBe("Runtime.evaluate");
    expect(typeof id).toBe("number");
  });

  it("gives up after WORLD_ATTEMPTS and throws the last error", async () => {
    const cdp = fakeCdp({ navigateAfter: Array(WORLD_ATTEMPTS).fill("Page.createIsolatedWorld") });
    await expect(createWorld(cdp, true, quick)).rejects.toThrow(/Cannot find context with specified id/u);
    expect(cdp.calls.filter((m) => m === "Runtime.evaluate").length).toBe(WORLD_ATTEMPTS);
  });

  it("sets the takeover flag it is given in the document", async () => {
    const cdp = fakeCdp();
    const sent: string[] = [];
    const send = cdp.send.bind(cdp);
    cdp.send = (method: string, params: Params = {}) => {
      if (method === "Runtime.evaluate") sent.push(String(params.expression));
      return send(method, params);
    };
    await createWorld(cdp, true, quick);
    await createWorld(cdp, false, quick);
    expect(sent[0]).toMatch(/globalThis\.__ocw\.setActive\(true\)/u);
    expect(sent[1]).toMatch(/globalThis\.__ocw\.setActive\(false\)/u);
  });
});

describe("replaceWorldScript", () => {
  it("registers the new script before dropping the old one, so no new document goes without it", async () => {
    const cdp = fakeCdp();
    const first = await replaceWorldScript(cdp, null, true);
    expect(cdp.calls).toEqual(["Page.addScriptToEvaluateOnNewDocument"]);
    const second = await replaceWorldScript(cdp, first, false);
    expect(cdp.calls.slice(1)).toEqual([
      "Page.addScriptToEvaluateOnNewDocument",
      "Page.removeScriptToEvaluateOnNewDocument",
    ]);
    expect(second).not.toBe(first);
    expect([...cdp.scripts.keys()]).toEqual([second]);
    expect(cdp.scripts.get(second)).toMatch(/let active = false;/u);
  });
});
