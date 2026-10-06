import { type Attachment, Attachment as AttachmentSchema, PresignUploadResponse } from "@ocw/contracts";
import { contentTypeOf } from "@/components/chat/attachments/files";
import { ApiRequestError, api } from "./api";

/**
 * Chat attachment upload (CHAT-12, D-03): presign through the API, PUT the bytes straight to object storage with
 * exactly the signed headers (no upload body ever passes through the API), then `complete` so the API verifies,
 * sniffs and renders previews. `XMLHttpRequest` because `fetch` has no upload progress.
 */

export interface UploadHandle {
  /** Resolves with the verified (`ready`) attachment. */
  promise: Promise<Attachment>;
  /** Cancels the presign, the PUT or the completion, whichever is running (the promise rejects with AbortError). */
  abort(): void;
}

const abortError = () => new DOMException("Upload cancelled", "AbortError");

function put(
  url: string,
  headers: Record<string, string>,
  file: Blob,
  signal: AbortSignal,
  onProgress: (fraction: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(abortError());
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", url);
    for (const [name, value] of Object.entries(headers)) xhr.setRequestHeader(name, value);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && e.total > 0) onProgress(Math.min(1, e.loaded / e.total));
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      // Storage refuses a body that does not match the signed type or length (403) or an expired URL.
      else
        reject(
          new ApiRequestError(xhr.status, "upload_failed", "The file could not be uploaded. Try again."),
        );
    };
    xhr.onerror = () => reject(new ApiRequestError(0, "network_error", "Upload failed"));
    xhr.onabort = () => reject(abortError());
    signal.addEventListener("abort", () => xhr.abort(), { once: true });
    xhr.send(file);
  });
}

export function uploadAttachment(
  conversationId: string,
  file: File,
  onProgress: (fraction: number) => void,
): UploadHandle {
  const controller = new AbortController();
  const { signal } = controller;
  const promise = (async () => {
    const presigned = await api.post(`/api/v1/conversations/${conversationId}/attachments`, {
      body: { filename: file.name || "file", contentType: contentTypeOf(file), size: file.size },
      schema: PresignUploadResponse,
      signal,
    });
    onProgress(0);
    await put(presigned.upload.url, presigned.upload.headers, file, signal, onProgress);
    onProgress(1);
    return api.post(`/api/v1/attachments/${presigned.attachment.id}/complete`, {
      schema: AttachmentSchema,
      signal,
    });
  })();
  return { promise, abort: () => controller.abort() };
}
