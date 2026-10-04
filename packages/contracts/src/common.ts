import { z } from "zod";

/** Every entity id is a UUID (v7 for rows we create, v4/uuid for better-auth rows). */
export const Id = z.uuid();
export type Id = z.infer<typeof Id>;

export const IsoDateTime = z.iso.datetime({ offset: true });
export type IsoDateTime = z.infer<typeof IsoDateTime>;

/** Principals that can author messages or act. Agents are first-class (never a bot flag). */
export const PrincipalKind = z.enum(["user", "agent", "system"]);
export type PrincipalKind = z.infer<typeof PrincipalKind>;

export const MemberKind = z.enum(["user", "agent"]);
export type MemberKind = z.infer<typeof MemberKind>;

export const OrgRole = z.enum(["owner", "admin", "member"]);
export type OrgRole = z.infer<typeof OrgRole>;

export const ClientKind = z.enum(["web", "desktop", "mobile", "agent", "system"]);
export type ClientKind = z.infer<typeof ClientKind>;

/** Uniform error body for every non-2xx REST response. */
export const ApiError = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiError = z.infer<typeof ApiError>;

export const Ok = z.object({ ok: z.literal(true) });
export type Ok = z.infer<typeof Ok>;

export const IdParams = z.object({ id: Id });

/**
 * Repo-relative path. Absolute host paths must never leave the device (AGENTS principle 7):
 * rejects leading slash, drive letters, home shortcuts and parent traversal.
 */
export const RelativePath = z
  .string()
  .min(1)
  .max(1024)
  .refine((p) => !/^([/\\]|[A-Za-z]:[/\\]|~)/.test(p) && !p.split(/[/\\]/).includes(".."), {
    message: "must be a repo-relative path",
  });
export type RelativePath = z.infer<typeof RelativePath>;
