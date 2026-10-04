import { z } from "zod";
import { Id, IsoDateTime, OrgRole } from "./common";

/** Projection of an org member (maintained by identity in `app.org_members`). */
export const Member = z.object({
  userId: Id,
  displayName: z.string(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  role: OrgRole,
  joinedAt: IsoDateTime,
});
export type Member = z.infer<typeof Member>;

export const MemberList = z.object({ members: z.array(Member) });
export type MemberList = z.infer<typeof MemberList>;
