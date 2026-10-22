// Semgrep fixtures for `ocw.live-input-logging` (.semgrep/rules.yml, 07.8-16; `node scripts/guard/run.mjs --rule-tests`).
// Never compiled, linted or scanned by the main guard run: each `ruleid:` line must match on the next line, each `ok:`
// line must not. What a person types while controlling a bot's browser never reaches a logger (D-07, P-10).
import type { LiveClientFrame, LiveInputFrame, SandboxdContextInput } from "@ocw/contracts";

declare const log: {
  info(...args: unknown[]): void;
  debug(...args: unknown[]): void;
  warn(...args: unknown[]): void;
  error(...args: unknown[]): void;
};
declare const req: { log: typeof log };
declare const core: { log: typeof log };

function frameLogged(frame: LiveInputFrame) {
  // ruleid: ocw.live-input-logging
  log.info(frame);
  // ruleid: ocw.live-input-logging
  req.log.debug({ input: frame }, "input frame");
}

function fieldsLogged(frame: { text: string; key: string }, text: string, key: string) {
  // ruleid: ocw.live-input-logging
  req.log.debug({ text });
  // ruleid: ocw.live-input-logging
  core.log.info({ key }, "key pressed");
  // ruleid: ocw.live-input-logging
  log.warn({ typed: frame.text });
  // ruleid: ocw.live-input-logging
  log.error("pressed", frame.key);
  void text;
  void key;
}

function clientFrameLogged(f: LiveClientFrame) {
  // ruleid: ocw.live-input-logging
  log.debug("client frame", f);
}

function batchLogged(input: SandboxdContextInput) {
  // ruleid: ocw.live-input-logging
  core.log.warn({ contextId: input.contextId, events: input.events }, "input not delivered");
}

// 07.8-26: the phone keyboard input (the DOM event and the element), before anything becomes a frame.
function domInputLogged(e: InputEvent, el: HTMLInputElement, c: CompositionEvent, p: ClipboardEvent) {
  // ruleid: ocw.live-input-logging
  console.log(e.data);
  // ruleid: ocw.live-input-logging
  console.debug("typed", el.value);
  // ruleid: ocw.live-input-logging
  console.info({ composed: c.data });
  // ruleid: ocw.live-input-logging
  console.warn(p.clipboardData);
  // ok: ocw.live-input-logging
  console.log(e.inputType);
}

function idsOnly(contextId: string, err: Error) {
  // ok: ocw.live-input-logging
  core.log.warn({ contextId, error: err.name }, "live view input not delivered");
  // ok: ocw.live-input-logging
  log.info({ contextId, state: "controlling" }, "lease taken");
}
