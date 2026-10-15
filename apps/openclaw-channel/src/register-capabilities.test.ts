import { describe, expect, it, vi } from "vitest";
import { registerCapabilities } from "./register-capabilities.js";
import { createToolGuard, TOOL_GATE_PRIORITY, TOOL_PIN_PRIORITY } from "./tool-guard.js";

vi.mock(
  "openclaw/plugin-sdk/channel-core",
  async () => (await import("./testing/openclaw-host.js")).channelCoreModule,
);

describe("registerCapabilities", () => {
  it("logs once per mode where the gate and the 07.5 params pin are wired, with their priorities (real-cell smoke)", () => {
    const info = vi.fn();
    const api = { registrationMode: "discovery-log-test", on: vi.fn(), logger: { info } };
    const guard = createToolGuard({ client: () => null });
    registerCapabilities(api as never, guard);
    registerCapabilities(api as never, guard);
    expect(info.mock.calls).toEqual([
      [
        `[ocw] tool gate registered (discovery-log-test registry; gate priority ${TOOL_GATE_PRIORITY}, params pin priority ${TOOL_PIN_PRIORITY})`,
      ],
    ]);
  });
});
