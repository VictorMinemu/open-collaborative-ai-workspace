import { describe, expect, it } from "vitest";
import { DEVICE_PROMPT_FILES_VERSION, HelloFrame, PromptPayload } from "./device-link";
import {
  PROMPT_FILES_NOTE_HEADER,
  promptAttachmentRoutes,
  promptFileCollisionPath,
  promptFileName,
  promptFilePath,
  promptFileRefusal,
  promptFilesNotePaths,
  promptFileTooLargeSentence,
  WORK_PROMPT_MAX_ATTACHMENTS,
  WORK_PROMPT_UPLOADS_DIR,
  withPromptFilesNote,
} from "./work-prompt-files";
import { WorkSessionFilePath, workSessionFilePathRefusal } from "./work-session-files";

/** ADR-0045: a Work Zone prompt carries any file; the ones the model does not read land in `.ocw/uploads/`. */

describe("where a prompt file lands", () => {
  it("the uploads folder is not on the deny list", () => {
    expect(WORK_PROMPT_UPLOADS_DIR).toBe(".ocw/uploads");
    expect(workSessionFilePathRefusal(`${WORK_PROMPT_UPLOADS_DIR}/spec.pdf`)).toBeNull();
    expect(promptFilePath("spec.pdf")).toBe(".ocw/uploads/spec.pdf");
  });

  it("every name becomes one plain WorkSessionFilePath segment", () => {
    const cases: Array<[string, string]> = [
      ["Q3 plan.docx", "Q3 plan.docx"],
      ["notes:v2.md", "notes_v2.md"],
      ["ENV~1", "ENV-1"],
      ["report. ", "report"],
      ["trailing...", "trailing"],
      ["CON", "_CON"],
      ["nul.txt", "_nul.txt"],
      ["a/b\\c.txt", "a_b_c.txt"],
      ["／etc／passwd", "_etc_passwd"],
      ["in​visible.md", "invisible.md"],
      ["", "file"],
      ["...", "file"],
    ];
    for (const [input, out] of cases) {
      expect(promptFileName(input), JSON.stringify(input)).toBe(out);
      expect(WorkSessionFilePath.safeParse(promptFilePath(input)).success, input).toBe(true);
    }
  });

  it("a long name keeps its extension and room for a collision suffix", () => {
    const name = promptFileName(`${"x".repeat(400)}.pdf`);
    expect(name.endsWith(".pdf")).toBe(true);
    expect(name.length).toBeLessThanOrEqual(247);
    expect(WorkSessionFilePath.safeParse(promptFileCollisionPath(promptFilePath(name), 99)).success).toBe(
      true,
    );
  });

  it("collisions get name-N.ext, never another folder", () => {
    expect(promptFileCollisionPath(".ocw/uploads/spec.pdf", 1)).toBe(".ocw/uploads/spec-1.pdf");
    expect(promptFileCollisionPath(".ocw/uploads/notes", 2)).toBe(".ocw/uploads/notes-2");
    expect(promptFileCollisionPath(".ocw/uploads/archive.tar.gz", 3)).toBe(".ocw/uploads/archive.tar-3.gz");
  });

  it("keys and credential files are refused by the shared deny list", () => {
    expect(promptFileRefusal("server.key")).toBe("secret");
    expect(promptFileRefusal("id_rsa")).toBe("secret");
    expect(promptFileRefusal("credentials.json")).toBe("secret");
    expect(promptFileRefusal("spec.pdf")).toBeNull();
    // A stored attachment name never starts with a dot (sanitizeFilename), so `.env` arrives as `env`.
    expect(promptFileRefusal("README.md")).toBeNull();
  });

  it("the size sentence names the limit", () => {
    expect(promptFileTooLargeSentence(25 * 1024 * 1024)).toBe("Over the 25 MB limit");
  });
});

describe("which attachments go inline", () => {
  const img = { inlineImage: true };
  const pdf = { inlineImage: false };

  it("images a model reads go inline, up to the cap; the rest go to the tree", () => {
    expect(promptAttachmentRoutes([img, pdf, img], true, 4)).toEqual(["inline", "file", "inline"]);
    expect(promptAttachmentRoutes([img, img, img], undefined, 2)).toEqual(["inline", "inline", "file"]);
  });

  it("a model that can't read images gets every image as a file", () => {
    expect(promptAttachmentRoutes([img, pdf], false, 4)).toEqual(["file", "file"]);
  });
});

describe("the note the runtime reads", () => {
  it("is appended after a blank line and lists every path", () => {
    const text = withPromptFilesNote("Summarise the spec", [
      ".ocw/uploads/spec.pdf",
      ".ocw/uploads/spec-1.pdf",
    ]);
    expect(text).toBe(
      `Summarise the spec\n\n${PROMPT_FILES_NOTE_HEADER}\n- .ocw/uploads/spec.pdf\n- .ocw/uploads/spec-1.pdf`,
    );
    expect(promptFilesNotePaths(text)).toEqual([".ocw/uploads/spec.pdf", ".ocw/uploads/spec-1.pdf"]);
  });

  it("leaves the text alone without files", () => {
    expect(withPromptFilesNote("hello", [])).toBe("hello");
    expect(promptFilesNotePaths("hello")).toEqual([]);
  });
});

describe("the wire", () => {
  it("a prompt payload carries files (no bytes, no URL), at most one per attachment", () => {
    const file = {
      transferId: "3c1f9a0e-8b7d-4c2a-9e1f-0a1b2c3d4e5f",
      path: ".ocw/uploads/a.pdf",
      sizeBytes: 3,
      sha256: null,
    };
    expect(PromptPayload.parse({ promptId: "p", text: "t", files: [file] }).files).toEqual([file]);
    expect(
      PromptPayload.safeParse({ promptId: "p", text: "t", files: [{ ...file, path: "/etc/passwd" }] })
        .success,
    ).toBe(false);
    expect(
      PromptPayload.safeParse({ promptId: "p", text: "t", files: [{ ...file, transferId: "../x" }] }).success,
    ).toBe(false);
    expect(
      PromptPayload.safeParse({
        promptId: "p",
        text: "t",
        files: Array.from({ length: WORK_PROMPT_MAX_ATTACHMENTS + 1 }, () => file),
      }).success,
    ).toBe(false);
  });

  it("hello announces prompt files; older hellos still parse", () => {
    const hello = {
      type: "hello",
      protocolVersion: 1,
      device: { name: "Mac", platform: "darwin" },
      runtimes: [],
    };
    expect(HelloFrame.parse(hello).promptFiles).toBeUndefined();
    expect(HelloFrame.parse({ ...hello, promptFiles: DEVICE_PROMPT_FILES_VERSION }).promptFiles).toBe(1);
    expect(HelloFrame.safeParse({ ...hello, promptFiles: 2 }).success).toBe(false);
  });
});
