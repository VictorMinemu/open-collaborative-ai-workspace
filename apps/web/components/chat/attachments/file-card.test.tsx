import type { Attachment } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { FileCard } from "./file-card";

const README: Attachment = {
  id: "00000000-0000-4000-8000-000000000001",
  conversationId: "00000000-0000-4000-8000-000000000002",
  messageId: null,
  filename: "README.md",
  contentType: "text/markdown",
  size: 1536,
  status: "ready",
  isImage: false,
  width: null,
  height: null,
  previewUrl: null,
  largeUrl: null,
  downloadUrl: "/api/v1/attachments/00000000-0000-4000-8000-000000000001/download",
  createdAt: "2026-11-11T00:00:00.000Z",
};

describe("FileCard (07.17.1.1 review WR-06)", () => {
  it("the download control is a 44 px touch target on a phone and 32 px from md up", () => {
    const html = renderToStaticMarkup(<FileCard attachment={README} />);
    const link = html.match(/<a [^>]*data-testid="file-download"[^>]*>/)?.[0] ?? "";
    expect(link).toContain('aria-label="Download README.md"');
    const classes = link.match(/class="([^"]+)"/)?.[1]?.split(" ") ?? [];
    expect(classes).toContain("size-8");
    expect(classes).toContain("max-md:size-11");
  });
});
