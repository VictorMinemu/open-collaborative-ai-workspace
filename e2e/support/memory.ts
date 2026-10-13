import { type APIRequestContext, expect } from "@playwright/test";
import { type Actor, ensureMember, SAM } from "./actors";
import { ALEX } from "./chat";

/**
 * Memory viewer fixtures (Phase 07.2, 07.2-10). Idempotent across projects and runs: the admin creates the department
 * "Comercial" with two teams, "Ventas" (Sam) and "Compras" (Alex), writes team and organization files through the real
 * memory API, and every file ends with exactly the content below (created, or updated to it).
 *
 * A team always sits under a department (ALLOWED_PARENT_KINDS), and members of a team read their department's memory,
 * so Sam's tree holds Comercial, Ventas and Organization; never Compras.
 */

export const MEMORY_DEPARTMENT = "Comercial";

/**
 * A Ventas member who exists only for memory-files.spec's viewer cases (WINDOWS 162). Nothing else signs her in or
 * gives her a bot, so her scope list is exactly Comercial, Ventas and Organization whatever ran before in the same
 * database (Sam gains "You & …" private scopes from bot-memory, personal-bots and bot-capabilities). Keep it that way:
 * never use her in another spec.
 */
export const MEMORY_READER: Actor = {
  name: "Nina Serra",
  email: "nina@ocw.test",
  password: "nina-e2e-password-123",
};
export const MEMORY_TEAM = "Ventas";
export const MEMORY_OTHER_TEAM = "Compras";

export const ACME = `# Acme Corp

Industrial pumps, 3 plants. Account owner: Ana Pérez.

## Contacts

- Marta Gil — purchasing
- Luis Romero — maintenance

## Open issues

- Renewal of the service contract in November
- Two pumps waiting for spare parts
`;

const VENTAS_FILES: Record<string, string> = {
  "clients/acme.md": ACME,
  "clients/globex/INDEX.md": "# Globex\n\nPilot with one plant since March.\n",
  "team/vacaciones.md": "# Turnos\n\nTurnos de vacaciones del equipo: agosto en dos grupos.\n",
  "hr/salaries.md": "# Salaries\n\nCompensation bands for the team (restricted folder).\n",
};

export const HOSTILE = `# Hostile notes

<script>alert(1)</script>

<img src=x onerror="alert(2)">

Plain text after the tags.
`;

const ORG_FILES: Record<string, string> = {
  "policies/vacations.md":
    "# Vacaciones\n\nPolítica de vacaciones: 23 días de vacación al año, pedidos con dos semanas.\n",
  "policies/expenses.md":
    "# Expenses\n\nTravel is booked through the office. Time off follows the [vacation policy](vacations.md).\n\nSee the [workspace memory](../MEMORY.md), an [outside page](https://example.org/guide) and a [text file](notes.txt).\n",
  "notes/hostile.md": HOSTILE,
};

const COMPRAS_FILES: Record<string, string> = {
  "suppliers/pumps.md": "# Pump suppliers\n\nVacaciones de proveedores en agosto.\n",
};

interface Scope {
  id: string;
  kind: string;
  label: string;
  unitId: string | null;
}

export interface MemorySeed {
  samId: string;
  alexId: string;
  departmentScopeId: string;
  ventasScopeId: string;
  comprasScopeId: string;
  orgScopeId: string;
  ventasUnitId: string;
}

async function findOrCreateUnit(
  admin: APIRequestContext,
  kind: "department" | "team",
  name: string,
  parentId: string | null,
): Promise<string> {
  const { units } = (await (await admin.get("/api/v1/units")).json()) as {
    units: Array<{ id: string; name: string; parentId: string | null }>;
  };
  const found = units.find((u) => u.name === name && u.parentId === parentId);
  if (found) return found.id;
  const res = await admin.post("/api/v1/units", { data: { kind, name, parentId } });
  expect(res.ok(), `create ${kind} ${name}: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}

async function ensureUnitMember(admin: APIRequestContext, unitId: string, userId: string) {
  const res = await admin.get(`/api/v1/units/${unitId}/members`);
  const { members } = (await res.json()) as { members: Array<{ userId: string }> };
  if (members.some((m) => m.userId === userId)) return;
  const add = await admin.post(`/api/v1/units/${unitId}/members`, { data: { userId, role: "member" } });
  expect(add.ok(), `add ${userId} to ${unitId}: ${add.status()}`).toBe(true);
}

/** Creates the file, or updates it to `content` when it already exists with something else. */
export async function putMemoryFile(api: APIRequestContext, scopeId: string, path: string, content: string) {
  const created = await api.post(`/api/v1/memory/scopes/${scopeId}/files`, { data: { path, content } });
  if (created.ok()) return;
  expect(created.status(), `create ${path}: ${await created.text()}`).toBe(409);
  const current = await api.get(`/api/v1/memory/scopes/${scopeId}/file?path=${encodeURIComponent(path)}`);
  expect(current.ok(), `read ${path}`).toBe(true);
  const file = (await current.json()) as { id: string; version: number; content: string };
  if (file.content === content) return;
  const updated = await api.put(`/api/v1/memory/files/${file.id}`, {
    data: { content, expectedVersion: file.version },
  });
  expect(updated.ok(), `update ${path}: ${await updated.text()}`).toBe(true);
}

export async function memoryScopes(api: APIRequestContext): Promise<Scope[]> {
  const res = await api.get("/api/v1/memory/scopes");
  expect(res.ok(), `GET /memory/scopes: ${res.status()}`).toBe(true);
  return ((await res.json()) as { scopes: Scope[] }).scopes;
}

export async function seedMemory(admin: APIRequestContext): Promise<MemorySeed> {
  const samId = await ensureMember(admin, SAM, "developer");
  const alexId = await ensureMember(admin, ALEX, "developer");
  const departmentId = await findOrCreateUnit(admin, "department", MEMORY_DEPARTMENT, null);
  const ventasUnitId = await findOrCreateUnit(admin, "team", MEMORY_TEAM, departmentId);
  const comprasUnitId = await findOrCreateUnit(admin, "team", MEMORY_OTHER_TEAM, departmentId);
  await ensureUnitMember(admin, ventasUnitId, samId);
  await ensureUnitMember(admin, comprasUnitId, alexId);

  // The admin's listing creates the unit scopes and the organization scope on first read.
  const scopes = await memoryScopes(admin);
  const byUnit = (unitId: string) => scopes.find((s) => s.kind === "unit" && s.unitId === unitId)?.id;
  const departmentScopeId = byUnit(departmentId);
  const ventasScopeId = byUnit(ventasUnitId);
  const comprasScopeId = byUnit(comprasUnitId);
  const orgScopeId = scopes.find((s) => s.kind === "org")?.id;
  expect(departmentScopeId && ventasScopeId && comprasScopeId && orgScopeId, "memory scopes").toBeTruthy();

  for (const [path, content] of Object.entries(VENTAS_FILES)) {
    await putMemoryFile(admin, ventasScopeId as string, path, content);
  }
  for (const [path, content] of Object.entries(ORG_FILES)) {
    await putMemoryFile(admin, orgScopeId as string, path, content);
  }
  for (const [path, content] of Object.entries(COMPRAS_FILES)) {
    await putMemoryFile(admin, comprasScopeId as string, path, content);
  }
  return {
    samId,
    alexId,
    departmentScopeId: departmentScopeId as string,
    ventasScopeId: ventasScopeId as string,
    comprasScopeId: comprasScopeId as string,
    orgScopeId: orgScopeId as string,
    ventasUnitId,
  };
}

/**
 * Deletes every Ventas file the seed does not define (MEMORY.md stays). Other specs write there (memory-proposals
 * applies clients/acme-<w>.md, clients/globex-<w>.md, ...) and memory-files walks and snapshots that tree row by row.
 * A fresh run reaches memory-files first; a repeat (--repeat-each, --keep-db) does not.
 */
export async function pruneVentasToSeed(admin: APIRequestContext, seed: MemorySeed) {
  const res = await admin.get(`/api/v1/memory/scopes/${seed.ventasScopeId}/files`);
  expect(res.ok(), `list Ventas files: ${res.status()}`).toBe(true);
  const { files } = (await res.json()) as { files: Array<{ id: string; path: string; version: number }> };
  for (const f of files) {
    if (f.path === "MEMORY.md" || Object.hasOwn(VENTAS_FILES, f.path)) continue;
    const del = await admin.delete(`/api/v1/memory/files/${f.id}?expectedVersion=${f.version}`);
    expect(del.ok(), `delete ${f.path}: ${del.status()}`).toBe(true);
  }
}

/** The dedicated viewer persona as a Ventas member (idempotent); returns her user id. */
export async function ensureMemoryReader(admin: APIRequestContext, seed: MemorySeed): Promise<string> {
  const id = await ensureMember(admin, MEMORY_READER, "developer");
  await ensureUnitMember(admin, seed.ventasUnitId, id);
  return id;
}

/** A `memory.read` deny on `hr/` in Ventas for one member (UI-SPEC: the folder disappears, its URL is not found). */
export async function denyFolder(
  admin: APIRequestContext,
  seed: MemorySeed,
  userId: string,
): Promise<string> {
  const rules = (await (await admin.get("/api/v1/permission-rules")).json()) as {
    rules: Array<{
      id: string;
      subjectId: string | null;
      pathPrefix: string | null;
      scopeUnitId: string | null;
    }>;
  };
  const existing = rules.rules.find(
    (r) => r.subjectId === userId && r.pathPrefix === "hr/" && r.scopeUnitId === seed.ventasUnitId,
  );
  if (existing) return existing.id;
  const res = await admin.post("/api/v1/permission-rules", {
    data: {
      scopeUnitId: seed.ventasUnitId,
      subjectKind: "user",
      subjectId: userId,
      permission: "memory.read",
      pathPrefix: "hr/",
      effect: "deny",
    },
  });
  expect(res.ok(), `deny hr/: ${res.status()} ${await res.text()}`).toBe(true);
  return ((await res.json()) as { id: string }).id;
}
