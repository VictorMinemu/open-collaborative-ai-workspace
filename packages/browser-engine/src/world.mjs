// The browser agent's isolated world (07.8-07, D-07, P-10): the script it installs in every document of a context's
// page, in `WORLD` only, and the CDP calls that create the world and keep the script registered. No dependencies; the
// CDP session is passed in (agent.mjs gives its Playwright CDPSession), so world.test.mjs drives it with a fake.
//
// A navigation can commit while these calls run (a takeover ends right after the person's click submitted a form, a
// bot op follows a redirect): the main frame keeps its id but its document, and with it the world's execution context,
// is replaced. `createWorld` then starts over on the new document instead of failing the op.

export const WORLD = "__ocw_agent_world";

/*
 * Installed in every document of a context's page, in `WORLD` only. It marks the editable elements that receive a
 * trusted input event while a takeover is active (window capture listeners, registered before any page script), and
 * reads the DOM facts the redaction needs. It never reads an element's value.
 */
export const worldScript = (active) => `(() => {
  if (globalThis.__ocw) { globalThis.__ocw.setActive(${active ? "true" : "false"}); return; }
  const marked = new Set();
  let active = ${active ? "true" : "false"};
  const editable = (el) => !!el && el.nodeType === 1 &&
    (el.localName === "input" || el.localName === "textarea" || el.localName === "select" || el.isContentEditable);
  const mark = (e) => {
    if (!active || !e.isTrusted) return;
    const path = typeof e.composedPath === "function" ? e.composedPath() : [];
    for (const el of [path[0], e.target]) if (editable(el)) marked.add(el);
  };
  for (const t of ["keydown", "beforeinput", "input", "change", "paste", "drop", "compositionend"]) {
    window.addEventListener(t, mark, true);
  }
  const collect = (root, out) => {
    for (const el of root.querySelectorAll("*")) {
      if (editable(el)) out.push(el);
      if (el.shadowRoot) collect(el.shadowRoot, out);
    }
    return out;
  };
  const text = (s) => (typeof s === "string" ? s.replace(/\\s+/g, " ").trim().slice(0, 200) : null);
  const facts = (el) => {
    const cs = getComputedStyle(el);
    const tag = el.localName;
    return {
      tag,
      type: tag === "input" ? String(el.type || "text").toLowerCase() : tag === "textarea" || tag === "select" ? tag : "contenteditable",
      autocomplete: el.getAttribute("autocomplete"),
      textSecurity: cs.getPropertyValue("-webkit-text-security") || "none",
      label: text(Array.from(el.labels || []).map((l) => l.textContent).join(" ")),
      attrName: el.getAttribute("name"),
      attrId: el.id || null,
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
    };
  };
  const focused = () => {
    let el = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return editable(el) ? el : null;
  };
  globalThis.__ocw = {
    setActive(v) { active = !!v; },
    fields() { return collect(document, []); },
    marked() { return Array.from(marked).filter((el) => el.isConnected); },
    factsOf(list) { return list.map(facts); },
    focusFacts() { const el = focused(); return el ? facts(el) : null; },
    anyMarked() { return marked.size > 0; },
  };
})();`;

/** How often `createWorld` starts over when a navigation replaced the document mid-way, and the pause between. */
export const WORLD_ATTEMPTS = 4;
const RETRY_MS = 50;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function createWorldOnce(cdp, active) {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: WORLD,
    grantUniveralAccess: false,
  });
  // The current document may predate the new-document script (or the world): install idempotently.
  await cdp.send("Runtime.evaluate", { contextId: executionContextId, expression: worldScript(active) });
  return executionContextId;
}

/**
 * The world's execution context in the main frame's current document, with the script installed and its takeover
 * flag set to `active`. A context destroyed by a navigation that committed between these calls ("Cannot find context
 * with specified id") is not an error of the op: it starts over on the new document, up to `WORLD_ATTEMPTS` times,
 * then throws the last error.
 */
export async function createWorld(cdp, active, { attempts = WORLD_ATTEMPTS, retryMs = RETRY_MS } = {}) {
  for (let attempt = 1; ; attempt++) {
    try {
      return await createWorldOnce(cdp, active);
    } catch (err) {
      if (attempt >= attempts) throw err;
      await sleep(retryMs);
    }
  }
}

/**
 * Registers the script with `active` for every new document and drops the previous registration `oldId`, in that
 * order: a document that commits in between runs both (the newer one only sets the flag), never neither. Resolves
 * with the new registration's identifier.
 */
export async function replaceWorldScript(cdp, oldId, active) {
  const { identifier } = await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
    source: worldScript(active),
    worldName: WORLD,
  });
  if (oldId)
    await cdp.send("Page.removeScriptToEvaluateOnNewDocument", { identifier: oldId }).catch(() => {});
  return identifier;
}
