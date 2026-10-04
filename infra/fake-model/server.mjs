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
// It also reports how many tools it was offered, so hardening tests can assert "tools=0".
//
// Env: PORT (default 18999), FAKE_MODEL_CAPTURE_DIR (optional: write each request body as JSON).
import { mkdirSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import path from "node:path";
import { pathToFileURL } from "node:url";

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

/** Builds the deterministic reply from the full prompt text. */
export function composeReply(promptText, toolCount) {
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
  parts.push(`[tools: ${toolCount}]`);
  return parts.join(" ");
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
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const reply = composeReply(promptFromOpenAI(body).all, toolCount);
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

function anthropicMessages(res, body) {
  capture("anthropic", body);
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;
  const reply = composeReply(promptFromAnthropic(body).all, toolCount);
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

export function createFakeModelServer() {
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/health" || url.pathname === "/healthz"))
        return sendJson(res, 200, { ok: true });
      if (req.method === "GET" && url.pathname === "/v1/models") {
        return sendJson(res, 200, {
          object: "list",
          data: MODELS.map((id) => ({ id, object: "model", created: 0, owned_by: "ocw-fake" })),
        });
      }
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
