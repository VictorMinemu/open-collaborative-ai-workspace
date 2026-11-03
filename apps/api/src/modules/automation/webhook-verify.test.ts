import { Webhook } from "standardwebhooks";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { newPublicId, newWebhookSecret, normalizePublicId, verifyStandardWebhook } from "./webhook-verify";

/**
 * 07.6-10 (D-02, D-07, Pitfall 4): the verifier is the `standardwebhooks` library over the exact bytes, tried with the
 * current secret and then the previous one; the clock is fixed so the ±5-minute window is pinned to the second.
 */

const SECRET = `whsec_${Buffer.alloc(32, 7).toString("base64")}`;
const OTHER = `whsec_${Buffer.alloc(32, 9).toString("base64")}`;
const NOW = new Date("2026-11-02T10:00:00Z");
const BODY = Buffer.from('{"order":{"id":450789,"name":"#1001"}}');

function signed(opts: { secret?: string; body?: Buffer; at?: Date; id?: string } = {}) {
  const at = opts.at ?? NOW;
  const id = opts.id ?? "msg_1";
  const body = opts.body ?? BODY;
  return {
    "webhook-id": id,
    "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
    "webhook-signature": new Webhook(opts.secret ?? SECRET).sign(id, at, body),
  };
}

const seconds = (s: number) => new Date(NOW.getTime() + s * 1000);

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.useRealTimers();
});

describe("verifyStandardWebhook", () => {
  it("accepts a correct signature and returns the id and the parsed body", () => {
    expect(verifyStandardWebhook(BODY, signed(), [SECRET])).toEqual({
      ok: true,
      id: "msg_1",
      payload: { order: { id: 450789, name: "#1001" } },
    });
  });

  it("refuses one changed body byte as signature", () => {
    const tampered = Buffer.from(BODY);
    tampered[tampered.length - 3] = "2".charCodeAt(0);
    expect(verifyStandardWebhook(tampered, signed(), [SECRET])).toEqual({ ok: false, reason: "signature" });
  });

  it("refuses a signature made with another secret", () => {
    expect(verifyStandardWebhook(BODY, signed({ secret: OTHER }), [SECRET])).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("refuses a timestamp 301 seconds old as timestamp", () => {
    expect(verifyStandardWebhook(BODY, signed({ at: seconds(-301) }), [SECRET])).toEqual({
      ok: false,
      reason: "timestamp",
    });
  });

  it("refuses a timestamp 301 seconds ahead as timestamp", () => {
    expect(verifyStandardWebhook(BODY, signed({ at: seconds(301) }), [SECRET])).toEqual({
      ok: false,
      reason: "timestamp",
    });
  });

  it("accepts a timestamp 299 seconds old", () => {
    expect(verifyStandardWebhook(BODY, signed({ at: seconds(-299) }), [SECRET]).ok).toBe(true);
  });

  it("accepts a header with two signatures when the second one is valid", () => {
    const h = signed();
    const wrong = new Webhook(OTHER).sign("msg_1", NOW, BODY);
    h["webhook-signature"] = `${wrong} ${h["webhook-signature"]}`;
    expect(verifyStandardWebhook(BODY, h, [SECRET]).ok).toBe(true);
  });

  it.each(["webhook-id", "webhook-timestamp", "webhook-signature"] as const)(
    "refuses a request without %s as signature",
    (header) => {
      const h: Record<string, string | undefined> = signed();
      delete h[header];
      expect(verifyStandardWebhook(BODY, h, [SECRET])).toEqual({ ok: false, reason: "signature" });
    },
  );

  it("refuses a non-numeric timestamp as signature", () => {
    expect(verifyStandardWebhook(BODY, { ...signed(), "webhook-timestamp": "soon" }, [SECRET])).toEqual({
      ok: false,
      reason: "signature",
    });
  });

  it("accepts the previous secret when the current one does not match (rotation grace)", () => {
    expect(verifyStandardWebhook(BODY, signed({ secret: OTHER }), [SECRET, OTHER]).ok).toBe(true);
  });

  it("refuses everything when there is no secret", () => {
    expect(verifyStandardWebhook(BODY, signed(), [])).toEqual({ ok: false, reason: "signature" });
  });

  it("verifies a body that is not JSON but returns no payload", () => {
    const body = Buffer.from("order=1001");
    expect(verifyStandardWebhook(body, signed({ body }), [SECRET])).toEqual({
      ok: true,
      id: "msg_1",
      payload: undefined,
    });
  });
});

describe("secrets and public ids", () => {
  it("newWebhookSecret is whsec_ + base64 of 32 bytes, and verifies what the library signs", () => {
    const secret = newWebhookSecret();
    expect(secret).toMatch(/^whsec_[A-Za-z0-9+/=]{32,120}$/);
    expect(Buffer.from(secret.slice("whsec_".length), "base64")).toHaveLength(32);
    expect(newWebhookSecret()).not.toBe(secret);
    expect(verifyStandardWebhook(BODY, signed({ secret }), [secret]).ok).toBe(true);
  });

  it("newPublicId is 26 Crockford base32 characters and differs across calls", () => {
    const ids = new Set(Array.from({ length: 200 }, () => newPublicId()));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("normalizePublicId upper-cases a valid segment and refuses anything else", () => {
    const id = newPublicId();
    expect(normalizePublicId(id.toLowerCase())).toBe(id);
    expect(normalizePublicId("short")).toBeNull();
    expect(normalizePublicId("U".repeat(26))).toBeNull();
    expect(normalizePublicId(`${id}/../x`)).toBeNull();
  });
});

describe("verified JSON is stored exactly or refused (07.6 review A LO-04)", () => {
  const payloadOf = (text: string) => {
    const body = Buffer.from(text);
    const v = verifyStandardWebhook(body, signed({ body }), [SECRET]);
    if (!v.ok) throw new Error("not verified");
    return v.payload;
  };

  it("an integer beyond 2^53 keeps its exact digits (as a string), so two 64-bit ids never merge", () => {
    expect(
      payloadOf('{"order":{"id":9007199254740993,"other":9007199254740992,"n":-12345678901234567890}}'),
    ).toEqual({ order: { id: "9007199254740993", other: "9007199254740992", n: "-12345678901234567890" } });
    // Safe integers, decimals and exponents stay numbers.
    expect(payloadOf('{"a":450789,"b":1.5,"c":1e30,"d":[9007199254740991]}')).toEqual({
      a: 450789,
      b: 1.5,
      c: 1e30,
      d: [9007199254740991],
    });
  });

  it("a lone surrogate or U+0000 anywhere (a value or a key) is no storable JSON: refused like a non-JSON body", () => {
    expect(payloadOf('{"note":"\\ud800"}')).toBeUndefined();
    expect(payloadOf('{"\\udc00":1}')).toBeUndefined();
    expect(payloadOf('{"a":["ok","x\\u0000"]}')).toBeUndefined();
    // A pair is one character (an emoji), and an escaped backslash before "u0000" is just text.
    expect(payloadOf('{"note":"\\ud83d\\ude00","path":"C:\\\\u0000"}')).toEqual({
      note: "😀",
      path: "C:\\u0000",
    });
  });
});
