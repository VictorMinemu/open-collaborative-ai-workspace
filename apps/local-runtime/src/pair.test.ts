import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PairingCancelledError, pairByDeviceCode } from "./pair.js";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tempHome(): string {
  const home = mkdtempSync(join(tmpdir(), "ocw-pair-"));
  dirs.push(home);
  return join(home, ".ocw");
}

const SERVER = "https://ocw.example.com";
const DEVICE_CODE = "dc_SECRET_device_code_0123456789abcdefghij";
const DEVICE_TOKEN = "dt_SECRET_device_token_9876543210";
const DEVICE_ID = "3f0c1a8e-6c55-4b8e-9d0e-0d3c6d8b9a11";
const ORG_ID = "7b3e2c51-41f4-4a3e-a5d8-9c1b2e4f6a70";

const START = {
  deviceCode: DEVICE_CODE,
  userCode: "ABCD-EFGH",
  verificationUri: "https://app.example.com/settings/devices?add=server",
  verificationUriComplete: "https://app.example.com/settings/devices?pair=ABCD-EFGH",
  expiresIn: 600,
  interval: 5,
};

const APPROVED = {
  deviceId: DEVICE_ID,
  organizationId: ORG_ID,
  deviceToken: DEVICE_TOKEN,
  name: "rack-1",
  webUrl: "https://app.example.com",
  organizationName: "Acme",
  ownerName: "Ada",
};

type Answer = { status: number; body: unknown } | Error;

const pairingError = (code: string): Answer => ({
  status: 400,
  body: { error: { code, message: code } },
});

/** A protocol-faithful fake of PD-06: one start answer, then the poll answers in order (the last one repeats). */
function fakeServer(start: Answer, polls: Answer[]) {
  const calls: Array<{ url: string; body: unknown }> = [];
  let poll = 0;
  const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body ? (JSON.parse(String(init.body)) as unknown) : null;
    calls.push({ url, body });
    const answer = url.endsWith("/api/v1/devices/pairings")
      ? start
      : (polls[Math.min(poll++, polls.length - 1)] as Answer);
    if (answer instanceof Error) throw answer;
    return new Response(JSON.stringify(answer.body), {
      status: answer.status,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;
  return { fetchFn, calls };
}

/** A virtual clock: `sleep` records the wait and advances `now`. */
function clock() {
  let now = 1_000_000;
  const sleeps: number[] = [];
  return {
    sleeps,
    now: () => now,
    sleep: async (ms: number, signal?: AbortSignal) => {
      if (signal?.aborted) throw new PairingCancelledError();
      sleeps.push(ms);
      now += ms;
    },
  };
}

function capture() {
  const lines: string[] = [];
  return { lines, out: (line: string) => lines.push(line), text: () => lines.join("\n") };
}

describe("pairByDeviceCode (07.12, D-03, PD-06)", () => {
  it("prints the link and the user code, waits 5 s, 10 s after slow_down, then saves the approved pairing", async () => {
    const home = tempHome();
    // The runtime waits `interval` before every poll: 5 s → slow_down, 10 s → pending (the slower pace stays), 10 s → 200.
    const server = fakeServer({ status: 200, body: START }, [
      pairingError("slow_down"),
      pairingError("authorization_pending"),
      { status: 200, body: APPROVED },
    ]);
    const c = clock();
    const out = capture();
    const warn = capture();

    const result = await pairByDeviceCode({
      home,
      serverUrl: `${SERVER}/`,
      name: "proposed-name",
      fetchFn: server.fetchFn,
      sleep: c.sleep,
      now: c.now,
      out: out.out,
      warn: warn.out,
    });

    expect(c.sleeps).toEqual([5_000, 10_000, 10_000]);
    expect(server.calls[0]).toMatchObject({
      url: `${SERVER}/api/v1/devices/pairings`,
      body: { name: "proposed-name", platform: process.platform },
    });
    expect((server.calls[0]?.body as { runtimeVersion?: string } | undefined)?.runtimeVersion).toBeTypeOf(
      "string",
    );
    for (const call of server.calls.slice(1)) {
      expect(call).toEqual({
        url: `${SERVER}/api/v1/devices/pairings/token`,
        body: { deviceCode: DEVICE_CODE },
      });
    }

    const printed = out.text();
    expect(printed).toContain(START.verificationUriComplete);
    expect(printed).toContain(START.verificationUri);
    expect(printed).toContain("ABCD-EFGH");
    expect(printed).toContain("expires in 10 minutes");
    expect(`${printed}\n${warn.text()}`).not.toContain(DEVICE_CODE);
    expect(`${printed}\n${warn.text()}`).not.toContain(DEVICE_TOKEN);
    expect(warn.lines).toEqual([]);

    const tokenPath = join(home, "device-token");
    expect(readFileSync(tokenPath, "utf8").trim()).toBe(DEVICE_TOKEN);
    expect(statSync(tokenPath).mode & 0o777).toBe(0o600);
    const config = JSON.parse(readFileSync(join(home, "runtime.json"), "utf8")) as Record<string, unknown>;
    expect(config).toMatchObject({
      serverUrl: SERVER,
      deviceName: "rack-1",
      deviceId: DEVICE_ID,
      webUrl: "https://app.example.com",
      pairedWith: { organization: "Acme", owner: "Ada" },
    });
    expect(typeof (config.pairedWith as { at: unknown }).at).toBe("string");
    expect(statSync(join(home, "runtime.json")).mode & 0o777).toBe(0o600);

    expect(result).toMatchObject({
      deviceId: DEVICE_ID,
      organizationId: ORG_ID,
      name: "rack-1",
      serverUrl: SERVER,
      tokenPath,
      webUrl: "https://app.example.com",
      pairedWith: { organization: "Acme", owner: "Ada" },
    });
  });

  it("keeps a path prefix on the server URL and keeps polling through a network error (a server restart)", async () => {
    const home = tempHome();
    const server = fakeServer({ status: 200, body: START }, [
      new TypeError("fetch failed"),
      { status: 502, body: { error: { message: "bad gateway" } } },
      { status: 200, body: APPROVED },
    ]);
    const c = clock();
    await pairByDeviceCode({
      home,
      serverUrl: `${SERVER}/ocw`,
      fetchFn: server.fetchFn,
      sleep: c.sleep,
      now: c.now,
      out: () => undefined,
    });
    expect(server.calls.map((call) => call.url)).toEqual([
      `${SERVER}/ocw/api/v1/devices/pairings`,
      `${SERVER}/ocw/api/v1/devices/pairings/token`,
      `${SERVER}/ocw/api/v1/devices/pairings/token`,
      `${SERVER}/ocw/api/v1/devices/pairings/token`,
    ]);
    expect(c.sleeps).toEqual([5_000, 5_000, 5_000]);
    expect(existsSync(join(home, "device-token"))).toBe(true);
  });

  it("keeps the token when an optional field of the approved answer is off-contract (LO-01)", async () => {
    // The server has already consumed the pairing: refusing the answer would lose the only copy of the token.
    const home = tempHome();
    const server = fakeServer({ status: 200, body: START }, [
      { status: 200, body: { ...APPROVED, organizationName: "x".repeat(300), webUrl: "not a url" } },
    ]);
    const c = clock();
    const result = await pairByDeviceCode({
      home,
      serverUrl: SERVER,
      name: "proposed-name",
      fetchFn: server.fetchFn,
      sleep: c.sleep,
      now: c.now,
      out: () => {},
    });
    expect(readFileSync(join(home, "device-token"), "utf8").trim()).toBe(DEVICE_TOKEN);
    expect(result).toMatchObject({ deviceId: DEVICE_ID, organizationId: ORG_ID, name: "rack-1" });
    expect(result.webUrl).toBeUndefined();
    expect(result.pairedWith).toBeUndefined();
  });

  it("an approved answer without a device token is still refused, and nothing is written", async () => {
    const home = tempHome();
    const { deviceToken: _omit, ...noToken } = APPROVED;
    const server = fakeServer({ status: 200, body: START }, [{ status: 200, body: noToken }]);
    const c = clock();
    await expect(
      pairByDeviceCode({
        home,
        serverUrl: SERVER,
        fetchFn: server.fetchFn,
        sleep: c.sleep,
        now: c.now,
        out: () => {},
      }),
    ).rejects.toThrow("its answer is not valid");
    expect(existsSync(join(home, "device-token"))).toBe(false);
  });

  it("access_denied ends with the denial line and writes nothing", async () => {
    const home = tempHome();
    const server = fakeServer({ status: 200, body: START }, [
      pairingError("authorization_pending"),
      pairingError("access_denied"),
    ]);
    const c = clock();
    await expect(
      pairByDeviceCode({
        home,
        serverUrl: SERVER,
        fetchFn: server.fetchFn,
        sleep: c.sleep,
        now: c.now,
        out: () => {},
      }),
    ).rejects.toThrow("The pairing was denied in Settings › Devices.");
    expect(existsSync(join(home, "device-token"))).toBe(false);
  });

  it("expired_token, or the deadline passing, ends with the expiry line", async () => {
    const home = tempHome();
    const expired = fakeServer({ status: 200, body: START }, [pairingError("expired_token")]);
    const c1 = clock();
    await expect(
      pairByDeviceCode({
        home,
        serverUrl: SERVER,
        fetchFn: expired.fetchFn,
        sleep: c1.sleep,
        now: c1.now,
        out: () => {},
      }),
    ).rejects.toThrow("The code expired. Run the command again.");

    const pending = fakeServer({ status: 200, body: { ...START, expiresIn: 12 } }, [
      pairingError("authorization_pending"),
    ]);
    const c2 = clock();
    await expect(
      pairByDeviceCode({
        home,
        serverUrl: SERVER,
        fetchFn: pending.fetchFn,
        sleep: c2.sleep,
        now: c2.now,
        out: () => {},
      }),
    ).rejects.toThrow("The code expired. Run the command again.");
    expect(pending.calls.length).toBeLessThanOrEqual(4);
    expect(existsSync(join(home, "device-token"))).toBe(false);
  });

  it("an aborted signal cancels the pairing and writes nothing", async () => {
    const home = tempHome();
    const server = fakeServer({ status: 200, body: START }, [pairingError("authorization_pending")]);
    const controller = new AbortController();
    const c = clock();
    let polls = 0;
    const sleep = async (ms: number, signal?: AbortSignal) => {
      if (++polls === 3) controller.abort();
      return c.sleep(ms, signal);
    };
    const err = await pairByDeviceCode({
      home,
      serverUrl: SERVER,
      fetchFn: server.fetchFn,
      sleep,
      now: c.now,
      signal: controller.signal,
      out: () => {},
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PairingCancelledError);
    expect((err as Error).message).toBe("Pairing cancelled.");
    expect(existsSync(join(home, "device-token"))).toBe(false);
    expect(existsSync(join(home, "runtime.json"))).toBe(false);
  });

  it("a start answer that is not a pairing is refused clearly, and nothing is written", async () => {
    const home = tempHome();
    const server = fakeServer({ status: 200, body: { ...START, userCode: "not-a-code" } }, []);
    const c = clock();
    await expect(
      pairByDeviceCode({
        home,
        serverUrl: SERVER,
        fetchFn: server.fetchFn,
        sleep: c.sleep,
        now: c.now,
        out: () => {},
      }),
    ).rejects.toThrow(/not a valid pairing answer/);
    expect(server.calls).toHaveLength(1);
    expect(existsSync(join(home, "runtime.json"))).toBe(false);

    const refused = fakeServer(
      { status: 429, body: { error: { message: "Too many pairing requests" } } },
      [],
    );
    await expect(
      pairByDeviceCode({
        home,
        serverUrl: SERVER,
        fetchFn: refused.fetchFn,
        sleep: c.sleep,
        now: c.now,
        out: () => {},
      }),
    ).rejects.toThrow("Too many pairing requests");
  });

  it("warns when the token would cross the network over plain http (loopback is fine)", async () => {
    for (const [url, warned] of [
      ["http://ocw.lan:4000", true],
      ["http://127.0.0.1:4000", false],
      ["http://127.8.9.10:4000", false],
      // Public DNS names that only start like a loopback address (LO-03).
      ["http://127.0.0.1.nip.io:4000", true],
      ["http://127.evil.example", true],
      ["http://localhost:4000", false],
      ["https://ocw.example.com", false],
    ] as const) {
      const home = tempHome();
      const server = fakeServer({ status: 200, body: START }, [{ status: 200, body: APPROVED }]);
      const c = clock();
      const warn = capture();
      await pairByDeviceCode({
        home,
        serverUrl: url,
        fetchFn: server.fetchFn,
        sleep: c.sleep,
        now: c.now,
        out: () => {},
        warn: warn.out,
      });
      expect(warn.text().includes("the device token will cross the network unencrypted"), url).toBe(warned);
    }
  });
});
