import { ASSIGN_REFUSAL_TEXT, type AssignPreview, type AssignRefusal } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { toneFor } from "@/components/ui/avatar";
import { Dialog } from "@/components/ui/dialog";
import { DropdownMenuItem } from "@/components/ui/dropdown-menu";
import { ASSIGN_DIALOG_COPY, AssignPreviewBody, AssignReasonItem, assignMenuState } from "./assign-dialog";
import { absentParticipants, OwnerChip, OwnerLine } from "./owner-chip";
import { RENAME_COPY, RenameForm, renameAllowed, renameError } from "./rename-dialog";

/**
 * The session owner surfaces of the session header (07.13.1.1-06, D-02, D-03, D-04, D-06, D-13, D-15): the Assign to
 * me menu entry and its confirm, the owner chip and line, and the rename form. The API decides `assign`, the preview
 * and `viewerCan`; these components only render them (C-01).
 */

const html = (node: React.ReactElement) => renderToStaticMarkup(node);
const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
const noop = () => undefined;

const OWNER = "01a11635-d6e7-7c87-9f17-0000000000a1";
const VIEWER = "01a11635-d6e7-7c87-9f17-0000000000a2";

const preview = (over: Partial<AssignPreview> = {}): AssignPreview => ({
  allowed: true,
  reason: null,
  previousOwnerLosesAccess: false,
  othersLosingAccess: 0,
  cancelledPrompts: 0,
  turnRunning: false,
  ...over,
});

const body = (p: AssignPreview, pending = false) =>
  html(
    <Dialog open>
      <AssignPreviewBody
        preview={p}
        previousOwnerName="Luis Pérez"
        title="Fix the login page"
        pending={pending}
        onConfirm={noop}
        onClose={noop}
      />
    </Dialog>,
  );

describe("AssignPreviewBody (D-03, D-13, D-15)", () => {
  it("names the session, says it becomes yours and that the previous owner stays in its history", () => {
    const t = text(body(preview()));
    expect(t).toContain(ASSIGN_DIALOG_COPY.becomesYours);
    expect(t).toContain(ASSIGN_DIALOG_COPY.history("Luis Pérez"));
    expect(ASSIGN_DIALOG_COPY.title("Fix the login page")).toBe("Take over “Fix the login page”?");
  });

  it("lists every consequence the preview reports, and the Assign to me button", () => {
    const markup = body(
      preview({
        previousOwnerLosesAccess: true,
        othersLosingAccess: 2,
        cancelledPrompts: 3,
        turnRunning: true,
      }),
    );
    const t = text(markup);
    expect(t).toContain("Luis Pérez will lose access to this session.");
    expect(t).toContain("2 other people will lose access.");
    expect(t).toContain("Their 3 queued prompts will be cancelled.");
    expect(t).toContain("The running turn finishes first; your next turns run as you.");
    expect(markup.match(/data-testid="assign-warning"/g)).toHaveLength(4);
    expect(markup).toContain('data-testid="assign-confirm"');
    expect(t).toContain("Assign to me");
    expect(t).toContain("Cancel");
  });

  it("shows no warning when nothing else changes", () => {
    const markup = body(preview());
    expect(markup).not.toContain('data-testid="assign-warning"');
    expect(markup).toContain('data-testid="assign-confirm"');
  });

  it("uses the singular for one person and one prompt", () => {
    const t = text(body(preview({ othersLosingAccess: 1, cancelledPrompts: 1 })));
    expect(t).toContain("1 other person will lose access.");
    expect(t).toContain("Their 1 queued prompt will be cancelled.");
  });

  it("disables Assign to me while the request runs", () => {
    const markup = body(preview(), true);
    expect(markup).toMatch(
      /data-testid="assign-confirm"[^>]*disabled=""|disabled=""[^>]*data-testid="assign-confirm"/,
    );
  });

  it("a refused preview shows only its reason and Close", () => {
    const markup = body(preview({ allowed: false, reason: "device_not_shared" }));
    const t = text(markup);
    expect(t).toContain("You can't use this server.");
    expect(t).toContain("Close");
    expect(markup).not.toContain('data-testid="assign-confirm"');
    expect(t).not.toContain(ASSIGN_DIALOG_COPY.becomesYours);
  });
});

describe("assignMenuState (D-04, PD-14)", () => {
  const detail = (assign: { allowed: boolean; reason: AssignRefusal | null } | undefined, over = {}) => ({
    assign,
    session: { createdBy: OWNER, status: "idle" as const, ...over },
  });

  it("offers the item when the API allows it", () => {
    expect(assignMenuState(detail({ allowed: true, reason: null }), VIEWER)).toEqual({ kind: "item" });
  });

  it("shows the fixed sentence for the four reasons a member can act on or understand", () => {
    for (const reason of ["not_on_server", "bot_session", "device_not_shared", "device_revoked"] as const) {
      expect(assignMenuState(detail({ allowed: false, reason }), VIEWER)).toEqual({
        kind: "reason",
        text: ASSIGN_REFUSAL_TEXT[reason],
      });
    }
  });

  it("shows nothing for the owner, an archived session, a viewer who may not prompt or an older API", () => {
    for (const reason of ["already_owner", "archived", "not_allowed"] as const) {
      expect(assignMenuState(detail({ allowed: false, reason }), VIEWER)).toEqual({ kind: "none" });
    }
    expect(assignMenuState(detail(undefined), VIEWER)).toEqual({ kind: "none" });
    // The owner of a desktop session gets `not_on_server` from the API (checked first); they see nothing.
    expect(assignMenuState(detail({ allowed: false, reason: "not_on_server" }), OWNER)).toEqual({
      kind: "none",
    });
    expect(
      assignMenuState(detail({ allowed: false, reason: "not_on_server" }, { status: "archived" }), VIEWER),
    ).toEqual({ kind: "none" });
  });
});

describe("AssignReasonItem (IN-06)", () => {
  it("is a disabled menu item, so screen readers and arrow keys reach the reason inside role=menu", () => {
    const el = AssignReasonItem({ text: ASSIGN_REFUSAL_TEXT.not_on_server, testId: "session-assign-reason" });
    expect(el.type).toBe(DropdownMenuItem);
    expect(el.props.disabled).toBe(true);
    expect(el.props.children).toBe(ASSIGN_REFUSAL_TEXT.not_on_server);
    expect(el.props["data-testid"]).toBe("session-assign-reason");
  });
});

describe("the owner in the session header (D-02)", () => {
  it("the desktop chip shows the first name, an avatar seeded by the owner id and the full name to tools", () => {
    const markup = html(<OwnerChip ownerId={OWNER} name="Luis Pérez" avatarUrl={null} />);
    expect(markup).toContain('data-testid="session-owner"');
    expect(markup).toContain('aria-label="Owner: Luis Pérez"');
    expect(markup).toContain(toneFor(OWNER));
    expect(text(markup)).toContain("Luis");
    expect(text(markup)).not.toContain("Pérez ");
  });

  it("the phone line says who owns it in full", () => {
    const markup = html(<OwnerLine ownerId={OWNER} name="Luis Pérez" avatarUrl={null} />);
    expect(markup).toContain('data-testid="session-owner"');
    expect(text(markup)).toContain("Owner · Luis Pérez");
    expect(markup).toContain(toneFor(OWNER));
  });

  it("an owner who left the organization reads as a former member", () => {
    expect(text(html(<OwnerLine ownerId={OWNER} name={null} avatarUrl={null} />))).toContain(
      "Owner · a former member",
    );
    const chip = html(<OwnerChip ownerId={OWNER} name={null} avatarUrl={null} />);
    expect(chip).toContain('aria-label="Owner: a former member"');
    expect(text(chip)).toContain("Former member");
  });

  it("the absent participants never repeat the owner, the viewer or anyone watching", () => {
    const P1 = "01a11635-d6e7-7c87-9f17-0000000000a3";
    const P2 = "01a11635-d6e7-7c87-9f17-0000000000a4";
    const participants = new Map([
      [OWNER, "Luis Pérez"],
      [VIEWER, "Ana García"],
      [P1, "Marta"],
      [P2, "Jon"],
    ]);
    expect(absentParticipants(participants, new Set([P2]), VIEWER, OWNER)).toEqual([[P1, "Marta"]]);
  });

  it("names are plain text, never markup", () => {
    const markup = html(<OwnerLine ownerId={OWNER} name={"<img src=x onerror=alert(1)>"} avatarUrl={null} />);
    expect(markup).not.toContain("<img src=x");
    expect(markup).toContain("&lt;img");
  });
});

describe("rename (D-06, D-14, PD-07)", () => {
  const form = (value: string, over: Partial<React.ComponentProps<typeof RenameForm>> = {}) =>
    html(
      <RenameForm
        id="rename"
        value={value}
        initial="Old title"
        pending={false}
        serverError={null}
        onChange={noop}
        onSubmit={noop}
        onCancel={noop}
        {...over}
      />,
    );

  it("prefills the title with a visible label, the counter and Save", () => {
    const markup = form("Old title");
    const t = text(markup);
    expect(markup).toMatch(/<label[^>]*for="rename"[^>]*>Title<\/label>/);
    expect(markup).toContain('value="Old title"');
    expect(t).toContain("9/200");
    expect(t).toContain(RENAME_COPY.save);
    expect(t).toContain(RENAME_COPY.cancel);
  });

  it("gives the client hints for an empty, a too long and a two-line title", () => {
    expect(renameError("")).toBe("Enter a title.");
    expect(renameError("   ")).toBe("Enter a title.");
    expect(renameError("x".repeat(201))).toBe("Use at most 200 characters.");
    expect(renameError("first\nsecond")).toBe("Use one line.");
    expect(renameError("  Fix login  ")).toBeNull();
    expect(renameError("x".repeat(200))).toBeNull();
  });

  it("IN-05: the field and both buttons are 44 px on every touch width (below 768 px), not only on phones", () => {
    const markup = form("Old title");
    const input = markup.match(/<input[^>]*data-testid="rename-input"[^>]*>/)?.[0] ?? "";
    expect(input).toContain("max-md:h-11");
    const buttons = markup.match(/<button[^>]*>/g) ?? [];
    expect(buttons).toHaveLength(2);
    for (const b of buttons) {
      expect(b).toContain("max-md:h-11");
      expect(b).not.toContain("max-sm:h-11");
    }
    const assign = body(preview()).match(/<button[^>]*>/g) ?? [];
    expect(assign.length).toBeGreaterThan(0);
    for (const b of assign) {
      expect(b).toContain("max-md:h-11");
      expect(b).not.toContain("max-sm:h-11");
    }
  });

  it("Save is off while unchanged, invalid or pending; a changed valid title can be saved", () => {
    const disabledSave =
      /data-testid="rename-save"[^>]*disabled=""|disabled=""[^>]*data-testid="rename-save"/;
    expect(form("Old title")).toMatch(disabledSave);
    expect(form("  Old title ")).toMatch(disabledSave);
    expect(form("")).toMatch(disabledSave);
    expect(form("New title", { pending: true })).toMatch(disabledSave);
    expect(form("New title")).not.toMatch(disabledSave);
  });

  it("shows the hint for an invalid value and the API's own message as is", () => {
    expect(text(form(""))).toContain("Enter a title.");
    expect(
      text(form("New title", { serverError: "A title can't contain a path on your computer." })),
    ).toContain("A title can't contain a path on your computer.");
  });

  it("is offered to people who may configure a session that is not archived", () => {
    expect(renameAllowed(["work_session.read", "work_session.configure"], "idle")).toBe(true);
    expect(renameAllowed(["work_session.read", "work_session.prompt"], "idle")).toBe(false);
    expect(renameAllowed(["work_session.configure"], "archived")).toBe(false);
  });
});
