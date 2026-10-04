import { z } from "zod";
import { ClientKind, Id, IsoDateTime, OrgRole } from "./common";
import { Permission } from "./permissions";

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
  /** Who sent it (null when the inviter's account is gone). */
  inviterId: Id.nullable(),
  /** What the viewer may do with this invitation (02-07 fills it; the web shows Revoke only when allowed). */
  viewerCan: z.array(Permission).optional(),
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

// ---------------------------------------------------------------- sessions (AUTH-05)

/** One of the caller's sessions. Never carries the session secret (Pitfall 9). */
export const SessionInfo = z.object({
  id: Id,
  clientKind: ClientKind,
  /** Such as "Chrome on macOS" or "Desktop app on macOS". */
  clientLabel: z.string().nullable(),
  ipAddress: z.string().nullable(),
  createdAt: IsoDateTime,
  lastActiveAt: IsoDateTime,
  /** The session making this request ("This device"). */
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof SessionInfo>;

export const SessionList = z.object({ sessions: z.array(SessionInfo) });
export type SessionList = z.infer<typeof SessionList>;

// ---------------------------------------------------------------- passwords (AUTH-04)

/** What the login page offers: self-service reset e-mail only when SMTP is configured. */
export const AuthCapabilities = z.object({ passwordResetEmail: z.boolean() });
export type AuthCapabilities = z.infer<typeof AuthCapabilities>;

export const RequestPasswordResetRequest = z.object({ email: Email });
export type RequestPasswordResetRequest = z.infer<typeof RequestPasswordResetRequest>;

export const ResetPasswordRequest = z.object({
  token: z.string().min(16).max(512),
  newPassword: Password,
});
export type ResetPasswordRequest = z.infer<typeof ResetPasswordRequest>;

export const ChangePasswordRequest = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: Password,
  revokeOtherSessions: z.boolean().default(true),
});
export type ChangePasswordRequest = z.infer<typeof ChangePasswordRequest>;

/** Admin-issued reset link, shown once (copy dialog). */
export const PasswordResetLink = z.object({ link: z.string(), expiresAt: IsoDateTime });
export type PasswordResetLink = z.infer<typeof PasswordResetLink>;

// ---------------------------------------------------------------- profile (ORG-06)

/** Emoji sequences: pictographs, emoji components (skin tones, keycaps, flags), ZWJ and VS-16. */
const EMOJI_SEQUENCE = /^(?:[\p{Extended_Pictographic}\p{Emoji_Component}]|\u200D|\uFE0F)+$/u;
/** At least one pictograph or regional indicator, so digits, `#` and `*` alone are not an emoji. */
const EMOJI_BASE = /[\p{Extended_Pictographic}\u{1F1E6}-\u{1F1FF}]/u;
const MAX_EMOJI_CODE_POINTS = 16;

export const EmojiString = z
  .string()
  .min(1)
  .refine((v) => [...v].length <= MAX_EMOJI_CODE_POINTS && EMOJI_SEQUENCE.test(v) && EMOJI_BASE.test(v), {
    message: "must be an emoji",
  });

/** https only: no http (mixed content, tracking over plain text), data:, javascript: or other schemes. */
export const HttpsUrl = z.url({ protocol: /^https$/ }).max(2048);

/** Avatar: an emoji or an https image URL (the model bot avatars already use). Upload waits for Phase 4. */
export const AvatarRef = z.union([HttpsUrl, EmojiString]);
export type AvatarRef = z.infer<typeof AvatarRef>;

export const StatusEmoji = EmojiString;
export type StatusEmoji = z.infer<typeof StatusEmoji>;

export const StatusText = z.string().trim().max(80);
export type StatusText = z.infer<typeof StatusText>;

export const Profile = z.object({
  userId: Id,
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  statusEmoji: z.string().nullable(),
  statusText: z.string().nullable(),
  role: OrgRole,
});
export type Profile = z.infer<typeof Profile>;

/** Partial update; `null` clears avatar or status. At least one field must be present. */
export const UpdateProfileRequest = z
  .object({
    displayName: DisplayName.optional(),
    avatarUrl: AvatarRef.nullable().optional(),
    statusEmoji: StatusEmoji.nullable().optional(),
    statusText: StatusText.nullable().optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), { message: "nothing to update" });
export type UpdateProfileRequest = z.infer<typeof UpdateProfileRequest>;
