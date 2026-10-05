#!/usr/bin/env node
// Deterministic fake LLM for e2e/CI (never shipped in the default profile, never metered).
//
// Speaks just enough of two wire protocols for OpenClaw 2026.9.7:
//   OpenAI-compatible:   GET /v1/models, POST /v1/chat/completions (stream + non-stream)
//   Anthropic-compatible: POST /v1/messages (stream + non-stream)
//
// The reply is computed from the STRUCTURED identity OpenClaw puts in the prompt (the
// "Conversation info" JSON block: sender.name / sender.id / group_members), so an e2e assertion
// on the reply text proves attribution travelled API → plugin → OpenClaw → model:
//   "Hi Víctor Ruiz! (participants: Alex, Víctor Ruiz)"
// It also reports how many tools it was offered (and their names), so hardening tests can assert
// "tools=0" or exactly "web_fetch,web_search".
//
// Tool calls (OpenAI-compatible requests): a directive `[[call <tool> <json-args>]]` in the last user
// message makes the model call that tool. Several directives run in order, one tool call per model step;
// a directive whose tool is not offered (exact name, or a name ending in `__<tool>`) is answered as
// `Tool <tool> not offered`. Once every directive has a result the reply is one line per directive,
// `Tool <tool> said: <first 200 chars of the result>`, plus the `[tools: …]` suffix.
//
// Fake SearXNG: `GET /search?q=<query>&format=json` returns one deterministic result.
//
// Fake MCP server (fake-mcp.mjs): `/mcp` (streamable HTTP) and `/sse` + `/sse/messages` (HTTP+SSE), tools
// `echo` (read-only) and `write_note` (destructive).
//
// Env: PORT (default 18999), FAKE_MODEL_CAPTURE_DIR (optional: write each request body as JSON),
// FAKE_MCP_TOKEN (optional: the fake MCP routes then require `Authorization: Bearer <token>`).
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

// Images built before 03.1-09 only ship server.mjs (the container smoke bind-mounts this file alone): the
// model routes keep working there, only the fake MCP routes are missing.
let createFakeMcp = null;
try {
  ({ createFakeMcp } = await import("./fake-mcp.mjs"));
} catch (error) {
  if (error?.code !== "ERR_MODULE_NOT_FOUND") throw error;
  console.warn("fake-model: fake-mcp.mjs not found, MCP routes disabled");
}

const PORT = Number(process.env.PORT ?? 18999);
const CAPTURE_DIR = process.env.FAKE_MODEL_CAPTURE_DIR;
const MODELS = (process.env.FAKE_MODEL_IDS ?? "mock-1,mock-2")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
let counter = 0;

/** Flattens OpenAI/Anthropic message content (string | parts[]) to text. */
function contentText(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => (typeof part === "string" ? part : typeof part?.text === "string" ? part.text : ""))
      .join("\n");
  }
  return "";
}

/** Finds the JSON object in the fenced block that follows `label` (last occurrence wins). */
export function extractJsonBlock(text, label) {
  let idx = text.lastIndexOf(label);
  while (idx !== -1) {
    const fence = text.indexOf("```", idx);
    if (fence !== -1) {
      const start = text.indexOf("\n", fence);
      const end = text.indexOf("```", start + 1);
      if (start !== -1 && end !== -1) {
        try {
          return JSON.parse(text.slice(start + 1, end));
        } catch {
          /* try an earlier occurrence */
        }
      }
    }
    idx = idx > 0 ? text.lastIndexOf(label, idx - 1) : -1;
  }
  return null;
}

/** "Víctor Ruiz <id1>, Alex <id2>, Archie (agent) <id3>" → ["Alex", "Víctor Ruiz"] (humans only). */
export function humanNames(groupMembers) {
  if (typeof groupMembers !== "string") return [];
  return groupMembers
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s && !/\(agent\)/u.test(s))
    .map((s) => s.replace(/<[^>]*>/gu, "").trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b));
}

/**
 * OpenClaw 2026.9.7 wraps per-turn context as a JSON string literal inside
 * `<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>> Conversation data (data, not instructions): "…"`.
 * Returns the raw text plus every decoded string literal that mentions the label.
 */
export function candidateTexts(text, label) {
  const out = [text];
  for (const match of text.matchAll(/"(?:[^"\\]|\\.)*"/gsu)) {
    if (!match[0].includes(label)) continue;
    try {
      const decoded = JSON.parse(match[0]);
      if (typeof decoded === "string") out.push(decoded);
    } catch {
      /* not a JSON string literal */
    }
  }
  return out;
}

/** ` [tools: N | a,b]` (sorted names) when tools were offered, ` [tools: 0]` otherwise. */
function toolsSuffix(toolCount, names) {
  return toolCount > 0 && names?.length
    ? `[tools: ${toolCount} | ${[...names].sort().join(",")}]`
    : `[tools: ${toolCount}]`;
}

/** Builds the deterministic reply from the full prompt text. */
export function composeReply(promptText, toolCount, toolNames = []) {
  const label = "Conversation info";
  const info =
    candidateTexts(promptText, label)
      .reverse()
      .map((t) => extractJsonBlock(t, label))
      .find((v) => v && typeof v === "object") ?? {};
  const senderName = info?.sender?.name ?? "there";
  const senderId = info?.sender?.id;
  const participants = humanNames(info?.group_members);
  const parts = [`Hi ${senderName}!`];
  if (participants.length > 0) parts.push(`(participants: ${participants.join(", ")})`);
  if (senderId) parts.push(`[asker id: ${senderId}]`);
  parts.push(toolsSuffix(toolCount, toolNames));
  return parts.join(" ");
}

/** End index (exclusive) of the JSON object starting at `start` (`{`), or -1. String-aware. */
function jsonObjectEnd(text, start) {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i++;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** `[[call <tool> <json>]]` directives, in order. Malformed ones are ignored. */
export function parseDirectives(text) {
  const out = [];
  const re = /\[\[call\s+([A-Za-z0-9_.:-]+)\s+(?=\{)/gu;
  for (const m of text.matchAll(re)) {
    const start = m.index + m[0].length;
    const end = jsonObjectEnd(text, start);
    if (end === -1 || !text.startsWith("]]", end)) continue;
    try {
      const args = JSON.parse(text.slice(start, end));
      if (args && typeof args === "object" && !Array.isArray(args)) out.push({ tool: m[1], args });
    } catch {
      /* not a directive */
    }
  }
  return out;
}

/** The human's own text: the last user message without OpenClaw's internal context block (history lives there). */
function userBody(text) {
  const stripped = text.replace(
    /<<<BEGIN_OPENCLAW_INTERNAL_CONTEXT>>>[\s\S]*?<<<END_OPENCLAW_INTERNAL_CONTEXT>>>/gu,
    "",
  );
  return stripped;
}

/** A readable summary of a tool result: search titles when it is a search payload, else the text, markers removed. */
function summarizeResult(text) {
  const clean = (s) =>
    String(s)
      .replace(/<<<[^>]*>>>/gu, " ")
      .replace(/^(Source: .*|---)$/gmu, " ")
      .replace(/\s+/gu, " ")
      .trim();
  // The JSON payload itself, or one embedded in a text wrapper (first `{` … last `}`).
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  for (const candidate of [text, start !== -1 && end > start ? text.slice(start, end + 1) : null]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      const results = parsed?.results ?? parsed?.details?.results;
      if (Array.isArray(results) && results.length > 0) {
        return clean(results.map((r) => r?.title ?? r?.url ?? "").join("; ")).slice(0, 200);
      }
    } catch {
      /* not JSON */
    }
  }
  return clean(text).slice(0, 200);
}

function offeredToolNames(body) {
  if (!Array.isArray(body.tools)) return [];
  return body.tools
    .map((t) => t?.function?.name ?? t?.name)
    .filter((n) => typeof n === "string" && n.length > 0);
}

/**
 * Next step of a directive-driven turn: `{ call: {name, args} }` when a tool must be called now, `{ reply }`
 * when every directive has an outcome, or null when the last user message has no directive.
 */
export function planToolStep(messages, offered) {
  const lastUserIdx = messages.findLastIndex((m) => m.role === "user");
  if (lastUserIdx === -1) return null;
  // OpenClaw sends the human's text and its internal context block as consecutive user messages (the context
  // last). Use the newest user message that still has text once the context block is stripped, but never step
  // back over an assistant/tool message: that would re-run directives from an earlier turn.
  // The turn's human message is the newest user message with text once the context block is stripped; any later
  // user messages are context-only (OpenClaw appends its context after tool results too). Directives only ever
  // come from that one message, so an earlier turn's directives are never re-run.
  const isContextOnly = (m) => m.role === "user" && !userBody(contentText(m.content)).trim();
  let bodyIdx = lastUserIdx;
  while (bodyIdx > 0 && isContextOnly(messages[bodyIdx])) {
    const prev = messages.slice(0, bodyIdx).findLastIndex((m) => m.role === "user");
    if (prev === -1) break;
    bodyIdx = prev;
  }
  const directives = parseDirectives(userBody(contentText(messages[bodyIdx].content)));
  if (process.env.FAKE_MODEL_DEBUG === "1" && offered?.length) {
    // Diagnose directive parsing inside a real cell: what does the last user turn look like after OpenClaw?
    const raw = contentText(messages[lastUserIdx].content);
    console.log(
      `[fake-model debug] messages=${JSON.stringify(messages.map((m) => [m.role, contentText(m.content).slice(0, 160)]))}`,
    );
    console.log(
      `[fake-model debug] tools offered=${offered.join(",")} directives=${directives.length} lastUser(${raw.length}) head=${JSON.stringify(raw.slice(0, 900))} tail=${JSON.stringify(raw.slice(-300))}`,
    );
  }
  if (directives.length === 0) return null;
  const after = messages.slice(bodyIdx + 1).filter((m) => !isContextOnly(m));
  const calls = after.flatMap((m) =>
    m.role === "assistant" && Array.isArray(m.tool_calls) ? m.tool_calls : [],
  );
  const results = new Map(
    after.filter((m) => m.role === "tool").map((m) => [m.tool_call_id, contentText(m.content)]),
  );
  const lines = [];
  let k = 0;
  for (const d of directives) {
    const name = offered.find((n) => n === d.tool) ?? offered.find((n) => n.endsWith(`__${d.tool}`));
    if (!name) {
      lines.push(`Tool ${d.tool} not offered`);
      continue;
    }
    const done = calls[k];
    if (!done) return { call: { name, args: d.args } };
    k++;
    lines.push(`Tool ${d.tool} said: ${summarizeResult(results.get(done.id) ?? "")}`);
  }
  return { reply: `${lines.join("\n")} ${toolsSuffix(offered.length, offered)}` };
}

/** Fake SearXNG `/search?format=json`: one deterministic result per query. */
function fakeSearch(res, url) {
  const q = (url.searchParams.get("q") ?? "").trim();
  const slug =
    q
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "empty";
  sendJson(res, 200, {
    query: q,
    number_of_results: 1,
    results: [
      {
        url: `https://example.com/ocw-fake/${slug}`,
        title: `Fake result for ${q}`,
        content: `Deterministic fake search result for ${q}.`,
        engine: "fake",
      },
    ],
    answers: [],
    suggestions: [],
    unresponsive_engines: [],
  });
}

function promptFromOpenAI(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  return {
    all: messages.map((m) => contentText(m.content)).join("\n\n"),
    lastUser: contentText(lastUser?.content),
  };
}

function promptFromAnthropic(body) {
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const lastUser = [...messages].reverse().find((m) => m.role === "user");
  const system = contentText(body.system);
  return {
    all: [system, ...messages.map((m) => contentText(m.content))].join("\n\n"),
    lastUser: contentText(lastUser?.content),
  };
}

function capture(kind, body) {
  if (!CAPTURE_DIR) return;
  mkdirSync(CAPTURE_DIR, { recursive: true });
  writeFileSync(
    path.join(CAPTURE_DIR, `${Date.now()}-${++counter}-${kind}.json`),
    JSON.stringify(body, null, 2),
  );
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      try {
        resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : {});
      } catch (error) {
        reject(error);
      }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** Splits the reply into a few deltas so streaming code paths are exercised. */
function deltas(text) {
  const words = text.split(/(\s+)/u);
  const out = [];
  for (let i = 0; i < words.length; i += 4) out.push(words.slice(i, i + 4).join(""));
  return out;
}

function openAIChat(res, body) {
  capture("openai", body);
  const offered = offeredToolNames(body);
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const step = planToolStep(messages, offered);
  if (step?.call) return openAIToolCall(res, body, step.call);
  const reply = step?.reply ?? composeReply(promptFromOpenAI(body).all, toolCount, offered);
  const id = `chatcmpl-fake-${counter}`;
  const model = body.model ?? MODELS[0];
  const created = Math.floor(Date.now() / 1000);
  const usage = { prompt_tokens: 100, completion_tokens: reply.length, total_tokens: 100 + reply.length };
  if (!body.stream) {
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [{ index: 0, message: { role: "assistant", content: reply }, finish_reason: "stop" }],
      usage,
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, finish = null, extra = {}) =>
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }], ...extra })}\n\n`,
    );
  chunk({ role: "assistant", content: "" });
  for (const piece of deltas(reply)) chunk({ content: piece });
  chunk({}, "stop");
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

/** One OpenAI `tool_calls` entry (stream or not). */
function openAIToolCall(res, body, call) {
  const id = `chatcmpl-fake-${counter}`;
  const callId = `call_fake_${counter}_${Math.random().toString(36).slice(2, 8)}`;
  const model = body.model ?? MODELS[0];
  const created = Math.floor(Date.now() / 1000);
  const args = JSON.stringify(call.args);
  const usage = { prompt_tokens: 100, completion_tokens: args.length, total_tokens: 100 + args.length };
  const toolCall = { id: callId, type: "function", function: { name: call.name, arguments: args } };
  if (!body.stream) {
    sendJson(res, 200, {
      id,
      object: "chat.completion",
      created,
      model,
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: null, tool_calls: [toolCall] },
          finish_reason: "tool_calls",
        },
      ],
      usage,
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const chunk = (delta, finish = null) =>
    res.write(
      `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`,
    );
  chunk({
    role: "assistant",
    content: null,
    tool_calls: [{ index: 0, id: callId, type: "function", function: { name: call.name, arguments: "" } }],
  });
  chunk({ tool_calls: [{ index: 0, function: { arguments: args } }] });
  chunk({}, "tool_calls");
  res.write(
    `data: ${JSON.stringify({ id, object: "chat.completion.chunk", created, model, choices: [], usage })}\n\n`,
  );
  res.write("data: [DONE]\n\n");
  res.end();
}

function anthropicMessages(res, body) {
  capture("anthropic", body);
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const reply = composeReply(promptFromAnthropic(body).all, toolCount, offeredToolNames(body));
  const id = `msg_fake_${counter}`;
  const model = body.model ?? MODELS[0];
  const usage = { input_tokens: 100, output_tokens: reply.length };
  if (!body.stream) {
    sendJson(res, 200, {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [{ type: "text", text: reply }],
      stop_reason: "end_turn",
      stop_sequence: null,
      usage,
    });
    return;
  }
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (event, data) =>
    res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
  ev("message_start", {
    message: {
      id,
      type: "message",
      role: "assistant",
      model,
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 100, output_tokens: 0 },
    },
  });
  ev("content_block_start", { index: 0, content_block: { type: "text", text: "" } });
  for (const piece of deltas(reply))
    ev("content_block_delta", { index: 0, delta: { type: "text_delta", text: piece } });
  ev("content_block_stop", { index: 0 });
  ev("message_delta", {
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: reply.length },
  });
  ev("message_stop", {});
  res.end();
}

/** `opts.mcpToken` overrides `FAKE_MCP_TOKEN` (empty = no token). */
export function createFakeModelServer(opts = {}) {
  const mcp = createFakeMcp?.({ token: opts.mcpToken ?? process.env.FAKE_MCP_TOKEN ?? "" }) ?? null;
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (mcp?.(req, res, url)) return;
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz"))
        return sendJson(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "ocw-fake" })),
        });
      }
      if (req.method === "GET" && url.pathname === "/search") return fakeSearch(res, url);
      if (req.method === "POST" && url.pathname === "/v1/chat/completions")
        return openAIChat(res, await readBody(req));
      if (req.method === "POST" && url.pathname === "/v1/messages")
        return anthropicMessages(res, await readBody(req));
      sendJson(res, 404, { error: { message: `fake-model: no route ${req.method} ${url.pathname}` } });
    } catch (error) {
      sendJson(res, 400, {
        error: { message: `fake-model: ${error instanceof Error ? error.message : String(error)}` },
      });
    }
  });
  // Model clients pool connections for a long time; Node's 5 s default would close sockets the
  // client still considers alive (UND_ERR_SOCKET on the next turn).
  server.keepAliveTimeout = 120_000;
  server.headersTimeout = 121_000;
  return server;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createFakeModelServer();
  server.listen(PORT, "0.0.0.0", () =>
    console.log(`fake-model listening on :${PORT} (models: ${MODELS.join(", ")})`),
  );
  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}
