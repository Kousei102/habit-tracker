import { execFileSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { BrowserContext, Locator, Page } from "@playwright/test";
import {
  TODAY,
  addButton,
  byDaysAgo,
  checkbox,
  daysAgo,
  documentText,
  expect,
  expectDashboardReady,
  expectHeatmapReady,
  habitList,
  habitRow,
  heatmapPicker,
  kindOption,
  nameField,
  openDashboard,
  readStorage,
  run,
  seedRaw,
  statsRow,
  test,
} from "../fixtures.ts";
import { STATIC_URL } from "../playwright.config.ts";

/*
 * Phase 8 — PWA and getting the data out.
 *
 * The acceptance criteria under test (docs/phases.md):
 *
 *   AC-8.1        A manifest ships and is linked, with the fields and the 192 /
 *                 512 icons an installable app needs.
 *   AC-8.2        The built HTML says "standalone" to iOS, apple-touch-icon
 *                 included. (Only the artefact can be checked here — no iPhone.)
 *   AC-8.3  [E2E] A service worker registers, and the app *starts and records*
 *                 with the network off.
 *   AC-8.4        `navigator.storage.persist()` is asked for; a refusal changes
 *                 nothing about whether the app works.
 *   AC-8.5  [E2E] Export downloads a JSON file holding every habit and record,
 *                 deleted ones included.
 *   AC-8.6  [E2E] Export → wipe → import restores habits, records, statistics
 *                 and the heatmap.
 *   AC-8.7  [E2E] Import summarises before it applies, and applies only on an
 *                 explicit press. No native `confirm()`.
 *   AC-8.8  [E2E] A broken or foreign file is refused **without touching the
 *                 stored bytes**.
 *   AC-8.9  [E2E] The last export date is on screen, including "never".
 *   AC-8.10       README: add to home screen, and the seven day deletion.
 *   AC-8.11 [E2E] 375px: nothing breaks, export and import are reachable.
 *   AC-8.12 [E2E] With an unreadable document, import *and* reset are reachable
 *                 from the screen, and reset cannot go off by accident.
 *
 * Two rules run through the whole file.
 *
 * **The clock is pinned** by the shared fixture (2026-03-15) and every seeded day
 * is an offset from it. Streaks, rates, the heatmap and the export filename are
 * all functions of "what day is it"; against a real calendar this file would
 * start failing at midnight and the failure would look like a product bug.
 *
 * **The bytes are the assertion.** For every criterion about not losing data, the
 * check is a byte-for-byte comparison of `localStorage` before and after, not a
 * look at the screen. A panel can say "読み込めません" while having already
 * flattened the document, and that is precisely the accident Phase 8 exists to
 * prevent. Each such test is paired with a control that changes the bytes on
 * purpose, so a comparison that cannot fail is visible as one.
 */

const REPO_ROOT = path.resolve(import.meta.dirname, "../..");
const DIST = path.join(REPO_ROOT, "client", "dist");
const LAST_EXPORT_KEY = "habit-tracker.last-export";

// ---------------------------------------------------------------------------
// Screen vocabulary. Role and accessible name only, as everywhere else.
// ---------------------------------------------------------------------------

const backupSection = (page: Page) => page.locator("#backup");
const backupHeading = (page: Page) => page.getByRole("heading", { name: "バックアップ" });
const exportButton = (page: Page) => page.getByRole("button", { name: "エクスポート" });
const rawExportButton = (page: Page) =>
  page.getByRole("button", { name: "壊れたデータをファイルに書き出す" });
const fileField = (page: Page) => page.getByLabel("バックアップファイル");
const importSummary = (page: Page) => page.getByTestId("import-summary");
const confirmImportButton = (page: Page) => page.getByRole("button", { name: "インポートを実行" });
const cancelImportButton = (page: Page) => page.getByRole("button", { name: "インポートをやめる" });
const lastExportLine = (page: Page) => page.getByTestId("last-export");
const recoveryNotice = (page: Page) => page.getByTestId("recovery-notice");
const openResetButton = (page: Page) => page.getByRole("button", { name: "データを初期化する" });
const resetAcknowledgement = (page: Page) =>
  page.getByRole("checkbox", { name: "記録がすべて消えることを理解しました" });
const runResetButton = (page: Page) => page.getByRole("button", { name: "すべての記録を削除する" });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Both stored keys, exactly as they are. The subject of every "nothing was lost". */
async function readAllStorage(page: Page): Promise<{ document: string | null; lastExport: string | null }> {
  return page.evaluate((key) => ({
    document: window.localStorage.getItem("habit-tracker"),
    lastExport: window.localStorage.getItem(key),
  }), LAST_EXPORT_KEY);
}

async function setLastExport(page: Page, date: string): Promise<void> {
  await page.evaluate(
    ([key, value]) => window.localStorage.setItem(key as string, value as string),
    [LAST_EXPORT_KEY, date],
  );
}

/** Clicks something that downloads, and returns the file's name and contents. */
async function download(page: Page, act: () => Promise<void>): Promise<{ name: string; text: string }> {
  const [downloaded] = await Promise.all([page.waitForEvent("download"), act()]);
  const file = await downloaded.path();
  return { name: downloaded.suggestedFilename(), text: fs.readFileSync(file, "utf8") };
}

/** Chooses a file in the import field, from bytes — no temp file on disk. */
async function chooseFile(page: Page, name: string, text: string): Promise<void> {
  await fileField(page).setInputFiles({
    name,
    mimeType: name.endsWith(".json") ? "application/json" : "text/plain",
    buffer: Buffer.from(text, "utf8"),
  });
}

type ExportFile = {
  format: string;
  format_version: number;
  habits: Array<{ id: number; name: string; kind: string; target: number | null; archived_at: string | null }>;
  entries: Array<{ habit_id: number; date: string; value: number }>;
  next_habit_id: number;
};

/**
 * Every heatmap cell's accessible name, in order.
 *
 * This is the drawing as a screen reader meets it — 365 labels carrying date and
 * value — and it is what AC-8.6 means by "the heatmap is restored". Comparing the
 * whole list is stricter than sampling cells and cannot be satisfied by a grid
 * that happens to agree on the three days a test remembered to look at.
 */
async function heatmapLabels(page: Page): Promise<string[]> {
  return page
    .locator('[role="gridcell"]')
    .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("aria-label") ?? ""));
}

/** Waits until a service worker is actually controlling the page. */
async function expectServiceWorkerControlling(page: Page): Promise<void> {
  await expect(page.locator("html")).toHaveAttribute("data-sw", "controlled", { timeout: 20_000 });
}

/** Fails the test if the app opens a native dialog — AC-8.7 forbids `confirm()`. */
function forbidNativeDialogs(page: Page): string[] {
  const seen: string[] = [];
  page.on("dialog", (dialog) => {
    seen.push(`${dialog.type()}: ${dialog.message()}`);
    void dialog.dismiss();
  });
  return seen;
}

async function expectWithinViewportWidth(page: Page, target: Locator, what: string): Promise<void> {
  const viewport = page.viewportSize();
  if (viewport === null) throw new Error("no viewport");
  await target.scrollIntoViewIfNeeded();
  const box = await target.boundingBox();
  expect(box, `${what} has no box`).not.toBeNull();
  expect(box?.x ?? -1, `${what} starts off the left edge`).toBeGreaterThanOrEqual(-1);
  expect((box?.x ?? 0) + (box?.width ?? 0), `${what} runs past the right edge`).toBeLessThanOrEqual(
    viewport.width + 1,
  );
}

// ---------------------------------------------------------------------------
// The document used by the round trip. One habit with a history, one numeric
// habit, and — the part an export is most likely to quietly drop — a *deleted*
// habit that still owns records.
// ---------------------------------------------------------------------------

const WALK = "往復_散歩";
const READ = "往復_読書";
const GONE = "往復_やめた瞑想";

const ROUND_TRIP = {
  habits: [
    { id: 1, name: WALK, kind: "boolean" as const },
    { id: 2, name: READ, kind: "numeric" as const, target: 30, unit: "分" },
    {
      id: 3,
      name: GONE,
      kind: "boolean" as const,
      archived_at: "2026-03-01T00:00:00.000Z",
      sort_order: 2,
    },
  ],
  entries: {
    // Five achieved days up to today, and a separate run of seven further back:
    // current 5, longest 7, and 12 of the last 30 days achieved.
    1: { ...byDaysAgo(run(0, 4, 1)), ...byDaysAgo(run(20, 26, 1)), ...byDaysAgo({ 10: 0 }) },
    // Three days at the target, then one below it — which must not count.
    2: { ...byDaysAgo(run(0, 2, 30)), ...byDaysAgo({ 3: 10 }) },
    // The deleted habit's history. Nothing on screen shows it; the file must.
    3: byDaysAgo({ 5: 1, 6: 1 }),
  },
};

/** The statistics the seeded document must produce, before and after a restore. */
async function expectRoundTripStats(page: Page): Promise<void> {
  await expect(statsRow(page, WALK)).toContainText("現在ストリーク 5 日");
  await expect(statsRow(page, WALK)).toContainText("最長ストリーク 7 日");
  await expect(statsRow(page, WALK)).toContainText("直近 30 日の達成率 40%（12 / 30 日）");

  await expect(statsRow(page, READ)).toContainText("現在ストリーク 3 日");
  await expect(statsRow(page, READ)).toContainText("最長ストリーク 3 日");
  await expect(statsRow(page, READ)).toContainText("直近 30 日の達成率 10%（3 / 30 日）");
}

// ===========================================================================
// AC-8.1 / AC-8.2 — what the build actually ships.
//
// No browser: these are criteria about the artefact. Chromium's manifest support
// would prove nothing about iOS, and the phone cannot be reached from here.
// ===========================================================================

test.describe("Phase 8 — installability", () => {
  /** Width and height straight out of the PNG's IHDR, decoded here and not by the app's own code. */
  function pngSize(file: string): { width: number; height: number } {
    const bytes = fs.readFileSync(file);
    const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    expect(Array.from(bytes.subarray(0, 8)), `${file} is not a PNG`).toEqual(signature);
    expect(bytes.subarray(12, 16).toString("latin1"), `${file}: first chunk is not IHDR`).toBe("IHDR");
    return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
  }

  test("AC-8.1: the build ships a manifest with the fields an installable app needs", () => {
    const manifestFile = path.join(DIST, "manifest.webmanifest");
    expect(fs.existsSync(manifestFile), "no manifest.webmanifest in the build").toBe(true);

    const manifest = JSON.parse(fs.readFileSync(manifestFile, "utf8")) as Record<string, unknown> & {
      icons: Array<{ src: string; sizes: string; type?: string; purpose?: string }>;
    };

    expect(manifest["name"], "name").toBeTruthy();
    expect(manifest["short_name"], "short_name").toBeTruthy();
    expect(manifest["start_url"], "start_url").toBeTruthy();
    expect(manifest["display"], "display").toBe("standalone");
    expect(String(manifest["theme_color"]), "theme_color").toMatch(/^#[0-9a-fA-F]{3,8}$/);
    expect(String(manifest["background_color"]), "background_color").toMatch(/^#[0-9a-fA-F]{3,8}$/);

    // The icons have to be there as files, at the sizes they claim — a manifest
    // pointing at a 404 is an app that cannot be added to a home screen, and
    // nothing in a build log would say so.
    for (const wanted of ["192x192", "512x512"]) {
      const icon = manifest.icons.find((candidate) => candidate.sizes.split(" ").includes(wanted));
      expect(icon, `the manifest declares no ${wanted} icon`).toBeDefined();

      const file = path.join(DIST, (icon as { src: string }).src.replace(/^\.?\//, ""));
      expect(fs.existsSync(file), `${file} is missing from the build`).toBe(true);

      const [width, height] = wanted.split("x").map(Number) as [number, number];
      expect(pngSize(file)).toEqual({ width, height });
    }
  });

  test("AC-8.1: the built HTML links the manifest", () => {
    const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");
    const link = /<link[^>]+rel=["']manifest["'][^>]*>/.exec(html);
    expect(link, "the built index.html has no <link rel=manifest>").not.toBeNull();

    const href = /href=["']([^"']+)["']/.exec(link?.[0] ?? "")?.[1] ?? "";
    expect(href).not.toBe("");
    expect(fs.existsSync(path.join(DIST, href.replace(/^\.?\//, ""))), `${href} does not exist`).toBe(true);
  });

  test("AC-8.2: the built HTML asks iOS for a standalone app, with an apple-touch-icon", () => {
    const html = fs.readFileSync(path.join(DIST, "index.html"), "utf8");

    // The tag iOS reads to decide between "a bookmark" and "an app". It is the
    // difference between a home screen icon that opens Safari — and stays subject
    // to the seven day storage deletion — and one that does not.
    expect(html, "no apple-mobile-web-app-capable meta").toMatch(
      /<meta[^>]+name=["']apple-mobile-web-app-capable["'][^>]+content=["']yes["']/,
    );

    const iconTag = /<link[^>]+rel=["']apple-touch-icon["'][^>]*>/.exec(html);
    expect(iconTag, "no apple-touch-icon link").not.toBeNull();

    const href = /href=["']([^"']+)["']/.exec(iconTag?.[0] ?? "")?.[1] ?? "";
    const file = path.join(DIST, href.replace(/^\.?\//, ""));
    expect(fs.existsSync(file), `apple-touch-icon ${href} is missing from the build`).toBe(true);

    // iOS scales whatever it is given, but a square icon of a sane size is the
    // difference between a crisp home screen and a blurred one.
    const size = pngSize(file);
    expect(size.width).toBe(size.height);
    expect(size.width).toBeGreaterThanOrEqual(120);
  });

  test("AC-8.10: the README says how to add to the home screen, and what happens if you do not", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");

    // The warning: seven days, and that it means the records are gone.
    expect(readme, "the README never mentions the seven day window").toMatch(/7\s*日/);
    const warning = /7\s*日[^\n]*/g;
    expect(readme.match(warning)?.join("\n"), "the 7 day mention is not about data being deleted").toMatch(
      /消え|削除/,
    );

    // The instructions: Safari, the share sheet, "ホーム画面に追加".
    expect(readme).toContain("ホーム画面に追加");
    expect(readme, "the README does not say to use Safari").toMatch(/Safari/);
    expect(readme, "no step mentions the share sheet").toMatch(/共有/);

    // And that the export exists as the second half of the answer.
    expect(readme).toMatch(/エクスポート/);
  });
});

// ===========================================================================
// AC-8.3 — offline.
//
// The order matters and is not decorative: the first navigation is not under a
// worker's control, so going offline before `data-sw="controlled"` tests nothing
// but a race. Every test below waits for that attribute, then cuts the network,
// then reloads.
// ===========================================================================

test.describe("Phase 8 — offline", () => {
  test("AC-8.3: with the network off the app starts, records, and keeps the record", async ({
    page,
    context,
  }) => {
    await openDashboard(page, { habits: [{ id: 1, name: "オフライン_散歩", kind: "boolean" }] });
    await expectServiceWorkerControlling(page);

    await context.setOffline(true);
    try {
      await page.reload();

      // It starts: this is a real render, not a cached screenshot.
      await expectDashboardReady(page);
      await expect(habitRow(page, "オフライン_散歩")).toBeVisible();
      await expectHeatmapReady(page);

      // ...and it is usable. A new habit *and* a record, both created with no
      // network at all.
      await nameField(page).fill("オフライン_筋トレ");
      await kindOption(page, "チェック式").check();
      await addButton(page).click();
      await expect(habitRow(page, "オフライン_筋トレ")).toBeVisible();

      await checkbox(page, "オフライン_筋トレ").check();
      await expect(habitRow(page, "オフライン_筋トレ").getByText("達成", { exact: true })).toBeVisible();
      await expect(statsRow(page, "オフライン_筋トレ")).toContainText("現在ストリーク 1 日");

      // Still offline, reload again: what was recorded is still there.
      await page.reload();
      await expectDashboardReady(page);
      await expect(checkbox(page, "オフライン_筋トレ")).toBeChecked();
      await expect(habitRow(page, "オフライン_散歩")).toBeVisible();
    } finally {
      await context.setOffline(false);
    }
  });

  test("AC-8.3: the same holds on a plain static file server (no Vary, no fallback)", async ({
    page,
    context,
  }) => {
    // 3102 is `python3 -m http.server`, which — unlike `vite preview` — sends no
    // `Vary` header at all. Both are worth running: the cache's `Vary` handling
    // is exactly the sort of thing that works on one host and not the other.
    await page.goto(`${STATIC_URL}/`);
    await expectDashboardReady(page);
    await expectServiceWorkerControlling(page);

    await nameField(page).fill("静的_オフライン_散歩");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, "静的_オフライン_散歩")).toBeVisible();

    await context.setOffline(true);
    try {
      await page.reload();
      await expectDashboardReady(page);
      await expect(habitRow(page, "静的_オフライン_散歩")).toBeVisible();
      await checkbox(page, "静的_オフライン_散歩").check();
      await expect(statsRow(page, "静的_オフライン_散歩")).toContainText("現在ストリーク 1 日");
    } finally {
      await context.setOffline(false);
    }
  });

  test("AC-8.3 control: without the worker, offline really does fail", async ({ page, context }) => {
    // Without this, "the app works offline" would also pass on a browser that was
    // simply serving everything out of its own HTTP cache, and the criterion
    // would be met by nothing at all.
    await page.goto("/");
    await expectServiceWorkerControlling(page);

    await page.evaluate(async () => {
      const registrations = await navigator.serviceWorker.getRegistrations();
      await Promise.all(registrations.map((registration) => registration.unregister()));
      const names = await caches.keys();
      await Promise.all(names.map((name) => caches.delete(name)));
    });

    await context.setOffline(true);
    try {
      // `waitUntil: "commit"` because with nothing cached there is nothing to
      // load; the point is what the document ends up being, not that it loads.
      await page.goto("/", { waitUntil: "commit" }).catch(() => undefined);
      await expect(page.getByRole("heading", { name: "ダッシュボード" })).toHaveCount(0);
    } finally {
      await context.setOffline(false);
    }
  });
});

// ===========================================================================
// AC-8.3, the `Vary` trap — and the service worker's update path.
//
// A cache entry stored by the worker carries no `Origin`; the page's own request
// for a module script does. `Cache.match` honours `Vary` by default, so on any
// host that sends `Vary: Origin` — `vite preview` does, and so do many static
// hosts — every asset misses and the offline app is a blank page, while devtools
// shows a perfectly full cache.
//
// These tests serve the real build from a server this file controls, so the same
// worker can be run with and without `ignoreVary`, and against a host that sends
// `Vary` and one that does not.
// ===========================================================================

type Harness = { url: string; setRoot: (dir: string) => void; close: () => Promise<void> };

const MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".webmanifest": "application/manifest+json",
  ".json": "application/json",
  ".svg": "image/svg+xml",
};

/**
 * A static file server whose document root can be swapped while it runs — which
 * is how a deploy is simulated below — and whose `Vary` header and `sw.js`
 * contents are under the test's control.
 */
async function startHost(options: {
  root: string;
  vary: boolean;
  rewriteSw?: (source: string) => string;
}): Promise<Harness> {
  let root = options.root;

  const server = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    let file = path.join(root, decodeURIComponent(url.pathname));
    if (url.pathname.endsWith("/")) file = path.join(file, "index.html");

    if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      response.writeHead(404, { "Content-Type": "text/plain" });
      response.end("not found");
      return;
    }

    let body = fs.readFileSync(file);
    if (url.pathname === "/sw.js" && options.rewriteSw !== undefined) {
      body = Buffer.from(options.rewriteSw(body.toString("utf8")), "utf8");
    }

    const headers: Record<string, string> = {
      "Content-Type": MIME[path.extname(file)] ?? "application/octet-stream",
      "Content-Length": String(body.byteLength),
      "Cache-Control": "no-cache",
    };
    // The header this whole section is about.
    if (options.vary) headers["Vary"] = "Origin";
    if (request.headers.origin !== undefined) headers["Access-Control-Allow-Origin"] = request.headers.origin;

    response.writeHead(200, headers);
    response.end(body);
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    setRoot: (dir) => {
      root = dir;
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A page in a fresh context, with the same pinned clock as every other spec. */
async function freshPage(context: BrowserContext): Promise<Page> {
  const page = await context.newPage();
  await page.clock.install({ time: new Date("2026-03-15T09:00:00") });
  return page;
}

test.describe("Phase 8 — the service worker's cache", () => {
  test("AC-8.3: offline works on a host that sends Vary: Origin", async ({ browser }) => {
    const host = await startHost({ root: DIST, vary: true });
    const context = await browser.newContext();
    try {
      const page = await freshPage(context);
      await page.goto(`${host.url}/`);
      await expectDashboardReady(page);
      await expectServiceWorkerControlling(page);

      await nameField(page).fill("Vary_散歩");
      await kindOption(page, "チェック式").check();
      await addButton(page).click();
      await expect(habitRow(page, "Vary_散歩")).toBeVisible();

      await context.setOffline(true);
      await page.reload();
      await expectDashboardReady(page);
      await expect(habitRow(page, "Vary_散歩")).toBeVisible();
    } finally {
      await context.close();
      await host.close();
    }
  });

  test("AC-8.3 control: the same worker without ignoreVary is blank offline", async ({ browser }) => {
    // The negative control for the fix. If this ever passes, `ignoreVary` has
    // stopped being load-bearing — or the test has stopped removing it, which is
    // why the substitution is asserted rather than assumed.
    let patched = false;
    const host = await startHost({
      root: DIST,
      vary: true,
      rewriteSw: (source) => {
        const next = source.replace("ignoreVary: true", "ignoreVary: false");
        patched = next !== source;
        return next;
      },
    });

    const context = await browser.newContext();
    try {
      const page = await freshPage(context);
      await page.goto(`${host.url}/`);
      await expectDashboardReady(page);
      await expectServiceWorkerControlling(page);
      expect(patched, "sw.js no longer contains `ignoreVary: true` — this control is vacuous").toBe(true);

      await context.setOffline(true);
      await page.reload({ waitUntil: "commit" }).catch(() => undefined);

      // The shell may still be served; the module script is the request that
      // carries an `Origin` and therefore misses. Either way, no app.
      await expect(page.getByRole("heading", { name: "ダッシュボード" })).toHaveCount(0);
    } finally {
      await context.close();
      await host.close();
    }
  });

  /**
   * Not an acceptance criterion, but the most common way a PWA dies: an old
   * worker serving an old app for ever. A second real build is produced (same
   * config, one CSS colour changed), served from the same origin, and the user
   * simply reloads.
   */
  test("a new build reaches a user who already has the old one cached", async ({ browser }) => {
    // A copy of the app's own sources — never written back to. The copy keeps
    // the repository's shape (`client/` beside `shared/`, with the base tsconfig
    // above them) because the app imports across those directories, and it sits
    // inside the repo so module resolution finds the same vite and react.
    const workDir = path.join(REPO_ROOT, ".harness/tmp/phase8-build-v2");
    const appDir = path.join(workDir, "client");
    fs.rmSync(workDir, { recursive: true, force: true });
    fs.mkdirSync(workDir, { recursive: true });
    fs.cpSync(path.join(REPO_ROOT, "client"), appDir, {
      recursive: true,
      filter: (source) => !/(^|[\\/])(dist|node_modules)$/.test(source),
    });
    fs.cpSync(path.join(REPO_ROOT, "shared"), path.join(workDir, "shared"), { recursive: true });
    fs.copyFileSync(
      path.join(REPO_ROOT, "tsconfig.base.json"),
      path.join(workDir, "tsconfig.base.json"),
    );

    // The visible difference between build 1 and build 2.
    const marker = "rgb(1, 2, 3)";
    fs.appendFileSync(
      path.join(appDir, "src", "styles.css"),
      `\n.card__title { color: ${marker}; }\n`,
      "utf8",
    );
    execFileSync("npx", ["vite", "build"], { cwd: appDir, stdio: "pipe" });

    const v2 = path.join(appDir, "dist");
    expect(fs.existsSync(path.join(v2, "index.html")), "the second build produced nothing").toBe(true);

    const host = await startHost({ root: DIST, vary: true });
    const context = await browser.newContext();
    try {
      const page = await freshPage(context);
      await page.goto(`${host.url}/`);
      await expectDashboardReady(page);
      await expectServiceWorkerControlling(page);

      const heading = page.getByRole("heading", { name: "ダッシュボード" });
      const before = await heading.evaluate((element) => getComputedStyle(element).color);
      expect(before, "build 1 already looks like build 2").not.toBe(marker);

      const cachesBefore = await page.evaluate(() => caches.keys());
      expect(cachesBefore.length, `caches after the first install: ${cachesBefore.join(", ")}`).toBe(1);

      // Deploy.
      host.setRoot(v2);
      await page.reload();
      await expectDashboardReady(page);

      // The new app is what the user is looking at...
      await expect
        .poll(async () => heading.evaluate((element) => getComputedStyle(element).color), {
          timeout: 15_000,
        })
        .toBe(marker);

      // ...and the old cache is dropped rather than accumulating for ever. Two
      // caches exist for the moment between the new worker installing and
      // activating, so this waits for the settled state rather than sampling it.
      await expect
        .poll(
          async () => {
            const keys = await page.evaluate(() => caches.keys());
            return keys.length === 1 && keys[0] !== cachesBefore[0] ? "only the new cache" : keys.join(",");
          },
          { timeout: 20_000 },
        )
        .toBe("only the new cache");

      // And the new build is the one that works offline now.
      await context.setOffline(true);
      await page.reload();
      await expectDashboardReady(page);
      await expect(heading).toHaveCSS("color", marker);
    } finally {
      await context.close();
      await host.close();
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

// ===========================================================================
// AC-8.4 — persistent storage.
// ===========================================================================

test.describe("Phase 8 — persistent storage", () => {
  test("AC-8.4: the app asks for persistent storage", async ({ page }) => {
    // `persisted()` is stubbed to false so the request has to be made; otherwise
    // a browser that already granted it would make this test say nothing.
    await page.addInitScript(() => {
      const manager = navigator.storage;
      (window as unknown as { __persistCalls: number }).__persistCalls = 0;
      manager.persisted = async () => false;
      manager.persist = async () => {
        (window as unknown as { __persistCalls: number }).__persistCalls += 1;
        return false;
      };
    });

    await page.goto("/");
    await expectDashboardReady(page);

    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __persistCalls: number }).__persistCalls))
      .toBeGreaterThanOrEqual(1);
  });

  test("AC-8.4: a refusal — even a thrown one — does not stop the app", async ({ page }) => {
    await page.addInitScript(() => {
      navigator.storage.persisted = async () => false;
      navigator.storage.persist = async () => {
        throw new Error("denied");
      };
    });

    const pageErrors: string[] = [];
    page.on("pageerror", (error) => pageErrors.push(error.message));

    await openDashboard(page, { habits: [{ id: 1, name: "拒否_散歩", kind: "boolean" }] });
    await checkbox(page, "拒否_散歩").check();
    await expect(statsRow(page, "拒否_散歩")).toContainText("現在ストリーク 1 日");

    // The panel says where the user stands rather than pretending.
    await expect(page.getByTestId("storage-persistence")).toContainText("永続化されていません");
    expect(pageErrors, "a rejected persist() reached the page as an uncaught error").toEqual([]);
  });
});

// ===========================================================================
// AC-8.5 / AC-8.9 — export.
// ===========================================================================

test.describe("Phase 8 — export", () => {
  test("AC-8.5: the exported file holds every habit and record, deleted ones included", async ({ page }) => {
    await openDashboard(page, ROUND_TRIP);
    await expectHeatmapReady(page);

    const file = await download(page, () => exportButton(page).click());

    // Named by the day it was taken, so a phone's Files app keeps generations.
    expect(file.name).toBe(`habit-tracker-${TODAY}.json`);

    const parsed = JSON.parse(file.text) as ExportFile;
    expect(parsed.format).toBe("habit-tracker-export");
    expect(parsed.format_version).toBeGreaterThanOrEqual(1);

    // All three habits — including the one the user deleted, which is invisible
    // on screen and is the thing an export most easily loses.
    expect(parsed.habits.map((habit) => habit.name).sort()).toEqual([WALK, READ, GONE].sort());
    const gone = parsed.habits.find((habit) => habit.name === GONE);
    expect(gone?.archived_at, "the deleted habit lost its archived_at").not.toBeNull();

    // Every record, counted against the seed rather than against the file.
    const seeded = Object.values(ROUND_TRIP.entries).reduce(
      (total, days) => total + Object.keys(days).length,
      0,
    );
    expect(parsed.entries.length, "records missing from the export").toBe(seeded);

    // ...and specifically the deleted habit's two days.
    const goneEntries = parsed.entries.filter((entry) => entry.habit_id === gone?.id);
    expect(goneEntries.map((entry) => entry.date).sort()).toEqual([daysAgo(6), daysAgo(5)].sort());

    // A day recorded as 0 ("I did not do it") is information, and survives.
    const zero = parsed.entries.find((entry) => entry.habit_id === 1 && entry.date === daysAgo(10));
    expect(zero?.value, "the explicit zero was dropped").toBe(0);
  });

  test("AC-8.9: the last export date is on screen — including when there has never been one", async ({
    page,
  }) => {
    await openDashboard(page, { habits: [{ id: 1, name: "日付_散歩", kind: "boolean" }] });

    // The "never" state is legible as such, not an empty space or a dash.
    await expect(lastExportLine(page)).toContainText("まだ一度もエクスポートしていません");
    // ...and it is said loudly enough to act on.
    await expect(page.getByTestId("export-reminder")).toBeVisible();

    await download(page, () => exportButton(page).click());

    await expect(lastExportLine(page)).toContainText(TODAY);
    await expect(lastExportLine(page)).not.toContainText("まだ一度も");
    await expect(page.getByTestId("export-reminder")).toHaveCount(0);

    // It is a fact about the device, so it survives a reload.
    await page.reload();
    await expectDashboardReady(page);
    await expect(lastExportLine(page)).toContainText(TODAY);
  });

  test("AC-8.9 control: a date is shown as stored, not as today", async ({ page }) => {
    // Without this, "the date is on screen" would also pass on an app that
    // printed today's date unconditionally.
    await openDashboard(page, { habits: [{ id: 1, name: "日付制御_散歩", kind: "boolean" }] });
    await setLastExport(page, daysAgo(40));
    await page.reload();
    await expectDashboardReady(page);

    await expect(lastExportLine(page)).toContainText(daysAgo(40));
    await expect(lastExportLine(page)).not.toContainText(TODAY);
  });
});

// ===========================================================================
// AC-8.6 / AC-8.7 — the round trip, and the confirmation in front of it.
// ===========================================================================

test.describe("Phase 8 — restore", () => {
  test("AC-8.6: export, wipe from the screen, import — everything comes back", async ({ page }) => {
    await openDashboard(page, ROUND_TRIP);
    await expectHeatmapReady(page);

    // ---- What "restored" has to mean, recorded before anything is destroyed.
    await expectRoundTripStats(page);
    await heatmapPicker(page).selectOption({ label: WALK });
    await expect(page.getByRole("grid", { name: `${WALK} の年間ヒートマップ` })).toBeVisible();
    const labelsBefore = await heatmapLabels(page);
    expect(labelsBefore.length, "the heatmap drew no cells").toBeGreaterThan(360);
    const storedBefore = await readStorage(page);

    // ---- Export.
    const file = await download(page, () => exportButton(page).click());

    // ---- Wipe, through the user interface and nothing else.
    await openResetButton(page).click();
    await resetAcknowledgement(page).check();
    await runResetButton(page).click();

    await expect(page.getByText("習慣がまだ登録されていません。")).toBeVisible();
    await expect(habitList(page).getByRole("listitem")).toHaveCount(0);
    await expect(statsRow(page, WALK)).toHaveCount(0);
    const wiped = JSON.parse((await readStorage(page)) as string) as { habits: unknown[] };
    expect(wiped.habits, "the reset left habits behind").toEqual([]);

    // ---- Import.
    await chooseFile(page, file.name, file.text);
    await expect(importSummary(page)).toBeVisible();
    await confirmImportButton(page).click();

    // Habits, including the two kinds and today's values.
    await expect(habitRow(page, WALK)).toBeVisible();
    await expect(habitRow(page, READ)).toContainText("30 / 30 分");
    await expect(checkbox(page, WALK)).toBeChecked();

    // Statistics: the same numbers, computed from the restored records.
    await expectRoundTripStats(page);

    // The heatmap, cell for cell.
    await heatmapPicker(page).selectOption({ label: WALK });
    await expect(page.getByRole("grid", { name: `${WALK} の年間ヒートマップ` })).toBeVisible();
    expect(await heatmapLabels(page), "the heatmap came back different").toEqual(labelsBefore);

    // The deleted habit and its records, which nothing on the dashboard shows.
    const storedAfter = JSON.parse((await readStorage(page)) as string) as {
      habits: Array<{ id: number; name: string; archived_at: string | null }>;
      entries: Record<string, Record<string, number>>;
    };
    const gone = storedAfter.habits.find((habit) => habit.name === GONE);
    expect(gone, "the deleted habit did not come back").toBeDefined();
    expect(gone?.archived_at).not.toBeNull();
    expect(storedAfter.entries[String(gone?.id)]).toEqual(ROUND_TRIP.entries[3]);

    // And the document as a whole is the same document, not merely a similar one.
    expect(storedAfter).toEqual(JSON.parse(storedBefore as string));

    // Survives a reload: it was written, not just rendered.
    await page.reload();
    await expectDashboardReady(page);
    await expectRoundTripStats(page);
  });

  test("AC-8.6: a deleted habit that is restored brings its records with it", async ({ page }) => {
    // The other half of "deleted habits are in the file": that the records
    // travelling with them are still attached to the right habit afterwards.
    await openDashboard(page, ROUND_TRIP);
    const file = await download(page, () => exportButton(page).click());

    await openResetButton(page).click();
    await resetAcknowledgement(page).check();
    await runResetButton(page).click();
    await expect(page.getByText("習慣がまだ登録されていません。")).toBeVisible();

    await chooseFile(page, file.name, file.text);
    await confirmImportButton(page).click();
    await expect(habitRow(page, WALK)).toBeVisible();

    // The heatmap is the one place a deleted habit is still selectable, because
    // its history is still there.
    await expectHeatmapReady(page);
    await heatmapPicker(page).selectOption({ label: `${GONE}（削除済み）` });
    await expect(page.getByRole("grid", { name: `${GONE}（削除済み） の年間ヒートマップ` })).toBeVisible();
    const recorded = (await heatmapLabels(page)).filter((label) => label.includes(daysAgo(5)));
    expect(recorded.length, `no heatmap cell for ${daysAgo(5)}`).toBe(1);
    expect(recorded[0], "the restored record is not drawn as a record").toMatch(/記録|達成|1/);
  });

  test("AC-8.7: choosing a file summarises it and changes nothing until it is confirmed", async ({
    page,
  }) => {
    const dialogs = forbidNativeDialogs(page);

    await openDashboard(page, { habits: [{ id: 1, name: "確認前_元の習慣", kind: "boolean" }] });
    const before = await readAllStorage(page);

    // A file that is plainly different from what is stored.
    const incoming = {
      format: "habit-tracker-export",
      format_version: 1,
      app_schema_version: 1,
      exported_at: "2026-03-14T00:00:00.000Z",
      next_habit_id: 4,
      habits: [
        { id: 1, name: "確認_散歩", kind: "boolean", target: null, unit: null, color: "blue", sort_order: 0, archived_at: null, created_at: "2026-01-01T00:00:00.000Z" },
        { id: 2, name: "確認_読書", kind: "numeric", target: 30, unit: "分", color: "green", sort_order: 1, archived_at: null, created_at: "2026-01-01T00:00:00.000Z" },
        { id: 3, name: "確認_やめた", kind: "boolean", target: null, unit: null, color: "pink", sort_order: 2, archived_at: "2026-02-01T00:00:00.000Z", created_at: "2026-01-01T00:00:00.000Z" },
      ],
      entries: [
        { habit_id: 1, date: daysAgo(9), value: 1 },
        { habit_id: 1, date: daysAgo(1), value: 1 },
        { habit_id: 2, date: daysAgo(4), value: 30 },
        { habit_id: 3, date: daysAgo(30), value: 1 },
      ],
    };

    await chooseFile(page, "habit-tracker-2026-03-14.json", JSON.stringify(incoming));

    // The summary: how many habits, how many records, over what period.
    await expect(importSummary(page)).toBeVisible();
    await expect(page.getByTestId("import-habit-count")).toContainText("3");
    await expect(page.getByTestId("import-entry-count")).toContainText("4");
    await expect(page.getByTestId("import-range")).toContainText(daysAgo(30));
    await expect(page.getByTestId("import-range")).toContainText(daysAgo(1));

    // Nothing has been applied. The old habit is still the one on screen, and the
    // stored bytes have not moved.
    await expect(habitRow(page, "確認前_元の習慣")).toBeVisible();
    await expect(habitRow(page, "確認_散歩")).toHaveCount(0);
    expect(await readAllStorage(page), "the file was applied before it was confirmed").toEqual(before);

    // Backing out leaves it that way.
    await cancelImportButton(page).click();
    await expect(importSummary(page)).toHaveCount(0);
    expect(await readAllStorage(page)).toEqual(before);

    // And the explicit press is what applies it.
    await chooseFile(page, "habit-tracker-2026-03-14.json", JSON.stringify(incoming));
    await expect(importSummary(page)).toBeVisible();
    await confirmImportButton(page).click();

    await expect(habitRow(page, "確認_散歩")).toBeVisible();
    await expect(habitRow(page, "確認前_元の習慣")).toHaveCount(0);
    expect((await readAllStorage(page)).document).not.toBe(before.document);

    // No native dialog anywhere in that sequence — Playwright dismisses those by
    // default, so an implementation built on `confirm()` would be untestable and
    // in practice unusable under automation.
    expect(dialogs, "the app used a native dialog").toEqual([]);
  });
});

// ===========================================================================
// AC-8.8 — the worst outcome this phase could have.
//
// "I tried to restore a backup and my records disappeared." Every case below
// asserts on the stored bytes, both keys, before and after.
// ===========================================================================

const GOOD_FILE = JSON.stringify({
  format: "habit-tracker-export",
  format_version: 1,
  app_schema_version: 1,
  exported_at: "2026-03-15T00:00:00.000Z",
  next_habit_id: 2,
  habits: [
    {
      id: 1,
      name: "正常なファイルの習慣",
      kind: "boolean",
      target: null,
      unit: null,
      color: "blue",
      sort_order: 0,
      archived_at: null,
      created_at: "2026-01-01T00:00:00.000Z",
    },
  ],
  entries: [{ habit_id: 1, date: daysAgo(0), value: 1 }],
});

const REJECTED: Array<{ label: string; filename: string; text: string }> = [
  { label: "truncated JSON", filename: "backup.json", text: '{"format":"habit-tracker-export","habits":[{"id":1,' },
  { label: "another app's JSON", filename: "notes.json", text: JSON.stringify({ todos: [{ title: "牛乳を買う" }] }) },
  { label: "a JSON array", filename: "array.json", text: "[1,2,3]" },
  { label: "plain text", filename: "memo.txt", text: "これはバックアップではありません" },
  { label: "an empty file", filename: "empty.json", text: "" },
  {
    label: "a newer format_version",
    filename: "future.json",
    text: JSON.stringify({ format: "habit-tracker-export", format_version: 99, habits: [], entries: [] }),
  },
  {
    label: "the right marker but a broken habit",
    filename: "fake.json",
    text: JSON.stringify({
      format: "habit-tracker-export",
      format_version: 1,
      habits: [{ id: "one", name: "偽物", kind: "boolean" }],
      entries: [],
    }),
  },
  {
    label: "the right marker but entries that are not rows",
    filename: "fake2.json",
    text: JSON.stringify({
      format: "habit-tracker-export",
      format_version: 1,
      habits: [],
      entries: "ぜんぶ",
    }),
  },
  {
    label: "a record with an impossible date",
    filename: "baddate.json",
    text: JSON.stringify({
      format: "habit-tracker-export",
      format_version: 1,
      habits: [],
      entries: [{ habit_id: 1, date: "2026-02-31", value: 1 }],
    }),
  },
  {
    label: "two habits sharing one id",
    filename: "dupe.json",
    text: JSON.stringify({
      format: "habit-tracker-export",
      format_version: 1,
      habits: [
        { id: 1, name: "同じ ID の A", kind: "boolean" },
        { id: 1, name: "同じ ID の B", kind: "boolean" },
      ],
      entries: [],
    }),
  },
  {
    label: "a very large file of nonsense",
    filename: "huge.json",
    // ~4 MB. Big enough that an implementation streaming it into storage before
    // validating would be obvious.
    text: `{"format":"habit-tracker-export","format_version":1,"habits":[` + "x".repeat(4_000_000),
  },
];

test.describe("Phase 8 — a bad file must cost nothing", () => {
  for (const variant of REJECTED) {
    test(`AC-8.8: ${variant.label} is refused and the stored bytes are untouched`, async ({ page }) => {
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));

      await openDashboard(page, ROUND_TRIP);
      await setLastExport(page, daysAgo(3));
      await page.reload();
      await expectDashboardReady(page);

      const before = await readAllStorage(page);
      expect(before.document, "nothing was seeded").not.toBeNull();

      await chooseFile(page, variant.filename, variant.text);

      // Something a person can read, and not an exception.
      const alert = page.getByRole("alert").first();
      await expect(alert).toBeVisible();
      const message = await alert.innerText();
      expect(message.trim(), "the refusal had no message").not.toBe("");
      expect(message).not.toContain("SyntaxError");
      expect(message).not.toContain("JSON.parse");
      expect(message).not.toContain("undefined");

      // There is no confirm button to press: a refused file never becomes a
      // pending one.
      await expect(importSummary(page)).toHaveCount(0);
      await expect(confirmImportButton(page)).toHaveCount(0);

      // The data is exactly as it was — the whole point.
      expect(await readAllStorage(page), "the stored document changed").toEqual(before);

      // The app is still the app afterwards, and still working from that data.
      await expect(habitRow(page, WALK)).toBeVisible();
      await expectRoundTripStats(page);

      // And it stays that way across a reload, so nothing was written late.
      await page.reload();
      await expectDashboardReady(page);
      expect(await readAllStorage(page)).toEqual(before);
      await expectRoundTripStats(page);
      expect(pageErrors, "an uncaught exception reached the page").toEqual([]);
    });
  }

  test("AC-8.8 control: a good file does change the bytes", async ({ page }) => {
    // The control for every test above: the byte comparison is capable of
    // failing, and the import path is capable of writing.
    await openDashboard(page, ROUND_TRIP);
    const before = await readAllStorage(page);

    await chooseFile(page, "good.json", GOOD_FILE);
    await expect(importSummary(page)).toBeVisible();
    await confirmImportButton(page).click();

    await expect(habitRow(page, "正常なファイルの習慣")).toBeVisible();
    const after = await readAllStorage(page);
    expect(after.document, "a valid import did not write anything").not.toBe(before.document);
    await expect(habitRow(page, WALK)).toHaveCount(0);
  });

  test("a file whose records outlive their habit keeps the records", async ({ page }) => {
    // Not an acceptance criterion — a judgement call the builder flagged. Pinned
    // because the alternative (silently dropping the rows) is data loss, and
    // because a future change in either direction should be a deliberate one.
    await openDashboard(page, { habits: [{ id: 1, name: "孤児_元", kind: "boolean" }] });

    const orphaned = JSON.stringify({
      format: "habit-tracker-export",
      format_version: 1,
      next_habit_id: 5,
      habits: [{ id: 1, name: "孤児_残った習慣", kind: "boolean" }],
      entries: [
        { habit_id: 1, date: daysAgo(0), value: 1 },
        { habit_id: 4, date: daysAgo(2), value: 1 },
      ],
    });

    await chooseFile(page, "orphan.json", orphaned);
    await expect(importSummary(page)).toBeVisible();
    await confirmImportButton(page).click();
    await expect(habitRow(page, "孤児_残った習慣")).toBeVisible();

    const stored = JSON.parse((await readStorage(page)) as string) as {
      entries: Record<string, Record<string, number>>;
    };
    expect(stored.entries["4"]?.[daysAgo(2)], "the orphaned record was dropped").toBe(1);
  });
});

// ===========================================================================
// AC-8.12 — the state with no way out, on a phone with no devtools.
// ===========================================================================

const BROKEN_DOCUMENT = '{"version":1,"next_habit_id":2,"habits":[{"id":1,"nam';

test.describe("Phase 8 — recovery from an unreadable document", () => {
  test("AC-8.12: the way out is on screen, and looking at it writes nothing", async ({ page }) => {
    await seedRaw(page, BROKEN_DOCUMENT);

    // The app is up and says what is wrong.
    await expect(page.getByRole("heading", { name: "ダッシュボード" })).toBeVisible();
    await expect(backupHeading(page)).toBeVisible();
    await expect(recoveryNotice(page)).toBeVisible();

    // ...and the panel that can fix it is above the panels that cannot. On a
    // phone this is the difference between finding it and not.
    const backupBox = await backupSection(page).boundingBox();
    const todayBox = await page.getByRole("heading", { name: "今日の習慣" }).boundingBox();
    expect(backupBox?.y ?? 0, "the recovery panel is below the rest of the page").toBeLessThan(
      todayBox?.y ?? 0,
    );

    // Both routes out are reachable.
    await expect(fileField(page)).toBeVisible();
    await expect(openResetButton(page)).toBeVisible();

    // And the bytes we could not read are still exactly the bytes we could not
    // read — the recovery screen itself is not a writer.
    expect(await readStorage(page)).toBe(BROKEN_DOCUMENT);
  });

  test("AC-8.12: the unreadable bytes can be rescued to a file before anything is destroyed", async ({
    page,
  }) => {
    await seedRaw(page, BROKEN_DOCUMENT);
    await expect(recoveryNotice(page)).toBeVisible();

    const rescued = await download(page, () => rawExportButton(page).click());
    expect(rescued.text, "the rescue file is not the stored bytes").toBe(BROKEN_DOCUMENT);
    expect(await readStorage(page), "rescuing the bytes rewrote them").toBe(BROKEN_DOCUMENT);
  });

  test("AC-8.12: a backup can be imported on top of an unreadable document", async ({ page }) => {
    await seedRaw(page, BROKEN_DOCUMENT);
    await expect(recoveryNotice(page)).toBeVisible();

    await chooseFile(page, "backup.json", GOOD_FILE);
    await expect(importSummary(page)).toBeVisible();

    // Still not applied: the confirmation is not skipped just because the current
    // document is rubbish.
    expect(await readStorage(page)).toBe(BROKEN_DOCUMENT);

    await confirmImportButton(page).click();

    await expect(habitRow(page, "正常なファイルの習慣")).toBeVisible();
    await expect(recoveryNotice(page)).toHaveCount(0);
    await expect(checkbox(page, "正常なファイルの習慣")).toBeChecked();

    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, "正常なファイルの習慣")).toBeVisible();
  });

  test("AC-8.12: a reset gets out of it, and takes three deliberate actions", async ({ page }) => {
    await seedRaw(page, BROKEN_DOCUMENT);
    await expect(recoveryNotice(page)).toBeVisible();

    // One: nothing destructive is on screen to begin with.
    await expect(runResetButton(page)).toHaveCount(0);
    await expect(resetAcknowledgement(page)).toHaveCount(0);

    // Two: opening it is not doing it.
    await openResetButton(page).click();
    await expect(resetAcknowledgement(page)).toBeVisible();
    await expect(runResetButton(page)).toBeDisabled();
    expect(await readStorage(page), "opening the reset panel wrote to storage").toBe(BROKEN_DOCUMENT);

    // Three: acknowledging is not doing it either.
    await resetAcknowledgement(page).check();
    await expect(runResetButton(page)).toBeEnabled();
    expect(await readStorage(page), "ticking the box wrote to storage").toBe(BROKEN_DOCUMENT);

    // Only the last press does.
    await runResetButton(page).click();
    await expect(recoveryNotice(page)).toHaveCount(0);
    await expect(page.getByText("習慣がまだ登録されていません。")).toBeVisible();

    // And the app works from there: this is a repaired app, not a quiet one.
    await nameField(page).fill("初期化後_散歩");
    await kindOption(page, "チェック式").check();
    await addButton(page).click();
    await expect(habitRow(page, "初期化後_散歩")).toBeVisible();
    await checkbox(page, "初期化後_散歩").check();

    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, "初期化後_散歩")).toBeChecked();
  });

  test("AC-8.12: a reset can be backed out of without destroying anything", async ({ page }) => {
    await openDashboard(page, ROUND_TRIP);
    const before = await readAllStorage(page);

    await openResetButton(page).click();
    await resetAcknowledgement(page).check();
    await page.getByRole("button", { name: "初期化をやめる" }).click();

    await expect(runResetButton(page)).toHaveCount(0);
    expect(await readAllStorage(page)).toEqual(before);
    await expect(habitRow(page, WALK)).toBeVisible();

    // Re-opening does not remember the acknowledgement, so the third action is
    // always three actions away.
    await openResetButton(page).click();
    await expect(resetAcknowledgement(page)).not.toBeChecked();
    await expect(runResetButton(page)).toBeDisabled();
  });

  test("AC-8.12 control: a readable document is not treated as broken", async ({ page }) => {
    await openDashboard(page, ROUND_TRIP);
    await expect(recoveryNotice(page)).toHaveCount(0);
    await expect(exportButton(page)).toBeEnabled();
  });
});

// ===========================================================================
// AC-8.11 — the phone this is all for.
// ===========================================================================

test.describe("Phase 8 — 375px", () => {
  test("AC-8.11: at 375px the backup panel holds together and both directions work", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await openDashboard(page, ROUND_TRIP);
    await expectHeatmapReady(page);

    await expect(backupHeading(page)).toBeVisible();
    await expectWithinViewportWidth(page, backupSection(page), "バックアップのカード");
    await expectWithinViewportWidth(page, exportButton(page), "エクスポート");
    await expectWithinViewportWidth(page, fileField(page), "バックアップファイル");

    // Export, from the phone-sized screen.
    const file = await download(page, () => exportButton(page).click());
    expect(file.name).toBe(`habit-tracker-${TODAY}.json`);
    await expect(lastExportLine(page)).toContainText(TODAY);

    // Import, with its summary and its confirmation, all inside 375px.
    await chooseFile(page, file.name, file.text);
    await expect(importSummary(page)).toBeVisible();
    await expectWithinViewportWidth(page, importSummary(page), "読み込む内容");
    await expectWithinViewportWidth(page, confirmImportButton(page), "インポートを実行");
    await confirmImportButton(page).click();
    await expect(habitRow(page, WALK)).toBeVisible();

    // The reset control, too — it is the AC-8.12 escape hatch and this is the
    // screen it exists for.
    await openResetButton(page).click();
    await expectWithinViewportWidth(page, resetAcknowledgement(page), "承諾のチェックボックス");
    await expectWithinViewportWidth(page, runResetButton(page), "すべての記録を削除する");

    // Nothing sticks out sideways with all of that on screen.
    const overflow = await page.evaluate(() => ({
      body: document.body.scrollWidth - document.body.clientWidth,
      root: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }));
    expect(overflow.body, "document.body scrolls sideways at 375px").toBeLessThanOrEqual(1);
    expect(overflow.root, "documentElement scrolls sideways at 375px").toBeLessThanOrEqual(1);
  });

  test("AC-8.11: the recovery panel is reachable at 375px too", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });
    await seedRaw(page, BROKEN_DOCUMENT);

    await expect(recoveryNotice(page)).toBeVisible();
    await expectWithinViewportWidth(page, recoveryNotice(page), "復旧の案内");
    await expectWithinViewportWidth(page, rawExportButton(page), "壊れたデータをファイルに書き出す");
    await expectWithinViewportWidth(page, openResetButton(page), "データを初期化する");

    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow, "the recovery screen scrolls sideways at 375px").toBeLessThanOrEqual(1);
  });
});

// ===========================================================================
// Regression guard for the phases before this one: the service worker is new
// infrastructure underneath an app that was already passing, and a cache is a
// very good way to make yesterday's screen appear today.
// ===========================================================================

test.describe("Phase 8 — the worker does not change what the app shows", () => {
  test("a fresh write is served, not a cached document", async ({ page }) => {
    await openDashboard(page, { habits: [{ id: 1, name: "キャッシュ_散歩", kind: "boolean" }] });
    await expectServiceWorkerControlling(page);

    await checkbox(page, "キャッシュ_散歩").check();
    await page.reload();
    await expectDashboardReady(page);
    await expect(checkbox(page, "キャッシュ_散歩")).toBeChecked();

    // A document written by another writer is picked up on the next load, which
    // a cached HTML response could not affect but a cached *anything else* might.
    await page.evaluate(
      ([key, value]) => window.localStorage.setItem(key as string, value as string),
      ["habit-tracker", documentText({ habits: [{ id: 9, name: "キャッシュ_後から", kind: "boolean" }] })],
    );
    await page.reload();
    await expectDashboardReady(page);
    await expect(habitRow(page, "キャッシュ_後から")).toBeVisible();
    await expect(habitRow(page, "キャッシュ_散歩")).toHaveCount(0);
  });
});
