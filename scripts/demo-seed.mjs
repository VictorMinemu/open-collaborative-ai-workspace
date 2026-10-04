#!/usr/bin/env node
/**
 * Seeds a fresh instance with a believable demo workspace through the public API only (no DB access):
 * organization + admin (setup token), three invited teammates, channels with history, and three
 * OpenClaw bots added to their channels.
 *
 * Usage (fresh database, API running):
 *   node scripts/demo-seed.mjs
 * Env:
 *   OCW_API_URL (default http://localhost:4000), OCW_PUBLIC_WEB_URL (default http://localhost:3000)
 *   OCW_SETUP_TOKEN (default: read from .env)
 *   DEMO_PASSWORD (default: random, printed at the end)
 *   ANTHROPIC_API_KEY (optional: configures the Anthropic provider so bots answer with a real model;
 *                      otherwise add the key later in Settings › Models and the bots become ready)
 */
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const API = process.env.OCW_API_URL ?? "http://localhost:4000";
const WEB = process.env.OCW_PUBLIC_WEB_URL ?? "http://localhost:3000";
const PASSWORD = process.env.DEMO_PASSWORD ?? `Demo-${randomBytes(6).toString("base64url")}`;
const MODEL = { provider: "anthropic", id: "claude-sonnet-5-5" };
const ALLOWED = ["claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-4-5"];

function fromDotEnv(name) {
  try {
    const line = readFileSync(join(import.meta.dirname, "..", ".env"), "utf8")
      .split("\n")
      .find((l) => l.startsWith(`${name}=`));
    return line?.slice(name.length + 1).trim();
  } catch {
    return undefined;
  }
}

/** Minimal cookie-jar client, one per person. */
function client() {
  let cookie = "";
  return async function call(method, path, body) {
    const res = await fetch(API + path, {
      method,
      headers: {
        origin: WEB,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
        ...(cookie ? { cookie } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const set = res.headers.getSetCookie?.() ?? [];
    if (set.length) cookie = set.map((c) => c.split(";")[0]).join("; ");
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      json = text;
    }
    if (!res.ok) throw new Error(`${method} ${path} → ${res.status}: ${text.slice(0, 300)}`);
    return json;
  };
}

const people = {
  victor: { name: "Víctor Ruiz", email: "victor@autofylabs.demo" },
  alex: { name: "Alex Kim", email: "alex@autofylabs.demo" },
  marta: { name: "Marta López", email: "marta@autofylabs.demo" },
  sam: { name: "Sam Patel", email: "sam@autofylabs.demo" },
};

const bots = [
  {
    key: "archie",
    name: "Archie",
    username: "archie",
    avatarUrl: "🧭",
    description: "Product manager: turns conversations into specs, priorities and next steps.",
    instructions:
      "You are Archie, the product manager of Autofy Labs. Be concise and concrete. When asked for plans, answer with a short prioritised list, owners and dates. Address people by name and keep track of who asked what.",
    channels: ["general", "producto"],
  },
  {
    key: "nova",
    name: "Nova",
    username: "nova",
    avatarUrl: "🛠️",
    description: "Code reviewer: reviews designs and diffs, flags risks and suggests fixes.",
    instructions:
      "You are Nova, a senior engineer reviewing code and technical designs. Point out correctness, security and maintainability risks first, then suggest the smallest fix. Use short bullet points and code blocks when useful.",
    channels: ["ingenieria"],
  },
  {
    key: "iris",
    name: "Iris",
    username: "iris",
    avatarUrl: "🔎",
    description: "Researcher: summarises markets, competitors and customer feedback.",
    instructions:
      "You are Iris, a research analyst. Give balanced, well-structured answers with a one-line takeaway first. Say clearly when something needs verification.",
    channels: ["lanzamiento"],
  },
];

const channels = [
  { name: "producto", topic: "Roadmap, specs and customer feedback" },
  { name: "ingenieria", topic: "Architecture, reviews and releases" },
  { name: "lanzamiento", topic: "Investor demo and launch plan" },
];

/** [channel, author, text] — posted in order to build a believable history. */
const history = [
  ["general", "victor", "¡Buenos días equipo! Esta semana enseñamos el MVP 0 a inversores 🚀"],
  ["general", "marta", "Genial. He dejado en #producto el resumen de las entrevistas con clientes."],
  [
    "producto",
    "marta",
    "Resumen de 12 entrevistas: lo que más valoran es poder compartir una sesión de IA con el equipo y que quede todo auditado.",
  ],
  [
    "producto",
    "alex",
    "Encaja con el Work Zone: una sesión de Claude Code que varias personas pueden seguir y aprobar.",
  ],
  [
    "ingenieria",
    "alex",
    "Merge del Work Zone hecho. Claude Code y Codex corren en el portátil de cada uno con su propia suscripción; la sesión vive en la plataforma.",
  ],
  ["ingenieria", "sam", "Revisé la UI en móvil: hilos y aprobaciones se ven bien a 390px 👌"],
  [
    "lanzamiento",
    "victor",
    "Guion de la demo: 1) chat con bots, 2) crear un bot en un clic, 3) Work Zone mejorando el propio producto.",
  ],
  ["lanzamiento", "sam", "Preparo las capturas para el deck."],
];

async function main() {
  const token = process.env.OCW_SETUP_TOKEN ?? fromDotEnv("OCW_SETUP_TOKEN");
  if (!token) throw new Error("OCW_SETUP_TOKEN not set and not found in .env");

  const as = { victor: client() };
  console.log("• setup: organization Autofy Labs + admin");
  await as.victor("POST", "/api/v1/setup", {
    token,
    name: people.victor.name,
    email: people.victor.email,
    password: PASSWORD,
    orgName: "Autofy Labs",
  });
  await as.victor("POST", "/api/auth/sign-in/email", { email: people.victor.email, password: PASSWORD });

  for (const key of ["alex", "marta", "sam"]) {
    const p = people[key];
    const inv = await as.victor("POST", "/api/v1/invitations", { email: p.email, role: "developer" });
    const id = (inv.invitation ?? inv).id;
    as[key] = client();
    await as[key]("POST", `/api/v1/invitations/${id}/accept`, { name: p.name, password: PASSWORD });
    await as[key]("POST", "/api/auth/sign-in/email", { email: p.email, password: PASSWORD });
    console.log(`• invited and joined: ${p.name}`);
  }

  // #general is created lazily on the first list.
  const listed = await as.victor("GET", "/api/v1/channels");
  const byName = new Map((listed.channels ?? listed).map((c) => [c.name, c]));
  for (const ch of channels) {
    const created = await as.victor("POST", "/api/v1/channels", { ...ch, visibility: "public" });
    byName.set(ch.name, created.channel ?? created);
    console.log(`• channel #${ch.name}`);
  }
  for (const key of ["alex", "marta", "sam"]) {
    const mine = await as[key]("GET", "/api/v1/channels");
    for (const c of mine.channels ?? mine) {
      if (!c.isMember) await as[key]("POST", `/api/v1/channels/${c.id}/join`);
    }
  }

  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (apiKey) {
    await as.victor("POST", "/api/v1/model-providers", {
      provider: "anthropic",
      apiKey,
      allowedModels: ALLOWED,
      enabled: true,
    });
    console.log("• model provider: Anthropic (key stored encrypted)");
    for (const b of bots) {
      const created = await as.victor("POST", "/api/v1/agents", {
        name: b.name,
        username: b.username,
        avatarUrl: b.avatarUrl,
        description: b.description,
        instructions: b.instructions,
        modelProvider: MODEL.provider,
        modelId: MODEL.id,
      });
      const agentId = (created.agent ?? created).id;
      for (const ch of b.channels) {
        await as.victor("POST", `/api/v1/channels/${byName.get(ch).id}/members`, {
          kind: "agent",
          id: agentId,
        });
      }
      console.log(`• bot @${b.username} → ${b.channels.map((c) => `#${c}`).join(", ")}`);
    }
  } else {
    console.log(
      "• no ANTHROPIC_API_KEY: skipped model provider and bots (add the key in Settings › Models, then create bots in one click — or re-run with ANTHROPIC_API_KEY=… pnpm demo:reset)",
    );
  }

  for (const [ch, who, text] of history) {
    await as[who]("POST", `/api/v1/conversations/${byName.get(ch).id}/messages`, { body: text });
  }
  console.log(`• ${history.length} messages of history`);

  console.log("\nDemo workspace ready.");
  console.log(`  Web:      ${WEB}`);
  for (const p of Object.values(people)) console.log(`  ${p.name.padEnd(12)} ${p.email}`);
  console.log(`  Password (all demo users): ${PASSWORD}`);
}

main().catch((error) => {
  console.error(`demo seed failed: ${error.message}`);
  process.exit(1);
});
