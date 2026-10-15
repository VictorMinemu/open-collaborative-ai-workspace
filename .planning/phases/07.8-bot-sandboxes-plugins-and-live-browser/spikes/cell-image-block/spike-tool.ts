// Spike (ii), 07.8-03: a throwaway plugin tool that returns an image block next to a text block. run.sh copies this
// file into a SCRATCH copy of apps/openclaw-channel/src (outside the repository), registers it from register-full.ts
// and bakes the cell image ocw-openclaw:spike-078. Never part of the product plugin.
import type { OpenClawAgentTool, OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";

export const SPIKE_IMAGE_TOOL = "ocw_spike_image";

// A valid 1×1 PNG (one opaque red pixel).
export const SPIKE_PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==";

// OpenClaw's AgentToolResult content is `(TextContent | ImageContent)[]` with ImageContent = `{ type: "image", data:
// <base64>, mimeType }`; our narrowed openclaw-sdk.d.ts only declares text, so the result is cast here (spike only).
type SpikeResult = Awaited<ReturnType<OpenClawAgentTool["execute"]>>;

export function registerSpikeImageTool(api: OpenClawPluginApi): void {
  api.registerTool(
    (): OpenClawAgentTool => ({
      name: SPIKE_IMAGE_TOOL,
      label: "Spike screenshot",
      description: "Spike 07.8-03: returns a screenshot of the current page (a 1x1 PNG) and a caption.",
      parameters: { type: "object", additionalProperties: false, properties: {} },
      async execute() {
        return {
          content: [
            { type: "text", text: "spike-078 caption: screenshot attached" },
            { type: "image", data: SPIKE_PNG_BASE64, mimeType: "image/png" },
          ],
          details: { ok: true },
        } as unknown as SpikeResult;
      },
    }),
    { name: SPIKE_IMAGE_TOOL },
  );
}
