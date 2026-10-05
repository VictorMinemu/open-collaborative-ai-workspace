// TEST FIXTURE ONLY (infra/openclaw/test, never shipped): the community plugin the marketplace smoke installs into the
// real cell (03.1-12, BOT-10). One tool, `ocw_echo`, that answers `echo <text>`. No dependencies, no network, no hooks.
import { definePluginEntry } from "openclaw/plugin-sdk/plugin-entry";

export default definePluginEntry({
  id: "ocw-echo",
  name: "OCW Echo (test fixture)",
  description: "Test fixture for the OCW marketplace smoke: one tool that echoes its input.",
  register(api) {
    api.registerTool({
      name: "ocw_echo",
      label: "Echo",
      description: "Echo the given text back, prefixed with 'echo'.",
      parameters: {
        type: "object",
        additionalProperties: false,
        properties: { text: { type: "string", maxLength: 200, description: "Text to echo." } },
        required: ["text"],
      },
      async execute(_id, params) {
        const text = `echo ${typeof params?.text === "string" ? params.text.slice(0, 200) : ""}`;
        return { content: [{ type: "text", text }], details: { text } };
      },
    });
  },
});
