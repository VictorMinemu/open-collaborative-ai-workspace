// The confined tools' names and refusal codes come from the contracts' source (07.8-08: shared markers, never copied
// strings). A relative import keeps this file free of package dependencies, so Playwright specs can load it too.
import {
  BROWSER_TOOL_NAMES,
  BUILTIN_TOOLS,
  SANDBOX_TOOL_NAMES,
  type TurnAttachment,
  WORK_SESSION_TOOL_NAMES,
} from "../../packages/contracts/src/bot-capabilities";
import { BrowserRefusal } from "../../packages/contracts/src/browser";
import { SandboxRefusal } from "../../packages/contracts/src/sandbox";

/**
 * Fake OpenClaw cell plugin — a test double that speaks the Agent Channel API v1 exactly like
 * `apps/openclaw-channel` does (see 01-AGENT-CHANNEL-API.md), without OpenClaw or a model.
 * Dependency-free (Node 24 global fetch + WebSocket) so API integration tests, Playwright specs and CI
 * scripts can all reuse it.
 *
 *   const plugin = new FakeCellPlugin({ apiUrl, token, autoAck: true, autoReply: true });
 *   await plugin.start();            // GET /cell, acks bots, opens /ws, subscribes live
 *   await plugin.waitFor((e) => e.type === "agent.mention.v1");
 *   await plugin.stop();
 *
 * Attachments (07.15-09): `[[call ocw_attachment_read {"attachmentId":"{{attachment:1}}"}]]` reads the turn's second
 * listed file through `POST /agent-channel/v1/attachments/read` (any tool's `{{attachment:N}}` argument becomes that
 * file's id; an index outside the list is not sent and reads `refused (not_found)`), and a turn that lists files ends its
 * reply with ` [attachments: <name>:<access>,…]`.
 *
 * Bot Work Zone sessions (07.16-21, PD-26): `[[call ocw_work_session_start {"projectId":"…","prompt":"…"}]]` (and
 * `_prompt`, `_read`, `_stop`) posts exactly the plugin's body to `POST /agent-channel/v1/work-sessions/<verb>`; an
 * `agent.work_session.v1` wake is answered on the session's card (`Done: …`, `Needs approval: …`, `<transition>: …`).
 *
 * Automation fan-out (07.17-18, PD-22), only for a spec that sets the hooks: a run turn offered `ocw_conversation_open`
 * lists the spec's connector (`fanOutFor`; an organization server `GET /cell` renders is called by the cell itself after
 * `POST /tool-calls`, any other through `ocw_connector_call`) and opens one conversation per id through `POST
 * /agent-channel/v1/conversations/open` (exactly the plugin's body); an `agent.automation_item.v1` turn runs
 * `itemCallsFor` in the item's thread; a `turn_done` wake in such a thread runs `wakeCallsFor` and mentions the item's
 * escalation. Like the plugin's board tool, a tainted or session-read turn never reads the board: it moves its thread's
 * card at the version it last saw (1 for a just-opened card) and retries one 409 at the current version.
 */

export interface FakeCellEvent {
  seq: number;
  type: string;
  data: Record<string, unknown> & { seq: number; type?: string };
}

export interface FakeCellAgent {
  id: string;
  handle: string;
  displayName: string;
  status: string;
  modelRef: string;
  instructions: string;
}

export interface FakeCellSnapshot {
  protocolVersion: number;
  cellId: string;
  organizationId: string;
  topic: string;
  lastSeq: number;
  agents: FakeCellAgent[];
  providers: Array<{
    id: string;
    kind: string;
    api: string;
    baseUrl: string;
    apiKey: string | null;
    models: string[];
  }>;
  subscriptions?: Array<{ id: string; kind: string; runtimeProvider: string; models: string[] }>;
  /** Org-enabled MCP servers with their header VALUES (cell token only, 03.1-10). */
  mcpServers?: Array<{
    id: string;
    safeName: string;
    transport: string;
    url: string;
    headers: Array<{ name: string; envName: string; value: string }>;
    tools: string[];
  }>;
}

export interface MentionPayload {
  eventId: string;
  seq: number;
  agent: { id: string; handle: string; displayName: string };
  conversation: { id: string; kind: string; name: string | null };
  thread: { rootMessageId: string };
  message: { id: string; text: string; author: { kind: string; id: string; displayName: string } };
  threadHistory: Array<{
    id: string;
    author: { kind: string; id: string; displayName: string };
    text: string;
  }>;
  roster: Array<{ kind: string; id: string; displayName: string }>;
  /** What this bot may do for this human on this turn (03.1-03); absent = no tools (fail closed). */
  turn?: {
    tools: string[];
    memory?: Array<{ id: string; text: string; createdAt: string }>;
    now?: { iso: string; timeZone: string; local: string } | null;
    /**
     * Tools withheld from this turn and why (06-10). `member_account` (07.4 D-03) names the connector or key whose
     * account stays private here, so the persona can link to the share page (UI-SPEC R7).
     */
    withheld?: Array<{
      tool: string;
      reason: string;
      resource?: { kind: "connector" | "vault_item"; id: string; name: string };
    }>;
    /**
     * Per-tool gate flags (03.1, 07.5 D-01). `approval` set = the tool has an approval policy for this bot and this
     * human: the gate sends the call's full `arguments` to `/tool-calls` (never for any other tool).
     */
    toolFlags?: Record<
      string,
      { untrustedOutput: boolean; sideEffecting: boolean; approval?: "always" | "when_tainted" }
    >;
    /** 07.7: present only when the turn is offered `ocw_consult_agent` (the bots it may ask here). */
    consult?: {
      chainId: string | null;
      depth: number;
      targets: Array<{ id: string; handle: string; displayName: string; description: string | null }>;
    };
    /** 07.7 D-09: the turn starts tainted (e.g. a consult reply after the consulted bot read web content). */
    tainted?: boolean;
    /**
     * 07.15 D-02: the files of the messages this turn reads (metadata only); absent on turns without files. Directives
     * name them by position (`{{attachment:N}}`), and the reply lists them (`turnAttachmentsSuffix`).
     */
    attachments?: TurnAttachment[];
  };
  /** 07.7 D-01: the turn answers a question another bot asked (the asking bot, its chain and this hop's depth). */
  origin?: Record<string, unknown>;
}

/**
 * `agent.consult_reply.v1` (07.7-06): built like a mention of the asking bot in the hop's thread; `message` is the
 * consulted bot's answer (or the question again when it failed or timed out).
 */
export interface ConsultReplyPayload extends MentionPayload {
  consultReply: {
    chainId: string;
    hopId: string;
    target: { id: string; handle: string; displayName: string };
    mode: "consult" | "handoff";
    outcome: "answered" | "failed" | "timed_out";
    answerMessageId: string | null;
  };
}

/**
 * `agent.card_action.v1` (06-13, 07.5-06): built like a mention of the bot on its card's message. For an approved
 * `tool.call` grant (07.5 D-02) `cardAction.grant` names the tool and its canonical arguments, to call exactly once.
 */
export interface CardActionPayload extends MentionPayload {
  cardAction: {
    messageId: string;
    kind: string;
    title: string;
    outcome: "approved" | "denied";
    decidedBy?: { id: string; displayName: string };
    grant?: { tool: string; arguments: string; useBy: string };
    /** The decider's note (07.5-11), absent without one. */
    note?: string;
  };
}

/**
 * `agent.automation_run.v1` (07.6-06, D-03): built like a mention of the bot on the run's anchor (the platform's run
 * card), authored by the run-as person; the standing order and any outside content travel in their own block.
 */
export interface AutomationRunPayload extends MentionPayload {
  automationRun: {
    automationId: string;
    runId: string;
    name: string;
    trigger: "schedule" | "webhook" | "mail" | "manual";
    instructions: string;
    inbound: {
      source: "webhook" | "mail";
      title: string;
      text: string;
      from: string | null;
      receivedAt: string;
    } | null;
  };
}

/** `agent.automation_item.v1` (07.17-17, D-04): a fan-out run opened this thread for an item; a tainted turn in it. */
export const AUTOMATION_ITEM_EVENT = "agent.automation_item.v1";

/**
 * `agent.automation_item.v1` (07.17 D-04, PD-09): built like a mention of the bot on the opened root (the card or the
 * channel message), authored by the run-as person, tainted from the start. The item travels only in `automationItem`.
 */
export interface AutomationItemPayload extends MentionPayload {
  automationItem: {
    automationId: string;
    runId: string;
    itemId: string;
    name: string;
    instructions: string;
    item: { title: string; text: string; openedAt: string };
    escalation: Array<{ kind: "user" | "unit"; id: string; handle: string; displayName: string }>;
  };
}

/** One simulated tool call (a `[[call …]]` directive, or what a spec's hook decides). */
export type SimulatedCall = { tool: string; args: Record<string, unknown> };

/** Subscription sign-in emulation (provider.auth.* commands), against a fake device-auth server. */
export interface FakeDeviceAuthOptions {
  /** Base URL of e2e/support/fake-device-auth-server.ts (stands in for https://auth.openai.com). */
  serverUrl: string;
  /** Plugin instance id sent as `reporterId` (default: random). */
  reporterId?: string;
  /** Poll interval of the token endpoint (default 200 ms). */
  pollMs?: number;
}

export interface FakeCellOptions {
  apiUrl: string;
  token: string;
  /** Ack every non-disabled bot as `ready` on start and on each `cell.config.changed`. */
  autoAck?: boolean;
  /**
   * Answer every mention with `replyText(mention)` (default: an identity-aware deterministic reply), or with the
   * simulated tool calls when the message carries `[[call …]]` directives (`simulateToolCalls`), followed by the
   * turn-tools suffix (`turnToolsSuffix`), the turn-context suffix (`turnContextSuffix`) and, on a turn that lists
   * files only, the attachments suffix (`turnAttachmentsSuffix`, 07.15-09).
   */
  autoReply?: boolean;
  replyText?: (m: MentionPayload) => string;
  /** Resume cursor; omit to start live. */
  afterSeq?: number;
  /** Handle `provider.auth.start|cancel|revoke` like apps/openclaw-channel does (device-code sign-in). */
  deviceAuth?: FakeDeviceAuthOptions;
  /**
   * Simulate the marketplace executor (03.1-12): `plugin.install.v1` reports `installing`, then `installed` with
   * `declaredTools = pluginTools["<package>@<version>"] ?? pluginTools[package] ?? []`; `plugin.uninstall.v1` reports `uninstalled`. Unset = the
   * plugin events are ignored (an older cell).
   */
  pluginTools?: Record<string, string[]>;
  /** Delay before each plugin report and each probe, so a browser can see `Installing` / `Probing` (default 1200 ms). */
  stepMs?: number;
  /**
   * Simulate the MCP probe (03.1-10): on `mcp.probe`, find the server in `GET /cell`, rewrite its `host:port`
   * through this map (e.g. `fake-mcp:4291` → `127.0.0.1:4291`), run `initialize` + `tools/list` over streamable
   * HTTP with the snapshot's headers and POST `/mcp/probe-results`. Unset = probes are ignored.
   */
  hostMap?: Record<string, string>;
  /**
   * The same `host:port` rewrite for the MCP tool calls the cell makes itself (07.17-18: the fan-out run's list of an
   * organization server `GET /cell` renders), without simulating probes. Unset = the server's own URL.
   */
  mcpHostMap?: Record<string, string>;
  /**
   * The calls the simulated persona decides to make for a mention, in addition to the message's own `[[call …]]`
   * directives (07.4-14: a member asks in plain words, the persona calls `ocw_connector_call`).
   */
  toolCallsFor?: (m: MentionPayload) => Array<{ tool: string; args: Record<string, unknown> }>;
  /**
   * Answer a denied card action (07.5-13) the way the plugin's mapper words it for the model: one line
   * `Card <title>: denied by <decider> (“<note>”)` (the note from `cardAction.note` only, never parsed from the
   * sentence). Off by default, so specs that count a bot's replies are unchanged.
   */
  replyOnDenied?: boolean;
  /**
   * Like the real bridge's `finally` (07.7-05/06): after answering a turn that can belong to a consult chain (offered
   * `ocw_consult_agent`, carrying `origin`, or an `agent.consult_reply.v1`), POST `/turns/:eventId/done` with `replied`
   * (or `failed` when the reply could not be posted). Other turns report nothing. Off by default.
   */
  autoDone?: boolean;
  /** Never answer (nor report done) for these bot ids: their turns stay open (a Stop or timeout scenario). */
  holdAgents?: ReadonlySet<string>;
  /**
   * The `@handle` of a person by user id (07.16-21), for the Work Zone wake replies that mention the asker. The events
   * carry no person's handle (the roster names only bots'); a person the map does not name is mentioned by the
   * wake's decider of the same id, else by their display name.
   */
  userHandles?: Readonly<Record<string, string>>;
  /**
   * 07.17-18 (PD-22): on an `agent.automation_run.v1` whose turn offers `ocw_conversation_open`, the connector (its safe
   * name) whose `list_records` the persona reads, and the ids it keeps as new (default: every id). The fake then reads
   * the list once, as the real cell would (a server `GET /cell` renders: the gate, then the server itself; any other:
   * `ocw_connector_call`), makes one `ocw_conversation_open` (an item per kept id: key `<id>`, title `Order <id>`, body
   * `Order <id> from the ERP.`) and replies `Opened <opened>, existing <existing>` on the run card. Null = the 07.6 run
   * answer. Unset = every run is answered as before.
   */
  fanOutFor?: (
    run: AutomationRunPayload,
  ) => { connector: string; select?: (ids: string[]) => string[] } | null;
  /**
   * 07.17-18 (PD-22): the calls the persona makes on an `agent.automation_item.v1` (in the item's thread, replying to its
   * root), awaited so a spec can hold the turn. The item's escalation is remembered by thread root for the wake. Unset =
   * item events are not answered (the cell before 07.17).
   */
  itemCallsFor?: (item: AutomationItemPayload) => SimulatedCall[] | Promise<SimulatedCall[]>;
  /**
   * 07.17-18 (PD-22): on a `turn_done` wake in a thread an item turn answered, the calls the persona makes (the session
   * read, the card's move); it then replies `Done: <last output line of its read> @<escalation handles>` (the asker when
   * the automation names nobody). Unset, or any other wake = the 07.16 answer.
   */
  wakeCallsFor?: (wake: WorkSessionWakePayload, ctx: { escalationHandles: string[] }) => SimulatedCall[];
}

/** 07.7: the consult tool (self-validated by `POST /consultations`, never `/tool-calls`). */
export const CONSULT_TOOL = "ocw_consult_agent";
const CONSULT_REPLY_EVENT = "agent.consult_reply.v1";

/**
 * Appended to every simulated reply: ` [turn tools: <sorted turn.tools joined by commas> | none]`. Lets a
 * browser spec see which tools the API gave the bot for that very turn (a policy change bites next turn).
 */
export function turnToolsSuffix(m: MentionPayload): string {
  const tools = [...(m.turn?.tools ?? [])].sort();
  return ` [turn tools: ${tools.length > 0 ? tools.join(",") : "none"}]`;
}

/**
 * Appended after the turn tools on every simulated reply: ` [memory: <turn.memory.length>] [now: <zone> | none]`.
 * Lets a browser spec see the bot's notes about the asker (D-10) and the asker's time zone (D-12) per turn.
 */
export function turnContextSuffix(m: MentionPayload): string {
  return ` [memory: ${m.turn?.memory?.length ?? 0}] [now: ${m.turn?.now?.timeZone ?? "none"}]`;
}

/**
 * 07.15-09 (PD-12): appended after the turn-context suffix, only on a turn that lists files: ` [attachments:
 * <name>:<access>,…]` in the turn's order (the current message's files first, then the history newest first). Lets a
 * browser spec see which files the API listed for the bot and how it may use each (`read`, `import`, `none`). Empty on
 * every other turn, so other specs' expected replies are unchanged.
 */
export function turnAttachmentsSuffix(m: MentionPayload): string {
  const files = m.turn?.attachments ?? [];
  return files.length > 0 ? ` [attachments: ${files.map((f) => `${f.name}:${f.access}`).join(",")}]` : "";
}

/** `{{attachment:N}}` (the whole string): the turn's N-th listed file, by position from 0 (07.15-09). */
const ATTACHMENT_REF = /^\{\{attachment:(-?\d+)\}\}$/u;

/**
 * Replaces every top-level string argument of the exact form `{{attachment:N}}` with the id of
 * `m.turn.attachments[N]`, so a spec can write a directive before it knows the ids the upload will mint. `null` when an
 * index is outside the list: the call is then never sent and reads `refused (not_found)`. Test-only: the real plugin
 * takes ids from the model, which reads them in the turn's Attachments block (T-07.15-09-03).
 */
export function withAttachmentIds(
  m: MentionPayload,
  args: Record<string, unknown>,
): Record<string, unknown> | null {
  const files = m.turn?.attachments ?? [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(args)) {
    const ref = typeof value === "string" ? ATTACHMENT_REF.exec(value) : null;
    if (!ref) {
      out[key] = value;
      continue;
    }
    const file = files[Number(ref[1])];
    if (!file) return null;
    out[key] = file.id;
  }
  return out;
}

/** The first line of a text read's content: the line after the API's `<attached_file>` delimiter (07.15-09). */
function firstContentLine(block: string): string {
  const lines = block.split("\n");
  const open = lines.indexOf("<attached_file>");
  const line = (open >= 0 ? lines[open + 1] : lines[0]) ?? "";
  return line === "</attached_file>" ? "" : line.trim();
}

/** The memory file tools (07.2-07/11) and the Agent Channel route each one calls (`POST /memory/<route>`). */
const MEMORY_FILE_TOOLS = {
  ocw_memory_list: "list",
  ocw_memory_read: "read",
  ocw_memory_write: "write",
  ocw_memory_propose: "propose",
} as const;
type MemoryFileTool = keyof typeof MEMORY_FILE_TOOLS;
const MEMORY_FILE_DONE: Record<MemoryFileTool, string> = {
  ocw_memory_list: "listed",
  ocw_memory_read: "read",
  ocw_memory_write: "written",
  ocw_memory_propose: "proposed",
};
const isMemoryFileTool = (name: string): name is MemoryFileTool => Object.hasOwn(MEMORY_FILE_TOOLS, name);

/**
 * `agent.work_session.v1` (07.16, D-09): a session the bot started changed state. Built like a mention of the bot on its
 * live card (`message.id` = the card, `message.author` = the person who asked), plus the transition and the people who
 * may decide its approvals.
 */
export interface WorkSessionWakePayload extends MentionPayload {
  workSession: {
    workSessionId: string;
    transition: "turn_done" | "waiting_approval" | "failed" | "ended" | "offline";
    status: string;
    summary: string;
    pendingApprovals: number;
    deciders: Array<{ id: string; handle: string; displayName: string }>;
  };
}
export const WORK_SESSION_EVENT = "agent.work_session.v1";

/**
 * The bot's own Work Zone session tools (07.16-08) and the verb of the route each one calls (`POST /work-sessions/<verb>`,
 * apps/openclaw-channel's work-session-tools.ts), with the keys each one sends besides the turn's ids. The start sends a
 * choice (`model`, `effort`, `fastMode`, `contextWindow`, `permissionMode`) only when the model gives it, and never a
 * device, a user, an audience or a worktree (the plugin's schema is closed).
 */
type WorkSessionTool = (typeof WORK_SESSION_TOOL_NAMES)[number];
const isWorkSessionTool = (name: string): name is WorkSessionTool =>
  (WORK_SESSION_TOOL_NAMES as readonly string[]).includes(name);
const workSessionVerb = (tool: WorkSessionTool) => tool.slice("ocw_work_session_".length);
const WORK_SESSION_KEYS: Record<WorkSessionTool, readonly string[]> = {
  ocw_work_session_start: [
    "projectId",
    "prompt",
    "model",
    "effort",
    "fastMode",
    "contextWindow",
    "permissionMode",
  ],
  ocw_work_session_prompt: ["workSessionId", "prompt"],
  ocw_work_session_read: ["workSessionId", "cursor"],
  ocw_work_session_stop: ["workSessionId"],
  // 07.17.1.1 (D-02, D-03): a chat attachment into the session's tree, and a file of the tree back into the chat.
  ocw_work_session_upload: ["workSessionId", "attachmentId", "path", "overwrite"],
  ocw_work_session_download: ["workSessionId", "path"],
};

/**
 * The ids a `list_records` answer lists (07.17-18): the connector's content is the tool's JSON text (`{"ids":[…]}`);
 * null for a refusal, an error result or anything else.
 */
export function idsOf(content: string): string[] | null {
  try {
    const parsed = JSON.parse(content) as { ids?: unknown } | null;
    const ids = parsed?.ids;
    return Array.isArray(ids) && ids.every((x) => typeof x === "string") ? (ids as string[]) : null;
  } catch {
    return null;
  }
}

/**
 * One MCP session over streamable HTTP with plain JSON-RPC over fetch (the fake MCP and the fake ERP answer single JSON
 * responses) to a server of `GET /cell`, with its rendered headers; `hosts` rewrites its `host:port` (e.g.
 * `fake-mcp:4291` → `127.0.0.1:4291`). The probe and the in-cell tool calls share it.
 */
function mcpSession(
  server: { url: string; headers: Array<{ name: string; value: string }> },
  hosts: Record<string, string> | undefined,
) {
  const url = new URL(server.url);
  const mapped = hosts?.[url.host];
  if (mapped) url.host = mapped;
  // A `Headers` object, not a plain record keyed by server-supplied names (no prototype keys, names validated).
  const base = new Headers({
    "content-type": "application/json",
    accept: "application/json, text/event-stream",
  });
  for (const h of server.headers) base.set(h.name, h.value);
  let session: string | null = null;
  return async (id: number | null, method: string, params: Record<string, unknown> = {}) => {
    const headers = new Headers(base);
    if (session) headers.set("mcp-session-id", session);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
      redirect: "error",
    });
    if (res.status === 401 || res.status === 403) {
      throw new Error(
        `The MCP server refused the credentials (HTTP ${res.status}). Check the header values.`,
      );
    }
    if (!res.ok && res.status !== 202) throw new Error(`The MCP server answered HTTP ${res.status}.`);
    session = res.headers.get("mcp-session-id") ?? session;
    const text = await res.text();
    return text ? (JSON.parse(text) as { result?: Record<string, unknown> }) : {};
  };
}

/** The last non-empty line of a read answer's newest output text ("" when it has none). */
export function lastOutputLine(read: { output?: { texts?: Array<{ text: string }> } } | null): string {
  const text = read?.output?.texts?.at(-1)?.text ?? "";
  return (
    text
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .at(-1) ?? ""
  );
}

/**
 * The pending approvals' tool names in a read answer, each once in the read's order (`Write, Bash`), else `a tool`.
 * The wake's summary never names them (code review WR-01): the bot learns them only by reading the session (D-20).
 */
function approvalToolsOf(read: Loose | null): string {
  const tools = read?.kind === "read" && Array.isArray(read.approvals) ? read.approvals : [];
  const names = [
    ...new Set(tools.map((a: { tool?: unknown }) => a.tool).filter((t) => typeof t === "string")),
  ];
  return names.length > 0 ? names.join(", ") : "a tool";
}

/** The Work Zone proposal tools (07.5-08/10) and the Agent Channel route each one calls (`POST /work-zone/<route>`). */
const WORK_ZONE_TOOLS = {
  ocw_work_zone_projects: "projects",
  ocw_start_work_zone: "proposals",
} as const;
type WorkZoneTool = keyof typeof WORK_ZONE_TOOLS;
const isWorkZoneTool = (name: string): name is WorkZoneTool => Object.hasOwn(WORK_ZONE_TOOLS, name);
/** The only fields a proposal carries besides the turn (07.5-10): never a user, a mode, a model or full access. */
const PROPOSAL_FIELDS = ["projectId", "deviceId", "prompt", "runtime"] as const;

/**
 * The confined tools (07.8-06): each is a thin caller of its own Agent Channel route, `/sandbox/<verb>` for
 * `ocw_sandbox_<verb>` and `/browser/<verb>` for `ocw_browser_<verb>` (apps/openclaw-channel's SANDBOX_TOOL_ROUTES and
 * BROWSER_TOOL_ROUTES), with the turn's ids and the model's arguments only. Never `/tool-calls`.
 */
type SandboxTool = (typeof SANDBOX_TOOL_NAMES)[number];
type BrowserTool = (typeof BROWSER_TOOL_NAMES)[number];
const isSandboxTool = (name: string): name is SandboxTool =>
  (SANDBOX_TOOL_NAMES as readonly string[]).includes(name);
const isBrowserTool = (name: string): name is BrowserTool =>
  (BROWSER_TOOL_NAMES as readonly string[]).includes(name);
export const confinedRoute = (tool: SandboxTool | BrowserTool): string =>
  isSandboxTool(tool)
    ? `/sandbox/${tool.slice("ocw_sandbox_".length)}`
    : `/browser/${tool.slice("ocw_browser_".length)}`;

// biome-ignore lint/suspicious/noExplicitAny: loose JSON of the confined routes' answers, rendered field by field
type Loose = Record<string, any>;

/** One line per confined result, deterministic for specs (outputs trimmed, never an image's bytes). */
function renderSandbox(tool: SandboxTool, b: Loose): string {
  switch (tool) {
    case "ocw_sandbox_exec":
    case "ocw_sandbox_process":
      return b.status === "running"
        ? `running ${b.processId}`
        : `exit ${b.exitCode}: ${String(b.stdout ?? "").trim()}${b.stderr ? ` | ${String(b.stderr).trim()}` : ""}`;
    case "ocw_sandbox_read":
      return `read ${b.path}: ${b.content}`;
    case "ocw_sandbox_write":
      return `wrote ${b.path} (${b.size} bytes)`;
    case "ocw_sandbox_list":
      return `listed ${(b.entries ?? []).map((e: Loose) => e.name).join(", ") || "(empty)"}`;
    case "ocw_sandbox_delete":
      return `deleted ${b.deleted}`;
    case "ocw_sandbox_share":
      return `shared ${b.name}`;
    case "ocw_sandbox_import":
      return `imported ${b.path}`;
  }
}

function renderBrowser(tool: BrowserTool, b: Loose): string {
  const signed = b.signedIn ? " (signed in)" : "";
  switch (tool) {
    case "ocw_browser_open":
      return `opened ${b.host}${signed}`;
    case "ocw_browser_snapshot":
      return `snapshot ${b.host}${signed}: ${b.text}`;
    case "ocw_browser_act":
      return `${b.navigated ? "navigated" : "acted"} on ${b.host}${b.download ? ` download ${b.download.name}` : ""}`;
    case "ocw_browser_screenshot":
      return `screenshot ${b.host}`;
    case "ocw_browser_wait":
      return `waited ${b.ok ? "ok" : "not found"} on ${b.host}`;
    case "ocw_browser_signin":
      return `sign-in requested for ${b.host}`;
    case "ocw_browser_close":
      return "closed";
  }
}

/** The three static connector and keychain tools (07.4-09): self-validated by their own routes, never `/tool-calls`. */
const CONNECTOR_TOOLS = ["ocw_connector_list", "ocw_connector_call", "ocw_http_request"] as const;
type ConnectorTool = (typeof CONNECTOR_TOOLS)[number];
const isConnectorTool = (name: string): name is ConnectorTool =>
  (CONNECTOR_TOOLS as readonly string[]).includes(name);

/**
 * The share links a persona gives for tools withheld as `member_account` (UI-SPEC R7, like apps/openclaw-channel's
 * mention-mapper): one Markdown line per connector or key, `[Allow {name} in {conversation}](/settings/connections?
 * share=<conversationId>&connector=<id>)` (`&key=<id>` for a personal key). The conversation reads `#name` for a
 * channel, else its id.
 */
export function memberAccountLinks(m: MentionPayload): string[] {
  const label = m.conversation.name ? `#${m.conversation.name}` : m.conversation.id;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const w of m.turn?.withheld ?? []) {
    if (w.reason !== "member_account" || !w.resource || seen.has(w.resource.id)) continue;
    seen.add(w.resource.id);
    const param = w.resource.kind === "connector" ? "connector" : "key";
    out.push(
      `[Allow ${w.resource.name} in ${label}](/settings/connections?share=${m.conversation.id}&${param}=${w.resource.id})`,
    );
  }
  return out;
}

/** `[[call <tool> <json>]]` directives in a message (same grammar as infra/fake-model), in order. */
export function parseCallDirectives(text: string): Array<{ tool: string; args: Record<string, unknown> }> {
  const out: Array<{ tool: string; args: Record<string, unknown> }> = [];
  for (const m of text.matchAll(/\[\[call\s+([A-Za-z0-9_.:-]+)\s+(?=\{)/gu)) {
    const start = (m.index ?? 0) + m[0].length;
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let i = start; i < text.length; i++) {
      const ch = text[i];
      if (inString) {
        if (ch === "\\") i++;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth++;
      else if (ch === "}" && --depth === 0) {
        end = i + 1;
        break;
      }
    }
    if (end === -1 || !text.startsWith("]]", end)) continue;
    try {
      const args = JSON.parse(text.slice(start, end)) as unknown;
      if (args && typeof args === "object" && !Array.isArray(args) && m[1]) {
        out.push({ tool: m[1], args: args as Record<string, unknown> });
      }
    } catch {
      /* not a directive */
    }
  }
  return out;
}

/** Deterministic, identity-aware reply (mirrors infra/fake-model): proves structured attribution travelled. */
export function identityReply(m: MentionPayload): string {
  const people = [
    ...new Set(
      [...m.threadHistory.map((h) => h.author), m.message.author]
        .filter((a) => a.kind === "user")
        .map((a) => a.displayName),
    ),
  ].sort();
  return `Asked by ${m.message.author.displayName} (${m.message.author.id}). Thread participants: ${people.join(", ")}.`;
}

export class FakeCellPlugin {
  readonly events: FakeCellEvent[] = [];
  readonly replies: Array<{ messageId: string; created: boolean; mention: MentionPayload }> = [];
  /**
   * Every `POST /tool-calls` this fake cell made (06-12: a withheld tool never reaches the gate). `arguments` is the
   * body's field (07.5 D-01): present only for a tool whose delivered flags carry `approval`.
   */
  readonly toolCallRequests: Array<{ eventId: string; tool: string; arguments?: Record<string, unknown> }> =
    [];
  snapshot: FakeCellSnapshot | null = null;
  lastSeq = 0;
  /** Subscription credentials this fake cell "holds" (provider → account), like OpenClaw's auth store. */
  readonly credentials = new Map<string, { email: string | null; planType: string | null }>();
  /** Every `POST /provider-auth` report sent, with the HTTP status it got. */
  readonly authReports: Array<{ status: number; body: Record<string, unknown> }> = [];
  readonly revoked: string[] = [];
  /** Every `POST /plugins/report` and `POST /mcp/probe-results` sent, with the HTTP status it got. */
  readonly pluginReports: Array<{ status: number; body: Record<string, unknown> }> = [];
  readonly probeReports: Array<{ status: number; body: Record<string, unknown> }> = [];
  private readonly flows = new Map<string, AbortController>();
  private readonly reporterId = `fake-${Math.random().toString(36).slice(2, 12)}`;
  private ws: WebSocket | null = null;
  private waiters: Array<() => void> = [];

  constructor(private readonly opts: FakeCellOptions) {}

  private get base() {
    return `${this.opts.apiUrl.replace(/\/+$/, "")}/agent-channel/v1`;
  }

  async request<T = unknown>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<{ status: number; body: T }> {
    const res = await fetch(`${this.base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.opts.token}`,
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    return { status: res.status, body: (text ? JSON.parse(text) : null) as T };
  }

  async fetchCell(): Promise<FakeCellSnapshot> {
    const res = await this.request<FakeCellSnapshot>("GET", "/cell");
    if (res.status !== 200) throw new Error(`GET /cell → ${res.status} ${JSON.stringify(res.body)}`);
    this.snapshot = res.body;
    return res.body;
  }

  /** Reports `ready` for every bot that is not disabled and not ready yet (what the real reconciler does). */
  async ackAll(): Promise<number> {
    const cell = await this.fetchCell();
    let n = 0;
    for (const a of cell.agents) {
      if (a.status === "disabled" || a.status === "ready") continue;
      const res = await this.request("POST", `/agents/${a.id}/status`, { status: "ready" });
      if (res.status === 200) n++;
    }
    return n;
  }

  async reply(m: MentionPayload, text: string) {
    // DMs and AI chats are flat (D-04, P-10): like apps/openclaw-channel, reply and type with no thread root.
    const flat = m.conversation.kind === "dm" || m.conversation.kind === "ai_chat";
    const threadRootMessageId = flat ? null : m.thread.rootMessageId;
    await this.request("POST", "/typing", {
      agentId: m.agent.id,
      conversationId: m.conversation.id,
      threadRootMessageId,
    });
    const res = await this.request<{ messageId: string; created: boolean }>("POST", "/messages", {
      agentId: m.agent.id,
      conversationId: m.conversation.id,
      threadRootMessageId,
      inReplyToMessageId: m.message.id,
      // The trigger (like apps/openclaw-channel): the delivered turn this reply answers.
      eventId: m.eventId,
      text,
      idempotencyKey: `evt:${m.eventId}`,
    });
    if (res.status !== 200) throw new Error(`POST /messages → ${res.status} ${JSON.stringify(res.body)}`);
    this.replies.push({ ...res.body, mention: m });
    return res.body;
  }

  /** Answers an automation run (07.6-06) on its anchor, for its turn, like the real plugin's reply to a run. */
  replyToRun(run: AutomationRunPayload, text: string) {
    return this.reply(run, text);
  }

  /**
   * Posts a typed Agent Card (06-13, `POST /agent-channel/v1/cards`) as `input.agentId`, like the real plugin's card
   * tool: the card lands where the agent may post, for a delivered turn (`eventId`, or the message it was delivered
   * for); 201 when created, 200 on an idempotent retry, 403 `no_trigger` without a turn.
   */
  async postCard(input: {
    agentId: string;
    conversationId: string;
    threadRootId: string | null;
    inReplyToMessageId?: string;
    eventId?: string;
    idempotencyKey: string;
    card: Record<string, unknown>;
  }): Promise<{ messageId: string; version: number }> {
    const res = await this.request<{ messageId: string; version: number }>("POST", "/cards", input);
    if (res.status !== 201 && res.status !== 200) {
      throw new Error(`POST /cards → ${res.status} ${JSON.stringify(res.body)}`);
    }
    return { messageId: res.body.messageId, version: res.body.version };
  }

  /** Updates one of its cards in place (`PATCH /agent-channel/v1/cards/:messageId`, optimistic version). */
  async patchCard(
    messageId: string,
    body: { agentId: string; patch: Record<string, unknown> & { expectedVersion: number } },
  ): Promise<{ version: number }> {
    const res = await this.request<{ version: number }>("PATCH", `/cards/${messageId}`, body);
    if (res.status !== 200) throw new Error(`PATCH /cards → ${res.status} ${JSON.stringify(res.body)}`);
    return { version: res.body.version };
  }

  async start(): Promise<void> {
    if (this.opts.autoAck) await this.ackAll();
    else await this.fetchCell();
    await this.connect(this.opts.afterSeq);
  }

  connect(afterSeq?: number): Promise<void> {
    const url = `${this.base.replace(/^http/, "ws")}/ws`;
    // Node's WebSocket (undici) accepts non-standard headers; browsers never can (the API refuses Origin).
    const ws = new WebSocket(url, { headers: { authorization: `Bearer ${this.opts.token}` } } as never);
    this.ws = ws;
    return new Promise((resolve, reject) => {
      ws.onerror = () => reject(new Error("cell WebSocket failed"));
      ws.onopen = () => {
        const topic = this.snapshot?.topic;
        if (!topic) return reject(new Error("call fetchCell() first"));
        ws.send(JSON.stringify({ op: "sub", topic, ...(afterSeq !== undefined ? { afterSeq } : {}) }));
      };
      ws.onmessage = (msg) => {
        const frame = JSON.parse(String(msg.data)) as {
          op: string;
          seq?: number;
          type?: string;
          data?: FakeCellEvent["data"];
          lastSeq?: number;
        };
        if (frame.op === "subscribed") {
          this.lastSeq = Math.max(this.lastSeq, frame.lastSeq ?? 0);
          resolve();
        } else if (frame.op === "ev" && frame.seq && frame.type && frame.data) {
          this.lastSeq = frame.seq;
          this.events.push({ seq: frame.seq, type: frame.type, data: frame.data });
          void this.onEvent(frame.type, frame.data).finally(() => this.notify());
        }
        this.notify();
      };
    });
  }

  /** Every `POST /turns/:eventId/done` this fake cell sent (07.7 `autoDone`), with the status it got. */
  readonly doneReports: Array<{
    eventId: string;
    agentId: string;
    outcome: "replied" | "failed";
    status: number;
  }> = [];

  /**
   * 07.7 (D-04, P-09): reports a chain turn as done, the real bridge's best-effort `finally` (a failure is recorded,
   * never thrown).
   */
  async turnDone(m: MentionPayload, outcome: "replied" | "failed"): Promise<void> {
    let status = 0;
    try {
      status = (await this.request("POST", `/turns/${m.eventId}/done`, { agentId: m.agent.id, outcome }))
        .status;
    } catch {
      /* unreachable: recorded as status 0 */
    }
    this.doneReports.push({ eventId: m.eventId, agentId: m.agent.id, outcome, status });
  }

  /**
   * Answers one mention-like turn (a mention, or a consult reply when `directives` is false) and, with `autoDone`,
   * reports a chain turn done after its reply, like apps/openclaw-channel's bridge (`mayBelongToChain`).
   */
  private async answerTurn(m: MentionPayload, type: string, directives: boolean): Promise<void> {
    if (this.opts.holdAgents?.has(m.agent.id)) return;
    const chainTurn =
      (m.turn?.tools ?? []).includes(CONSULT_TOOL) || m.origin !== undefined || type === CONSULT_REPLY_EVENT;
    let replied = false;
    try {
      const calls = [
        ...(directives ? parseCallDirectives(m.message.text) : []),
        ...(this.opts.toolCallsFor?.(m) ?? []),
      ];
      const body =
        calls.length > 0
          ? (await this.simulateToolCalls(m, calls)).join("\n")
          : (this.opts.replyText ?? identityReply)(m);
      const links = memberAccountLinks(m);
      await this.reply(
        m,
        body +
          (links.length > 0 ? `\n${links.join("\n")}` : "") +
          turnToolsSuffix(m) +
          turnContextSuffix(m) +
          turnAttachmentsSuffix(m),
      );
      replied = true;
    } finally {
      if (chainTurn && this.opts.autoDone) await this.turnDone(m, replied ? "replied" : "failed");
    }
  }

  async onEvent(type: string, data: FakeCellEvent["data"]) {
    try {
      if (type === "cell.config.changed" && this.opts.autoAck) await this.ackAll();
      if (type === "agent.mention.v1" && this.opts.autoReply) {
        await this.answerTurn(data as unknown as MentionPayload, type, true);
      }
      if (type === CONSULT_REPLY_EVENT && this.opts.autoReply) {
        // 07.7-06: the asking bot's return turn, in the hop's thread in reply to the answer (or the question). Answered
        // like a mention, except that the answer is another bot's text: its `[[call …]]` directives never run.
        await this.answerTurn(data as unknown as ConsultReplyPayload, type, false);
      }
      if (type === WORK_SESSION_EVENT && this.opts.autoReply) {
        await this.answerWake(data as unknown as WorkSessionWakePayload);
      }
      if (type === "agent.automation_run.v1" && this.opts.autoReply) {
        // A run is answered like a mention (07.6-06): on the anchor (`inReplyToMessageId` = the event's message) for its
        // turn (`eventId`); the anchor is in the thread the event names (flat in a DM). Only the persona's own calls run:
        // the server sentence carries no directives, and outside content is never read as one.
        const r = data as unknown as AutomationRunPayload;
        const fanOut = (r.turn?.tools ?? []).includes(BUILTIN_TOOLS.conversationOpen)
          ? (this.opts.fanOutFor?.(r) ?? null)
          : null;
        if (fanOut) {
          await this.answerFanOutRun(r, fanOut);
          return;
        }
        const calls = this.opts.toolCallsFor?.(r) ?? [];
        const body =
          calls.length > 0
            ? (await this.simulateToolCalls(r, calls)).join("\n")
            : (this.opts.replyText ?? identityReply)(r);
        await this.replyToRun(r, body + turnToolsSuffix(r) + turnContextSuffix(r));
      }
      if (type === AUTOMATION_ITEM_EVENT && this.opts.autoReply && this.opts.itemCallsFor) {
        await this.answerItem(data as unknown as AutomationItemPayload);
      }
      if (type === "agent.card_action.v1" && this.opts.autoReply) {
        // An approved grant (07.5 D-02): call the granted tool once, with exactly the granted arguments.
        const a = data as unknown as CardActionPayload;
        const grant = a.cardAction?.outcome === "approved" ? a.cardAction.grant : undefined;
        if (grant) {
          let args: Record<string, unknown> = {};
          try {
            const parsed = JSON.parse(grant.arguments) as unknown;
            if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
              args = parsed as Record<string, unknown>;
            }
          } catch {
            /* the API sends canonical JSON; anything else re-runs with no arguments and is refused */
          }
          const lines = await this.simulateToolCalls(a, [{ tool: grant.tool, args }]);
          this.grantReruns.push({ eventId: a.eventId, tool: grant.tool, lines });
          await this.reply(a, lines.join("\n") + turnToolsSuffix(a) + turnContextSuffix(a));
        } else if (a.cardAction?.outcome === "denied" && this.opts.replyOnDenied) {
          const by = a.cardAction.decidedBy?.displayName ?? "an approver";
          const note = a.cardAction.note ? ` (“${a.cardAction.note}”)` : "";
          await this.reply(a, `Card ${a.cardAction.title}: denied by ${by}${note}`);
        }
      }
      if (this.opts.pluginTools && (type === "plugin.install.v1" || type === "plugin.uninstall.v1")) {
        await this.runPluginFlow(type, data);
      }
      if (this.opts.hostMap && type === "mcp.probe") await this.runMcpProbe(data);
      if (this.opts.deviceAuth) {
        if (type === "provider.auth.start") void this.runDeviceFlow(data);
        if (type === "provider.auth.cancel") this.flows.get(String(data.flowId))?.abort();
        if (type === "provider.auth.revoke") {
          this.credentials.delete(String(data.provider));
          this.revoked.push(String(data.provider));
        }
      }
    } catch (err) {
      console.error("fake cell plugin handler failed", err);
    }
  }

  /**
   * Simulates the cell running each `[[call <tool> <json>]]` of a mention, the way apps/openclaw-channel does:
   * a tool is offered only when it (or a name ending in `__<tool>`) is in `turn.tools`; `ocw_memory_save` posts
   * `{eventId, agentId, text}` to `/agent-channel/v1/memories`; `ocw_board_card` calls the board routes itself
   * (`boardCall`, 07.1-13: like memory, never `/tool-calls`); `ocw_memory_list|read|write|propose` call
   * `/agent-channel/v1/memory/<list|read|write|propose>` (`memoryCall`, 07.2-17); `ocw_connector_list|call` and
   * `ocw_http_request` call `/agent-channel/v1/connectors/list|call` and `/http-requests` (`connectorCall`, 07.4-14);
   * `ocw_work_zone_projects` / `ocw_start_work_zone` call `/agent-channel/v1/work-zone/projects|proposals`
   * (`workZoneCall`, 07.5-12); `ocw_work_session_start|prompt|read|stop` call `/agent-channel/v1/work-sessions/<verb>`
   * (`workSessionCall`, 07.16-21); `ocw_sandbox_*` / `ocw_browser_*` call `/agent-channel/v1/sandbox|browser/<verb>`
   * (`sandbox` / `browser`, 07.8-08); `ocw_consult_agent` calls `/agent-channel/v1/consultations` (`consultCall`,
   * 07.7-10); `ocw_attachment_read` calls `/agent-channel/v1/attachments/read` (`attachmentRead`, 07.15-09); any other
   * tool asks `/agent-channel/v1/tool-calls` (with the call's `arguments` only when
   * its delivered flags carry `approval`, 07.5 D-01) and, when allowed, reports a result. Before any of that, a
   * `{{attachment:N}}` argument becomes the turn's N-th file id (`withAttachmentIds`; outside the list the call is not
   * sent and reads `refused (not_found)`). One line per call:
   * `Tool <offered name>: allowed | denied (<reason>) | approval_required | approval_pending | approval_denied |
   * approval_used`, `Tool <name>: saved | created | moved | waiting set | read | listed | written | proposed |
   * refused (<code>) | not offered`.
   */
  async simulateToolCalls(
    m: MentionPayload,
    calls: Array<{ tool: string; args: Record<string, unknown> }>,
  ): Promise<string[]> {
    const lines: string[] = [];
    const offered = m.turn?.tools ?? [];
    let boardCreates = 0;
    let consults = 0;
    for (const directive of calls) {
      const args = withAttachmentIds(m, directive.args);
      if (args === null) {
        lines.push(`Tool ${directive.tool}: refused (not_found)`);
        continue;
      }
      const call = { tool: directive.tool, args };
      if (isConnectorTool(call.tool)) {
        // The logical connector tool decides `ocw_connector_call` (connectorCall); list and http are offered by name.
        if (call.tool !== "ocw_connector_call" && !offered.includes(call.tool)) {
          const w = m.turn?.withheld?.find((x) => x.tool === call.tool);
          lines.push(`Tool ${call.tool}: ${w ? `refused (${w.reason})` : "not offered"}`);
          continue;
        }
        lines.push(`Tool ${call.tool}: ${await this.connectorCall(m, call.tool, call.args)}`);
        continue;
      }
      const name = offered.find((t) => t === call.tool || t.endsWith(`__${call.tool}`));
      if (!name) {
        // Like apps/openclaw-channel's "Tools withheld in this conversation" block (06-10): say why, for whom.
        const withheld = m.turn?.withheld?.find(
          (w) => w.tool === call.tool || w.tool.endsWith(`__${call.tool}`),
        );
        lines.push(
          withheld
            ? `Tool ${call.tool}: not available for ${m.message.author.displayName} (${withheld.reason})`
            : `Tool ${call.tool}: not offered`,
        );
        continue;
      }
      if (name === CONSULT_TOOL) {
        lines.push(`Tool ${call.tool}: ${await this.consultCall(m, call.args, ++consults)}`);
        continue;
      }
      if (name === BUILTIN_TOOLS.attachmentRead) {
        lines.push(`Tool ${call.tool}: ${await this.attachmentRead(m, call.args)}`);
        continue;
      }
      if (isSandboxTool(name)) {
        lines.push(`Tool ${call.tool}: ${await this.sandbox(m, name, call.args)}`);
        continue;
      }
      if (isBrowserTool(name)) {
        lines.push(`Tool ${call.tool}: ${await this.browser(m, name, call.args)}`);
        continue;
      }
      if (name === "ocw_memory_save") {
        const res = await this.request<{ error?: { code?: string } }>("POST", "/memories", {
          eventId: m.eventId,
          agentId: m.agent.id,
          text: typeof call.args.text === "string" ? call.args.text : "",
        });
        lines.push(
          res.status === 200
            ? `Tool ${call.tool}: saved`
            : `Tool ${call.tool}: denied (${res.body?.error?.code ?? res.status})`,
        );
        continue;
      }
      if (name === "ocw_board_card") {
        lines.push(`Tool ${call.tool}: ${await this.boardCall(m, call.args, ++boardCreates)}`);
        continue;
      }
      if (isMemoryFileTool(name)) {
        lines.push(`Tool ${call.tool}: ${await this.memoryCall(m, name, call.args)}`);
        continue;
      }
      if (isWorkZoneTool(name)) {
        lines.push(`Tool ${call.tool}: ${await this.workZoneCall(m, name, call.args)}`);
        continue;
      }
      if (isWorkSessionTool(name)) {
        lines.push(`Tool ${call.tool}: ${(await this.workSessionCall(m, name, call.args)).line}`);
        continue;
      }
      const params: { query?: string; url?: string } = {};
      if (typeof call.args.query === "string") params.query = call.args.query;
      if (typeof call.args.url === "string") params.url = call.args.url;
      // 07.5 D-01: the full arguments travel only for a tool with an approval policy on this turn.
      const flagged = m.turn?.toolFlags?.[name]?.approval !== undefined;
      this.toolCallRequests.push({
        eventId: m.eventId,
        tool: name,
        ...(flagged ? { arguments: call.args } : {}),
      });
      const res = await this.request<{ callId?: string; allowed?: boolean; reason?: string | null }>(
        "POST",
        "/tool-calls",
        {
          eventId: m.eventId,
          agentId: m.agent.id,
          tool: name,
          params,
          ...(flagged ? { arguments: call.args } : {}),
        },
      );
      // The line names the tool the turn offered (`<safe>__echo` for an MCP tool), like the gate saw it.
      if (res.status !== 200 || !res.body.allowed || !res.body.callId) {
        const reason = res.body?.reason ?? null;
        lines.push(
          reason?.startsWith("approval_")
            ? `Tool ${name}: ${reason}`
            : `Tool ${name}: denied (${reason ?? res.status})`,
        );
        continue;
      }
      await this.request("POST", `/tool-calls/${res.body.callId}/result`, {
        status: "ok",
        resultCount: 0,
        durationMs: 1,
      });
      lines.push(`Tool ${name}: allowed`);
    }
    return lines;
  }

  /** Every confined route call (07.8-08): the route, the keys sent (never values) and the status it got. */
  readonly confinedRequests: Array<{ eventId: string; route: string; keys: string[]; status: number }> = [];

  private async confined(m: MentionPayload, tool: SandboxTool | BrowserTool, args: Record<string, unknown>) {
    const route = confinedRoute(tool);
    const body = { ...args, eventId: m.eventId, agentId: m.agent.id };
    const res = await this.request<Loose | null>("POST", route, body);
    this.confinedRequests.push({
      eventId: m.eventId,
      route,
      keys: Object.keys(body).sort(),
      status: res.status,
    });
    return res;
  }

  /**
   * `ocw_sandbox_*` the way apps/openclaw-channel's sandbox-tools.ts sends it (07.8-06): `POST /agent-channel/v1/
   * sandbox/<verb>` with the mention's `eventId` and `agentId` beside the model's arguments. Answers the rendered result,
   * `refused (<code>)` when the API refused with a `SandboxRefusal` code, else `failed (<HTTP status>)`.
   */
  async sandbox(m: MentionPayload, tool: SandboxTool, args: Record<string, unknown>): Promise<string> {
    const res = await this.confined(m, tool, args);
    if (res.status === 200 && res.body) return renderSandbox(tool, res.body);
    const code = SandboxRefusal.safeParse(res.body?.error?.code);
    return code.success ? `refused (${code.data})` : `failed (${res.status})`;
  }

  /** Every `POST /attachments/read` the simulated tool made (07.15-09): the turn, the file id and the status it got. */
  readonly attachmentRequests: Array<{ eventId: string; attachmentId: string; status: number }> = [];

  /**
   * `ocw_attachment_read` the way apps/openclaw-channel's attachment-tool.ts sends it (07.15-06): `POST
   * /agent-channel/v1/attachments/read` with the mention's `eventId` and `agentId` beside the model's `attachmentId`,
   * nothing else. Answers `read <name>: <first line of the file's content>` for text, `image <name> (<mimeType>)` for an
   * image (never its bytes), `refused (<code>)` for a refusal (a 200 answer, or the error envelope's code otherwise),
   * else `failed (<HTTP status>)`.
   */
  async attachmentRead(m: MentionPayload, args: Record<string, unknown>): Promise<string> {
    const attachmentId = typeof args.attachmentId === "string" ? args.attachmentId : "";
    const res = await this.request<Loose | null>("POST", "/attachments/read", {
      eventId: m.eventId,
      agentId: m.agent.id,
      attachmentId,
    });
    this.attachmentRequests.push({ eventId: m.eventId, attachmentId, status: res.status });
    const b = res.body;
    if (res.status === 200 && b) {
      if (b.kind === "text") return `read ${b.name}: ${firstContentLine(String(b.text ?? ""))}`;
      if (b.kind === "image") return `image ${b.name} (${b.mimeType})`;
      if (b.kind === "refused") return `refused (${b.code})`;
    }
    return b?.error?.code ? `refused (${b.error.code})` : `failed (${res.status})`;
  }

  /** `ocw_browser_*` likewise (`/browser/<verb>`), refusals parsed with `BrowserRefusal`. */
  async browser(m: MentionPayload, tool: BrowserTool, args: Record<string, unknown>): Promise<string> {
    const res = await this.confined(m, tool, args);
    if (res.status === 200 && res.body) return renderBrowser(tool, res.body);
    const code = BrowserRefusal.safeParse(res.body?.error?.code);
    return code.success ? `refused (${code.data})` : `failed (${res.status})`;
  }

  /** Every connector or keychain route call the simulated tools made, with the status it got (07.4-14). */
  readonly connectorRequests: Array<{ eventId: string; route: string; status: number; body: unknown }> = [];

  /**
   * `ocw_connector_list | ocw_connector_call | ocw_http_request` the way apps/openclaw-channel's connector-tools.ts
   * sends them (07.4-09) to `POST /agent-channel/v1/connectors/list`, `/agent-channel/v1/connectors/call` and
   * `/agent-channel/v1/http-requests`: only the mention's event and agent ids beside the model's arguments, never a user id or a
   * credential (the API binds the asker to the stored turn). A connector call whose logical tool `<safe>__<tool>` is not
   * on the turn is not sent: withheld as `member_account` it reads `refused (member_account)`, else `not offered`.
   * Answers: list `<n> connectors, <k> keys`; call the API's content (`error: …` when it is an error result); http
   * `<status> <body>`; any refusal `refused (<code>)`.
   */
  private async connectorCall(m: MentionPayload, tool: ConnectorTool, args: Record<string, unknown>) {
    const turn = { eventId: m.eventId, agentId: m.agent.id };
    const send = async <T>(route: string, body: Record<string, unknown>) => {
      const res = await this.request<T & { error?: { code?: string } }>("POST", route, body);
      this.connectorRequests.push({ eventId: m.eventId, route, status: res.status, body: res.body });
      return res;
    };
    const refused = (res: { status: number; body: { error?: { code?: string } } | null }) =>
      `refused (${res.body?.error?.code ?? res.status})`;
    if (tool === "ocw_connector_list") {
      const res = await send<{ connectors: unknown[]; keys: unknown[] }>("/connectors/list", turn);
      return res.status === 200
        ? `${res.body.connectors.length} connectors, ${res.body.keys.length} keys`
        : refused(res);
    }
    if (tool === "ocw_connector_call") {
      const connector = typeof args.connector === "string" ? args.connector : "";
      const name = typeof args.tool === "string" ? args.tool : "";
      const logical = `${connector}__${name}`;
      if (!(m.turn?.tools ?? []).includes(logical)) {
        const withheld = m.turn?.withheld?.find((w) => w.tool === logical);
        return withheld ? `refused (${withheld.reason})` : "not offered";
      }
      const res = await send<{ content: string; isError: boolean }>("/connectors/call", {
        ...turn,
        connector,
        tool: name,
        arguments: args.arguments && typeof args.arguments === "object" ? args.arguments : {},
      });
      if (res.status !== 200) return refused(res);
      return res.body.isError ? `error: ${res.body.content}` : res.body.content;
    }
    const res = await send<{ status: number; body: string }>("/http-requests", {
      ...turn,
      handle: args.handle,
      method: args.method,
      url: args.url,
      ...(args.headers ? { headers: args.headers } : {}),
      ...(args.body !== undefined ? { body: args.body } : {}),
    });
    return res.status === 200 ? `${res.body.status} ${res.body.body}` : refused(res);
  }

  /** Every `POST /consultations` the simulated `ocw_consult_agent` made (07.7-10), with the status and body it got. */
  readonly consultRequests: Array<{ eventId: string; status: number; body: unknown }> = [];

  /**
   * `ocw_consult_agent` the way apps/openclaw-channel's consult-tool.ts sends it (07.7-05): the target named by the model
   * (a bot id or `@handle`) must be one of `turn.consult.targets` (else `refused (not_a_target)`, nothing sent); then
   * `POST /agent-channel/v1/consultations` with only the turn's event and agent, the target's id, the trimmed question,
   * the mode (default `consult`) and the key `<eventId>:consult:<n>`. Answers the server's sentence, or
   * `refused (<code>)` (the body's `code`, else the error envelope's, else the HTTP status).
   */
  private async consultCall(m: MentionPayload, args: Record<string, unknown>, n: number): Promise<string> {
    const raw = typeof args.target === "string" ? args.target.trim().replace(/^@/u, "").toLowerCase() : "";
    const target = (m.turn?.consult?.targets ?? []).find(
      (t) => raw !== "" && (t.id.toLowerCase() === raw || t.handle.toLowerCase() === raw),
    );
    if (!target) return "refused (not_a_target)";
    const res = await this.request<{
      ok?: boolean;
      code?: string;
      sentence?: string;
      error?: { code?: string };
    } | null>("POST", "/consultations", {
      eventId: m.eventId,
      agentId: m.agent.id,
      target: target.id,
      question: typeof args.question === "string" ? args.question.trim() : "",
      mode: args.mode === "handoff" ? "handoff" : "consult",
      idempotencyKey: `${m.eventId}:consult:${n}`,
    });
    this.consultRequests.push({ eventId: m.eventId, status: res.status, body: res.body });
    if (res.status === 200 && res.body?.ok === true) return res.body.sentence ?? "sent";
    return `refused (${res.body?.code ?? res.body?.error?.code ?? res.status})`;
  }

  /** Every grant re-run (07.5 D-02): the card action's event, the granted tool and the lines it produced. */
  readonly grantReruns: Array<{ eventId: string; tool: string; lines: string[] }> = [];

  /** Every Work Zone route call the simulated tools made, with the body sent and the answer (07.5-12). */
  readonly workZoneRequests: Array<{
    eventId: string;
    route: string;
    sent: Record<string, unknown>;
    status: number;
    body: unknown;
  }> = [];

  /**
   * `ocw_work_zone_projects | ocw_start_work_zone` the way apps/openclaw-channel's work-zone-tools.ts sends them
   * (07.5-10) to `POST /agent-channel/v1/work-zone/projects` and `/work-zone/proposals`: the mention's `eventId` and
   * `agentId`, and for a proposal only `projectId`, `deviceId`, `prompt` and `runtime` from the model's arguments, never
   * a user id or a mode (the API binds the human to the stored turn and always starts Supervised). Answers `listed`,
   * `proposed`, `refused (<code>)` for an in-band refusal or an HTTP error.
   */
  private async workZoneCall(m: MentionPayload, tool: WorkZoneTool, args: Record<string, unknown>) {
    const route = `/work-zone/${WORK_ZONE_TOOLS[tool]}`;
    const sent: Record<string, unknown> = { eventId: m.eventId, agentId: m.agent.id };
    if (tool === "ocw_start_work_zone") {
      for (const key of PROPOSAL_FIELDS) if (args[key] !== undefined) sent[key] = args[key];
    }
    const res = await this.request<{
      approvalId?: string;
      refused?: string;
      projects?: unknown[];
      error?: { code?: string };
    }>("POST", route, sent);
    this.workZoneRequests.push({ eventId: m.eventId, route, sent, status: res.status, body: res.body });
    if (res.status !== 200) return `refused (${res.body?.error?.code ?? res.status})`;
    if (typeof res.body?.refused === "string") return `refused (${res.body.refused})`;
    return tool === "ocw_work_zone_projects" ? "listed" : "proposed";
  }

  /** Every bot Work Zone session route call (07.16-21): the tool, the route, the body sent and the answer. */
  readonly workSessionRequests: Array<{
    eventId: string;
    tool: WorkSessionTool;
    route: string;
    sent: Record<string, unknown>;
    status: number;
    body: Loose | null;
  }> = [];

  /** Every `agent.work_session.v1` this fake cell answered (07.16-21): the transition and the reply's text. */
  readonly workSessionWakes: Array<{
    eventId: string;
    transition: WorkSessionWakePayload["workSession"]["transition"];
    workSessionId: string;
    text: string;
    /** 07.17-18: the lines of `wakeCallsFor`'s calls, on the wakes of an item's card only. */
    lines?: string[];
  }> = [];

  /**
   * `ocw_work_session_start | _prompt | _read | _stop` the way apps/openclaw-channel's work-session-tools.ts sends them
   * (07.16-08): `POST /agent-channel/v1/work-sessions/<verb>` with the mention's `eventId` and `agentId` and only the
   * tool's own keys the model gave (`WORK_SESSION_KEYS`; strings trimmed). Self-validated by its route, never
   * `/tool-calls`. Lines: `started <projectName> (<mode>)`, `proposed`, `queued`, `read <status>: <last output line>`,
   * `stopped`, `refused (<code>)` for an in-band refusal or the error envelope's code (else the HTTP status).
   */
  async workSessionCall(
    m: MentionPayload,
    tool: WorkSessionTool,
    args: Record<string, unknown>,
  ): Promise<{ line: string; body: Loose | null }> {
    const route = `/work-sessions/${workSessionVerb(tool)}`;
    const sent: Record<string, unknown> = { eventId: m.eventId, agentId: m.agent.id };
    for (const key of WORK_SESSION_KEYS[tool]) {
      const value = args[key];
      if (value !== undefined) sent[key] = typeof value === "string" ? value.trim() : value;
    }
    const res = await this.request<Loose | null>("POST", route, sent);
    this.workSessionRequests.push({
      eventId: m.eventId,
      tool,
      route,
      sent,
      status: res.status,
      body: res.body,
    });
    const b = res.body;
    if (res.status !== 200 || !b) return { line: `refused (${b?.error?.code ?? res.status})`, body: b };
    switch (b.kind) {
      case "started":
        return { line: `started ${b.projectName} (${b.mode})`, body: b };
      case "proposed":
      case "queued":
      case "stopped":
        return { line: String(b.kind), body: b };
      case "read":
        return { line: `read ${b.session?.status}: ${lastOutputLine(b)}`, body: b };
      default:
        return { line: `refused (${b.code ?? res.status})`, body: b };
    }
  }

  /** The `@handle` a wake reply mentions a person by (`userHandles`, else the wake's decider, else the name). */
  private handleOf(w: WorkSessionWakePayload, userId: string, displayName: string): string {
    const known =
      this.opts.userHandles?.[userId] ?? w.workSession.deciders.find((d) => d.id === userId)?.handle;
    return known ?? (displayName.trim().toLowerCase().replace(/\s+/gu, "-") || "asker");
  }

  /**
   * PD-26: answers `agent.work_session.v1` deterministically, on the card in its thread for the wake (`reply`: the
   * event's thread, `inReplyToMessageId` = the card message, `eventId` = the wake). `turn_done` calls
   * `ocw_work_session_read` (when the wake offers it) and replies `Done: <last output line> @<asker>`; `waiting_approval`
   * reads it too (when offered: the summary is a count only, WR-01) and replies `Needs approval: <tools> @<decider> …`
   * (`a tool` without the read; the bot never approves, D-10); `failed`, `ended` and `offline` reply
   * `<transition>: <summary> @<asker>`. Never for a held bot.
   */
  private async answerWake(w: WorkSessionWakePayload): Promise<void> {
    if (this.opts.holdAgents?.has(w.agent.id)) return;
    const ws = w.workSession;
    const asker = `@${this.handleOf(w, w.message.author.id, w.message.author.displayName)}`;
    const escalation = this.escalationByRoot.get(w.thread.rootMessageId);
    if (escalation && this.opts.wakeCallsFor && ws.transition === "turn_done") {
      // PD-22: the item's card. The spec's calls (the read, the move), then the people the automation names.
      const lines = await this.simulateToolCalls(
        w,
        this.opts.wakeCallsFor(w, { escalationHandles: escalation }),
      );
      const read = this.workSessionRequests
        .filter(
          (r) =>
            r.eventId === w.eventId && r.tool === BUILTIN_TOOLS.workSessionRead && r.body?.kind === "read",
        )
        .at(-1);
      const line = (read ? lastOutputLine(read.body) : "") || ws.summary;
      const people = escalation.length > 0 ? escalation.map((h) => `@${h}`).join(" ") : asker;
      const text = `Done: ${line} ${people}`;
      await this.reply(w, text);
      this.workSessionWakes.push({
        eventId: w.eventId,
        transition: ws.transition,
        workSessionId: ws.workSessionId,
        text,
        lines,
      });
      return;
    }
    const read = (w.turn?.tools ?? []).includes(BUILTIN_TOOLS.workSessionRead)
      ? () => this.workSessionCall(w, BUILTIN_TOOLS.workSessionRead, { workSessionId: ws.workSessionId })
      : null;
    let text: string;
    if (ws.transition === "turn_done") {
      let line = ws.summary;
      if (read) {
        const r = await read();
        line = r.body?.kind === "read" ? lastOutputLine(r.body) || ws.summary : r.line;
      }
      text = `Done: ${line} ${asker}`;
    } else if (ws.transition === "waiting_approval") {
      const tools = approvalToolsOf(read ? (await read()).body : null);
      const deciders = ws.deciders.map((d) => `@${d.handle}`);
      text = `Needs approval: ${tools}${deciders.length > 0 ? ` ${deciders.join(" ")}` : ""}`;
    } else {
      text = `${ws.transition}: ${ws.summary} ${asker}`;
    }
    await this.reply(w, text);
    this.workSessionWakes.push({
      eventId: w.eventId,
      transition: ws.transition,
      workSessionId: ws.workSessionId,
      text,
    });
  }

  /** Every memory route call the simulated memory tools made, with the status and body it got (07.2-17). */
  readonly memoryRequests: Array<{ eventId: string; route: string; status: number; body: unknown }> = [];

  /**
   * `ocw_memory_list|read|write|propose` the way apps/openclaw-channel's memory-files-tool.ts sends them (07.2-17): the
   * model's arguments as they are, next to the mention's `eventId` and `agentId`; never a user or owner id (the API binds
   * the human to the stored turn). Answers `listed`, `read`, `written`, `proposed`, `refused (<code>)` for an in-band
   * refusal or `denied (<code>)` for an HTTP error.
   */
  private async memoryCall(
    m: MentionPayload,
    tool: MemoryFileTool,
    args: Record<string, unknown>,
  ): Promise<string> {
    const route = `/memory/${MEMORY_FILE_TOOLS[tool]}`;
    const res = await this.request<{ refused?: string; error?: { code?: string } }>("POST", route, {
      ...args,
      eventId: m.eventId,
      agentId: m.agent.id,
    });
    this.memoryRequests.push({ eventId: m.eventId, route, status: res.status, body: res.body });
    if (res.status !== 200) return `denied (${res.body?.error?.code ?? res.status})`;
    if (typeof res.body?.refused === "string") return `refused (${res.body.refused})`;
    return MEMORY_FILE_DONE[tool];
  }

  /** Every board route call the simulated `ocw_board_card` made, with the status it got (07.1-13). */
  readonly boardRequests: Array<{ eventId: string; route: string; status: number }> = [];

  /**
   * `ocw_board_card` the way apps/openclaw-channel's board-tool.ts runs it (07.1-13): only the mention's event and agent
   * travel, never a conversation; a create is keyed `<eventId>:board:<n>`; a move or a waiting state reads the turn
   * thread's card version first (`POST /board/read`) and names it. Never card text on a change. Answers `created`,
   * `moved`, `waiting set`, `read` or `denied (<code>)`.
   */
  private async boardCall(m: MentionPayload, args: Record<string, unknown>, n: number): Promise<string> {
    const turn = { eventId: m.eventId, agentId: m.agent.id };
    type ErrorBody = { error?: { code?: string } };
    const call = async <T>(method: string, route: string, body: Record<string, unknown>) => {
      const res = await this.request<T & ErrorBody>(method, route, body);
      this.boardRequests.push({ eventId: m.eventId, route: `${method} ${route}`, status: res.status });
      return res;
    };
    const denied = (res: { status: number; body: ErrorBody | null }) =>
      `denied (${res.body?.error?.code ?? res.status})`;
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    // 07.17 (D-06, D-12), like the plugin: outside content or a session's output never creates a card or reads the board.
    const restricted = this.restrictedTurn(m);
    if (restricted && (args.action === "create" || args.action === "read")) return "denied (tainted)";
    if (restricted) return this.restrictedBoardChange(m, args, call);
    if (args.action === "create") {
      const res = await call<{ card: { messageId: string } }>("POST", "/board/cards", {
        ...turn,
        idempotencyKey: `${m.eventId}:board:${n}`,
        description: str(args.description) ?? "",
        ...(str(args.title) ? { title: str(args.title) } : {}),
        ...(str(args.columnId) ? { columnId: str(args.columnId) } : {}),
        ...(str(args.waitingOn) ? { waitingOn: str(args.waitingOn) } : {}),
      });
      return res.status === 201 || res.status === 200 ? "created" : denied(res);
    }
    const read = await call<{ card: { messageId: string; version: number } | null }>(
      "POST",
      "/board/read",
      turn,
    );
    if (read.status !== 200) return denied(read);
    if (args.action === "read") return "read";
    const card = read.body.card;
    if (!card) return "denied (not_a_card)";
    const change =
      args.action === "move"
        ? { move: { columnId: str(args.columnId) ?? "", afterCardId: str(args.afterCardId) ?? null } }
        : args.action === "set_waiting"
          ? { waitingOn: str(args.waitingOn) ?? "" }
          : null;
    if (!change) return "denied (unknown_action)";
    const res = await call("PATCH", `/board/cards/${card.messageId}`, {
      ...turn,
      expectedVersion: card.version,
      ...change,
    });
    if (res.status !== 200) return denied(res);
    return args.action === "move" ? "moved" : "waiting set";
  }

  /** A turn that started tainted, or read a Work Zone session's output (07.17 D-06, D-12): it may not read the board. */
  private restrictedTurn(m: MentionPayload): boolean {
    return (
      m.turn?.tainted === true ||
      this.workSessionRequests.some(
        (r) => r.eventId === m.eventId && r.tool === BUILTIN_TOOLS.workSessionRead,
      )
    );
  }

  /** The card versions this cell last saw (`<agentId>:<cardId>`), like the plugin's board-tool memory (07.17 D-06). */
  private readonly boardVersions = new Map<string, number>();

  /**
   * A move or waiting change on a turn that may not read the board (apps/openclaw-channel's board-tool.ts, 07.17 D-06):
   * the thread's card (or `cardId`) at the version this cell last saw, else 1 (a card the automation just opened); a 409
   * `board_card_version_conflict` whose details carry that card is retried ONCE at its version. The route decides.
   */
  private async restrictedBoardChange(
    m: MentionPayload,
    args: Record<string, unknown>,
    call: <T>(
      method: string,
      route: string,
      body: Record<string, unknown>,
    ) => Promise<{ status: number; body: (T & { error?: { code?: string } }) | null }>,
  ): Promise<string> {
    const str = (v: unknown) => (typeof v === "string" ? v : undefined);
    const change =
      args.action === "move"
        ? { move: { columnId: str(args.columnId) ?? "", afterCardId: str(args.afterCardId) ?? null } }
        : args.action === "set_waiting"
          ? { waitingOn: str(args.waitingOn) ?? "" }
          : null;
    if (!change) return "denied (unknown_action)";
    const cardId = str(args.cardId) ?? m.thread.rootMessageId;
    const key = `${m.agent.id}:${cardId}`;
    type Card = { messageId?: string; version?: number };
    type Answer = { card?: Card; error?: { code?: string; details?: { card?: Card } } };
    const patch = (expectedVersion: number) =>
      call<Answer>("PATCH", `/board/cards/${cardId}`, {
        eventId: m.eventId,
        agentId: m.agent.id,
        expectedVersion,
        ...change,
      });
    let res = await patch(this.boardVersions.get(key) ?? 1);
    const current = res.body?.error?.details?.card;
    if (
      res.status === 409 &&
      res.body?.error?.code === "board_card_version_conflict" &&
      current?.messageId === cardId &&
      typeof current.version === "number"
    ) {
      res = await patch(current.version);
    }
    if (res.status !== 200) {
      if (res.status === 409) this.boardVersions.delete(key);
      return `denied (${res.body?.error?.code ?? res.status})`;
    }
    const version = res.body?.card?.version;
    if (typeof version === "number") this.boardVersions.set(key, version);
    return args.action === "move" ? "moved" : "waiting set";
  }

  /** Every `POST /conversations/open` this cell made (07.17-18): the body sent exactly, the status and the answer. */
  readonly conversationOpenRequests: Array<{
    eventId: string;
    sent: Record<string, unknown>;
    status: number;
    body: Loose | null;
  }> = [];

  /** Every item turn this cell answered (07.17-18): its thread root, the item's title and the lines its calls made. */
  readonly itemTurns: Array<{ eventId: string; rootMessageId: string; title: string; lines: string[] }> = [];

  /** The escalation handles of the item turns answered, by thread root (the card or message the run opened). */
  private readonly escalationByRoot = new Map<string, string[]>();

  /**
   * PD-22: a fan-out run. One read of `<connector>__list_records` (nothing sent, and nothing opened, when the turn does
   * not offer it), the way the real cell reaches that server: a server `GET /cell` renders (`org_secret`, the e2e ERP)
   * is called by the cell itself after the gate (`inCellMcpCall`); any other (per-member or organization account) goes
   * through `ocw_connector_call`, the API's proxy, which serves only those modes. Then exactly the plugin's
   * `ocw_conversation_open` body (`{ eventId, agentId, items }`, apps/openclaw-channel's conversation-open-tool.ts) with
   * an item per kept id, then one reply on the run card: `Opened <opened>, existing <existing>`, or the refusal.
   */
  private async answerFanOutRun(
    r: AutomationRunPayload,
    fanOut: { connector: string; select?: (ids: string[]) => string[] },
  ): Promise<void> {
    if (this.opts.holdAgents?.has(r.agent.id)) return;
    const logical = `${fanOut.connector}__list_records`;
    if (!(r.turn?.tools ?? []).includes(logical)) {
      const withheld = r.turn?.withheld?.find((w) => w.tool === logical);
      await this.replyToRun(
        r,
        `Tool ocw_connector_call: ${withheld ? `refused (${withheld.reason})` : "not offered"}`,
      );
      return;
    }
    const cell = await this.request<FakeCellSnapshot | null>("GET", "/cell");
    const rendered =
      cell.status === 200 ? cell.body?.mcpServers?.find((s) => s.safeName === fanOut.connector) : undefined;
    const tool = rendered ? logical : "ocw_connector_call";
    const listed = rendered
      ? await this.inCellMcpCall(r, rendered, "list_records", {})
      : await this.connectorCall(r, "ocw_connector_call", {
          connector: fanOut.connector,
          tool: "list_records",
          arguments: {},
        });
    const ids = idsOf(listed);
    if (!ids) {
      await this.replyToRun(r, `Tool ${tool}: ${listed}`);
      return;
    }
    const kept = fanOut.select ? fanOut.select(ids) : ids;
    const sent = {
      eventId: r.eventId,
      agentId: r.agent.id,
      items: kept.map((id) => ({ externalKey: id, title: `Order ${id}`, body: `Order ${id} from the ERP.` })),
    };
    const res = await this.request<Loose | null>("POST", "/conversations/open", sent);
    this.conversationOpenRequests.push({ eventId: r.eventId, sent, status: res.status, body: res.body });
    const b = res.body;
    if (res.status !== 200 || b?.ok !== true || !Array.isArray(b.results)) {
      const code = b?.code ?? b?.error?.code ?? res.status;
      await this.replyToRun(r, `Tool ${BUILTIN_TOOLS.conversationOpen}: refused (${code})`);
      return;
    }
    const results = b.results as Array<{ opened?: boolean; refused?: string | null }>;
    const opened = results.filter((x) => x.opened === true).length;
    const existing = results.filter((x) => x.opened !== true && !x.refused).length;
    await this.replyToRun(r, `Opened ${opened}, existing ${existing}`);
  }

  /**
   * A tool of an organization MCP server the cell renders (`GET /cell` → `mcpServers`: `org_secret`, its headers'
   * values for the cell only), run the way OpenClaw runs it: the plugin's gate first (`POST /tool-calls` with the
   * offered name `<safe>__<tool>`, the arguments only when the turn flags an approval on it), then the server itself
   * (`initialize`, `notifications/initialized`, `tools/call` over streamable HTTP with the rendered headers; `mcpHostMap`
   * rewrites its host), then `POST /tool-calls/:callId/result`. The connector proxy is never used for such a server
   * (it serves only the per-member and organization-account modes: `not_in_turn`). Returns the tool's text, or
   * `denied (<reason>)`, `approval_*`, `error: <text>`.
   */
  private async inCellMcpCall(
    m: MentionPayload,
    server: NonNullable<FakeCellSnapshot["mcpServers"]>[number],
    tool: string,
    args: Record<string, unknown>,
  ): Promise<string> {
    const name = `${server.safeName}__${tool}`;
    const flagged = m.turn?.toolFlags?.[name]?.approval !== undefined;
    this.toolCallRequests.push({ eventId: m.eventId, tool: name, ...(flagged ? { arguments: args } : {}) });
    const gate = await this.request<{ callId?: string; allowed?: boolean; reason?: string | null } | null>(
      "POST",
      "/tool-calls",
      {
        eventId: m.eventId,
        agentId: m.agent.id,
        tool: name,
        params: {},
        ...(flagged ? { arguments: args } : {}),
      },
    );
    const callId = gate.body?.callId;
    if (gate.status !== 200 || gate.body?.allowed !== true || !callId) {
      const reason = gate.body?.reason ?? null;
      return reason?.startsWith("approval_") ? reason : `denied (${reason ?? gate.status})`;
    }
    const started = Date.now();
    let text = "";
    let isError = false;
    try {
      const rpc = mcpSession(server, this.opts.mcpHostMap);
      await rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ocw-fake-cell", version: "1.0.0" },
      });
      await rpc(null, "notifications/initialized");
      const called = await rpc(2, "tools/call", { name: tool, arguments: args });
      const content = (called.result?.content as Array<{ type?: string; text?: string }> | undefined) ?? [];
      text = content.map((c) => c.text ?? "").join("\n");
      isError = called.result?.isError === true;
    } catch (err) {
      text = err instanceof Error ? err.message : String(err);
      isError = true;
    }
    await this.request("POST", `/tool-calls/${callId}/result`, {
      status: isError ? "error" : "ok",
      resultCount: isError ? 0 : 1,
      durationMs: Date.now() - started,
    });
    return isError ? `error: ${text}` : text;
  }

  /** PD-22: an item turn. The spec's calls run in the item's thread (the reply answers the opened root). */
  private async answerItem(item: AutomationItemPayload): Promise<void> {
    if (this.opts.holdAgents?.has(item.agent.id)) return;
    const root = item.thread.rootMessageId;
    this.escalationByRoot.set(
      root,
      (item.automationItem?.escalation ?? []).map((e) => e.handle),
    );
    const calls = (await this.opts.itemCallsFor?.(item)) ?? [];
    const lines = calls.length > 0 ? await this.simulateToolCalls(item, calls) : [];
    const title = item.automationItem?.item.title ?? "";
    await this.reply(item, lines.length > 0 ? lines.join("\n") : `Read ${title}`);
    this.itemTurns.push({ eventId: item.eventId, rootMessageId: root, title, lines });
  }

  private step() {
    return new Promise((r) => setTimeout(r, this.opts.stepMs ?? 1200));
  }

  /** The marketplace executor, simulated: no download, no OpenClaw; the API re-scores the report as usual. */
  private async runPluginFlow(type: string, data: FakeCellEvent["data"]) {
    const step = () => this.step();
    const report = async (body: Record<string, unknown>) => {
      const res = await this.request("POST", "/plugins/report", body);
      this.pluginReports.push({ status: res.status, body });
      this.notify();
      return res;
    };
    const flowId = String(data.flowId);
    const pluginRowId = String(data.pluginRowId);
    if (type === "plugin.uninstall.v1") {
      await step();
      await report({ flowId, pluginRowId, state: "uninstalled", pluginId: String(data.pluginId) });
      return;
    }
    const packageName = String(data.packageName);
    await step();
    await report({ flowId, pluginRowId, state: "installing" });
    await step();
    const tools =
      this.opts.pluginTools?.[`${packageName}@${String(data.version)}`] ??
      this.opts.pluginTools?.[packageName] ??
      [];
    await report({
      flowId,
      pluginRowId,
      state: "installed",
      pluginId: typeof data.expectedPluginId === "string" ? data.expectedPluginId : packageName,
      version: String(data.version),
      declaredTools: tools.map((name) => ({ name })),
    });
  }

  /** The MCP probe, simulated with plain JSON-RPC over fetch (the fake MCP answers single JSON responses). */
  private async runMcpProbe(data: FakeCellEvent["data"]) {
    const probeId = String(data.probeId);
    const serverId = String(data.serverId);
    await this.step();
    const cell = await this.fetchCell();
    const server = cell.mcpServers?.find((s) => s.id === serverId);
    const send = async (body: Record<string, unknown>) => {
      const res = await this.request("POST", "/mcp/probe-results", body);
      this.probeReports.push({ status: res.status, body });
      this.notify();
    };
    if (!server) {
      await send({ probeId, serverId, ok: false, error: "The cell does not know this MCP server." });
      return;
    }
    const rpc = mcpSession(server, this.opts.hostMap);
    try {
      await rpc(1, "initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "ocw-fake-cell", version: "1.0.0" },
      });
      await rpc(null, "notifications/initialized");
      const listed = await rpc(2, "tools/list");
      const tools = ((listed.result?.tools as Array<Record<string, unknown>> | undefined) ?? []).map((t) => ({
        name: String(t.name),
        ...(typeof t.title === "string" ? { title: t.title } : {}),
        ...(typeof t.description === "string" ? { description: t.description } : {}),
        ...(t.annotations && typeof t.annotations === "object"
          ? {
              annotations: {
                readOnlyHint: (t.annotations as { readOnlyHint?: boolean }).readOnlyHint === true,
                destructiveHint: (t.annotations as { destructiveHint?: boolean }).destructiveHint === true,
              },
            }
          : {}),
      }));
      await send({ probeId, serverId, ok: true, tools });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await send({
        probeId,
        serverId,
        ok: false,
        error: /fetch failed/i.test(message) ? "Could not reach the MCP server." : message.slice(0, 300),
      });
    }
  }

  async reportAuth(body: Record<string, unknown>) {
    const res = await this.request("POST", "/provider-auth", {
      reporterId: this.opts.deviceAuth?.reporterId ?? this.reporterId,
      ...body,
    });
    this.authReports.push({ status: res.status, body });
    this.notify();
    return res;
  }

  /**
   * Mirrors apps/openclaw-channel/src/provider-auth.ts: request a code, report it, poll until the owner
   * approves (or denies / it expires / the admin cancels), exchange, report the account. Never logs codes.
   */
  private async runDeviceFlow(data: FakeCellEvent["data"]) {
    const da = this.opts.deviceAuth;
    if (!da) return;
    const flowId = String(data.flowId);
    const provider = String(data.provider);
    if (Date.parse(String(data.startBefore)) < Date.now()) return; // stale replay
    const abort = new AbortController();
    this.flows.set(flowId, abort);
    const post = async (path: string, body: Record<string, string>, form = false) => {
      const res = await fetch(`${da.serverUrl}${path}`, {
        method: "POST",
        headers: { "content-type": form ? "application/x-www-form-urlencoded" : "application/json" },
        body: form ? new URLSearchParams(body).toString() : JSON.stringify(body),
        signal: abort.signal,
      });
      return { status: res.status, json: (await res.json()) as Record<string, string> };
    };
    try {
      const code = await post("/api/accounts/deviceauth/usercode", { client_id: "fake" });
      const pending = await this.reportAuth({
        provider,
        flowId,
        state: "pending",
        verificationUrl: `${da.serverUrl}/codex/device`,
        userCode: code.json.user_code,
        expiresAt: new Date(Date.now() + 15 * 60_000).toISOString(),
      });
      if (pending.status !== 200) return; // claimed by another instance / closed
      for (;;) {
        await new Promise((r) => setTimeout(r, da.pollMs ?? 200));
        if (abort.signal.aborted) return;
        const poll = await post("/api/accounts/deviceauth/token", {
          device_auth_id: code.json.device_auth_id ?? "",
          user_code: code.json.user_code ?? "",
        });
        if (poll.status === 403) continue;
        if (poll.status !== 200) {
          const err =
            poll.json.error === "access_denied"
              ? "denied"
              : poll.json.error === "expired_token"
                ? "expired"
                : "failed";
          await this.reportAuth({
            provider,
            flowId,
            state: "error",
            error: { code: err, message: "device authorization failed" },
          });
          return;
        }
        const tokens = await post(
          "/oauth/token",
          {
            grant_type: "authorization_code",
            code: poll.json.authorization_code ?? "",
            code_verifier: poll.json.code_verifier ?? "",
          },
          true,
        );
        const claims = JSON.parse(
          Buffer.from((tokens.json.id_token ?? "").split(".")[1] ?? "", "base64url").toString("utf8") || "{}",
        ) as { email?: string; "https://api.openai.com/auth"?: { chatgpt_plan_type?: string } };
        const account = {
          email: claims.email ?? null,
          planType: claims["https://api.openai.com/auth"]?.chatgpt_plan_type ?? null,
        };
        this.credentials.set(provider, account);
        await this.reportAuth({ provider, flowId, state: "connected", account });
        return;
      }
    } catch (err) {
      if (!abort.signal.aborted) {
        await this.reportAuth({
          provider,
          flowId,
          state: "error",
          error: { code: "failed", message: String(err).slice(0, 200) },
        });
      }
    } finally {
      this.flows.delete(flowId);
    }
  }

  private notify() {
    for (const w of this.waiters.splice(0)) w();
  }

  /** Resolves with the first event matching `pred` (already received or future). */
  async waitFor(pred: (e: FakeCellEvent) => boolean, timeoutMs = 10_000): Promise<FakeCellEvent> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const hit = this.events.find(pred);
      if (hit) return hit;
      const left = deadline - Date.now();
      if (left <= 0)
        throw new Error(`timed out waiting for cell event (got ${this.events.map((e) => e.type)})`);
      await new Promise<void>((r) => {
        const t = setTimeout(r, Math.min(left, 250));
        this.waiters.push(() => {
          clearTimeout(t);
          r();
        });
      });
    }
  }

  async waitUntil(pred: () => boolean, timeoutMs = 10_000): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (!pred()) {
      if (Date.now() > deadline) throw new Error("timed out");
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  /** Debug snapshot for failing specs: socket state and the durable events seen so far. */
  debugState(): { readyState: number | null; lastSeq: number; events: string[] } {
    return {
      readyState: this.ws?.readyState ?? null,
      lastSeq: this.lastSeq,
      events: this.events.map((e) => `${e.seq}:${e.type}`),
    };
  }

  async stop(): Promise<void> {
    for (const f of this.flows.values()) f.abort();
    const ws = this.ws;
    this.ws = null;
    if (!ws || ws.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((r) => {
      ws.onclose = () => r();
      ws.close();
      setTimeout(r, 1000);
    });
  }
}
