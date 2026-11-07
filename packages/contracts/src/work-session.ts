import { z } from "zod";
import { Attachment } from "./attachments";
import { Id, IsoDateTime } from "./common";
import { DiffFile, WORK_PROMPT_MAX_IMAGES } from "./device-link";
import { Permission } from "./permissions";
import {
  ApprovalOutcome,
  PermissionMode,
  RuntimeId,
  SessionEvent,
  WorkSessionStatus,
} from "./session-events";
import { ContextWindow, EffortLevel, WorkSessionSettings } from "./session-settings";
import { TitleSource } from "./session-title";
import {
  ProjectDefaultVisibility,
  SessionVisibilityKind,
  TeamProjectRef,
  WORK_PROJECT_LIMITS,
  WorkProjectPerson,
} from "./work-projects";

/** Working-tree change totals of a session (from the device's last `diff.result`). */
export const DiffStat = z.object({
  files: z.number().int().nonnegative(),
  additions: z.number().int().nonnegative(),
  deletions: z.number().int().nonnegative(),
});
export type DiffStat = z.infer<typeof DiffStat>;

/**
 * How a list row summarises a session's audience (Phase 07.9, D-07, UI-SPEC R1). `activeCount` counts the active
 * selected entries: teams for `teams`, people other than the owner for `people`, 0 otherwise. `teams` or `people` with
 * `activeCount` 0 reads as the owner case (UI-SPEC §1.5). `firstTeamName` names the first active team (`teams` only).
 */
export const WorkSessionVisibilitySummary = z.object({
  kind: SessionVisibilityKind,
  activeCount: z.number().int().nonnegative(),
  /** The audience is not the default the session's project gives new sessions (the sidebar marker shows it). */
  differsFromDefault: z.boolean(),
  firstTeamName: z.string().max(WORK_PROJECT_LIMITS.nameMax).nullable(),
});
export type WorkSessionVisibilitySummary = z.infer<typeof WorkSessionVisibilitySummary>;

/**
 * How long a finished turn waits on its author as "Your turn" (Phase 07.10, UI-SPEC § 3). The API reads only turns
 * that ended within it (`attention.lastTurnEndedAt`, 07.10-07 LO-01); the sidebar drops a reason older than it.
 */
export const WORK_SESSION_TURN_WINDOW_MS = 24 * 60 * 60 * 1000;

/**
 * What in one session waits on one viewer (Phase 07.10, PD-05, D-05; UI-SPEC R2, § 3 Needs you), decided by the API
 * for that viewer only and never sent to anyone else.
 */
export const WorkSessionAttention = z.object({
  /**
   * The session has a pending approval and the resolver lets this viewer decide it (`work_session.approve` on the
   * session: the creator, the device owner, an admin). A Tool-layer rule still decides when the approval is answered.
   */
  approval: z.boolean(),
  /**
   * When the session's last finished turn (its most recent prompt that was dispatched and then completed or failed)
   * ended, only when that turn ran this viewer's prompt; null otherwise. Queued and running prompts never count.
   */
  lastTurnEndedAt: IsoDateTime.nullable(),
});
export type WorkSessionAttention = z.infer<typeof WorkSessionAttention>;

export const WorkSession = z.object({
  id: Id,
  conversationId: Id,
  projectId: Id,
  projectName: z.string(),
  deviceId: Id,
  deviceName: z.string(),
  deviceOnline: z.boolean(),
  runtime: RuntimeId,
  model: z.string().nullable(),
  permissionMode: PermissionMode,
  worktree: z.boolean(),
  /** Git branch the session works on (reported by the device). */
  branch: z.string().nullable(),
  status: WorkSessionStatus,
  title: z.string(),
  /** Typed (`user`, never replaced), the prompt's first line (`heuristic`) or generated (`auto`) (D-19). */
  titleSource: TitleSource,
  createdBy: Id,
  createdByName: z.string().nullable(),
  /** Prompts waiting in the shared queue. */
  queuedCount: z.number().int().nonnegative(),
  /** Approval requests nobody answered yet ("Needs attention"). */
  pendingApprovals: z.number().int().nonnegative(),
  lastError: z.string().nullable(),
  /** Requested (authorized) settings, what the device reported, and whether a change is pending (D-07, D-14). */
  settings: WorkSessionSettings,
  /** Full access is requested or reported (persistent badge for every controller, D-04). */
  fullAccess: z.boolean(),
  /** When the in-flight turn was dispatched ("Working 5m"); null when nothing runs. */
  runningSince: IsoDateTime.nullable(),
  diffStat: DiffStat.nullable(),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Who can see the session (Phase 07.9). Always sent by the API from 07.9; optional so replayed DTOs parse. */
  visibility: WorkSessionVisibilitySummary.optional(),
  /**
   * The team project the session's repository is linked to; null = a personal repository, or a project this viewer
   * may not see named (then `teamProjectHidden` is true) (Phase 07.9; per viewer from 07.10, PD-03, PD-04). Sent on
   * the viewer's own surfaces (the list, the detail, their `user:` frames); absent on the shared `ws:` stream, so
   * optional (replayed and `ws:` DTOs parse).
   */
  teamProject: TeamProjectRef.nullable().optional(),
  /**
   * Per viewer (Phase 07.10, PD-04; 07.9 D-14): present and true only when the session's repository is linked to a
   * team project this viewer may not see named (they cannot open it and did not create the session, e.g. the device
   * owner outside the project, D-11). `teamProject` is then null. Absent = false; absent on `ws:`.
   */
  teamProjectHidden: z.boolean().optional(),
  /**
   * What in the session waits on this viewer (Phase 07.10, PD-05; UI-SPEC R2). Per viewer: sent on the viewer's own
   * surfaces (the list, the detail, their `user:` frames); absent on the shared `ws:` stream, so optional.
   */
  attention: WorkSessionAttention.optional(),
});
export type WorkSession = z.infer<typeof WorkSession>;

export const WorkSessionList = z.object({ sessions: z.array(WorkSession) });
export type WorkSessionList = z.infer<typeof WorkSessionList>;

/** A non-empty list of distinct ids, at most `max`. */
const distinctIds = (max: number) =>
  z
    .array(Id)
    .min(1)
    .max(max)
    .refine((ids) => new Set(ids).size === ids.length, { message: "must not repeat an id" });

/**
 * A session audience as a request sets it (Phase 07.9, D-04): exactly the entries its kind needs, nothing else
 * (strict objects: a request whose kind and entries disagree is refused). The owner is implied in every kind and never
 * listed. Entries outside the project's access are refused by the API (`audience_outside_project`).
 */
export const SessionAudienceInput = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("owner") }),
  z.strictObject({ kind: z.literal("project") }),
  z.strictObject({ kind: z.literal("teams"), teamIds: distinctIds(WORK_PROJECT_LIMITS.teamIdsMax) }),
  z.strictObject({ kind: z.literal("people"), userIds: distinctIds(WORK_PROJECT_LIMITS.userIdsMax) }),
]);
export type SessionAudienceInput = z.infer<typeof SessionAudienceInput>;

export const CreateWorkSessionRequest = z.object({
  projectId: Id,
  /** Optional cross-check: the project's device. */
  deviceId: Id.optional(),
  runtime: RuntimeId.default("claude-code"),
  title: z.string().trim().min(1).max(200).optional(),
  model: z.string().trim().min(1).max(200).optional(),
  /**
   * Absent = the person did not pick one: the start lowers `default` to the highest mode they may use on the device
   * (e.g. `plan` under a capped grant). A picked mode is never lowered; it is refused with its reason (WINDOWS #205).
   */
  permissionMode: PermissionMode.optional(),
  effort: EffortLevel.optional(),
  fastMode: z.boolean().optional(),
  contextWindow: ContextWindow.optional(),
  /** Work in a dedicated git worktree on the device. */
  worktree: z.boolean().default(false),
  /** Optional first prompt queued immediately. */
  prompt: z.string().trim().min(1).max(50_000).optional(),
  /**
   * Phase 07.9 (D-03, D-04): who can see the new session. Absent = the project's default (`project` when its switch
   * is on, `owner` when off; a personal repository: `project`). Validated against project access by the API.
   */
  visibility: SessionAudienceInput.optional(),
});
export type CreateWorkSessionRequest = z.input<typeof CreateWorkSessionRequest>;

export const PromptStatus = z.enum(["queued", "dispatched", "running", "completed", "failed", "cancelled"]);
export type PromptStatus = z.infer<typeof PromptStatus>;

export const WorkPrompt = z.object({
  id: Id,
  workSessionId: Id,
  authorUserId: Id,
  authorName: z.string().nullable(),
  originDeviceId: Id.nullable(),
  body: z.string(),
  status: PromptStatus,
  position: z.number().int(),
  createdAt: IsoDateTime,
  dispatchedAt: IsoDateTime.nullable(),
  completedAt: IsoDateTime.nullable(),
  /**
   * Phase 06.1: the images sent with the prompt (previews re-check the session's read access). Defaults to `[]`
   * so `prompt.updated` events persisted before 06.1 still parse.
   */
  attachments: z.array(Attachment).default([]),
  /**
   * Phase 07.5 (D-03): the bot whose proposal this first prompt came from ("Ana · proposed by @Scout"); the author is
   * still the person who clicked Start. Defaults to null so older `prompt.updated` payloads parse.
   */
  proposedBy: z
    .object({ agentId: Id, displayName: z.string().max(200) })
    .nullable()
    .default(null),
});
export type WorkPrompt = z.infer<typeof WorkPrompt>;

/** `POST /api/v1/work-sessions/:id/commands`: a `/` command typed in the composer (P-10). */
export const SessionCommandRequest = z.object({ text: z.string().trim().min(2).max(2000) });
export type SessionCommandRequest = z.infer<typeof SessionCommandRequest>;

export const SessionCommandResult = z.object({
  kind: z.enum(["settings", "prompt", "refused"]),
  command: z.string().max(64),
  notice: z.string().max(500),
  session: WorkSession.optional(),
  prompt: WorkPrompt.optional(),
});
export type SessionCommandResult = z.infer<typeof SessionCommandResult>;

export const CreatePromptRequest = z.object({
  /** Required even with images (P-06): titles, slash detection, the queue and the audit key off the text. */
  body: z.string().trim().min(1).max(50_000),
  /**
   * Phase 06.1 (D-02): images the sender uploaded into the session's conversation through the attachment routes,
   * in the order they go to the runtime.
   */
  attachmentIds: z.array(Id).max(WORK_PROMPT_MAX_IMAGES).optional(),
});
export type CreatePromptRequest = z.infer<typeof CreatePromptRequest>;

/** Edit, move (0-based index among queued prompts) or cancel a prompt while it is still queued. */
export const UpdatePromptRequest = z.object({
  body: z.string().trim().min(1).max(50_000).optional(),
  index: z.number().int().nonnegative().optional(),
  status: z.literal("cancelled").optional(),
});
export type UpdatePromptRequest = z.infer<typeof UpdatePromptRequest>;

export const ApprovalStatus = z.enum(["pending", "approved", "denied", "expired"]);
export type ApprovalStatus = z.infer<typeof ApprovalStatus>;

export const WorkApproval = z.object({
  id: Id,
  workSessionId: Id,
  request: z.object({ tool: z.string(), summary: z.string(), paths: z.array(z.string()) }),
  status: ApprovalStatus,
  decidedBy: Id.nullable(),
  decidedByName: z.string().nullable(),
  decision: ApprovalOutcome.nullable(),
  comment: z.string().nullable(),
  createdAt: IsoDateTime,
  decidedAt: IsoDateTime.nullable(),
});
export type WorkApproval = z.infer<typeof WorkApproval>;

export const ResolveApprovalRequest = z.object({
  decision: z.enum(["once", "session", "deny"]),
  comment: z.string().trim().max(2000).optional(),
});
export type ResolveApprovalRequest = z.infer<typeof ResolveApprovalRequest>;

/** A persisted session event (stream `ws:<id>`, type `work_session.event`). */
export const WorkSessionEventRecord = z.object({
  seq: z.number().int().positive(),
  at: IsoDateTime,
  event: SessionEvent,
});
export type WorkSessionEventRecord = z.infer<typeof WorkSessionEventRecord>;

/** `left_project`: the caller created the session and left its project since (D-12); null = nothing special. */
export const WorkSessionViewerState = z.enum(["left_project"]);
export type WorkSessionViewerState = z.infer<typeof WorkSessionViewerState>;

export const WorkSessionDetail = z.object({
  session: WorkSession,
  prompts: z.array(WorkPrompt),
  approvals: z.array(WorkApproval),
  /** Durable session events in order (latest window). Subscribe to `ws:<id>` with `afterSeq = lastSeq`. */
  events: z.array(WorkSessionEventRecord),
  lastSeq: z.number().int().nonnegative(),
  /** Permissions the caller holds on this resource, decided by the API resolver (UI gating only). */
  viewerCan: z.array(Permission).optional(),
  /** Phase 07.9 (D-12): the caller created the session and has since left its project (read and archive only). */
  viewerState: WorkSessionViewerState.nullable().optional(),
});
export type WorkSessionDetail = z.infer<typeof WorkSessionDetail>;

export const WorkSessionDiff = z.object({
  files: z.array(DiffFile),
  patch: z.string(),
  truncated: z.boolean(),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  generatedAt: IsoDateTime,
  /** False when the session's project has no git repository (changes are not tracked). */
  git: z.boolean().optional(),
});
export type WorkSessionDiff = z.infer<typeof WorkSessionDiff>;

/**
 * Payloads of the durable events on stream `ws:<id>` (see EventTypes):
 * - `work_session.event` → WorkSessionEventPayload (runtime event from the device)
 * - `work_session.updated` → WorkSession
 * - `prompt.updated` → WorkPrompt
 * - `approval.updated` → WorkApproval
 * and the ephemeral `assistant.delta` → `{ messageId, text }`.
 */
export const WorkSessionEventPayload = z.object({ at: IsoDateTime, event: SessionEvent });
export type WorkSessionEventPayload = z.infer<typeof WorkSessionEventPayload>;

/** `work_session.changes`: file summary of the working tree after a turn (patch via GET /diff). */
export const WorkSessionChanges = z.object({
  files: z.array(DiffFile),
  branch: z.string().nullable(),
  headSha: z.string().nullable(),
  truncated: z.boolean(),
  at: IsoDateTime,
  /** False when the session's project has no git repository (changes are not tracked). */
  git: z.boolean().optional(),
});
export type WorkSessionChanges = z.infer<typeof WorkSessionChanges>;

// ---------------------------------------------------------------- audience (Phase 07.9, D-04, D-11, D-12)

/** `PUT /api/v1/work-sessions/:id/visibility`: the new audience (replaces the stored one). */
export const UpdateWorkSessionVisibilityRequest = SessionAudienceInput;
export type UpdateWorkSessionVisibilityRequest = z.infer<typeof UpdateWorkSessionVisibilityRequest>;

/**
 * Why a person can see a session ("See all"): its owner, its owner who left the project (D-12), the device owner
 * (D-11), a project lead, a project member, a member of an assigned team (`via` the team), or someone who can use the
 * device of a personal repository (`via` the device). Admins are a role, never listed (`AlwaysVisible.admins`).
 */
export const ViewerReason = z.enum([
  "owner",
  "owner_left",
  "device_owner",
  "lead",
  "member",
  "team",
  "device",
]);
export type ViewerReason = z.infer<typeof ViewerReason>;

export const WorkSessionViewer = WorkProjectPerson.extend({
  reason: ViewerReason,
  /** The team (`team`) or device (`device`) the access comes through; null otherwise. */
  via: z.object({ id: Id, name: z.string().max(200) }).nullable(),
});
export type WorkSessionViewer = z.infer<typeof WorkSessionViewer>;

/** Who always sees a session whatever its audience: admins (a role) and the device's owner (D-11). */
export const AlwaysVisible = z.object({
  admins: z.literal(true),
  /** Null when the device owner is the session's owner (the footer then names admins only). */
  deviceOwner: z
    .object({
      userId: Id,
      firstName: z.string().max(200),
      deviceName: z.string().max(200),
      /** The caller is the device owner ("Admins and you can always see it"). */
      isViewer: z.boolean(),
    })
    .nullable(),
});
export type AlwaysVisible = z.infer<typeof AlwaysVisible>;

/**
 * `GET /api/v1/work-sessions/:id/visibility`: everything the visibility panel shows (UI-SPEC Surface 1). Teams and
 * people include stored entries that grant nothing any more (`active: false`, UI-SPEC §1.5).
 */
export const WorkSessionVisibilityView = z.object({
  kind: SessionVisibilityKind,
  /**
   * The project's default for new sessions; null = a personal repository (no project setting) or a project the viewer
   * can't open (`project.kind` `hidden`).
   */
  projectDefault: ProjectDefaultVisibility.nullable(),
  /**
   * Where the session runs. `hidden` (Phase 07.10-07, HI-01): a team project the viewer may not open (the D-11 device
   * owner outside it), decided per viewer like the session's `teamProject`; then no id, no name, no default, no teams
   * and no stored people are sent, and no `team` viewer row names its team.
   */
  project: z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("team"), id: Id, name: TeamProjectRef.shape.name }),
    z.object({ kind: z.literal("personal"), deviceName: z.string().max(200) }),
    z.object({ kind: z.literal("hidden") }),
  ]),
  owner: z.object({ userId: Id, name: z.string().max(200) }),
  /** The project's assigned teams plus selected teams no longer assigned. */
  teams: z.array(
    z.object({
      id: Id,
      name: TeamProjectRef.shape.name,
      kind: z.enum(["team", "department"]),
      memberCount: z.number().int().nonnegative(),
      /** Part of the stored audience (only meaningful for `teams`). */
      selected: z.boolean(),
      /** Still grants access (assigned to the project). */
      active: z.boolean(),
    }),
  ),
  /** The stored people (kind `people`), owner excluded; `active` = still has project access. */
  people: z.array(WorkProjectPerson.extend({ active: z.boolean() })).max(WORK_PROJECT_LIMITS.userIdsMax),
  viewers: z.object({
    count: z.number().int().nonnegative(),
    people: z.array(WorkSessionViewer).max(WORK_PROJECT_LIMITS.viewersMax),
    /** Viewers beyond the listed rows ("and {n} more"). */
    more: z.number().int().nonnegative(),
  }),
  alwaysVisible: AlwaysVisible,
  /** `work_session.visibility` on this session, decided by the API resolver (UI gating only). */
  viewerCan: z.object({ change: z.boolean() }),
  viewerState: WorkSessionViewerState.nullable(),
});
export type WorkSessionVisibilityView = z.infer<typeof WorkSessionVisibilityView>;

/** The answer to an audience change: the new view and who lost access (count, and at most three names). */
export const UpdateWorkSessionVisibilityResult = z.object({
  visibility: WorkSessionVisibilityView,
  removedCount: z.number().int().nonnegative(),
  removedNames: z.array(z.string().max(200)).max(WORK_PROJECT_LIMITS.removedNamesMax),
});
export type UpdateWorkSessionVisibilityResult = z.infer<typeof UpdateWorkSessionVisibilityResult>;

/**
 * `GET /api/v1/work-sessions/:id/visibility/people?q=` and `GET /api/v1/projects/:projectId/audience/people?q=`:
 * people with access to the project (never admins as such), for the People picker.
 */
export const AudiencePeople = z.object({
  people: z.array(WorkProjectPerson).max(WORK_PROJECT_LIMITS.peopleSearchMax),
});
export type AudiencePeople = z.infer<typeof AudiencePeople>;

/** `GET /api/v1/projects/:projectId/audience/preview`: who a draft audience would show the new session to. */
export const AudiencePreview = z.object({
  count: z.number().int().nonnegative(),
  people: z.array(WorkProjectPerson).max(WORK_PROJECT_LIMITS.previewPeople),
  alwaysVisible: AlwaysVisible,
});
export type AudiencePreview = z.infer<typeof AudiencePreview>;

/** Ephemeral `work_session.removed` on `user:<id>`: an audience change removed the caller (ids only). */
export const WorkSessionRemovedEvent = z.object({ id: Id });
export type WorkSessionRemovedEvent = z.infer<typeof WorkSessionRemovedEvent>;

/** Durable `work_session.visibility_changed` on `ws:<id>`: the audience changed; re-decide and refetch (ids only). */
export const WorkSessionVisibilityChangedEvent = z.object({ workSessionId: Id });
export type WorkSessionVisibilityChangedEvent = z.infer<typeof WorkSessionVisibilityChangedEvent>;
