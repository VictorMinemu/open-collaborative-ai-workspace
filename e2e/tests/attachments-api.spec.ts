import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { apiAs, BASE_URL, openAs } from "../support/actors";
import { ADMIN, API_URL } from "./env";

/**
 * CHAT-12 storage tracer (04-04): from a signed-in browser page, presign a PNG for #general, PUT the bytes straight
 * to Garage (proving the bucket CORS policy the API set for the web origin), complete through the API and download
 * through the API's authorized 302. The composer UI arrives in 04-12; this proves the pipeline end to end. In the
 * isolated harness Garage is the `ocw-e2e-storage` project on 127.0.0.1:4292; in CI it is compose's garage.
 */

/** A 1×1 PNG. */
const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

test("attachments: presign → browser PUT to object storage → complete → authorized download", async ({
  browser,
}, info) => {
  test.skip(info.project.name !== "desktop", "API-level storage flow; viewport-independent (desktop only)");
  test.setTimeout(90_000);
  const { context, page } = await openAs(browser, ADMIN, "desktop");
  try {
    const flow = await page.evaluate(
      async ({ api, png }) => {
        const json = async (r: Response) => ({ status: r.status, body: await r.json() });
        const cfg = await json(await fetch(`${api}/api/v1/attachments/config`, { credentials: "include" }));
        const list = await json(await fetch(`${api}/api/v1/channels`, { credentials: "include" }));
        const general = (list.body.channels as Array<{ id: string; slug: string }>).find(
          (c) => c.slug === "general",
        );
        if (!general) throw new Error("no #general");
        const bytes = Uint8Array.from(atob(png), (c) => c.charCodeAt(0));
        const presign = await json(
          await fetch(`${api}/api/v1/conversations/${general.id}/attachments`, {
            method: "POST",
            credentials: "include",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ filename: "e2e-dot.png", contentType: "image/png", size: bytes.length }),
          }),
        );
        // Cross-origin PUT with a non-simple content type: the preflight only passes with the bucket's CORS rule.
        const put = await fetch(presign.body.upload.url, {
          method: "PUT",
          headers: presign.body.upload.headers,
          body: bytes,
        });
        const complete = await json(
          await fetch(`${api}/api/v1/attachments/${presign.body.attachment.id}/complete`, {
            method: "POST",
            credentials: "include",
          }),
        );
        return {
          cfg: cfg.body,
          uploadUrl: presign.body.upload.url as string,
          presignStatus: presign.status,
          putStatus: put.status,
          complete,
        };
      },
      { api: API_URL, png: PNG_B64 },
    );

    expect(flow.cfg).toMatchObject({ enabled: true, reason: null });
    expect(flow.presignStatus).toBe(200);
    if (process.env.OCW_S3_PUBLIC_URL)
      expect(flow.uploadUrl.startsWith(process.env.OCW_S3_PUBLIC_URL)).toBe(true);
    expect(flow.putStatus).toBe(200);
    expect(flow.complete.status).toBe(200);
    expect(flow.complete.body).toMatchObject({ status: "ready", contentType: "image/png", isImage: true });
    const id = flow.complete.body.id as string;

    // The API answers a 302 to a short-lived presigned GET, never cached.
    const admin = await apiAs(ADMIN);
    const redirect = await admin.get(`/api/v1/attachments/${id}/download`, { maxRedirects: 0 });
    expect(redirect.status()).toBe(302);
    expect(redirect.headers()["cache-control"]).toBe("private, no-store");
    await admin.dispose();

    // A real browser download: navigation to the API, 302 to storage, `attachment` disposition.
    const downloading = page.waitForEvent("download");
    await page.evaluate((url) => {
      const a = document.createElement("a");
      a.href = url;
      document.body.appendChild(a);
      a.click();
    }, `${API_URL}/api/v1/attachments/${id}/download`);
    const download = await downloading;
    expect(download.suggestedFilename()).toBe("e2e-dot.png");
    const saved = await download.path();
    expect(readFileSync(saved).equals(Buffer.from(PNG_B64, "base64"))).toBe(true);
    expect(page.url().startsWith(BASE_URL)).toBe(true);
  } finally {
    await context.close();
  }
});
