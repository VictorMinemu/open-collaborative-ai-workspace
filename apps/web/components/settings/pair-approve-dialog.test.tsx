import type { PairingRequestView } from "@ocw/contracts";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ApiRequestError } from "@/lib/api";
import { PairCodeField, PairRequestDetails, pairErrorText, requestAge } from "./pair-approve-dialog";

/**
 * Settings › Devices › Pair a server (07.12-07, D-01…D-03, PD-14): what the owner sees before approving a server that
 * asked to join from its terminal (RFC 8628 §5.4 anti-phishing: the code to compare, the requested name, the platform,
 * where the request came from and how long ago, and the warning), the error copy for every refusal the API sends, and
 * the Server tab of Add a device. Pure rendering in node; the API decides who may look up, approve or deny.
 */

const NOW = Date.parse("2026-10-29T12:00:00.000Z");
const MIN = 60_000;

function request(over: Partial<PairingRequestView> = {}): PairingRequestView {
  return {
    userCode: "ABCD-EFGH",
    name: "rack-01",
    platform: "linux",
    runtimeVersion: "0.12.0",
    requestIp: "203.0.113.7",
    requestedAt: new Date(NOW - 2 * MIN).toISOString(),
    expiresAt: new Date(NOW + 8 * MIN).toISOString(),
    ...over,
  };
}

const details = (over: Partial<PairingRequestView> = {}, name = "rack-01") =>
  renderToStaticMarkup(
    <PairRequestDetails request={request(over)} now={NOW} name={name} onNameChange={() => undefined} />,
  );

describe("PairRequestDetails", () => {
  it("shows the code to compare, the name, the platform, the IP, the age and the warning", () => {
    const html = details();
    expect(html).toContain('data-testid="pair-request-code"');
    expect(html).toContain("ABCD-EFGH");
    expect(html).toContain("Check that the server shows the same code");
    expect(html).toMatch(
      /data-testid="pair-request-name"[^>]*value="rack-01"|value="rack-01"[^>]*data-testid="pair-request-name"/,
    );
    expect(html).toContain("Linux");
    expect(html).toContain("203.0.113.7");
    expect(html).toContain("2 min ago");
    expect(html).toContain("0.12.0");
    expect(html).toContain("Only approve a code you started yourself, on a computer you control.");
  });

  it("names macOS and Windows, and leaves out a missing IP or runtime version", () => {
    expect(details({ platform: "darwin" })).toContain("macOS");
    expect(details({ platform: "win32" })).toContain("Windows");
    const html = details({ requestIp: null, runtimeVersion: null });
    expect(html).not.toContain('data-testid="pair-request-ip"');
    expect(html).not.toContain('data-testid="pair-request-runtime"');
  });

  it("keeps the name the approver typed", () => {
    expect(details({}, "Build rack")).toContain('value="Build rack"');
  });
});

describe("requestAge", () => {
  const at = (ms: number) => new Date(NOW - ms).toISOString();
  it("reads just now, minutes, then hours", () => {
    expect(requestAge(at(10_000), NOW)).toBe("just now");
    expect(requestAge(at(MIN), NOW)).toBe("1 min ago");
    expect(requestAge(at(2 * MIN + 20_000), NOW)).toBe("2 min ago");
    expect(requestAge(at(9 * MIN), NOW)).toBe("9 min ago");
    expect(requestAge(at(125 * MIN), NOW)).toBe("2 h ago");
  });
  it("never says a request is from the future (clock skew)", () => {
    expect(requestAge(new Date(NOW + 30_000).toISOString(), NOW)).toBe("just now");
  });
});

describe("pairErrorText", () => {
  const err = (status: number, code: string) => new ApiRequestError(status, code, "server message");
  it("words each refusal the API sends", () => {
    expect(pairErrorText(err(404, "pairing_not_found"))).toBe(
      "This code is not valid or has expired. Check the code on the server, or run the command again.",
    );
    expect(pairErrorText(err(409, "already_decided"))).toBe("This request was already approved or denied.");
    expect(pairErrorText(err(403, "forbidden"))).toBe("You can't pair devices in this organization.");
    expect(pairErrorText(err(429, "rate_limited"))).toBe("Too many attempts. Wait a minute and try again.");
  });
  it("falls back to the API's own message, and to the network text", () => {
    expect(pairErrorText(err(500, "internal"))).toBe("server message");
    expect(pairErrorText(new ApiRequestError(0, "network_error", "x"))).toBe(
      "Can't reach the server. Check that the API is running.",
    );
  });
});

describe("PairCodeField", () => {
  it("is a named, unspelled, uppercase code field with Continue disabled until the code is valid", () => {
    const empty = renderToStaticMarkup(
      <PairCodeField value="" onChange={() => undefined} onSubmit={() => undefined} />,
    );
    expect(empty).toContain('data-testid="pair-code-input"');
    expect(empty).toContain('placeholder="XXXX-XXXX"');
    expect(empty).toContain('autoComplete="off"');
    expect(empty).toContain('spellCheck="false"');
    expect(empty).toContain('maxLength="9"');
    expect(empty).toMatch(
      /data-testid="pair-code-continue"[^>]*disabled|disabled[^>]*data-testid="pair-code-continue"/,
    );
    const valid = renderToStaticMarkup(
      <PairCodeField value="ABCD-EFGH" onChange={() => undefined} onSubmit={() => undefined} />,
    );
    expect(valid).not.toMatch(
      /data-testid="pair-code-continue"[^>]*disabled=""|disabled=""[^>]*data-testid="pair-code-continue"/,
    );
  });
});
