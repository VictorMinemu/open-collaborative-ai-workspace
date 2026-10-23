import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { audienceRefusal } from "./new-session-dialog";

/**
 * A refused create request words the stale draft with the names the dialog showed (07.9-14, UI-SPEC Copy "Refusal
 * (inline)", D-04, D-13). The API sends entry ids only (07.9-06); the names come from the draft.
 */

const LEO = "01a11635-d6e7-7c87-9f17-0000000000a2";
const PIA = "01a11635-d6e7-7c87-9f17-0000000000a3";
const SAM = "01a11635-d6e7-7c87-9f17-0000000000a4";
const WEB = "01a11635-d6e7-7c87-9f17-0000000000d1";
const OPS = "01a11635-d6e7-7c87-9f17-0000000000d2";

const team = {
  deviceName: "Ana's MacBook",
  teamProject: {
    id: "01a11635-d6e7-7c87-9f17-0000000000e1",
    name: "Customer portal",
    defaultVisibility: "project" as const,
  },
};
const personal = { deviceName: "Ana's MacBook", teamProject: null };
const person = (userId: string, name: string) => ({ userId, name, avatarUrl: null });
const people = {
  kind: "people" as const,
  people: [person(LEO, "Leo Park"), person(PIA, "Pia Gómez"), person(SAM, "Sam Lee")],
};
const refused = (code: string, ids: string[]) =>
  new ApiRequestError(422, code, "Only people with access to the project can be chosen", { ids });

describe("audienceRefusal", () => {
  it("names the person who left the project", () => {
    expect(audienceRefusal(refused("audience_outside_project", [LEO]), people, team)).toBe(
      "Leo Park isn't in Customer portal anymore. Choose who can see it again.",
    );
  });

  it("names two, then two and a count", () => {
    expect(audienceRefusal(refused("audience_outside_project", [LEO, PIA]), people, team)).toBe(
      "Leo Park and Pia Gómez aren't in Customer portal anymore. Choose who can see it again.",
    );
    expect(audienceRefusal(refused("audience_outside_project", [LEO, PIA, SAM]), people, team)).toBe(
      "Leo Park, Pia Gómez and 1 more aren't in Customer portal anymore. Choose who can see it again.",
    );
  });

  it("on a personal repository, says who can't use the device anymore", () => {
    expect(audienceRefusal(refused("audience_outside_project", [PIA]), people, personal)).toBe(
      "Pia Gómez can't use Ana's MacBook anymore. Choose who can see it again.",
    );
  });

  it("names a team no longer assigned to the project", () => {
    const teams = {
      kind: "teams" as const,
      teams: [
        { id: WEB, name: "Web" },
        { id: OPS, name: "Ops" },
      ],
    };
    expect(audienceRefusal(refused("team_not_assigned", [OPS]), teams, team)).toBe(
      "Ops isn't assigned to Customer portal anymore. Choose who can see it again.",
    );
  });

  it("leaves every other error to the API's own message", () => {
    expect(audienceRefusal(new ApiRequestError(403, "forbidden", "No"), people, team)).toBeNull();
    expect(audienceRefusal(new Error("boom"), people, team)).toBeNull();
    expect(audienceRefusal(refused("audience_outside_project", ["unknown"]), people, team)).toBeNull();
    expect(audienceRefusal(refused("audience_outside_project", [LEO]), { kind: "project" }, team)).toBeNull();
    expect(
      audienceRefusal(new ApiRequestError(422, "audience_outside_project", "x", null), people, team),
    ).toBeNull();
  });
});
