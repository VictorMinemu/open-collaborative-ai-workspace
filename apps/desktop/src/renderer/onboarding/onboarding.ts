// Onboarding page logic (bundled local renderer, talks to main only via window.ocwOnboarding).

import type { DesktopStatus, RuntimeInfo } from "../../shared/ipc";

interface Defaults {
  webUrl: string;
  apiUrl: string;
  deviceName: string;
  paired: boolean;
}
interface CheckResult {
  ok: boolean;
  webUrl?: string;
  apiUrl?: string;
  message: string | null;
}
interface EnrollResult {
  ok: boolean;
  message?: string;
}

interface OnboardingApi {
  defaults(): Promise<Defaults>;
  status(): Promise<DesktopStatus>;
  checkServer(input: { webUrl: string; apiUrl?: string }): Promise<CheckResult>;
  enroll(input: { webUrl: string; apiUrl: string; code: string; deviceName: string }): Promise<EnrollResult>;
  finish(skipPairing: boolean): Promise<unknown>;
  onStatus(cb: (s: DesktopStatus) => void): void;
}

const api = (window as unknown as { ocwOnboarding: OnboardingApi }).ocwOnboarding;

type Step = "server" | "pair" | "done";

function $(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`missing #${id}`);
  return el;
}
const input = (id: string) => $(id) as HTMLInputElement;
const button = (id: string) => $(id) as HTMLButtonElement;

let webUrl = "";
let apiUrl = "";
let apiTouched = false;
let skipped = false;

function show(step: Step): void {
  const order: Step[] = ["server", "pair", "done"];
  for (const s of order) {
    const section = document.querySelector<HTMLElement>(`[data-step="${s}"]`);
    if (section) section.hidden = s !== step;
    const dot = document.querySelector<HTMLElement>(`[data-step-dot="${s}"]`);
    dot?.classList.toggle("active", s === step);
    dot?.classList.toggle("done", order.indexOf(s) < order.indexOf(step));
  }
  const focus: Record<Step, string> = { server: "web-url", pair: "code", done: "open-workspace" };
  requestAnimationFrame(() => $(focus[step]).focus());
}

function setError(id: string, message: string | null, field?: HTMLInputElement): void {
  const el = $(id);
  el.textContent = message ?? "";
  el.hidden = !message;
  if (field) field.setAttribute("aria-invalid", message ? "true" : "false");
}

function busy(btn: HTMLButtonElement, on: boolean): void {
  btn.disabled = on;
  btn.classList.toggle("busy", on);
}

/** Mirror of the main-process derivation, for the live hint only (main re-derives). */
function guessApi(web: string): string {
  try {
    const u = new URL(/^[a-z]+:\/\//i.test(web) ? web : `http://${web}`);
    if (u.port === "3000") u.port = "4000";
    return u.origin;
  } catch {
    return "";
  }
}

function runtimeState(r: RuntimeInfo | undefined): { tone: string; text: string } {
  if (!r) return { tone: "off", text: "Checking…" };
  if (!r.installed) return { tone: "off", text: "Not installed" };
  if (!r.loggedIn) return { tone: "warn", text: "Installed · sign in required" };
  return { tone: "ok", text: r.version ? `Ready · v${r.version}` : "Ready" };
}

function renderStatus(s: DesktopStatus): void {
  const set = (key: string, tone: string, text: string) => {
    const li = document.querySelector<HTMLElement>(`[data-check="${key}"]`);
    if (!li) return;
    li.dataset.tone = tone;
    const state = li.querySelector(".state");
    if (state) state.textContent = text;
  };
  const runtimeTone =
    s.state === "online"
      ? "ok"
      : s.state === "connecting"
        ? "warn"
        : s.state === "needs_pairing"
          ? "warn"
          : "off";
  const runtimeText =
    s.state === "online" ? "Online" : s.state === "connecting" ? "Running · connecting to server" : s.label;
  set("runtime", runtimeTone, runtimeText);
  const reported = s.runtimes.length > 0;
  for (const id of ["claude-code", "codex"]) {
    const r = s.runtimes.find((x) => x.id === id);
    const st = reported ? runtimeState(r) : { tone: "off", text: "Checking…" };
    set(id, st.tone, st.text);
  }
}

async function onServerSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const btn = button("server-submit");
  busy(btn, true);
  setError("server-error", null, input("web-url"));
  try {
    const typedApi = input("api-url").value.trim();
    const res = await api.checkServer({
      webUrl: input("web-url").value,
      ...(apiTouched && typedApi ? { apiUrl: typedApi } : {}),
    });
    if (!res.ok || !res.webUrl || !res.apiUrl) {
      setError("server-error", res.message ?? "Could not reach that server.", input("web-url"));
      return;
    }
    webUrl = res.webUrl;
    apiUrl = res.apiUrl;
    show("pair");
  } finally {
    busy(btn, false);
  }
}

async function onPairSubmit(e: Event): Promise<void> {
  e.preventDefault();
  const code = input("code").value.trim();
  const deviceName = input("device-name").value.trim();
  if (code.length < 4)
    return setError("pair-error", "Enter the pairing code from the Devices page.", input("code"));
  if (!deviceName) return setError("pair-error", "Give this computer a name.", input("device-name"));
  const btn = button("pair-submit");
  busy(btn, true);
  setError("pair-error", null, input("code"));
  try {
    const res = await api.enroll({ webUrl, apiUrl, code, deviceName });
    if (!res.ok) {
      setError("pair-error", res.message ?? "Pairing failed.", input("code"));
      return;
    }
    skipped = false;
    $("done-title").textContent = `${deviceName} is paired`;
    show("done");
    renderStatus(await api.status());
  } catch {
    setError("pair-error", "Pairing failed. Check the code and try again.", input("code"));
  } finally {
    busy(btn, false);
  }
}

async function init(): Promise<void> {
  const d = await api.defaults();
  input("web-url").value = d.webUrl;
  input("api-url").value = d.apiUrl;
  input("device-name").value = d.deviceName;

  input("web-url").addEventListener("input", () => {
    setError("server-error", null, input("web-url"));
    if (!apiTouched) input("api-url").value = guessApi(input("web-url").value.trim());
  });
  input("api-url").addEventListener("input", () => {
    apiTouched = true;
  });
  input("code").addEventListener("input", () => setError("pair-error", null, input("code")));
  $("server-form").addEventListener("submit", (e) => void onServerSubmit(e));
  $("pair-form").addEventListener("submit", (e) => void onPairSubmit(e));
  button("pair-back").addEventListener("click", () => show("server"));
  button("pair-skip").addEventListener("click", () => {
    skipped = true;
    $("done-title").textContent = "You can pair later";
    $("done-lead").textContent =
      "Chat and bots work right away. Pair this computer from the menu bar when you want to run Work Zone sessions here.";
    show("done");
    void api.status().then(renderStatus);
  });
  button("open-workspace").addEventListener("click", () => void api.finish(skipped));
  api.onStatus(renderStatus);

  if (d.paired) {
    // Re-opened from the menu while already paired: start at the server step, ready to re-pair.
    $("done-title").textContent = `${d.deviceName} is paired`;
  }
  show("server");
}

void init();
