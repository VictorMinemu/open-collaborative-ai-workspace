import { describe, expect, it } from "vitest";
import { checkMcpUrl } from "./url-policy";

const ok = (url: string) => expect(checkMcpUrl(url), url).toEqual({ ok: true });
const refused = (url: string) => {
  const r = checkMcpUrl(url);
  expect(r.ok, url).toBe(false);
  if (!r.ok) expect(r.reason.length, url).toBeGreaterThan(0);
};

describe("checkMcpUrl (T-03.1-09-02)", () => {
  it("accepts https anywhere public or private", () => {
    ok("https://mcp.example.com/mcp");
    ok("https://mcp.example.com:8443/v1/mcp?x=1");
    ok("https://10.0.0.5/mcp");
    ok("https://[2001:db8::1]/mcp");
  });

  it("accepts http only to single-label compose hosts and RFC 1918 IPv4 literals", () => {
    ok("http://mcp-docs:8080/mcp");
    ok("http://fake-model:18999/mcp");
    ok("http://10.1.2.3/mcp");
    ok("http://172.16.0.9:3000/sse");
    ok("http://172.31.255.1/mcp");
    ok("http://192.168.1.20/mcp");
  });

  it("refuses http to public hosts", () => {
    refused("http://example.com");
    refused("http://mcp.example.com/mcp");
    refused("http://8.8.8.8/mcp");
    refused("http://172.32.0.1/mcp");
    refused("http://[fd00::1]/mcp");
  });

  it("refuses loopback, unspecified, link-local and metadata targets on any scheme", () => {
    for (const scheme of ["http", "https"]) {
      refused(`${scheme}://localhost/mcp`);
      refused(`${scheme}://LOCALHOST./mcp`);
      refused(`${scheme}://api.localhost/mcp`);
      refused(`${scheme}://127.0.0.1/mcp`);
      refused(`${scheme}://127.1.2.3/mcp`);
      refused(`${scheme}://2130706433/mcp`); // 127.0.0.1 in decimal
      refused(`${scheme}://0.0.0.0/mcp`);
      refused(`${scheme}://169.254.169.254/latest/meta-data`);
      refused(`${scheme}://169.254.1.1/mcp`);
      refused(`${scheme}://[::1]/mcp`);
      refused(`${scheme}://[::]/mcp`);
      refused(`${scheme}://[fe80::1]/mcp`);
      refused(`${scheme}://[::ffff:127.0.0.1]/mcp`);
      refused(`${scheme}://[fd00:ec2::254]/mcp`);
      refused(`${scheme}://metadata.google.internal/computeMetadata/v1`);
      refused(`${scheme}://metadata/computeMetadata/v1`);
    }
  });

  it("refuses other schemes, credentials in the URL and garbage", () => {
    refused("ftp://mcp.example.com/mcp");
    refused("file:///etc/passwd");
    refused("ws://mcp.example.com/mcp");
    refused("https://user:pass@mcp.example.com/mcp");
    refused("https://token@mcp.example.com/mcp");
    refused("not a url");
    refused("");
  });
});
