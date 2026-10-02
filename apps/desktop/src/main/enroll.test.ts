import { describe, expect, it } from "vitest";
import { checkServer, EnrollError, enrollDevice } from "./enroll";

function fakeFetch(handler: (url: string, init?: RequestInit) => Response | Promise<Response>) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fn = (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(url), init });
    return handler(String(url), init);
  }) as typeof fetch;
  return { fn, calls };
}

const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

describe("enrollDevice", () => {
  it("posts the B3 contract and returns the token", async () => {
    const { fn, calls } = fakeFetch(() =>
      json(201, { deviceId: "dev-1", organizationId: "org-1", deviceToken: "ocwdt_0123456789abcdef" }),
    );
    const res = await enrollDevice(
      {
        apiUrl: "http://localhost:4000",
        code: " ab12-cd34 ",
        deviceName: "Victor's Mac",
        platform: "darwin",
      },
      fn,
    );
    expect(res.deviceToken).toBe("ocwdt_0123456789abcdef");
    expect(calls[0]!.url).toBe("http://localhost:4000/api/v1/devices/enroll");
    expect(calls[0]!.init?.method).toBe("POST");
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({
      code: "ab12-cd34",
      name: "Victor's Mac",
      platform: "darwin",
    });
  });

  it("maps invalid/expired codes to a friendly error", async () => {
    for (const status of [400, 404, 410]) {
      const { fn } = fakeFetch(() => json(status, { error: "x" }));
      await expect(enrollDevice({ apiUrl: "http://a", code: "abcd", deviceName: "m" }, fn)).rejects.toThrow(
        /invalid or has expired/,
      );
    }
  });

  it("reports unreachable servers and malformed responses", async () => {
    const down = fakeFetch(() => {
      throw new TypeError("fetch failed");
    });
    await expect(
      enrollDevice({ apiUrl: "http://a", code: "abcd", deviceName: "m" }, down.fn),
    ).rejects.toThrow(/Could not reach/);
    const bad = fakeFetch(() => json(200, { deviceId: "x" }));
    await expect(
      enrollDevice({ apiUrl: "http://a", code: "abcd", deviceName: "m" }, bad.fn),
    ).rejects.toBeInstanceOf(EnrollError);
  });
});

describe("checkServer", () => {
  it("checks the web origin and the API health endpoint", async () => {
    const { fn, calls } = fakeFetch((url) =>
      url.endsWith("/health") ? json(200, { status: "ok" }) : json(307, {}),
    );
    await expect(checkServer("http://localhost:3000", "http://localhost:4000", fn)).resolves.toEqual({
      web: true,
      api: true,
      message: null,
    });
    expect(calls.map((c) => c.url).sort()).toEqual(["http://localhost:3000", "http://localhost:4000/health"]);
  });

  it("explains which side is down", async () => {
    const { fn } = fakeFetch((url) => {
      if (url.endsWith("/health")) throw new TypeError("refused");
      return json(200, {});
    });
    const res = await checkServer("http://localhost:3000", "http://localhost:4000", fn);
    expect(res.api).toBe(false);
    expect(res.message).toMatch(/API at http:\/\/localhost:4000/);
  });
});
