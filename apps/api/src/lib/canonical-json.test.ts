import { createHash } from "node:crypto";
import { projectFields } from "@ocw/contracts";
import { describe, expect, it } from "vitest";
import { CanonicalHashError, canonicalHash } from "./canonical-json";

/**
 * 07.6-07 (D-04, D-09, Pitfall 9): the watched-record hash is sha256 over 07.5's RFC 8785 canonical JSON (the RFC's own
 * vectors are tested with `canonicalJson` in 07.5-01). These pin the hash of the watched projection, its key-order
 * independence, the documented number limit and the refusals a check maps to `last_status = error`.
 */

const SO_10442 = {
  id: "SO-10442",
  status: "Confirmed",
  delivery_date: "2026-10-14",
  total: "1250.00",
  customer: "Globex S.L.",
};
const FIELDS = [{ pointer: "/status" }, { pointer: "/delivery_date" }, { pointer: "/total" }];

describe("canonicalHash (07.5 canonicalJson, RFC 8785)", () => {
  it("pins the hash of a fixed projection (a change in canonicalization or projection is caught)", () => {
    // Computed outside the code under test: printf '<canonical text>' | shasum -a 256.
    const canonical =
      '{"fields":{"/delivery_date":"2026-10-14","/status":"Confirmed","/total":"1250.00"},"v":1}';
    const pinned = "6e71c93ce4a970a5a3824cc2a9769612a2bb256d8bfd6c976647b2ea3445d083";
    expect(createHash("sha256").update(canonical).digest("hex")).toBe(pinned);
    expect(canonicalHash(projectFields(SO_10442, FIELDS))).toBe(pinned);
  });

  it("equal data in any key order hashes the same, nested objects too", () => {
    expect(canonicalHash({ b: 1, a: 2 })).toBe(canonicalHash({ a: 2, b: 1 }));
    expect(canonicalHash({ x: { d: [1, { z: 1, y: 2 }], c: "é" }, w: null })).toBe(
      canonicalHash({ w: null, x: { c: "é", d: [1, { y: 2, z: 1 }] } }),
    );
    // The projection's field order does not matter either.
    expect(canonicalHash(projectFields(SO_10442, [...FIELDS].reverse()))).toBe(
      canonicalHash(projectFields(SO_10442, FIELDS)),
    );
    expect(canonicalHash({ a: 1 })).not.toBe(canonicalHash({ a: 2 }));
    expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
  });

  it("Pitfall 9: decimal strings keep every character; the same decimals as numbers hash the same", () => {
    expect(canonicalHash({ total: "10.10" })).not.toBe(canonicalHash({ total: "10.1" }));
    // Documented limit: JSON.parse turns 10.10 into 10.1 before hashing, so a numeric 10.10 → 10.1 is invisible.
    expect(canonicalHash({ total: 10.1 })).toBe(canonicalHash(JSON.parse('{"total":10.10}')));
    // Integers beyond 2^53 lose precision the same way.
    expect(canonicalHash(JSON.parse('{"n":9007199254740993}'))).toBe(canonicalHash({ n: 9007199254740992 }));
  });

  it("NaN, Infinity and a lone surrogate throw CanonicalHashError with 07.5's code", () => {
    const codeOf = (value: unknown) => {
      try {
        canonicalHash(value);
        return null;
      } catch (err) {
        expect(err).toBeInstanceOf(CanonicalHashError);
        return (err as CanonicalHashError).code;
      }
    };
    expect(codeOf({ fields: { "/total": Number.NaN } })).toBe("non_finite");
    expect(codeOf({ fields: { "/total": Number.POSITIVE_INFINITY } })).toBe("non_finite");
    expect(codeOf({ fields: { "/status": "\ud800" } })).toBe("lone_surrogate");
    expect(codeOf({ fields: { "/status": undefined } })).toBe("undefined");
    expect(codeOf({ fields: { "/when": new Date(0) } })).toBe("unsupported");
  });
});
