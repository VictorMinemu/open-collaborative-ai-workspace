import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  type APIRequestContext,
  type BrowserContext,
  expect,
  type Locator,
  type Page,
  type Route,
  test,
} from "@playwright/test";
import { MODULE_CATALOG } from "../../packages/contracts/src/module-access.ts";
import { expectNoSeriousA11y } from "../support/a11y";
import { type Actor, apiAs, BASE_URL, ensureMember, openAs, SAM } from "../support/actors";
import { freshPersonalBot, freshTeamBot, openTeamBotSheet } from "../support/bot-tools";
import {
  captureReview,
  expectNoSidewaysScroll,
  expectTouchTargets,
  unnamedControls,
} from "../support/layout";
import { putMemoryFile } from "../support/memory";
import {
  enableBotSandbox,
  enableSandboxOrg,
  fakeSandboxd,
  killSwitch,
  organizationOf,
  resume,
  type SandboxTarget,
} from "../support/sandbox";
import { ADMIN } from "./env";

/**
 * The bot page's Sandbox tab (07.8-15; SBX-05, D-04, D-12, UI-SPEC Surface 3, R4, R11). A person who configures a bot
 * sees its sandbox: the status card, the lazy file tree and a plain-text preview, against the real API and the fake
 * sandboxd (`scripts/e2e-isolated.sh` mounts it at `/__sandboxd`; the spec seeds files and events through its controls).
 * Upload (conflicts, the 50 MB limit), download (the exact bytes), delete, restart and stop work end to end; disk full,
 * the kill switch and a file the bot changed show their fixed sentences. Someone who may not configure the bot sees no
 * Sandbox tab, and `?tab=sandbox` shows Memory. The Capabilities panel has the per-bot Sandbox and Browser switches.
 * Every screen passes axe in light and dark, 44 px targets and no sideways scroll at 390, and the UI-SPEC review
 * screenshots (`bot-sandbox-*`) are captured when OCW_E2E_SCREENSHOT_DIR is set.
 *
 * The memory tree backstop (R4): the 07.2 tree rows moved into a shared `TreeRowView`. With
 * `OCW_E2E_TREE_BASELINE=<dir>`, the agent page's memory tree of a fixed bot is captured at this width in light and
 * dark; the first run writes the PNGs (on the commit before the extraction), every later run must produce the same
 * bytes. Without the variable the test still checks the tree renders.
 */

test.describe.configure({ mode: "serial" });

const SCOUT = "Scout";
const EMPTY_BOT = "Tidy";
const CAPS_BOT = "Sandbox switch";
const TREELINE = "Treeline";
const Q3 = "month,revenue\njul,1200\naug,1450\nsep,1610\n";
const Q3_NEW = "month,revenue\njul,1200\naug,1450\nsep,1610\noct,1702\n";
const SUMMARY = "# Q3 summary\n\nRevenue grew every month.\n";
const NOTES = "Ask finance for the September close.\n";
const FETCH = "import csv\nprint('fetch')\n";
const ORDERS = "id,amount\n1,1250\n2,980\n";
const MIB = 1024 * 1024;

let admin: APIRequestContext;
let orgId: string;
let samId: string;
const open: BrowserContext[] = [];
/** Scout, shared by the tracer and the file and lifecycle tests of one project. */
let scout: { id: string; target: SandboxTarget } | null = null;

test.beforeAll(async () => {
  admin = await apiAs(ADMIN);
  samId = await ensureMember(admin, SAM, "developer");
  orgId = await organizationOf(admin);
  await enableSandboxOrg(admin);
  // A kill left by another spec would hide the running state.
  await resume(admin);
});

test.afterAll(async () => {
  for (const c of open.splice(0)) await c.close();
  await enableSandboxOrg(admin, true);
  await resume(admin);
  await admin?.dispose();
});

async function signIn(browser: Parameters<typeof openAs>[0], project: string, who: Actor = ADMIN) {
  const s = await openAs(browser, who, project);
  open.push(s.context);
  return s.page;
}

const widthOf = (project: string) => (project === "mobile" ? "390" : "1440");

/** A team bot with its Sandbox switch on and a running sandbox holding a few files. */
async function botWithFiles(name: string): Promise<{ id: string; target: SandboxTarget }> {
  const id = await freshTeamBot(admin, name);
  await enableBotSandbox(admin, id, { sandbox: true });
  const target = { orgId, agentId: id };
  const fake = fakeSandboxd();
  await fake.seedFile(target, "reports/q3.csv", Q3);
  await fake.seedFile(target, "reports/summary.md", SUMMARY);
  await fake.seedFile(target, "scripts/fetch.py", FETCH);
  await fake.seedFile(target, "notes.txt", NOTES);
  await fake.seedFile(target, ".env.example", "TOKEN=\n");
  // Disk and CPU as sandboxd reports them (the API mirrors usage events).
  await fake.emit({ type: "usage", target, cpuMs: 12 * 60_000, diskBytes: 1_503_238_554 });
  return { id, target };
}

const tabs = (page: Page) => page.getByRole("tablist");
const row = (page: Page, path: string) => page.getByTestId(`sandbox-row-${path}`);

async function openSandbox(page: Page, id: string) {
  await page.goto(`${BASE_URL}/bots/${id}?tab=sandbox`);
  await expect(page.getByTestId("agent-tab-sandbox")).toHaveAttribute("aria-selected", "true");
  await expect(page.getByTestId("sandbox-status")).toBeVisible({ timeout: 15_000 });
  await expect(page.getByTestId("sandbox-tree")).toBeVisible();
}

/** Opens a file: the preview pane from 1024 px, the file sheet on phones. Returns where the preview is. */
async function openFile(page: Page, path: string, mobile: boolean): Promise<Locator> {
  await row(page, path).click();
  const where = mobile ? page.getByTestId("sandbox-file-sheet") : page.getByTestId("sandbox-file-pane");
  await expect(where).toBeVisible();
  await expect(where.getByTestId("sandbox-preview")).toBeVisible();
  return where;
}

/** axe (light and dark), named controls, no sideways scroll, 44 px targets below 1024. */
async function checkScreen(page: Page, selector: string, label: string) {
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await expectNoSeriousA11y(page, selector);
    expect.soft(await unnamedControls(page), `${label} (${theme}): unnamed controls`).toEqual([]);
    await expectNoSidewaysScroll(page, `${label} ${theme}`);
  }
  await page.emulateMedia({ colorScheme: "light" });
  await expectTouchTargets(page, selector);
}

/** Reloads until the status card shows `state` (the API mirrors sandboxd's events as they arrive). */
async function reloadUntil(page: Page, state: string) {
  await expect
    .poll(
      async () => {
        await page.reload();
        const card = page.getByTestId("sandbox-status");
        await card.waitFor();
        return card.getAttribute("data-status");
      },
      { timeout: 15_000 },
    )
    .toBe(state);
}

test("the memory tree renders the same pixels after its rows moved to TreeRowView (R4 backstop)", async ({
  browser,
}, info) => {
  const id = await freshTeamBot(admin, TREELINE);
  const scope = await admin.post("/api/v1/memory/scopes", { data: { kind: "agent", agentId: id } });
  expect(scope.ok(), "ensure Treeline's notebook").toBe(true);
  const scopeId = ((await scope.json()) as { id: string }).id;
  await putMemoryFile(admin, scopeId, "MEMORY.md", "# Treeline\n\nKeeps the row backstop steady.\n");
  await putMemoryFile(admin, scopeId, "suppliers/pumps.md", "# Pumps\n");
  await putMemoryFile(admin, scopeId, "suppliers/deep/valves.md", "# Valves\n");
  await putMemoryFile(admin, scopeId, "zeta.md", "# Zeta\n");

  const page = await signIn(browser, info.project.name);
  await page.goto(`${BASE_URL}/bots/${id}`);
  const tree = page.getByRole("tree", { name: `${TREELINE} memory files` });
  await expect(tree.getByRole("treeitem", { name: "MEMORY.md", exact: true })).toBeVisible();
  await tree.getByRole("treeitem", { name: "suppliers, folder", exact: true }).click();
  await tree.getByRole("treeitem", { name: "deep, folder", exact: true }).click();
  await expect(tree.getByRole("treeitem", { name: "valves.md", exact: true })).toBeVisible();
  // A keyboard-focused row (the focus ring) next to the selected one.
  await tree.getByRole("treeitem", { name: "zeta.md", exact: true }).focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowDown");
  const viewport = page.viewportSize();
  if (viewport) await page.mouse.move(viewport.width - 4, viewport.height - 4);

  const dir = process.env.OCW_E2E_TREE_BASELINE;
  for (const theme of ["light", "dark"] as const) {
    await page.emulateMedia({ colorScheme: theme });
    await page.waitForTimeout(300);
    const png = await tree.screenshot({ animations: "disabled", caret: "hide" });
    if (!dir) continue;
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `memory-tree-${widthOf(info.project.name)}-${theme}.png`);
    if (!existsSync(file)) {
      writeFileSync(file, png);
      continue;
    }
    expect(png.equals(readFileSync(file)), `${file}: identical pixels`).toBe(true);
  }
  await page.emulateMedia({ colorScheme: "light" });
});

test("a configurer opens the Sandbox tab and previews a file the bot wrote; others never see the tab", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  scout = await botWithFiles(SCOUT);
  const page = await signIn(browser, info.project.name);
  await openSandbox(page, scout.id);

  const status = page.getByTestId("sandbox-status");
  await expect(status).toHaveAttribute("data-status", "running", { timeout: 15_000 });
  await expect(status.getByRole("status")).toHaveAccessibleName("Status: Running");
  // The fake's events carry no runtime: the card never claims more isolation than the API reports.
  await expect(page.getByTestId("sandbox-isolation")).toHaveText("Hardened container · weaker isolation");
  await expect(page.getByTestId("sandbox-disk")).toContainText("1.4 GB of 2 GB");
  await expect(page.getByTestId("sandbox-cpu")).toContainText("12 min");
  await expect(page.getByTestId("sandbox-limits")).toContainText("Stops after 15 min without use");
  await expect(page.getByTestId("sandbox-team-notice")).toBeVisible();
  await expect(status.getByRole("progressbar", { name: "Disk used" })).toBeVisible();

  const tree = page.getByRole("tree", { name: `Files in ${SCOUT}'s sandbox` });
  await expect(tree).toBeVisible();
  // Folders first, then files; dot files are listed (muted).
  await expect(tree.getByRole("treeitem")).toHaveText([
    /^reports/,
    /^scripts/,
    /^\.env\.example/,
    /^notes\.txt/,
  ]);
  await row(page, "reports").click();
  const q3 = row(page, "reports/q3.csv");
  await expect(q3).toBeVisible();
  await expect(q3).toHaveAccessibleName(`q3.csv, ${Q3.length} B`);
  if (!mobile) await captureReview(page, "bot-sandbox-hardened-1440");
  const where = await openFile(page, "reports/q3.csv", mobile);
  await expect(where.getByTestId("sandbox-preview").locator("pre")).toContainText("month,revenue");
  await expect(where.getByRole("region", { name: "Preview of q3.csv" })).toBeVisible();

  // Sam reads the bot but may not configure it: no Sandbox tab, and the deep link shows Memory.
  const sam = await signIn(browser, info.project.name, SAM);
  await sam.goto(`${BASE_URL}/bots/${scout.id}?tab=sandbox`);
  await expect(sam.getByTestId("agent-page")).toBeVisible();
  await expect(tabs(sam).getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
  await expect(sam.getByTestId("agent-tab-sandbox")).toHaveCount(0);
});

test("files: a changed file asks to reload, upload with a conflict and the 50 MB limit, download the exact bytes, delete", async ({
  browser,
}, info) => {
  test.setTimeout(120_000);
  if (!scout) throw new Error("the tracer test creates Scout");
  const mobile = info.project.name === "mobile";
  const w = widthOf(info.project.name);
  const fake = fakeSandboxd();
  const page = await signIn(browser, info.project.name);
  await openSandbox(page, scout.id);
  await row(page, "reports").click();

  // The bot writes a new version while it is open: a reload line, never a silent swap (refresh every 10 s).
  let where = await openFile(page, "reports/q3.csv", mobile);
  if (mobile) {
    await checkScreen(page, '[data-testid="sandbox-file-sheet"]', "file sheet");
    await captureReview(page, "bot-sandbox-file-390");
  } else {
    await checkScreen(page, '[data-testid="sandbox-files"]', "files");
  }
  await fake.seedFile(scout.target, "reports/q3.csv", Q3_NEW);
  await expect(where.getByTestId("sandbox-preview-changed")).toContainText("This file changed. Reload", {
    timeout: 15_000,
  });
  await expect(where.getByTestId("sandbox-preview").locator("pre")).not.toContainText("oct,1702");
  await where.getByRole("button", { name: "Reload" }).click();
  await expect(where.getByTestId("sandbox-preview").locator("pre")).toContainText("oct,1702");

  // Download: the API's attachment, byte for byte.
  const downloading = page.waitForEvent("download");
  await where.getByTestId("sandbox-download").click();
  const download = await downloading;
  expect(download.suggestedFilename()).toBe("q3.csv");
  expect(readFileSync(await download.path()).toString("utf8")).toBe(Q3_NEW);
  if (mobile) {
    await page.getByRole("button", { name: "Close file" }).click();
    await expect(page.getByTestId("sandbox-file-sheet")).toHaveCount(0);
  }

  // Upload into the focused folder: a progress row while it runs, a conflict that asks Replace / Skip.
  await row(page, "reports").focus();
  await page.getByTestId("sandbox-upload").click();
  let dialog = page.getByTestId("upload-dialog");
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole("heading", { name: "Upload to reports/" })).toBeVisible();
  await expect(dialog).toContainText(`Files go into ${SCOUT}'s sandbox. ${SCOUT} can read and change them.`);
  await expect(dialog).toContainText("Up to 50 MB each · ");
  // Files on disk (Playwright refuses to mix paths and buffers; a 51 MB buffer is over its own limit).
  const dir = info.outputPath("upload");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "orders.csv"), ORDERS);
  writeFileSync(join(dir, "q3.csv"), Q3);
  writeFileSync(join(dir, "big.bin"), Buffer.alloc(51 * MIB, 1));
  await dialog
    .getByTestId("upload-input")
    .setInputFiles([join(dir, "orders.csv"), join(dir, "q3.csv"), join(dir, "big.bin")]);
  const rows = dialog.getByTestId("upload-row");
  await expect(rows).toHaveCount(3);
  await expect(rows.filter({ hasText: "big.bin" })).toContainText("Over 50 MB");
  await expect(rows.filter({ hasText: "q3.csv" })).toContainText("q3.csv already exists.");
  await expect(dialog.getByTestId("upload-submit")).toHaveText("Upload 1");

  // Hold the upload on the wire: a progress row next to the conflict and the refused file, and "Stop uploading".
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Released only after "Stop uploading": the held request is aborted, never sent to the API.
  let aborted: Promise<void> = Promise.resolve();
  const hold = (route: Route) => {
    aborted = held.then(() => route.abort().catch(() => undefined));
    return aborted;
  };
  const uploads = (url: URL) => url.pathname.endsWith("/sandbox/files/upload");
  await page.route(uploads, hold);
  await dialog.getByTestId("upload-submit").click();
  await expect(rows.filter({ hasText: "orders.csv" }).getByRole("progressbar")).toBeVisible();
  await expect(rows.filter({ hasText: "q3.csv" })).toContainText("q3.csv already exists.");
  await expect(dialog.getByTestId("upload-cancel")).toHaveText("Stop uploading");
  await checkScreen(page, '[data-testid="upload-dialog"]', "upload dialog");
  await captureReview(page, `bot-sandbox-upload-${w}`);
  await dialog.getByTestId("upload-cancel").click();
  await expect(dialog.getByTestId("upload-cancel")).toHaveText("Cancel");
  await expect(rows.filter({ hasText: "orders.csv" }).getByRole("progressbar")).toHaveCount(0);
  release();
  // Unrouting first would let Playwright send the held request on.
  await aborted;
  await page.unroute(uploads, hold);

  await rows.filter({ hasText: "q3.csv" }).getByRole("button", { name: "Replace" }).click();
  await expect(dialog.getByTestId("upload-submit")).toHaveText("Upload 2");
  await dialog.getByTestId("upload-submit").click();
  await expect(page.getByText("2 files uploaded to reports")).toBeVisible({ timeout: 15_000 });
  await expect(dialog).toHaveCount(0);
  await expect(row(page, "reports/orders.csv")).toBeVisible();
  if (!mobile) {
    // From 1024 px the first uploaded file opens.
    await expect(
      page.getByTestId("sandbox-file-pane").getByRole("heading", { name: "orders.csv" }),
    ).toBeVisible();
  }
  const download2 = await (
    await admin.get(`/api/v1/agents/${scout.id}/sandbox/files/download?path=reports%2Fq3.csv`)
  ).text();
  expect(download2, "Replace overwrote q3.csv").toBe(Q3);

  // Delete from the preview: a confirmation that opens on Cancel, then the toast, and the row is gone.
  where = await openFile(page, "reports/q3.csv", mobile);
  await where.getByTestId("sandbox-delete").click();
  dialog = page.getByTestId("sandbox-delete-dialog");
  await expect(dialog.getByRole("heading", { name: "Delete q3.csv?" })).toBeVisible();
  await expect(dialog).toContainText(`It's removed from ${SCOUT}'s sandbox. This can't be undone.`);
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  await dialog.getByTestId("sandbox-delete-confirm").click();
  await expect(page.getByText("q3.csv deleted")).toBeVisible();
  await expect(row(page, "reports/q3.csv")).toHaveCount(0);

  // A folder asks with its file count (Delete on the focused row).
  await row(page, "scripts").focus();
  await page.keyboard.press("Delete");
  dialog = page.getByTestId("sandbox-delete-dialog");
  await expect(dialog.getByRole("heading", { name: "Delete scripts and everything in it?" })).toBeVisible();
  await expect(dialog).toContainText(`1 file is removed from ${SCOUT}'s sandbox. This can't be undone.`);
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toHaveCount(0);
});

test("lifecycle: restart and stop with confirmations, disk full and the kill switch say why nothing runs", async ({
  browser,
}, info) => {
  if (!scout) throw new Error("the tracer test creates Scout");
  const mobile = info.project.name === "mobile";
  const fake = fakeSandboxd();
  const page = await signIn(browser, info.project.name);
  await openSandbox(page, scout.id);
  const status = page.getByTestId("sandbox-status");
  await expect(status).toHaveAttribute("data-status", "running");

  await page.getByTestId("sandbox-restart").click();
  let dialog = page.getByTestId("sandbox-restart-dialog");
  await expect(dialog.getByRole("heading", { name: `Restart ${SCOUT}'s sandbox?` })).toBeVisible();
  await dialog.getByTestId("sandbox-restart-confirm").click();
  await expect(page.getByText(`${SCOUT}'s sandbox restarted`)).toBeVisible();
  // The restart went through the API, which records the runtime sandboxd reported (gVisor in the fake).
  await expect(page.getByTestId("sandbox-isolation")).toHaveText("Isolated with gVisor");
  await row(page, "reports").click();
  if (!mobile) {
    await openFile(page, "reports/summary.md", false);
    await checkScreen(page, '[data-testid="sandbox-status"]', "status");
    await captureReview(page, "bot-sandbox-1440");
  } else {
    await openFile(page, "reports/summary.md", true);
    await page.getByRole("button", { name: "Close file" }).click();
    // The file stays selected in the tree after the sheet closes.
    await expect(row(page, "reports/summary.md")).toHaveAttribute("aria-current", "page");
    await checkScreen(page, '[data-testid="sandbox-tab"]', "sandbox tab");
    await page.getByTestId("sandbox-tab").evaluate((el) => el.scrollTo(0, 0));
    await captureReview(page, "bot-sandbox-390");
  }

  await page.getByTestId("sandbox-stop").click();
  dialog = page.getByTestId("sandbox-stop-dialog");
  await expect(dialog.getByRole("heading", { name: `Stop ${SCOUT}'s sandbox?` })).toBeVisible();
  await expect(dialog).toContainText(
    `Running commands end now. Files in /workspace stay. It starts again the next time ${SCOUT} needs it.`,
  );
  await expect(dialog.getByRole("button", { name: "Cancel" })).toBeFocused();
  if (mobile) {
    await checkScreen(page, '[data-testid="sandbox-stop-dialog"]', "stop dialog");
    await captureReview(page, "bot-sandbox-stop-dialog-390");
  }
  await dialog.getByTestId("sandbox-stop-confirm").click();
  await expect(page.getByText(`${SCOUT}'s sandbox stopped`)).toBeVisible();
  await expect(status).toHaveAttribute("data-status", "stopped");
  await expect(status).toContainText(`Starts when ${SCOUT} needs it.`);
  await expect(page.getByTestId("sandbox-stop")).toHaveCount(0);
  // The files stay readable while it is stopped.
  await expect(row(page, "reports")).toBeVisible();

  // Over its quota sandboxd stops it with disk_full: a red notice, no actions.
  await fake.emit({ type: "usage", target: scout.target, cpuMs: 0, diskBytes: 2048 * MIB });
  await fake.emit({
    type: "state",
    target: scout.target,
    kind: "sbx",
    state: "disk_full",
    reason: "disk_full",
  });
  await reloadUntil(page, "disk_full");
  await expect(page.getByTestId("sandbox-notice")).toHaveText(
    `The sandbox is full (2 GB of 2 GB). ${SCOUT} can't write files or run commands until you delete some.`,
  );
  await expect(page.getByTestId("sandbox-restart")).toHaveCount(0);
  if (!mobile) {
    await checkScreen(page, '[data-testid="sandbox-status"]', "disk full");
    await captureReview(page, "bot-sandbox-full-1440");
  }

  // The kill switch: running again, then an admin stops every sandbox.
  await fake.emit({ type: "usage", target: scout.target, cpuMs: 0, diskBytes: 1_503_238_554 });
  await fake.emit({ type: "state", target: scout.target, kind: "sbx", state: "running", reason: null });
  await reloadUntil(page, "running");
  await killSwitch(admin);
  try {
    await page.reload();
    await expect(page.getByTestId("sandbox-status")).toHaveAttribute("data-status", "killed");
    await expect(page.getByTestId("sandbox-notice")).toHaveText(
      "An admin stopped all sandboxes. Files are kept.",
    );
    await expect(page.getByTestId("sandbox-stop")).toHaveCount(0);
  } finally {
    await resume(admin);
  }
});

test("an empty workspace offers Upload, and a bot that never ran says when it starts", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  const id = await freshTeamBot(admin, EMPTY_BOT);
  await enableBotSandbox(admin, id, { sandbox: true });
  const page = await signIn(browser, info.project.name);
  await page.goto(`${BASE_URL}/bots/${id}?tab=sandbox`);
  await expect(page.getByTestId("sandbox-status")).toHaveAttribute("data-status", "absent");
  await expect(page.getByTestId("sandbox-notice")).toHaveText(
    `No sandbox yet. It's created the first time ${EMPTY_BOT} needs it.`,
  );
  // Nothing runs yet, so no isolation is claimed.
  await expect(page.getByTestId("sandbox-isolation")).toHaveCount(0);
  const empty = page.getByTestId("sandbox-files-empty");
  await expect(empty).toContainText("No files yet");
  await expect(empty.getByRole("button", { name: "Upload" })).toBeVisible();
  await checkScreen(page, '[data-testid="sandbox-tab"]', "empty");
  if (mobile) {
    await empty.scrollIntoViewIfNeeded();
    await captureReview(page, "bot-sandbox-empty-390");
  }
});

test("capabilities: Sandbox and Browser switches per bot, with the API's reason, applying, and absent with the module off", async ({
  browser,
}, info) => {
  const mobile = info.project.name === "mobile";
  const id = await freshTeamBot(admin, CAPS_BOT);
  const page = await signIn(browser, info.project.name);

  // The organization switch is off: both rows say so and cannot be turned on.
  await enableSandboxOrg(admin, false);
  try {
    let sheet = await openTeamBotSheet(page, CAPS_BOT);
    const panel = sheet.getByTestId("capabilities-panel");
    await expect(panel.getByTestId("capability-sandbox")).toBeDisabled();
    await expect(panel.getByTestId("capability-reason-sandbox")).toHaveText(
      "Turned off by your organization",
    );
    await expect(panel.getByTestId("capability-browser")).toBeDisabled();
    await expect(panel.getByText("Keeps files and runs commands in its own sandbox")).toBeVisible();
    await expect(panel.getByText("Opens web pages in a real browser")).toBeVisible();
    // A bot that never had a sandbox shows no Sandbox tab while the organization has it off.
    await page.goto(`${BASE_URL}/bots/${id}?tab=sandbox`);
    await expect(tabs(page).getByRole("tab", { name: "Memory" })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("agent-tab-sandbox")).toHaveCount(0);

    await enableSandboxOrg(admin, true);
    sheet = await openTeamBotSheet(page, CAPS_BOT);
    const toggle = sheet.getByTestId("capability-sandbox");
    await expect(toggle).toBeEnabled();
    await expect(toggle).not.toBeChecked();
    const patched = page.waitForResponse(
      (r) => r.url().endsWith(`/agents/${id}/capabilities`) && r.request().method() === "PATCH",
    );
    await toggle.click();
    expect((await patched).ok()).toBe(true);
    await expect(toggle).toBeChecked();
    // The bot's runtime takes the change from its next refresh: the row says it is still applying (WINDOWS #248).
    const applying = sheet.getByTestId("capability-applying-sandbox");
    await expect(applying).toHaveText("Applying. Ready in a few seconds.");
    await expectNoSeriousA11y(page, '[data-testid="capabilities-panel"]');
    await expect(applying).toHaveCount(0, { timeout: 10_000 });
    const view = (await (await admin.get(`/api/v1/agents/${id}/capabilities`)).json()) as {
      capabilities: { sandbox: boolean; browser: boolean };
    };
    expect(view.capabilities).toMatchObject({ sandbox: true, browser: false });

    // The status is available: the bot page has its Sandbox tab.
    await page.goto(`${BASE_URL}/bots/${id}?tab=sandbox`);
    await expect(page.getByTestId("agent-tab-sandbox")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByTestId("sandbox-status")).toHaveAttribute("data-status", "absent");
  } finally {
    await enableSandboxOrg(admin, true);
  }

  // With the Sandbox and Browser modules off for Sam, his own bot has neither row nor tab.
  if (mobile) return;
  const bot = await freshPersonalBot(SAM, samId);
  const rules: string[] = [];
  try {
    for (const permission of [...MODULE_CATALOG.sandbox.patterns, ...MODULE_CATALOG.browser.patterns]) {
      const res = await admin.post("/api/v1/permission-rules", {
        data: { scopeUnitId: null, subjectKind: "user", subjectId: samId, permission, effect: "deny" },
      });
      expect(res.ok(), `deny ${permission} for Sam: ${res.status()}`).toBe(true);
      rules.push(((await res.json()) as { id: string }).id);
    }
    const sam = await signIn(browser, info.project.name, SAM);
    await sam.goto(`${BASE_URL}/bots/${bot.id}?tab=capabilities`);
    await expect(sam.getByTestId("capabilities-panel")).toBeVisible();
    await expect(sam.getByTestId("capability-internet")).toBeVisible();
    await expect(sam.getByTestId("capability-sandbox")).toHaveCount(0);
    await expect(sam.getByTestId("capability-browser")).toHaveCount(0);
    await expect(sam.getByTestId("agent-tab-sandbox")).toHaveCount(0);
  } finally {
    for (const ruleId of rules) await admin.delete(`/api/v1/permission-rules/${ruleId}`);
  }
});
