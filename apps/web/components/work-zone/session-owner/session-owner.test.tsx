import { ASSIGN_REFUSAL_TEXT, type AssignPreview, type AssignRefusal } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { Dialog } from "@/components/ui/dialog";
import { ASSIGN_DIALOG_COPY, AssignPreviewBody, assignMenuState } from "./assign-dialog";

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
