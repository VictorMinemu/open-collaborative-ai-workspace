// node --test scripts/gate/cleanroom.test.mjs
//
// The clean-room gate runs the documented `docker compose up -d --build --wait` in a fresh clone without -p, so the
// clone's `docker compose config` is checked first: project, published ports and built images must be the run's.
// No Docker here.
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { checkComposeConfig, cleanroomNames, gateKeys } from "./cleanroom.mjs";
import { assertSafe, gatePorts } from "./lib.mjs";

const SHA = "8db72c2a1b2c3d4e5f60718293a4b5c6d7e8f901";

describe("cleanroomNames", () => {
  it("derives an ocw-cleanroom project and a tag carrying the sha and the run id, both accepted by assertSafe", () => {
    const n = cleanroomNames(SHA, "abc123");
    assert.equal(n.project, "ocw-cleanroom-abc123");
    assert.equal(n.imageTag, "cleanroom-8db72c2a1b2c-abc123");
    assert.ok(n.imageTag.endsWith("-abc123"), "teardown removes only images whose tag carries the run id");
    assertSafe({
      project: n.project,
      imageTag: n.imageTag,
      envFile: path.join(tmpdir(), "x", "ocw", ".env"),
      ports: Object.values(gatePorts(34)),
    });
  });

  it("refuses a malformed sha or run id", () => {
    assert.throws(() => cleanroomNames("HEAD", "abc"), /sha/);
    assert.throws(() => cleanroomNames(SHA, "../x"), /run id/);
    assert.throws(() => cleanroomNames(SHA, ""), /run id/);
  });
});

describe("gateKeys", () => {
  it("adds only the e2e override, the mock model, loopback publishing and the sign-in limit (no secret, no port)", () => {
    const keys = gateKeys();
    assert.deepEqual(Object.keys(keys).sort(), [
      "COMPOSE_FILE",
      "OCW_MODEL_PROVIDER",
      "OCW_PUBLISH_ADDRESS",
      "OCW_SIGNIN_RATE_LIMIT_PER_MINUTE",
    ]);
    assert.match(keys.COMPOSE_FILE, /^compose\.yaml:compose\.e2e\.yaml:/);
    assert.equal(keys.OCW_MODEL_PROVIDER, "mock");
    assert.equal(keys.OCW_PUBLISH_ADDRESS, "127.0.0.1");
  });
});

describe("checkComposeConfig", () => {
  const expected = {
    project: "ocw-cleanroom-abc123",
    imageTag: "cleanroom-8db72c2a1b2c-abc123",
    ports: Object.values(gatePorts(34)),
  };
  const config = (over = {}) => ({
    name: "ocw-cleanroom-abc123",
    services: {
      postgres: { image: "postgres:18", ports: [{ published: "3402", target: 5432 }] },
      api: { image: "ocw-api:cleanroom-8db72c2a1b2c-abc123", ports: [{ published: "3401", target: 4000 }] },
      web: { image: "ocw-web:cleanroom-8db72c2a1b2c-abc123", ports: [{ published: "3400", target: 3000 }] },
      caddy: { image: "caddy:2", ports: [{ published: "3443" }, { published: "3480" }] },
      ...over,
    },
  });

  it("accepts the run's project, block ports and ocw-* images, and reports them", () => {
    assert.deepEqual(checkComposeConfig(config(), expected), {
      ports: [3400, 3401, 3402, 3443, 3480],
      images: ["ocw-api:cleanroom-8db72c2a1b2c-abc123", "ocw-web:cleanroom-8db72c2a1b2c-abc123"],
    });
  });

  it("refuses another project (e.g. the demo's or a directory-derived default)", () => {
    assert.throws(() => checkComposeConfig({ ...config(), name: "t3code-81d72154" }, expected), /project/);
    assert.throws(() => checkComposeConfig({ ...config(), name: "ocw" }, expected), /project/);
  });

  it("refuses a port outside the block (the demo's 3000/4000) and an unpinned port", () => {
    assert.throws(
      () => checkComposeConfig(config({ web: { image: "x", ports: [{ published: "3000" }] } }), expected),
      /3000/,
    );
    assert.throws(
      () => checkComposeConfig(config({ api2: { ports: [{ target: 4000 }] } }), expected),
      /unpinned/,
    );
  });

  it("refuses an ocw-* image under another tag (the demo's :local) and a config that builds nothing", () => {
    assert.throws(
      () => checkComposeConfig(config({ openclaw: { image: "ocw-openclaw:local" } }), expected),
      /ocw-openclaw:local/,
    );
    assert.throws(
      () =>
        checkComposeConfig(
          { name: expected.project, services: { postgres: { image: "postgres:18" } } },
          expected,
        ),
      /no ocw-\* image/,
    );
  });
});
