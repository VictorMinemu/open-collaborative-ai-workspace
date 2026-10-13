import type { MemoryActor, MemoryRevisionMeta } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "./api";
import {
  actorLabel,
  folderIndexPath,
  formatSize,
  isNearFull,
  moveKind,
  newFileContent,
  parentFolder,
  pathErrorText,
  revisionAccessibleName,
  revisionOpLabel,
  saveErrorText,
  secretFindings,
  secretHeadline,
  utf8Bytes,
} from "./memory-edit";

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const ana: MemoryActor = { kind: "user", id: id(1), displayName: "Ana Pérez", onBehalfOf: null };
const scout: MemoryActor = {
  kind: "agent",
  id: id(2),
  displayName: "Scout",
  onBehalfOf: { id: id(3), displayName: "Sam Lee" },
};

function rev(version: number, op: MemoryRevisionMeta["op"], path = "clients/acme.md"): MemoryRevisionMeta {
  return {
    version,
    op,
    path,
    linesAdded: 2,
    linesRemoved: 0,
    author: ana,
    approvalRequestId: null,
    createdAt: "2026-10-13T10:00:00.000Z",
  };
}

describe("pathErrorText", () => {
  it("speaks every parser reason in words (UI-SPEC Copywriting › File actions)", () => {
    expect(pathErrorText("dot_segment")).toBe('"." and ".." aren\'t allowed.');
    expect(pathErrorText("extension")).toBe("File names end in .md (lowercase).");
    expect(pathErrorText("absolute")).toBe('Remove the leading "/".');
    expect(pathErrorText("missing_slash")).toBe('End the folder with "/".');
    expect(pathErrorText("segment_length")).toBe("Each name can have up to 64 characters.");
  });
});

describe("secretHeadline", () => {
  it("names one line, two lines, three, then counts the rest", () => {
    expect(secretHeadline([12])).toBe("This looks like a secret on line 12.");
    expect(secretHeadline([12, 30])).toBe("This looks like a secret on lines 12 and 30.");
    expect(secretHeadline([3, 7, 9])).toBe("This looks like a secret on lines 3, 7 and 9.");
    expect(secretHeadline([1, 2, 3, 4, 5])).toBe("This looks like a secret on lines 1, 2, 3 and 2 more.");
  });
  it("falls back to a line-less sentence", () => {
    expect(secretHeadline([])).toBe("This looks like a secret.");
  });
});

describe("secretFindings", () => {
  it("reads the masked block findings of a 422 secret_detected, sorted unique lines", () => {
    const err = new ApiRequestError(422, "secret_detected", "x", {
      findings: [
        {
          kind: "secret",
          severity: "block",
          source: "builtin",
          count: 2,
          samples: ["sk-a••••"],
          lines: [9, 3],
        },
        { kind: "secret", severity: "block", source: "builtin", count: 1, samples: ["ghp_••••"], lines: [3] },
      ],
    });
    expect(secretFindings(err)).toEqual({ lines: [3, 9], samples: ["sk-a••••", "ghp_••••"] });
  });
  it("is null for any other error", () => {
    expect(secretFindings(new ApiRequestError(409, "memory_version_conflict", "x"))).toBeNull();
    expect(secretFindings(new Error("x"))).toBeNull();
  });
});

describe("saveErrorText", () => {
  it("maps API codes to plain sentences, never the code", () => {
    expect(saveErrorText(new ApiRequestError(413, "memory_file_too_large", "x"))).toBe(
      "This file is over 256 KB. Split it into smaller files.",
    );
    expect(saveErrorText(new ApiRequestError(409, "memory_scope_full", "x"))).toBe(
      "This memory holds 2,000 files, the most it can. Delete or merge files first.",
    );
    expect(saveErrorText(new ApiRequestError(409, "memory_path_exists", "x"))).toBe(
      "A file with this name already exists.",
    );
    expect(
      saveErrorText(new ApiRequestError(400, "memory_path_invalid", "x", { reason: "dot_segment" })),
    ).toBe('"." and ".." aren\'t allowed.');
    expect(saveErrorText(new ApiRequestError(0, "network_error", "x"))).toBe(
      "Couldn't save. Your changes are still here.",
    );
    expect(saveErrorText(new ApiRequestError(500, "internal", "boom"))).toBe(
      "Couldn't save. Your changes are still here.",
    );
  });
});

describe("sizes", () => {
  it("counts UTF-8 bytes and shows KB of 256 KB", () => {
    expect(utf8Bytes("é")).toBe(2);
    expect(formatSize(0)).toBe("0 KB of 256 KB");
    expect(formatSize(12 * 1024 + 1)).toBe("13 KB of 256 KB");
    expect(isNearFull(230 * 1024)).toBe(false);
    expect(isNearFull(236 * 1024)).toBe(true);
  });
});

describe("paths", () => {
  it("derives the parent folder, the new-file template and the folder index", () => {
    expect(parentFolder("clients/acme.md")).toBe("clients/");
    expect(parentFolder("MEMORY.md")).toBe("");
    expect(newFileContent("meetings/2026-10-08.md")).toBe("# 2026-10-08\n");
    expect(folderIndexPath("meetings")).toEqual({ ok: true, folder: "meetings/", path: "meetings/INDEX.md" });
    expect(folderIndexPath("clients/meetings/")).toEqual({
      ok: true,
      folder: "clients/meetings/",
      path: "clients/meetings/INDEX.md",
    });
    expect(folderIndexPath("../x")).toEqual({ ok: false, reason: "dot_segment" });
  });
  it("tells a rename (same folder) from a move", () => {
    expect(moveKind("clients/acme.md", "clients/acme-corp.md")).toBe("rename");
    expect(moveKind("clients/acme.md", "archive/acme.md")).toBe("move");
    expect(moveKind("clients/acme.md", "clients/acme.md")).toBe("same");
  });
});

describe("revisions", () => {
  it("labels every op; a rename names the previous file", () => {
    expect(revisionOpLabel(rev(1, "create"))).toBe("Created");
    expect(revisionOpLabel(rev(2, "update"))).toBe("Edited");
    expect(revisionOpLabel(rev(3, "append"))).toBe("Added to");
    expect(revisionOpLabel(rev(4, "rename", "clients/acme-corp.md"), rev(3, "append"))).toBe(
      "Renamed from acme.md",
    );
    expect(revisionOpLabel(rev(4, "rename"))).toBe("Renamed");
    expect(revisionOpLabel(rev(5, "restore"))).toBe("Restored");
    expect(revisionOpLabel(rev(6, "delete"))).toBe("Deleted");
  });
  it("names actors and builds the row's accessible name", () => {
    expect(actorLabel(ana)).toBe("Ana Pérez");
    expect(actorLabel(scout)).toBe("Scout for Sam Lee");
    expect(actorLabel({ kind: "system", id: null, displayName: "system", onBehalfOf: null })).toBe(
      "Workspace",
    );
    expect(revisionAccessibleName({ ...rev(5, "append"), author: scout }, "Added to", "2 minutes ago")).toBe(
      "Version 5, Added to, by Scout for Sam Lee, 2 minutes ago, 2 lines added, 0 removed",
    );
  });
});
