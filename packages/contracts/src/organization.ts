import { z } from "zod";
import { Id, IsoDateTime, OrgRole } from "./common";

export const MemberStatus = z.enum(["active", "deactivated"]);
export type MemberStatus = z.infer<typeof MemberStatus>;

/** Projection of an org member (maintained by identity in `app.org_members`). */
export const Member = z.object({
  userId: Id,
  displayName: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: OrgRole,
  /** `deactivated` members cannot sign in and every permission is denied to them. */
  status: MemberStatus,
  statusEmoji: z.string().nullable(),
  statusText: z.string().nullable(),
  joinedAt: IsoDateTime,
});
export type Member = z.infer<typeof Member>;

export const MemberList = z.object({ members: z.array(Member) });
export type MemberList = z.infer<typeof MemberList>;
