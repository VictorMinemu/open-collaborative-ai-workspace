import { APICallError } from "ai";
import { describe, expect, it } from "vitest";
import { classify } from "./errors";

/**
 * P-04/P-10: provider failures are classified into `AiErrorCode` (plus the credential transition they imply) and
 * the classified value never carries the request or response body (AI SDK errors hold the prompt).
 */

const PROMPT = "my secret prompt about the merger";

/** A pre-stream HTTP error the way @ai-sdk/openai 4.0.80 raises it (failedResponseHandler). */
function httpError(status: number, body: unknown) {
  const responseBody = JSON.stringify(body);
  const parsed = body as { error?: unknown };
  return new APICallError({
    message: "request failed",
    url: "https://api.openai.com/v1/responses",
    requestBodyValues: { input: [{ role: "user", content: PROMPT }] },
    statusCode: status,
    responseBody,
    isRetryable: status === 429 || status >= 500,
    ...(parsed.error ? { data: body } : {}),
  });
}

const siwc = (status: number, code: string, param: string | null = null) =>
  httpError(status, { error: { code, param, message: `failed: ${PROMPT}`, type: "invalid_request_error" } });

/** A mid-stream `response.failed` surfaced as a stream `error` part (createProviderStreamError shape). */
function streamFailure(code: string) {
  return {
    message: "You have reached your ChatGPT plan usage limit",
    type: "response.failed",
    code,
    statusCode: 500,
    isRetryable: true,
    data: { type: "response.failed", response: { error: { code, message: PROMPT } } },
  };
}

describe("classify (ChatGPT plan codes)", () => {
  it("usage limit (429), also when it arrives mid-stream as response.failed", () => {
    expect(classify(siwc(429, "subscription_sharing_usage_limit_exceeded"))).toEqual({
      code: "usage_limit_exceeded",
      param: null,
      status: 429,
      credentialState: null,
      retryable: false,
    });
    expect(classify(streamFailure("subscription_sharing_usage_limit_exceeded"))).toMatchObject({
      code: "usage_limit_exceeded",
      credentialState: null,
      retryable: false,
    });
  });

  it("a stream failure before any output (APICallError carrying the frame) is classified by its code", () => {
    const err = new APICallError({
      message: "stream failed",
      url: "https://api.openai.com/v1/responses",
      requestBodyValues: { input: PROMPT },
      statusCode: 500,
      responseBody: JSON.stringify({ prompt: PROMPT }),
      data: {
        type: "response.failed",
        response: { error: { code: "subscription_sharing_usage_limit_exceeded" } },
      },
    });
    expect(classify(err).code).toBe("usage_limit_exceeded");
  });

  it("not eligible (403) moves the credential to not_eligible", () => {
    expect(classify(siwc(403, "subscription_sharing_user_not_eligible"))).toMatchObject({
      code: "user_not_eligible",
      status: 403,
      credentialState: "not_eligible",
      retryable: false,
    });
  });

  it("usage unavailable (503) is retryable and leaves the credential alone", () => {
    expect(classify(siwc(503, "subscription_sharing_usage_unavailable"))).toMatchObject({
      code: "usage_unavailable",
      credentialState: null,
      retryable: true,
    });
  });

  it("unsupported capability (400) keeps error.param", () => {
    expect(classify(siwc(400, "subscription_sharing_unsupported_capability", "tools"))).toMatchObject({
      code: "unsupported_capability",
      param: "tools",
      status: 400,
      credentialState: null,
    });
  });

  it("invalid user (401) needs a reconnect", () => {
    expect(classify(siwc(401, "subscription_sharing_invalid_user"))).toMatchObject({
      code: "invalid_credential",
      credentialState: "needs_reconnect",
    });
  });

  it("route not supported", () => {
    expect(classify(siwc(403, "subscription_sharing_route_not_supported")).code).toBe("route_not_supported");
  });

  it('a {"detail": "..."} 401 admission error is an invalid credential', () => {
    expect(classify(httpError(401, { detail: `Unauthorized ${PROMPT}` }))).toMatchObject({
      code: "invalid_credential",
      status: 401,
      credentialState: "needs_reconnect",
    });
  });
});

describe("classify (everything else)", () => {
  it("an abort is interrupted", () => {
    const abort = new DOMException("This operation was aborted", "AbortError");
    expect(classify(abort)).toMatchObject({ code: "interrupted", credentialState: null, retryable: false });
  });

  it("a plain 429 without a plan code is rate limited", () => {
    expect(
      classify(httpError(429, { error: { message: "slow down", code: "rate_limit_exceeded" } })),
    ).toMatchObject({ code: "rate_limited", retryable: true });
  });

  it("anything else is provider_error", () => {
    expect(classify(new Error(PROMPT))).toEqual({
      code: "provider_error",
      param: null,
      status: null,
      credentialState: null,
      retryable: false,
    });
    expect(classify(httpError(500, { error: { message: PROMPT } })).code).toBe("provider_error");
    expect(classify("boom").code).toBe("provider_error");
    expect(classify(null).code).toBe("provider_error");
  });

  it("the classified value never contains the request or response body", () => {
    const errors = [
      siwc(429, "subscription_sharing_usage_limit_exceeded"),
      siwc(400, "subscription_sharing_unsupported_capability", "tools"),
      httpError(401, { detail: PROMPT }),
      streamFailure("subscription_sharing_usage_limit_exceeded"),
      new Error(PROMPT),
    ];
    for (const err of errors) expect(JSON.stringify(classify(err))).not.toContain("secret prompt");
  });

  it("an over-long or odd param is not copied verbatim", () => {
    const long = "x".repeat(500);
    expect(
      classify(siwc(400, "subscription_sharing_unsupported_capability", long)).param?.length,
    ).toBeLessThanOrEqual(200);
  });
});
