import type { Device, DeviceList, DeviceSignIn, ProviderAuthStatus } from "@ocw/contracts";
import { MutationObserver, QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Dialog } from "@/components/ui/panel-dialog";
import {
  cancelBotPoolSignInMutation,
  cancelDeviceSignInMutation,
  forgetSignIn,
  poolKeys,
  signInRefetchInterval,
  startBotPoolSignInMutation,
  startDeviceSignInMutation,
} from "@/lib/account-pool-queries";
import { api } from "@/lib/api";
import { wzKeys } from "@/lib/workzone-queries";
import {
  ChatgptAccountForm,
  deviceChoices,
  SignInCodeView,
  signInErrorText,
  viewOfBotSignIn,
  viewOfDeviceSignIn,
  WHERE_QUESTION,
} from "./add-chatgpt-account-dialog";

vi.mock("@/lib/api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/api")>();
  return { ...actual, api: { get: vi.fn(), post: vi.fn(), patch: vi.fn(), put: vi.fn(), del: vi.fn() } };
});

/**
 * Settings › Account pool › Add ChatGPT account (07.18-15, D-02, D-10): "For bots" signs in inside the bots runtime
 * (the Models sign-in route with `poolAccount`), "On a device" on one online server device (Codex's device code runs
 * there). Both show the same code view; the code never reaches the console and is dropped when the dialog closes.
 */

const T = "2026-11-24T09:00:00.000Z";
const NOW = Date.parse("2026-11-24T09:01:00.000Z");
const SERVER = "01a11635-d6e7-7c87-9f17-0000000000d1";
const LAPTOP = "01a11635-d6e7-7c87-9f17-0000000000d2";
const ASLEEP = "01a11635-d6e7-7c87-9f17-0000000000d3";
const GONE = "01a11635-d6e7-7c87-9f17-0000000000d4";
const FLOW = "01a11635-d6e7-7c87-9f17-0000000000f1";
const OTHER_FLOW = "01a11635-d6e7-7c87-9f17-0000000000f2";
const URL = "https://auth.openai.com/codex/device";

function device(over: Partial<Device> = {}): Device {
  return {
    id: SERVER,
    ownerUserId: "01a11635-d6e7-7c87-9f17-0000000000a1",
    ownerName: "Owen",
    name: "Build server",
    platform: "linux",
    status: "online",
    shared: true,
    fullAccessOptIn: false,
    hostKind: "service",
    shareMaxMode: "default",
    lastSeenAt: T,
    runtimes: [],
    daemonVersion: "0.12.0",
    projectCount: 1,
    revokedAt: null,
    createdAt: T,
    ...over,
  };
}

const DEVICES: Device[] = [
  device({ id: LAPTOP, name: "Ana's MacBook", hostKind: "desktop", platform: "darwin" }),
  device(),
  device({ id: ASLEEP, name: "Rack 2", status: "offline" }),
  device({ id: GONE, name: "Old box", revokedAt: T }),
];

function signIn(over: Partial<DeviceSignIn> = {}): DeviceSignIn {
  return {
    id: FLOW,
    deviceId: SERVER,
    label: "ops@acme",
    state: "pending",
    verificationUrl: URL,
    userCode: "ABCD-1234",
    expiresAt: "2026-11-24T09:15:00.000Z",
    error: null,
    accountId: null,
    startedAt: T,
    ...over,
  };
}

function botStatus(over: Partial<ProviderAuthStatus> = {}): ProviderAuthStatus {
  return {
    provider: "openai-codex",
    state: "pending",
    flowId: FLOW,
    verificationUrl: URL,
    userCode: "WXYZ-9876",
    expiresAt: "2026-11-24T09:15:00.000Z",
    startedAt: T,
    error: null,
    account: null,
    cellConnected: true,
    ...over,
  };
}

function render(node: ReactElement, qc = new QueryClient()): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={qc}>
      <Dialog open>{node}</Dialog>
    </QueryClientProvider>,
  );
}

function withDevices(): QueryClient {
  const qc = new QueryClient();
  qc.setQueryData<DeviceList>(wzKeys.devices, { devices: DEVICES });
  return qc;
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]+>/g, " ")
    .replace(/&#x27;|&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();

const tagsOf = (html: string, id: string) =>
  html.match(new RegExp(`<[a-z]+[^>]*data-testid="${id}"[^>]*>`, "g")) ?? [];

const from = (html: string, id: string) => {
  const at = html.indexOf(`data-testid="${id}"`);
  return at < 0 ? "" : html.slice(html.indexOf(">", at) + 1);
};

const CONSOLE = ["log", "info", "warn", "error", "debug"] as const;

beforeEach(() => {
  vi.mocked(api.post).mockReset();
  vi.mocked(api.del).mockReset();
  for (const m of CONSOLE) vi.spyOn(console, m);
});

afterEach(() => {
  // T-07.18-15-02: nothing in this flow writes to the console, least of all the code.
  for (const m of CONSOLE) expect(console[m]).not.toHaveBeenCalled();
  vi.restoreAllMocks();
});

describe("where the account is used (Task 3)", () => {
  it("asks for bots or a device, then a label", () => {
    const html = render(<ChatgptAccountForm onDone={() => undefined} />, withDevices());
    expect(WHERE_QUESTION).toBe("Where will this account be used?");
    expect(text(html)).toContain(WHERE_QUESTION);
    expect(text(from(html, "chatgpt-where-bots"))).toContain("For bots");
    expect(text(from(html, "chatgpt-where-bots"))).toContain("Signs in inside the bots runtime");
    expect(text(from(html, "chatgpt-where-device"))).toContain("On a device");
    expect(text(from(html, "chatgpt-where-device"))).toContain("Work Zone sessions on one server device");
    expect(tagsOf(html, "chatgpt-account-label")).toHaveLength(1);
    // Nothing to start before a label.
    expect(tagsOf(html, "chatgpt-account-start")[0]).toContain(` disabled=""`);
  });

  it("on a device lists online server devices; the others are disabled with the reason", () => {
    expect(deviceChoices(DEVICES)).toEqual([
      { id: SERVER, name: "Build server", disabled: false, reason: null },
      { id: LAPTOP, name: "Ana's MacBook", disabled: true, reason: "Not a server device" },
      { id: ASLEEP, name: "Rack 2", disabled: true, reason: "Offline" },
    ]);
    const html = render(
      <ChatgptAccountForm onDone={() => undefined} initial={{ where: "device", label: "ops@acme" }} />,
      withDevices(),
    );
    const list = text(from(html, "chatgpt-devices"));
    expect(list).toContain("Build server");
    expect(list).toContain("Not a server device");
    expect(list).toContain("Offline");
    expect(list).not.toContain("Old box");
    const laptop = html.match(new RegExp(`<input[^>]*value="${LAPTOP}"[^>]*>`))?.[0] ?? "";
    expect(laptop).toContain(` disabled=""`);
    // The one usable server is chosen, so Start is on.
    const server = html.match(new RegExp(`<input[^>]*value="${SERVER}"[^>]*>`))?.[0] ?? "";
    expect(server).toContain(` checked=""`);
    expect(tagsOf(html, "chatgpt-account-start")[0]).not.toContain(` disabled=""`);
  });

  it("says so when there is no server device", () => {
    const qc = new QueryClient();
    qc.setQueryData<DeviceList>(wzKeys.devices, { devices: [DEVICES[0] as Device] });
    const html = render(
      <ChatgptAccountForm onDone={() => undefined} initial={{ where: "device", label: "ops@acme" }} />,
      qc,
    );
    expect(text(html)).toContain("No server device is online");
    expect(tagsOf(html, "chatgpt-account-start")[0]).toContain(` disabled=""`);
  });
});

describe("the code view (Task 3)", () => {
  it("shows the link in a new tab, the code large with a copy button, and the expiry", () => {
    const view = viewOfDeviceSignIn(signIn());
    if (!view) throw new Error("no view");
    const html = render(
      <SignInCodeView
        view={view}
        where="device"
        now={NOW}
        onCancel={() => undefined}
        onRetry={() => undefined}
      />,
    );
    const link = tagsOf(html, "chatgpt-verification-url")[0] ?? "";
    expect(link).toContain(`href="${URL}"`);
    expect(link).toContain('target="_blank"');
    expect(link).toContain('rel="noopener noreferrer"');
    expect(text(from(html, "chatgpt-user-code"))).toContain("ABCD-1234");
    expect(tagsOf(html, "chatgpt-copy-code")).toHaveLength(1);
    expect(text(from(html, "chatgpt-code-expiry"))).toContain("Expires in 14:00");
    expect(tagsOf(html, "chatgpt-sign-in-cancel")).toHaveLength(1);
  });

  it("shows Connected, and an error in plain words with Try again", () => {
    const connected = viewOfDeviceSignIn(
      signIn({ state: "connected", userCode: null, verificationUrl: null }),
    );
    if (!connected) throw new Error("no view");
    const ok = render(
      <SignInCodeView view={connected} where="device" onCancel={() => undefined} onRetry={() => undefined} />,
    );
    expect(text(from(ok, "chatgpt-sign-in-connected"))).toContain("Connected");
    expect(ok).not.toContain("ABCD-1234");

    const failed = viewOfDeviceSignIn(
      signIn({ state: "error", userCode: null, error: { code: "device_offline", message: "x" } }),
    );
    if (!failed) throw new Error("no view");
    const err = render(
      <SignInCodeView view={failed} where="device" onCancel={() => undefined} onRetry={() => undefined} />,
    );
    expect(text(from(err, "chatgpt-sign-in-error"))).toContain(
      "The device went offline. Check that it's running, then try again.",
    );
    expect(text(from(err, "chatgpt-sign-in-retry"))).toContain("Try again");
  });

  it("reads every error code in plain words; failed keeps the API's sentence", () => {
    expect(signInErrorText("expired", "x", "device")).toBe("The code expired before it was used.");
    expect(signInErrorText("denied", "x", "bots")).toBe("The sign-in was declined.");
    expect(signInErrorText("cancelled", "x", "bots")).toBe("Sign-in cancelled.");
    expect(signInErrorText("runtime_too_old", "x", "device")).toBe(
      "Update the OCW runtime on this device, then try again.",
    );
    expect(signInErrorText("cell_offline", "x", "bots")).toBe(
      "The bots runtime is offline. Start it in Settings › Bots runtime, then try again.",
    );
    expect(signInErrorText("unsupported", "x", "device")).toBe("Update Codex on this device and try again.");
    expect(signInErrorText("unsupported", "x", "bots")).toBe(
      "ChatGPT doesn't allow sign-in with a code for this account.",
    );
    expect(signInErrorText("failed", "The device could not sign in.", "device")).toBe(
      "The device could not sign in.",
    );
  });

  it("bots: only the flow this dialog started is shown", () => {
    expect(viewOfBotSignIn(botStatus(), FLOW)?.userCode).toBe("WXYZ-9876");
    expect(viewOfBotSignIn(botStatus({ flowId: OTHER_FLOW }), FLOW)).toBeNull();
    expect(viewOfBotSignIn(botStatus({ state: "connected" }), FLOW)?.state).toBe("connected");
    expect(viewOfBotSignIn(botStatus({ state: "idle", flowId: null }), FLOW)).toBeNull();
    expect(viewOfBotSignIn(null, FLOW)).toBeNull();
  });
});

describe("the sign-in routes (Task 3)", () => {
  it("for bots starts the Models sign-in with poolAccount, and Try again restarts it", async () => {
    vi.mocked(api.post).mockResolvedValue(botStatus({ state: "starting", userCode: null }));
    const qc = new QueryClient();
    await new MutationObserver(qc, startBotPoolSignInMutation(qc)).mutate({ label: "bots@acme" });
    await new MutationObserver(qc, startBotPoolSignInMutation(qc)).mutate({
      label: "bots@acme",
      restart: true,
    });
    const [path, opts] = vi.mocked(api.post).mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/model-providers/openai-codex/auth");
    expect((opts as { body: unknown }).body).toEqual({ poolAccount: { label: "bots@acme" } });
    const [, retry] = vi.mocked(api.post).mock.calls[1] ?? [];
    expect((retry as { body: unknown }).body).toEqual({
      poolAccount: { label: "bots@acme" },
      restart: true,
    });
    expect(qc.getQueryData(poolKeys.botSignIn)).toMatchObject({ flowId: FLOW });
  });

  it("on a device starts and cancels the device sign-in", async () => {
    vi.mocked(api.post).mockResolvedValue(
      signIn({ state: "starting", userCode: null, verificationUrl: null }),
    );
    vi.mocked(api.del).mockResolvedValue(null);
    const qc = new QueryClient();
    await new MutationObserver(qc, startDeviceSignInMutation(qc)).mutate({
      deviceId: SERVER,
      label: "ops@acme",
    });
    const [path, opts] = vi.mocked(api.post).mock.calls[0] ?? [];
    expect(path).toBe("/api/v1/account-pool/chatgpt/device-sign-ins");
    expect((opts as { body: unknown }).body).toEqual({ deviceId: SERVER, label: "ops@acme" });
    expect(qc.getQueryData(poolKeys.deviceSignIn(SERVER))).toMatchObject({ id: FLOW });

    await new MutationObserver(qc, cancelDeviceSignInMutation(qc)).mutate(SERVER);
    expect(vi.mocked(api.del).mock.calls[0]?.[0]).toBe(
      `/api/v1/account-pool/chatgpt/device-sign-ins/current?deviceId=${SERVER}`,
    );
  });

  it("for bots cancels through the Models sign-in route", async () => {
    vi.mocked(api.del).mockResolvedValue(
      botStatus({ state: "error", error: { code: "cancelled", message: "" } }),
    );
    const qc = new QueryClient();
    await new MutationObserver(qc, cancelBotPoolSignInMutation(qc)).mutate();
    expect(vi.mocked(api.del).mock.calls[0]?.[0]).toBe("/api/v1/model-providers/openai-codex/auth");
  });

  it("polls every 2 s while starting or pending, and stops otherwise", () => {
    expect(signInRefetchInterval("starting")).toBe(2000);
    expect(signInRefetchInterval("pending")).toBe(2000);
    expect(signInRefetchInterval("connected")).toBe(false);
    expect(signInRefetchInterval("error")).toBe(false);
    expect(signInRefetchInterval(undefined)).toBe(false);
  });

  it("closing the dialog drops the code from the cache", () => {
    const qc = new QueryClient();
    qc.setQueryData(poolKeys.deviceSignIn(SERVER), signIn());
    qc.setQueryData(poolKeys.botSignIn, botStatus());
    forgetSignIn(qc, SERVER);
    expect(qc.getQueryData(poolKeys.deviceSignIn(SERVER))).toBeUndefined();
    expect(qc.getQueryData(poolKeys.botSignIn)).toBeUndefined();
  });
});
