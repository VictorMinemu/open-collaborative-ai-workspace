import { z } from "zod";
import { Id, IsoDateTime, OrgRole } from "./common";

export const Password = z.string().min(12, "Use at least 12 characters").max(256);
export const Email = z.email().max(320);
export const DisplayName = z.string().trim().min(1).max(80);

export const SetupStatusResponse = z.object({ setupComplete: z.boolean() });
export type SetupStatusResponse = z.infer<typeof SetupStatusResponse>;

export const SetupRequest = z.object({
  token: z.string().min(16).max(512),
  name: DisplayName,
  email: Email,
  password: Password,
  orgName: z.string().trim().min(2).max(80),
});
export type SetupRequest = z.infer<typeof SetupRequest>;

export const CurrentUser = z.object({
  id: Id,
  name: z.string(),
  email: z.string(),
  image: z.string().nullable(),
});
export type CurrentUser = z.infer<typeof CurrentUser>;

export const CurrentOrg = z.object({
  id: Id,
  name: z.string(),
  slug: z.string(),
  role: OrgRole,
});
export type CurrentOrg = z.infer<typeof CurrentOrg>;

export const MeResponse = z.object({
  user: CurrentUser,
  organization: CurrentOrg,
  sessionId: z.string(),
});
export type MeResponse = z.infer<typeof MeResponse>;

export const SetupResponse = MeResponse;
export type SetupResponse = MeResponse;

export const InvitationStatus = z.enum(["pending", "accepted", "rejected", "canceled"]);
export type InvitationStatus = z.infer<typeof InvitationStatus>;

export const CreateInvitationRequest = z.object({
  email: Email,
  role: OrgRole.default("developer"),
});
export type CreateInvitationRequest = z.infer<typeof CreateInvitationRequest>;

export const Invitation = z.object({
  id: Id,
  email: z.string(),
  role: OrgRole,
  status: InvitationStatus,
  expiresAt: IsoDateTime,
  createdAt: IsoDateTime.optional(),
  /** Copyable link to share out of band (SMTP is optional). */
  link: z.string(),
});
export type Invitation = z.infer<typeof Invitation>;

export const InvitationList = z.object({ invitations: z.array(Invitation) });
export type InvitationList = z.infer<typeof InvitationList>;

/** Public, minimal view of an invitation shown on /invite/[id] before signup. */
export const PublicInvitation = z.object({
  id: Id,
  email: z.string(),
  organizationName: z.string(),
  inviterName: z.string().nullable(),
  role: OrgRole,
  status: InvitationStatus,
  expired: z.boolean(),
});
export type PublicInvitation = z.infer<typeof PublicInvitation>;

export const AcceptInvitationRequest = z.object({
  name: DisplayName,
  password: Password,
});
export type AcceptInvitationRequest = z.infer<typeof AcceptInvitationRequest>;

export const SignInRequest = z.object({ email: Email, password: z.string().min(1).max(256) });
export type SignInRequest = z.infer<typeof SignInRequest>;
