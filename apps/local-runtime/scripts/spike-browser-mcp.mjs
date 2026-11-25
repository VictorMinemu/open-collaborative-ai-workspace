#!/usr/bin/env node
// 07.13-04 spike (manual tool, never run in CI): a stand-in `ocw_browser` stdio MCP server for the Codex browser-mcp
// recorder (`record-codex-fixture.ts --scenario browser-mcp`). It opens nothing: `open { url }` answers
// `Opened <host>` and `screenshot {}` answers one image content (a 1×1 JPEG). stdout carries only the MCP protocol;
// nothing is logged.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

/**
 * A 1×1 RGB baseline JPEG (JFIF, quality 90), base64. Baseline on purpose: Codex 0.172 could not process a 1×1
 * progressive grayscale JPEG and sent the model "image content omitted because it could not be processed" instead
 * (07.13-SPIKES.md A-3); Chromium's screenshots are baseline RGB JPEGs.
 */
export const ONE_PIXEL_JPEG =
  "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAAMCAgMCAgMDAwMEAwMEBQgFBQQEBQoHBwYIDAoMDAsKCwsNDhIQDQ4RDgsLEBYQERMUFRUVDA8XGBYUGBIUFRT/2wBDAQMEBAUEBQkFBQkUDQsNFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBQUFBT/wAARCAABAAEDASIAAhEBAxEB/8QAHwAAAQUBAQEBAQEAAAAAAAAAAAECAwQFBgcICQoL/8QAtRAAAgEDAwIEAwUFBAQAAAF9AQIDAAQRBRIhMUEGE1FhByJxFDKBkaEII0KxwRVS0fAkM2JyggkKFhcYGRolJicoKSo0NTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqDhIWGh4iJipKTlJWWl5iZmqKjpKWmp6ipqrKztLW2t7i5usLDxMXGx8jJytLT1NXW19jZ2uHi4+Tl5ufo6erx8vP09fb3+Pn6/8QAHwEAAwEBAQEBAQEBAQAAAAAAAAECAwQFBgcICQoL/8QAtREAAgECBAQDBAcFBAQAAQJ3AAECAxEEBSExBhJBUQdhcRMiMoEIFEKRobHBCSMzUvAVYnLRChYkNOEl8RcYGRomJygpKjU2Nzg5OkNERUZHSElKU1RVVldYWVpjZGVmZ2hpanN0dXZ3eHl6goOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4uPk5ebn6Onq8vP09fb3+Pn6/9oADAMBAAIRAxEAPwDwqiiiv3M/HD//2Q==";

const server = new McpServer({ name: "ocw_browser", version: "0.0.0-spike" });

server.registerTool(
  "open",
  {
    description: "Open a page in the session's browser (spike: nothing is opened).",
    inputSchema: { url: z.string() },
  },
  async ({ url }) => {
    let host = "an invalid URL";
    try {
      host = new URL(url).host;
    } catch {
      /* keep the placeholder */
    }
    return { content: [{ type: "text", text: `Opened ${host}` }] };
  },
);

server.registerTool(
  "screenshot",
  { description: "Take a screenshot of the open page (spike: a 1×1 JPEG).", inputSchema: {} },
  async () => ({ content: [{ type: "image", data: ONE_PIXEL_JPEG, mimeType: "image/jpeg" }] }),
);

await server.connect(new StdioServerTransport());
