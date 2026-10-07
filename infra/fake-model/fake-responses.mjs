// Fake OpenAI Responses API for the ChatGPT-plan AI chat backend (Phase 5, never metered, never real).
//
//   POST /v1/responses  (stream:true)  SSE in the shape @ai-sdk/openai 4.0.80 parses:
//     response.created → response.output_item.added → response.content_part.added →
//     response.output_text.delta × n → response.output_text.done → response.content_part.done →
//     response.output_item.done → response.completed (usage)
//   The reply is `Echo: <last user text without [[directives]]>` plus ` [images:N]` / ` [files:N]`.
//
// Directives in the last user message:
//   [[slow]]                     the echo, then counting " 1" … " 40": 40 deltas 100 ms apart (stop tests)
//   [[plan:usage_limit]]         3 deltas, then response.failed `subscription_sharing_usage_limit_exceeded`
//   [[plan:not_eligible]]        403 `subscription_sharing_user_not_eligible` before streaming
//   [[plan:invalid_user]]        401 `subscription_sharing_invalid_user`
//   [[plan:unavailable]]         503 `subscription_sharing_usage_unavailable`
//   [[plan:unsupported:<param>]] 400 `subscription_sharing_unsupported_capability` with `error.param`
//   [[web <query>]]              hosted web search (05-11), only when the request offers a `web_search` tool: a
//                                `web_search_call` item (action.search, the result URL as its source), then the
//                                message as the second output item, its text ending with an inline citation
//                                ` ([example.com](https://example.com/ocw-fake/<slug>))` that a
//                                `response.output_text.annotation.added` url_citation covers (title
//                                `Fake result for <query>`, as the fake SearXNG names it). Without the tool the
//                                directive is stripped like any other (a plain echo).
//
// Title requests (05-10): when the instructions (`instructions`, a developer/system item) ask for a "short title",
// the reply is `Title: <first three words of the user text>` (the text inside `<request>…</request>` when present,
// directives stripped); `[[title:<text>]]` in the user text forces the reply to exactly <text>. With `[[slow]]` the
// title arrives after the same 4 s, unchanged. server.mjs applies
// the same rule to chat completions (system/developer message) and Anthropic (`system`).
//
// Plan bearers (`fake-plan-…`) get the ChatGPT-plan preview rules: `store` must be false, `stream` true, no
// `system` input item and none of PLAN_FORBIDDEN_KEYS, else 400 `fake_preview_violation` naming the key.

/** Request fields the ChatGPT plan preview route rejects (developers.openai.com/siwc, preview limitations). */
export const PLAN_FORBIDDEN_KEYS = [
  "max_output_tokens",
  "temperature",
  "top_p",
  "metadata",
  "user",
  "truncation",
  "previous_response_id",
  "prompt_cache_retention",
  "safety_identifier",
  "background",
  "conversation",
  "max_tool_calls",
];

export const SLOW_DELTAS = 40;
export const SLOW_INTERVAL_MS = 100;

/** The `GET /v1/models` catalog a ChatGPT-plan token sees. */
export function planCatalog() {
  return {
    data: [
      { slug: "gpt-6-astra", display_name: "GPT-6 Astra", visibility: "list" },
      { slug: "gpt-5.6-luna", display_name: "GPT-5.6 Luna", visibility: "list" },
      { slug: "gpt-internal", visibility: "hide" },
    ],
  };
}

/** True when the Authorization header carries a fake ChatGPT-plan token. */
export function isPlanBearer(headers) {
  const auth = headers?.authorization;
  return typeof auth === "string" && /^Bearer\s+fake-plan-/u.test(auth);
}

const DIRECTIVE_RE = /\[\[[^\]]*\]\]/gu;

/** `[[name]]` / `[[plan:x]]` directives of a text, without brackets. */
export function directivesOf(text) {
  return [...text.matchAll(DIRECTIVE_RE)].map((m) => m[0].slice(2, -2).trim());
}

/** Text of one Responses input item (string content or input_text/output_text parts). */
function itemText(item) {
  if (typeof item?.content === "string") return item.content;
  if (!Array.isArray(item?.content)) return "";
  return item.content
    .map((p) => (p?.type === "input_text" || p?.type === "output_text" ? (p.text ?? "") : ""))
    .join("\n");
}

function lastUserItem(input) {
  if (!Array.isArray(input)) return null;
  for (let i = input.length - 1; i >= 0; i--) {
    if (input[i]?.role === "user") return input[i];
  }
  return null;
}

const TITLE_REQUEST_RE = /\bshort title\b/iu;
const FORCED_TITLE_RE = /\[\[title:([^\]]*)\]\]/u;
const REQUEST_BLOCK_RE = /<request>\s*([\s\S]*?)\s*<\/request>/u;

/** True when any of these instruction texts asks for a short title (the API's title prompt, 05-10). */
export function isTitleRequest(instructionTexts) {
  return instructionTexts.some((t) => typeof t === "string" && TITLE_REQUEST_RE.test(t));
}

/** The reply to a title request: `[[title:<text>]]` verbatim, else `Title: <first three words>`. */
export function titleReply(userText) {
  const forced = FORCED_TITLE_RE.exec(userText);
  if (forced) return (forced[1] ?? "").trim();
  const inner = REQUEST_BLOCK_RE.exec(userText)?.[1] ?? userText;
  const words = withoutDirectives(inner).split(" ").filter(Boolean).slice(0, 3);
  return `Title: ${words.join(" ")}`;
}

/** Instruction texts of a Responses body: `instructions` and every developer/system item. */
function responsesInstructions(body) {
  const items = Array.isArray(body.input) ? body.input : [];
  return [
    typeof body.instructions === "string" ? body.instructions : "",
    ...items.filter((i) => i?.role === "developer" || i?.role === "system").map(itemText),
  ];
}

/** Counts `type` parts of an item's content. */
function partCount(item, type) {
  return Array.isArray(item?.content) ? item.content.filter((p) => p?.type === type).length : 0;
}

/** ` [images:N]` / ` [files:N]` suffix (empty when none). */
export function attachmentSuffix(images, files = 0) {
  return `${images > 0 ? ` [images:${images}]` : ""}${files > 0 ? ` [files:${files}]` : ""}`;
}

/** Strips directives and collapses whitespace. */
export function withoutDirectives(text) {
  return text.replace(DIRECTIVE_RE, " ").replace(/\s+/gu, " ").trim();
}

/** The 40 slow deltas: the reply (with " 1"), then " 2" … " 40". */
export function slowPieces(reply) {
  return Array.from({ length: SLOW_DELTAS }, (_, i) => (i === 0 ? `${reply} 1` : ` ${i + 1}`));
}

/** Splits a reply into word-group deltas (normal speed); always at least three for a reply of 3+ characters. */
function pieces(text) {
  const words = text.split(/(\s+)/u);
  const out = [];
  for (let i = 0; i < words.length; i += 2) out.push(words.slice(i, i + 2).join(""));
  const groups = out.filter((p) => p.length > 0);
  if (groups.length >= 3 || text.length < 3) return groups;
  const third = Math.ceil(text.length / 3);
  return [text.slice(0, third), text.slice(third, 2 * third), text.slice(2 * third)].filter(Boolean);
}

/** The deterministic result URL of a fake search (same slug rule as the fake SearXNG in server.mjs). */
export function fakeResultUrl(query) {
  const slug =
    query
      .toLowerCase()
      .replace(/[^a-z0-9]+/gu, "-")
      .replace(/^-|-$/gu, "") || "empty";
  return `https://example.com/ocw-fake/${slug}`;
}

/** True when a Responses body offers the hosted `web_search` tool (or its preview name). */
function offersWebSearch(body) {
  return (
    Array.isArray(body.tools) &&
    body.tools.some((t) => t?.type === "web_search" || t?.type === "web_search_preview")
  );
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function sendJson(res, status, obj) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

/** The first plan-preview rule the body breaks, or null. */
function previewViolation(body) {
  if (body.store !== false) return "store";
  if (body.stream !== true) return "stream";
  for (const key of PLAN_FORBIDDEN_KEYS) if (body[key] !== undefined) return key;
  if (Array.isArray(body.input) && body.input.some((item) => item?.role === "system")) {
    return "input[].role=system";
  }
  return null;
}

const PLAN_ERRORS = {
  not_eligible: [
    403,
    "subscription_sharing_user_not_eligible",
    "This account is not eligible for ChatGPT plan usage",
  ],
  invalid_user: [401, "subscription_sharing_invalid_user", "The ChatGPT sign-in is no longer valid"],
  unavailable: [
    503,
    "subscription_sharing_usage_unavailable",
    "ChatGPT plan usage is temporarily unavailable",
  ],
};

let responseCounter = 0;

/**
 * Handles `POST /v1/responses`. `body` is the parsed JSON request; `ctx.headers` defaults to `req.headers`.
 */
export async function handleResponses(req, res, body, ctx = {}) {
  const headers = ctx.headers ?? req.headers;
  const plan = isPlanBearer(headers);
  if (plan) {
    const key = previewViolation(body);
    if (key) {
      return sendJson(res, 400, {
        error: {
          code: "fake_preview_violation",
          type: "invalid_request_error",
          param: key,
          message: `fake-model: the ChatGPT plan route rejects ${key}`,
        },
      });
    }
  }

  const user = lastUserItem(body.input);
  const userText = itemText(user);
  const directives = directivesOf(userText);
  const has = (d) => directives.includes(d);

  for (const [name, [status, code, message]] of Object.entries(PLAN_ERRORS)) {
    if (has(`plan:${name}`))
      return sendJson(res, status, { error: { code, type: "invalid_request_error", param: null, message } });
  }
  const unsupported = directives.find((d) => d.startsWith("plan:unsupported:"));
  if (unsupported) {
    return sendJson(res, 400, {
      error: {
        code: "subscription_sharing_unsupported_capability",
        type: "invalid_request_error",
        param: unsupported.slice("plan:unsupported:".length),
        message: "This capability is not supported with ChatGPT plan usage",
      },
    });
  }

  const title = isTitleRequest(responsesInstructions(body));
  const webQuery = title
    ? null
    : directives
        .find((d) => /^web\s/u.test(d))
        ?.slice(4)
        .trim() || null;
  const search = webQuery && offersWebSearch(body) ? { query: webQuery, url: fakeResultUrl(webQuery) } : null;
  const echo = `Echo: ${withoutDirectives(userText)}${attachmentSuffix(
    partCount(user, "input_image"),
    partCount(user, "input_file"),
  )}`;
  const citation = search ? ` ([example.com](${search.url}))` : "";
  const reply = title ? titleReply(userText) : `${echo}${citation}`;
  // A slow title is the same title after the same 4 s (no counting appended to it).
  const slow = has("slow") && !title;
  if (has("slow") && title) await sleep(SLOW_DELTAS * SLOW_INTERVAL_MS);
  const usageLimit = has("plan:usage_limit");
  const all = slow ? slowPieces(reply) : pieces(reply);
  const deltas = usageLimit ? all.slice(0, 3) : all;

  const id = `resp_fake_${++responseCounter}`;
  const itemId = `msg_fake_${responseCounter}`;
  const searchId = `ws_fake_${responseCounter}`;
  /** The message's output index: after the search call when there is one. */
  const msgIndex = search ? 1 : 0;
  const model = body.model ?? "gpt-6-astra";
  const createdAt = Math.floor(Date.now() / 1000);
  let seq = 0;
  res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
  const ev = (type, data) =>
    res.write(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: seq++, ...data })}\n\n`);
  const response = (status, extra = {}) => ({
    id,
    object: "response",
    created_at: createdAt,
    model,
    status,
    service_tier: null,
    ...extra,
  });

  ev("response.created", { response: response("in_progress") });
  const searchItem = search
    ? {
        type: "web_search_call",
        id: searchId,
        status: "completed",
        action: { type: "search", query: search.query, sources: [{ type: "url", url: search.url }] },
      }
    : null;
  if (searchItem) {
    ev("response.output_item.added", {
      output_index: 0,
      item: { type: "web_search_call", id: searchId, status: "in_progress" },
    });
    ev("response.output_item.done", { output_index: 0, item: searchItem });
  }
  ev("response.output_item.added", {
    output_index: msgIndex,
    item: { type: "message", id: itemId, role: "assistant", status: "in_progress", content: [] },
  });
  ev("response.content_part.added", {
    item_id: itemId,
    output_index: msgIndex,
    content_index: 0,
    part: { type: "output_text", text: "", annotations: [] },
  });
  let closed = false;
  res.on("close", () => {
    closed = true;
  });
  for (const delta of deltas) {
    if (closed) return;
    ev("response.output_text.delta", { item_id: itemId, output_index: msgIndex, content_index: 0, delta });
    if (slow) await sleep(SLOW_INTERVAL_MS);
  }
  const text = deltas.join("");
  const usage = {
    input_tokens: 100 + Math.ceil(JSON.stringify(body.input ?? []).length / 4),
    input_tokens_details: { cached_tokens: 0 },
    output_tokens: Math.max(1, Math.ceil(text.length / 4)),
    output_tokens_details: { reasoning_tokens: 0 },
  };
  usage.total_tokens = usage.input_tokens + usage.output_tokens;
  if (usageLimit) {
    ev("response.failed", {
      response: response("failed", {
        error: {
          code: "subscription_sharing_usage_limit_exceeded",
          message: "You have reached your ChatGPT plan usage limit",
        },
        usage,
      }),
    });
    return res.end();
  }
  const annotations = [];
  if (search && text.includes(citation)) {
    const start = text.lastIndexOf(citation) + 1;
    const annotation = {
      type: "url_citation",
      start_index: start,
      end_index: start + citation.length - 1,
      url: search.url,
      title: `Fake result for ${search.query}`,
    };
    annotations.push(annotation);
    ev("response.output_text.annotation.added", {
      item_id: itemId,
      output_index: msgIndex,
      content_index: 0,
      annotation_index: 0,
      annotation,
    });
  }
  ev("response.output_text.done", { item_id: itemId, output_index: msgIndex, content_index: 0, text });
  ev("response.content_part.done", {
    item_id: itemId,
    output_index: msgIndex,
    content_index: 0,
    part: { type: "output_text", text, annotations },
  });
  const item = {
    type: "message",
    id: itemId,
    role: "assistant",
    status: "completed",
    content: [{ type: "output_text", text, annotations }],
  };
  ev("response.output_item.done", { output_index: msgIndex, item });
  const output = searchItem ? [searchItem, item] : [item];
  ev("response.completed", { response: response("completed", { output, usage }) });
  res.end();
}
