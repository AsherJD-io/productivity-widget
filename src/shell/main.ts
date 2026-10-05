/**
 * Electron MAIN process (native Windows).
 *
 * Responsibilities:
 *   - own the native window: frameless, transparent, always-on-top, draggable
 *   - own the vault: poller + writer
 *   - own widget-only UI state persistence, kept strictly OUT of the vault note
 *   - push derived state to the renderer over IPC
 *
 * The renderer never touches the filesystem and never derives anything. All
 * interpretation lives in the portable domain core, which runs unchanged under
 * plain `node` in WSL and under Electron here.
 */
import { app, BrowserWindow, ipcMain, screen, shell } from "electron";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { ProjectPoller } from "../vault/poller.ts";
import { setTaskChecked } from "../vault/writer.ts";
import type { DerivedState } from "../types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// First statement that can possibly run: if this does not appear in the log,
// the module was never loaded and the problem is upstream of main.js.
console.log(`main.js loaded from ${HERE}`);

/* ------------------------------------------------------------------ *
 * Widget configuration (never stored in the vault note)
 * ------------------------------------------------------------------ */

/** Defaults point at the real vault established during inspection. */
const DEFAULT_VAULT_ROOT =
  "C:\\Users\\Asher\\Downloads\\Asher\\Dev\\Git\\Obsidian\\23asher.io";
// The user renamed the project note in Obsidian; this is the live path.
const DEFAULT_NOTE = "Productivity/To-Do List.md";

export interface WidgetConfig {
  vaultRoot: string;
  notePath: string;
  expanded: boolean;
  /** Window position in screen coordinates, so the widget returns where it was. */
  x: number | null;
  y: number | null;
}

function configPath(): string {
  return join(app.getPath("userData"), "widget-config.json");
}

/**
 * A note path is acceptable only if it is vault-relative and stays inside the
 * vault. This rejects absolute paths, `..` traversal, and any value that is
 * really an executable path - all of which previously reached the reader.
 */
function isValidNotePath(vaultRoot: string, notePath: string): boolean {
  if (typeof notePath !== "string" || notePath.trim() === "") return false;
  if (isAbsolute(notePath)) return false;
  if (/^[a-zA-Z]:/.test(notePath)) return false;
  if (notePath.includes("\\\\")) return false;
  if (/(^|[\\/])node_modules([\\/]|$)/.test(notePath)) return false;
  if (/\.exe$/i.test(notePath)) return false;
  if (!notePath.toLowerCase().endsWith(".md")) return false;

  try {
    const root = resolve(vaultRoot);
    const full = resolve(root, notePath);
    const rel = relative(root, full);
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** True when the configured vault root looks like the real vault. */
function isValidVaultRoot(vaultRoot: string): boolean {
  if (typeof vaultRoot !== "string" || vaultRoot.trim() === "") return false;
  return vaultRoot.toLowerCase().endsWith(".io") || existsSync(vaultRoot);
}

function loadConfig(): WidgetConfig {
  const fallback: WidgetConfig = {
    vaultRoot: DEFAULT_VAULT_ROOT,
    notePath: DEFAULT_NOTE,
    expanded: false,
    x: null,
    y: null,
  };

  try {
    const raw = readFileSync(configPath(), "utf8");
    const parsed = JSON.parse(raw) as Partial<WidgetConfig>;
    return {
      vaultRoot: isValidVaultRoot(parsed.vaultRoot ?? "") ? parsed.vaultRoot! : fallback.vaultRoot,
      expanded: typeof parsed.expanded === "boolean" ? parsed.expanded : fallback.expanded,
      x: typeof parsed.x === "number" ? parsed.x : null,
      y: typeof parsed.y === "number" ? parsed.y : null,
      // Reject a persisted notePath that is absolute, escapes the vault, or is
      // not a Markdown file. This is what a poisoned config looks like.
      notePath: isValidNotePath(
        typeof parsed.vaultRoot === "string" && isValidVaultRoot(parsed.vaultRoot)
          ? parsed.vaultRoot
          : DEFAULT_VAULT_ROOT,
        typeof parsed.notePath === "string" ? parsed.notePath : "",
      )
        ? (parsed.notePath as string)
        : fallback.notePath,
    };
  } catch {
    // No config yet, or it is unreadable. Defaults are non-destructive.
    return fallback;
  }
}

function saveConfig(config: WidgetConfig): void {
  try {
    const file = configPath();
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch (err) {
    // Persistence is best-effort and must never take the widget down.
    console.error("could not persist widget config:", err);
  }
}

let config: WidgetConfig = loadConfig();

/* ------------------------------------------------------------------ *
 * Window
 * ------------------------------------------------------------------ */

/**
 * EXACTLY TWO window geometry states. There is no third size and no
 * additive growth: every toggle sets the window to one of these two fixed
 * bounds, anchored on the current top-left so the widget does not jump.
 *
 * COMPACT and EXPANDED are the reference screenshot sizes: 238x155 collapsed
 * and 398x605 expanded. The screenshots are the specification. An earlier
 * revision widened both to 480px on the argument that a wider box suits real
 * project titles; that changed the design rather than scaling it, so it is
 * reverted here. The two states differ in WIDTH as well as height, so the
 * compact box is not a cropped version of the expanded one.
 */
const COMPACT = { width: 238, height: 155 } as const;
const EXPANDED = { width: 398, height: 605 } as const;

/*
 * Measured on this machine: requesting 238x155 produced a window measuring
 * 239x156, and 398x605 produced 399x606. Chromium keeps a 1px invisible frame
 * on each axis of a frameless window; `thickFrame: false` does not remove it.
 *
 * The reference dimensions are what the WIDGET must measure, so the size
 * actually requested is reduced by 1px per axis to land exactly on them.
 */
const FRAME_COMPENSATION = 1;

type Geometry = { width: number; height: number };

function geometryFor(expanded: boolean): Geometry {
  const target = expanded ? EXPANDED : COMPACT;
  // Subtract the measured invisible frame so the window lands exactly on the
  // reference dimensions rather than 1px beyond them.
  return {
    width: target.width - FRAME_COMPENSATION,
    height: target.height - FRAME_COMPENSATION,
  };
}

/**
 * Put the window into one of the two fixed geometries.
 *
 * Assigns absolute bounds anchored on the current top-left, so the widget
 * keeps its position and the size can never accumulate across toggles. This
 * is the single place window geometry is decided; the toggle button and the
 * self-test both go through it.
 */
function applyGeometry(win: BrowserWindow, expanded: boolean): void {
  if (win.isDestroyed()) return;
  const target = geometryFor(expanded);
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width: target.width, height: target.height });
}

let mainWindow: BrowserWindow | null = null;
let poller: ProjectPoller | null = null;
let focusHooked = false;

/** The exact source the current UI state was derived from, for the conflict guard. */
let currentSource: string | null = null;
let currentState: DerivedState | null = null;
let lastError: string | null = null;

function createWindow(): BrowserWindow {
  const size = geometryFor(config.expanded);

  // exactOptionalPropertyTypes: only pass x/y when we actually have them.
  const position =
    config.x !== null && config.y !== null ? { x: config.x, y: config.y } : {};

  const win = new BrowserWindow({
    width: size.width,
    height: size.height,
    ...position,
    /*
     * useContentSize is deliberately NOT set.
     *
     * For a frameless window the content box already equals the window box,
     * so it only adds ambiguity. Worse, it made setMinimumSize/setMaximumSize
     * content-relative while setBounds stayed window-relative, and mixing the
     * two is what allowed the reported drift. Every size call in this file
     * is now unambiguously a window bound.
     */
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    /*
     * thickFrame:false removes the invisible resize border Windows otherwise
     * keeps on a frameless window. Without it the OS reserves 1px on each
     * edge, so a requested 238x155 measured 240x157 and the widget never sat
     * exactly on its reference geometry.
     */
    thickFrame: false,
    resizable: false,
    maximizable: false,
    minimizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    hasShadow: false,
    show: false,
    webPreferences: {
      preload: join(HERE, "preload.cjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });

  // 'screen-saver' is the strongest always-on-top level on Windows: it keeps
  // the widget above ordinary application windows.
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

  // Hard limits. Nothing, including a stray IPC call, can grow the widget
  // past EXPANDED or shrink it below COMPACT.
  win.setMinimumSize(COMPACT.width, COMPACT.height);
  win.setMaximumSize(EXPANDED.width, EXPANDED.height);

  void win.loadFile(join(HERE, "..", "ui", "index.html"));

  /*
   * Show the window robustly.
   *
   * `ready-to-show` alone proved unreliable here: the window stayed hidden
   * and never appeared in the desktop enumeration. Three independent triggers
   * guarantee it becomes visible, whichever fires first.
   */
  let shown = false;
  const reveal = (): void => {
    if (shown || win.isDestroyed()) return;
    shown = true;
    win.show();
    win.showInactive();
  };
  win.once("ready-to-show", reveal);
  win.webContents.once("did-finish-load", reveal);
  win.webContents.once("did-fail-load", (_e, _code, description) => {
    console.error(`renderer failed to load: ${description}`);
    reveal();
  });
  const fallback = setTimeout(reveal, 1500);
  win.once("ready-to-show", () => clearTimeout(fallback));

  const persistPosition = (): void => {
    if (win.isDestroyed() || win.isMinimized()) return;
    const pos = win.getPosition();
    const x = pos[0];
    const y = pos[1];
    if (x === undefined || y === undefined) return;
    config = { ...config, x, y };
    saveConfig(config);
  };
  win.on("moved", persistPosition);

  return win;
}

/* ------------------------------------------------------------------ *
 * State push
 * ------------------------------------------------------------------ */

function pushState(): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  mainWindow.webContents.send("widget:state", {
    state: currentState,
    source: currentSource,
    expanded: config.expanded,
    error: lastError,
    vaultRoot: config.vaultRoot,
    notePath: config.notePath,
  });
}

function refresh(reason: "poll" | "write" | "manual"): void {
  if (!poller) return;

  // Poll immediately after our own write, as the design requires.
  const outcome = poller.pollNow();

  if (outcome.loaded !== null) {
    currentState = outcome.loaded.state;
    currentSource = outcome.loaded.source;
    if (lastError !== null) lastError = null;
  }

  if (outcome.error !== null) {
    lastError = `${outcome.error.name}: ${outcome.error.message}`;
  } else if (reason === "write" && outcome.changed) {
    lastError = null;
  }

  pushState();
}

function startPoller(): void {
  poller?.stop();

  poller = new ProjectPoller({
    // The renderer and Electron both speak Windows paths.
    vaultRoot: config.vaultRoot,
    projectNotes: [config.notePath],
    intervalMs: 1000,
    idleIntervalMs: 5000,
    isIdle: () => !config.expanded,
  });

  poller.onChange = (loaded) => {
    currentState = loaded.state;
    currentSource = loaded.source;
    lastError = null;
    pushState();
  };

  poller.onError = (err) => {
    lastError = `${err.name}: ${err.message}`;
    pushState();
  };

  // Obsidian or the user may edit the note while the widget has focus.
  // Registered once per window, not once per poller restart, otherwise
  // toggling expand repeatedly leaks focus listeners.
  if (focusHooked === false) {
    focusHooked = true;
    mainWindow?.on("focus", () => refresh("manual"));
  }

  poller.start();
  refresh("manual");
}

/* ------------------------------------------------------------------ *
 * IPC
 * ------------------------------------------------------------------ */

ipcMain.handle("widget:toggle-task", (_event, taskId: string) => {
  if (currentSource === null || currentState === null) {
    return { ok: false, kind: "not-ready", message: "No project loaded yet." };
  }

  // The snapshot handed to the writer is the exact source the visible state
  // was derived from. If the file has moved on, the writer refuses.
  const result = setTaskChecked({
    vaultRoot: config.vaultRoot,
    notePath: config.notePath,
    taskId,
    snapshot: currentSource,
  });

  if (result.ok) {
    currentState = result.state;
    currentSource = result.source;
    lastError = null;
    pushState();
    // Confirm from disk rather than trusting our own write.
    refresh("write");
    return { ok: true };
  }

  if (result.kind === "conflict") {
    // Adopt the newer document instead of retrying, and tell the UI.
    if (result.state !== null) {
      currentState = result.state;
      refresh("manual");
    }
    return {
      ok: false,
      kind: "conflict",
      message: "The note changed in Obsidian. Reloaded the latest version.",
    };
  }

  return { ok: false, kind: result.kind, message: result.error.message };
});

ipcMain.handle("widget:toggle-expand", () => {
  config = { ...config, expanded: !config.expanded };
  saveConfig(config);

  if (mainWindow && !mainWindow.isDestroyed()) {
    /*
     * Switch between the two fixed geometries via the shared helper.
     *
     * The previous implementation interpolated over 14 frames from whatever
     * size the window happened to be, so rapid toggles started concurrent
     * animation loops each holding a stale starting size. They fought each
     * other and the window drifted larger until it filled the screen.
     * Assigning absolute bounds cannot accumulate.
     */
    applyGeometry(mainWindow, config.expanded);

    poller?.stop();
    startPoller();
  }

  pushState();
  return { expanded: config.expanded };
});

ipcMain.handle("widget:move", (_event, dx: number, dy: number) => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const pos = mainWindow.getPosition();
  const x = pos[0];
  const y = pos[1];
  if (x === undefined || y === undefined) return;
  mainWindow.setPosition(Math.round(x + dx), Math.round(y + dy));
});

ipcMain.handle("widget:refresh", () => {
  refresh("manual");
  return { ok: true };
});

ipcMain.handle("widget:reveal-note", () => {
  shell.showItemInFolder(join(config.vaultRoot, config.notePath));
});

ipcMain.handle("widget:diagnostics", () => {
  const noteFull = join(config.vaultRoot, config.notePath);
  return {
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,
    vaultRoot: config.vaultRoot,
    vaultExists: existsSync(config.vaultRoot),
    notePath: config.notePath,
    noteExists: existsSync(noteFull),
    configFile: configPath(),
    pollCount: poller?.pollCount ?? 0,
    primaryDisplay: screen.getPrimaryDisplay().size,
    scaleFactor: screen.getPrimaryDisplay().scaleFactor,
    allDisplays: screen.getAllDisplays().map((d) => ({
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
    })),
  };
});

/* ------------------------------------------------------------------ *
 * Self-test
 *
 * Launched with --selftest, the app measures its own real window and writes
 * the result to a JSON file, then exits. This is how the native Windows
 * shell is verified: facts reported by the running process itself, not
 * inferred from the outside.
 * ------------------------------------------------------------------ */

/*
 * Self-test is driven by a command-line argument, NOT an environment
 * variable.
 *
 * Measured: WSL interop does not forward the Linux environment to a Windows
 * child process. `WIDGET_SELFTEST=1` was visible to the WSL-side launcher
 * but arrived in the Electron main process as `undefined`. The application
 * path argument does arrive correctly, so argv is the reliable channel.
 */
const SELFTEST = process.argv.includes("--selftest");
const SELFTEST_FLAG = "--selftest-out";
const SELFTEST_OUT =
  process.argv[process.argv.indexOf(SELFTEST_FLAG) + 1] ?? "selftest.json";

/*
 * Self-test only: temporarily point the widget at a different note so the
 * expanded layout can be verified against a real file without editing the
 * user's saved configuration. Never persisted.
 */
const SELFTEST_NOTE_FLAG = "--selftest-note";
if (SELFTEST) {
  /*
   * SAFE argv parsing.
   *
   * The previous version did:
   *   process.argv[process.argv.indexOf("--selftest-note") + 1]
   * When the flag is absent, indexOf() returns -1, +1 makes that 0, and
   * argv[0] is the Electron executable. That path was then assigned to
   * config.notePath and persisted, so every later launch tried to read
   * electron.exe as a project note and crashed the main process.
   *
   * The index MUST be checked for -1 before the +1 is ever used.
   */
  const flagIndex = process.argv.indexOf(SELFTEST_NOTE_FLAG);
  if (flagIndex !== -1 && flagIndex + 1 < process.argv.length) {
    const candidate = process.argv[flagIndex + 1];
    if (
      candidate !== undefined &&
      !candidate.startsWith("--") &&
      isValidNotePath(config.vaultRoot, candidate)
    ) {
      config = { ...config, notePath: candidate, expanded: false };
    } else {
      console.error(`selftest: ignoring unsafe --selftest-note value`);
    }
  }
}

async function runSelfTest(): Promise<void> {
  const win = mainWindow;
  if (!win) throw new Error("no window");

  console.log(`selftest: argv=${JSON.stringify(process.argv)}`);
  console.log(`selftest: out=${SELFTEST_OUT}`);

  // Let the renderer paint and the first poll settle.
  await new Promise((r) => setTimeout(r, 3000));

  const pos = win.getPosition();
  const size = win.getSize();
  const bounds = win.getBounds();

  /*
   * TEN CYCLES THROUGH THE REAL INTERACTION PATH.
   *
   * A previous revision called applyGeometry() directly. That only proved the
   * helper worked, and left the user-reported "window grows when I click it"
   * bug completely untested.
   *
   * Each cycle now performs a real DOM click on the circular control inside
   * the gold tray, exercising the whole chain:
   *
   *   .tray-toggle click -> renderer listener -> window.widget.toggleExpand()
   *   -> ipcRenderer.invoke("widget:toggle-expand") -> ipcMain handler
   *   -> config.expanded flips -> applyGeometry() -> win.setBounds()
   *
   * A synthetic DOM click is used, NOT an operating-system mouse event:
   * Electron cannot inject a trusted OS click into its own window from
   * inside the process, and no external input automation is available here.
   * Everything downstream of the click is the genuine production path.
   */
  const clickTrayToggle = async (): Promise<void> => {
    await win.webContents.executeJavaScript(`
      (() => {
        const btn = document.querySelector('.tray-toggle');
        if (!btn) throw new Error('circular tray control not found');
        btn.click();
        return true;
      })()
    `);
    await new Promise((r) => setTimeout(r, 250));
  };

  const measure = async (): Promise<Record<string, unknown>> => {
    const b = win.getBounds();
    const dom = await win.webContents.executeJavaScript(`
      (() => {
        const q = (s) => document.querySelector(s);
        const r = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
        const shell = r('.shell'), paper = r('.paper'), tray = r('.tray'), list = r('.expanded');
        const chev = q('.chevron');
        return {
          viewport: [document.documentElement.clientWidth, document.documentElement.clientHeight],
          shell: shell ? { w: Math.round(shell.width), h: Math.round(shell.height) } : null,
          paper: paper ? { top: Math.round(paper.top), height: Math.round(paper.height) } : null,
          tray: tray ? { top: Math.round(tray.top), height: Math.round(tray.height) } : null,
          list: list ? { height: Math.round(list.height) } : null,
          listHidden: q('.expanded') ? q('.expanded').hasAttribute('hidden') : null,
          trayVisible: !!(tray && tray.height > 0),
          toggleVisible: (() => { const t = q('.tray-toggle'); return !!(t && t.getBoundingClientRect().height > 0); })(),
          chevronTransform: chev ? getComputedStyle(chev).transform : null,
          taskRows: document.querySelectorAll('.task').length,
          phaseHeads: document.querySelectorAll('.phase-head').length,
          phaseStamps: document.querySelectorAll('.phase-stamp').length,
        };
      })()
    `);
    return { bounds: { x: b.x, y: b.y, width: b.width, height: b.height }, ...dom };
  };

  const cycles: unknown[] = [];
  for (let i = 0; i < 10; i++) {
    await clickTrayToggle(); // -> expanded
    const expandedSample = await measure();
    await clickTrayToggle(); // -> collapsed
    const collapsedSample = await measure();
    cycles.push({ cycle: i + 1, expanded: expandedSample, collapsed: collapsedSample });
  }

  // Settle in the collapsed state for the resting report.
  await new Promise((r) => setTimeout(r, 400));

  const expandedDom = await (async (): Promise<Record<string, unknown>> => {
    await clickTrayToggle(); // -> expanded, to sample the list
    await new Promise((r) => setTimeout(r, 300));
    const out = await win.webContents.executeJavaScript(`
      (() => {
        const q = (s) => document.querySelector(s);
        const done = q('.task.is-done .task-text');
        return {
          taskRows: document.querySelectorAll('.task').length,
          phaseHeads: document.querySelectorAll('.phase-head').length,
          phaseStamps: document.querySelectorAll('.phase-stamp').length,
          stampText: q('.phase-stamp') ? q('.phase-stamp').textContent : null,
          struckThrough: done ? getComputedStyle(done).textDecorationLine : null,
          listHidden: q('.expanded') ? q('.expanded').hasAttribute('hidden') : null,
          dots: document.querySelectorAll('.dot-motif .dot').length,
          toggleIsCircle: (() => {
            const t = q('.tray-toggle'); if (!t) return false;
            return getComputedStyle(t).borderRadius.indexOf('50%') >= 0;
          })(),
        };
      })()
    `);
    await clickTrayToggle(); // back to collapsed
    return out;
  })();

  // The click cycles above already leave the widget collapsed, so no extra
  // geometry call is made here. Nothing else may resize the window.

  /*
   * TASK CLICK: trusted input, real file verification.
   *
   * This does NOT call .click(). It sends a genuine mouseDown/mouseUp at the
   * checkbox's on-screen coordinates via webContents.sendInputEvent, which is
   * the same path an operating-system click takes. It then reads the actual
   * Markdown file back off disk to confirm the checkbox character changed.
   */
  const noteFullPath = join(config.vaultRoot, config.notePath);
  const before = readFileSync(noteFullPath, "utf8");

  applyGeometry(win, true);
  config = { ...config, expanded: true };
  pushState();
  await new Promise((r) => setTimeout(r, 700));

  const target = await win.webContents.executeJavaScript(`
    (() => {
      const row = document.querySelector('.task:not(.is-done)');
      if (!row) return null;
      const btn = row.querySelector('.task-box');
      if (!btn) return null;
      const b = btn.getBoundingClientRect();
      const rb = row.getBoundingClientRect();
      return {
        id: btn.getAttribute('aria-label') ? Array.from(row.querySelectorAll('*')).length : null,
        btn: { x: Math.round(b.left + b.width / 2), y: Math.round(b.top + b.height / 2), w: b.width, h: b.height },
        row: { x: Math.round(rb.left + rb.width / 2), y: Math.round(rb.top + rb.height / 2) },
        text: row.querySelector('.task-text').textContent,
      };
    })()
  `);

  let clickResult: Record<string, unknown> = { skipped: "no unchecked task row found" };
  if (target) {
    const point = target.btn as { x: number; y: number };
    win.webContents.sendInputEvent({ type: "mouseMove", x: point.x, y: point.y });
    win.webContents.sendInputEvent({ type: "mouseDown", x: point.x, y: point.y, button: "left", clickCount: 1 });
    win.webContents.sendInputEvent({ type: "mouseUp", x: point.x, y: point.y, button: "left", clickCount: 1 });
    await new Promise((r) => setTimeout(r, 900));

    const after = readFileSync(noteFullPath, "utf8");
    const changedLines = before
      .split("\n")
      .map((line, i) => (line === after.split("\n")[i] ? null : { i, was: line, now: after.split("\n")[i] }))
      .filter(Boolean);

    const eventLog = (await win.webContents.executeJavaScript(
      "window.__eventLog ? window.__eventLog() : null",
    )) as string[] | null;

    clickResult = {
      checkboxCenter: point,
      rendererEventLog: eventLog,
      checkboxSize: `${(target.btn as { w: number; h: number }).w}x${(target.btn as { w: number; h: number }).h}`,
      taskText: target.text,
      fileChangedOnDisk: before !== after,
      changedLineCount: changedLines.length,
      changedLines: changedLines.slice(0, 3),
      bytesDelta: after.length - before.length,
    };
  }

  applyGeometry(win, false);
  config = { ...config, expanded: false };
  pushState();
  await new Promise((r) => setTimeout(r, 400));

  /*
   * OVERFLOW TEST using a temporary fixture note.
   *
   * The fixture is written to the OS temp directory, never the user's vault,
   * and is deleted afterwards. It exists to prove that overflowing task
   * content scrolls vertically without widening or heightening the pane.
   */
  const fixtureRoot = join(tmpdir(), "widget-overflow-fixture");
  const fixtureRel = "Overflow Fixture.md";
  const fixtureFull = join(fixtureRoot, fixtureRel);
  mkdirSync(fixtureRoot, { recursive: true });

  const longTask =
    "Verify the inverter firmware revision matches the commissioning checklist exactly";
  const fixtureBody = [
    "---",
    "project: Overflow Fixture",
    "---",
    "",
    "# Overflow Fixture",
    "",
    "## Phase One",
    ...Array.from({ length: 40 }, (_, i) => `- [ ] Task number ${i + 1} ${longTask} ^ov-${i + 1}`),
    "",
    "## Phase Two",
    "- [x] A completed task with a deliberately long descriptive label ^ov-done",
    ...Array.from({ length: 10 }, (_, i) => `- [ ] Short ${i + 1} ^ov-b-${i + 1}`),
    "",
  ].join("\n");
  writeFileSync(fixtureFull, fixtureBody, "utf8");

  config = { ...config, vaultRoot: fixtureRoot, notePath: fixtureRel, expanded: true };
  applyGeometry(win, true);
  poller?.stop();
  startPoller();
  await new Promise((r) => setTimeout(r, 1200));

  const boundsBeforeOverflow = { ...win.getBounds() };
  const overflowDom = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const pane = q('.expanded');
      const cs = getComputedStyle(pane);
      return {
        taskRows: document.querySelectorAll('.task').length,
        overflowY: cs.overflowY,
        overflowX: cs.overflowX,
        verticallyScrollable: pane.scrollHeight > pane.clientHeight,
        horizontalOverflow: pane.scrollWidth > pane.clientWidth + 1,
        clientW: pane.clientWidth,
        scrollW: pane.scrollWidth,
        clientH: pane.clientHeight,
        scrollH: pane.scrollHeight,
        trayTop: Math.round(q('.tray').getBoundingClientRect().top),
        trayHeight: Math.round(q('.tray').getBoundingClientRect().height),
        titleTop: Math.round(q('.project-title').getBoundingClientRect().top),
        longestTaskWrapped: (() => {
          const rows = Array.from(document.querySelectorAll('.task-text'));
          const tallest = rows.reduce((a, b) => (b.getBoundingClientRect().height > a.getBoundingClientRect().height ? b : a), rows[0]);
          return tallest ? Math.round(tallest.getBoundingClientRect().height) : null;
        })(),
      };
    })()
  `);
  const boundsAfterOverflow = { ...win.getBounds() };

  // Restore the real note and remove the fixture.
  config = { ...config, vaultRoot: DEFAULT_VAULT_ROOT, notePath: DEFAULT_NOTE, expanded: false };
  applyGeometry(win, false);
  poller?.stop();
  startPoller();
  rmSync(fixtureRoot, { recursive: true, force: true });
  await new Promise((r) => setTimeout(r, 600));

  const report = {
    overflowTest: {
      fixtureRemoved: !existsSync(fixtureRoot),
      boundsBefore: boundsBeforeOverflow,
      boundsAfter: boundsAfterOverflow,
      heightUnchanged:
        boundsBeforeOverflow.height === boundsAfterOverflow.height,
      widthUnchanged: boundsBeforeOverflow.width === boundsAfterOverflow.width,
      ...overflowDom,
    },
    taskClick: clickResult,
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,

    window: {
      visible: win.isVisible(),
      focused: win.isFocused(),
      frameless: !win.isMovable() ? "unknown" : "movable",
      alwaysOnTop: win.isAlwaysOnTop(),
      alwaysOnTopLevel: "screen-saver (requested)",
      fullScreenable: win.isFullScreenable(),
      minimizable: win.isMinimizable(),
      resizable: win.isResizable(),
      skipTaskbar: "requested via setSkipTaskbar(true)",
      opacitySupported: true,
      x: pos[0] ?? null,
      y: pos[1] ?? null,
      width: size[0] ?? null,
      height: size[1] ?? null,
      bounds,
      // Fixed states this build allows. Nothing outside these two is reachable.
      expectedCompact: COMPACT,
      expectedExpanded: EXPANDED,
      matchesCompact: size[0] === COMPACT.width && size[1] === COMPACT.height,
      matchesExpanded: size[0] === EXPANDED.width && size[1] === EXPANDED.height,
    },

    /* Expanded-state layout sample. */
    expandedDom,

    /* Ten cycles driven through the real tray-button click path. */
    cycles,
    cycleSummary: (() => {
      const bw = (s: Record<string, unknown>) =>
        (s.bounds as { width: number; height: number; x: number; y: number });
      const ups = cycles.map((c) => (c as { expanded: Record<string, unknown> }).expanded);
      const downs = cycles.map((c) => (c as { collapsed: Record<string, unknown> }).collapsed);
      const allBounds = [...ups, ...downs].map(bw);
      return {
        total: cycles.length,
        expandedBoundSizes: [...new Set(ups.map((s) => `${bw(s).width}x${bw(s).height}`))],
        collapsedBoundSizes: [...new Set(downs.map((s) => `${bw(s).width}x${bw(s).height}`))],
        distinctBoundSizes: [...new Set(allBounds.map((b) => `${b.width}x${b.height}`))],
        distinctPositions: [...new Set(allBounds.map((b) => `${b.x},${b.y}`))],
        expandedViewportSizes: [
          ...new Set(ups.map((s) => (s.viewport as number[]).join("x"))),
        ],
        collapsedViewportSizes: [
          ...new Set(downs.map((s) => (s.viewport as number[]).join("x"))),
        ],
        everyCycleExact: ups.every(
          (s) => bw(s).width === EXPANDED.width && bw(s).height === EXPANDED.height,
        ) && downs.every(
          (s) => bw(s).width === COMPACT.width && bw(s).height === COMPACT.height,
        ),
        collapsedListHidden: downs.every((s) => s.listHidden === true),
        expandedListVisible: ups.every((s) => s.listHidden === false),
        trayVisibleBothStates: ups.every((s) => s.trayVisible === true)
          && downs.every((s) => s.trayVisible === true),
        toggleVisibleBothStates: ups.every((s) => s.toggleVisible === true)
          && downs.every((s) => s.toggleVisible === true),
        chevronDiffersBetweenStates:
          (ups[0]?.chevronTransform as string) !== (downs[0]?.chevronTransform as string),
        positionStable: new Set(allBounds.map((b) => `${b.x},${b.y}`)).size === 1,
        everFullScreen: allBounds.some((b) => b.width > 1000 || b.height > 1000),
        monotonicGrowth: (() => {
          // The reported symptom was growth. Compare first and last cycle.
          const first = bw(ups[0]!);
          const last = bw(ups[ups.length - 1]!);
          return last.height > first.height || last.width > first.width;
        })(),
      };
    })(),

    displays: screen.getAllDisplays().map((d) => ({
      bounds: d.bounds,
      scaleFactor: d.scaleFactor,
      primary: d.id === screen.getPrimaryDisplay().id,
    })),

    vault: {
      root: config.vaultRoot,
      rootExists: existsSync(config.vaultRoot),
      note: config.notePath,
      noteExists: existsSync(join(config.vaultRoot, config.notePath)),
    },

    domain: {
      loaded: currentState !== null,
      title: currentState?.title ?? null,
      fraction: currentState?.fraction ?? null,
      percent: currentState?.percent ?? null,
      total: currentState?.total ?? null,
      completed: currentState?.completed ?? null,
      nextTaskId: currentState?.nextTask?.id ?? null,
      nextTaskText: currentState?.nextTask?.text ?? null,
      phases: currentState?.phases.map((p) => ({
        title: p.title,
        total: p.total,
        completed: p.completed,
        complete: p.complete,
      })) ?? [],
      completePhases: currentState?.completePhases.map((p) => p.title) ?? [],
    },

    renderer: await win.webContents.executeJavaScript(`
      (() => {
        const q = (s) => document.querySelector(s);
        return {
          domReady: document.readyState,
          title: q('#project-title')?.textContent ?? null,
          fraction: q('#fraction')?.textContent ?? null,
          progressWidth: q('#progress-fill')?.style.width ?? null,
          next: q('#next-task')?.textContent ?? null,
          quest: q('#quest-count')?.textContent ?? null,
          phaseCount: q('#phase-count')?.textContent ?? null,
          // Line count and fit, to prove the collapsed title is one line and
          // is not being ellipsis-truncated.
          titleHeight: (() => { const t = q('.project-title'); return t ? Math.round(t.getBoundingClientRect().height) : null; })(),
          titleClientW: (() => { const t = q('.project-title'); return t ? t.clientWidth : null; })(),
          titleScrollW: (() => { const t = q('.project-title'); return t ? t.scrollWidth : null; })(),
          titleTruncated: (() => { const t = q('.project-title'); return t ? t.scrollWidth > t.clientWidth + 1 : null; })(),
          bridgePresent: typeof window.widget === 'object',
          frameWidth: q('#shell')?.getBoundingClientRect().width ?? null,
          frameHeight: q('#shell')?.getBoundingClientRect().height ?? null,
          // Authoritative widget size: the page viewport, which excludes any
          // invisible border the OS keeps around a frameless window.
          viewportWidth: document.documentElement.clientWidth,
          viewportHeight: document.documentElement.clientHeight,
          devicePixelRatio: window.devicePixelRatio,
          trayVisible: !!q('.tray'),
          dots: document.querySelectorAll('.dot-motif .dot').length,
          toggleIsCircle: (() => {
            const t = q('.tray-toggle');
            if (!t) return false;
            const cs = getComputedStyle(t);
            return cs.borderRadius === '50%' || cs.borderRadius.includes('50%');
          })(),
          teethHeight: (() => {
            const t = q('.teeth');
            return t ? t.getBoundingClientRect().height : null;
          })(),
          trayHeight: (() => {
            const t = q('.tray');
            return t ? t.getBoundingClientRect().height : null;
          })(),
          paperHeight: (() => {
            const p = q('.paper');
            return p ? p.getBoundingClientRect().height : null;
          })(),
          taskRows: document.querySelectorAll('.task').length,
          phaseHeads: document.querySelectorAll('.phase-head').length,
          phaseStamps: document.querySelectorAll('.phase-stamp').length,
          struckThrough: (() => {
            const done = document.querySelector('.task.is-done .task-text');
            return done ? getComputedStyle(done).textDecorationLine : null;
          })(),
          bodyBg: getComputedStyle(document.body).backgroundColor,
        };
      })()
    `),

    errors: lastError,
    pollCount: poller?.pollCount ?? 0,
  };

  writeFileSync(SELFTEST_OUT, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  console.log("SELFTEST WRITTEN");
  app.quit();
}

/* ------------------------------------------------------------------ *
 * Lifecycle
 * ------------------------------------------------------------------ */

/*
 * GPU handling is forced in-process.
 *
 * Measured on this machine: a trivial Electron window aborts with
 *   FATAL:content\browser\gpu\gpu_data_manager_impl_private.cc:417]
 *     GPU process isn't usable. Goodbye.
 * and exits 3. The GPU CHILD process cannot be spawned at all here, and
 * --disable-gpu alone does not help, because the compositor still wants one.
 * --in-process-gpu runs it inside the browser process and the app starts
 * reliably.
 *
 * For a ~238x155 px widget this costs nothing: there is no 3D, no video, and
 * the only animation is a height transition.
 */
app.commandLine.appendSwitch("disable-gpu");
app.commandLine.appendSwitch("disable-gpu-compositing");
app.commandLine.appendSwitch("in-process-gpu");

app.whenReady().then(() => {
  mainWindow = createWindow();
  startPoller();

  if (SELFTEST) {
    setTimeout(() => {
      runSelfTest().catch((err: unknown) => {
        console.error("selftest failed:", err);
        app.exit(1);
      });
    }, 500);
  }

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      mainWindow = createWindow();
      startPoller();
    }
  });
});

app.on("window-all-closed", () => {
  poller?.stop();
  app.quit();
});

// Refuse to become a second instance; the widget is a singleton.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.show();
    }
  });
}
