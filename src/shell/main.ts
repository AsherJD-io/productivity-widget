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
 * MEASURED, not assumed. A probe on this machine (scripts/geom-content.mjs,
 * display scaleFactor 1.25) recorded, for a frameless transparent window:
 *
 *   request 238x155  ->  size 239x156  content 239x156  inner 239x156
 *   request 398x605  ->  size 399x606  content 399x606  inner 399x606
 *
 * Two facts follow, and both matter:
 *
 * 1. getContentSize() === getSize() for this window. There is NO outer frame
 *    to subtract: the content box and the window box are the same rectangle.
 *    So "use content semantics" and "use window semantics" are the SAME
 *    coordinate system here, and mixing them was never the fault.
 *
 * 2. Requesting N produces N+1. Chromium reserves a 1px invisible border on a
 *    frameless window and `thickFrame: false` does not remove it. This is a
 *    real, constant inset at this display scale, so it is subtracted once, in
 *    one place, to land the renderer on the reference dimensions exactly.
 *
 * The previous note claimed this constant was "stale". It was not. It is
 * exactly what makes 238x155 come out as 238x155. The real fault is recorded
 * on applyGeometry below.
 */
const FRAME_INSET = 1;

type Geometry = { width: number; height: number };

/**
 * Convert a CONTENT target into the WINDOW size that must be requested to make
 * the renderer measure that target. This is the only conversion in the file.
 */
function geometryFor(expanded: boolean): Geometry {
  const target = expanded ? EXPANDED : COMPACT;
  return {
    width: target.width - FRAME_INSET,
    height: target.height - FRAME_INSET,
  };
}

/**
 * Put the window into one of the two fixed geometries.
 *
 * This is the single place window geometry is decided. The constructor, the
 * toggle button and the self-test all go through it, which is the whole fix:
 *
 * THE ACTUAL BUG. The BrowserWindow constructor path and the setBounds path
 * are not equivalent on Windows. Constructing a frameless window below
 * Windows' minimum frameless size is silently CLAMPED UP: a request of
 * 237x154 came back as 242x159. Nothing re-applied geometry after load, so
 * the widget rested at 242x156 - about 4px wider than the reference - and the
 * paper was clipped on the right. Toggling worked, because setBounds is not
 * clamped, so the two paths disagreed: rest 242x156, toggled 238x155.
 *
 * Constructing with `useContentSize: true` does NOT avoid the clamp - it was
 * measured and returns identical numbers. The clamp is Windows-side, so the
 * fix is to stop trusting the constructor and re-assert geometry once the
 * window exists, which applyGeometryAfterLoad does.
 *
 * Bounds are absolute and anchored on the current top-left, so the widget
 * keeps its position and the size can never accumulate across toggles.
 */
function applyGeometry(win: BrowserWindow, expanded: boolean): void {
  if (win.isDestroyed()) return;
  const target = geometryFor(expanded);
  const b = win.getBounds();
  win.setBounds({ x: b.x, y: b.y, width: target.width, height: target.height });
}

/**
 * Re-assert geometry once the native window actually exists.
 *
 * Called after creation and again after the first paint, because the
 * constructor's clamped size is what produced the right-edge clipping.
 */
function applyGeometryAfterLoad(win: BrowserWindow, expanded: boolean): void {
  applyGeometry(win, expanded);
  if (win.isDestroyed()) return;
  win.webContents.once("did-finish-load", () => applyGeometry(win, expanded));
  // Belt and braces: the clamp is applied during native window creation, so a
  // second assertion after the first frame rules out any ordering surprise.
  setTimeout(() => applyGeometry(win, expanded), 250);
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
    /*
     * COMPACT and EXPANDED are CONTENT (renderer) dimensions, so the window is
     * declared in content terms and every size call in this file is converted
     * by the single geometryFor() helper. One coherent model: content in,
     * window request out, no ad-hoc pixel arithmetic anywhere else.
     */
    useContentSize: true,
    width: size.width,
    height: size.height,
    ...position,
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
  //
  // Set in the SAME coordinate system as every other size call here: the
  // window request produced by geometryFor(), i.e. already inset by
  // FRAME_INSET. Using the raw COMPACT/EXPANDED content numbers would set a
  // limit one pixel looser than the geometry that must satisfy it, which is
  // precisely the kind of unit mismatch this file previously had.
  const min = geometryFor(false);
  const max = geometryFor(true);
  win.setMinimumSize(min.width, min.height);
  win.setMaximumSize(max.width, max.height);

  /*
   * Re-assert geometry now and after load.
   *
   * The constructor's size is clamped up by Windows (237x154 -> 242x159) and
   * never corrected, which left the widget resting ~4px too wide with the
   * paper clipped on the right. These calls are what fix the reported bug.
   */
  applyGeometryAfterLoad(win, config.expanded);

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
    autostart: loginItemState(),
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
          // Authoritative renderer size, recorded explicitly. The CONTENT
          // target must match this, not getSize().
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
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
          /*
           * Native drag regions, asserted from computed style rather than
           * assumed from the stylesheet. Exactly one drag path must exist: the
           * native one. Interactive elements must opt OUT of it.
           */
          dragRegions: (() => {
            const region = (sel) => {
              const el = q(sel);
              if (!el) return null;
              const r = el.getBoundingClientRect();
              return {
                region: getComputedStyle(el).webkitAppRegion || 'none',
                visible: r.width > 0 && r.height > 0,
              };
            };
            return {
              // MUST be draggable.
              shell: region('.shell'),
              paperHead: region('.paper-head'),
              // MUST NOT be draggable.
              task: region('.task'),
              taskBox: region('.task-box'),
              taskText: region('.task-text'),
              tray: region('.tray'),
              trayToggle: region('.tray-toggle'),
              expandedPane: region('.expanded'),
            };
          })(),
        };
      })()
    `);
    return {
      bounds: { x: b.x, y: b.y, width: b.width, height: b.height },
      getSize: win.getSize(),
      getContentSize: win.getContentSize(),
      ...dom,
    };
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
   * TASK CLICK: trusted input, real file verification, ISOLATED FIXTURE.
   *
   * This does NOT call .click(). It sends a genuine mouseDown/mouseUp at the
   * checkbox's on-screen coordinates via webContents.sendInputEvent, which is
   * the same path an operating-system click takes, then reads the Markdown
   * file back off disk to confirm the checkbox character changed.
   *
   * It runs against a TEMPORARY FIXTURE, never the user's real note.
   *
   * This was a real defect, not a theoretical one. The previous revision ran
   * this test against the live configured note, so every self-test run ticked
   * a real task off the user's To-Do List. Two of the user's tasks were
   * checked off this way and had to be reverted by hand. The writer path is
   * unchanged and still fully exercised; only the target file is now a
   * throwaway in tmpdir(), exactly as the overflow test already does.
   */
  const clickRoot = join(tmpdir(), "widget-click-fixture");
  const clickRel = "Click Fixture.md";
  const clickFullPath = join(clickRoot, clickRel);
  mkdirSync(clickRoot, { recursive: true });
  writeFileSync(
    clickFullPath,
    [
      "---",
      "project: Click Fixture",
      "---",
      "",
      "# Click Fixture",
      "",
      "## Phase One",
      "- [ ] Isolated click-path task that must never touch the real note ^clk-01",
      "- [ ] A second isolated task ^clk-02",
      "",
    ].join("\n"),
    "utf8",
  );

  const realVault = { vaultRoot: config.vaultRoot, notePath: config.notePath };
  /*
   * Snapshot of the real note taken BEFORE the click test, so the report can
   * prove the click never touched it. Read once, here, for that assertion
   * only; the click itself targets the fixture.
   */
  const REAL_NOTE_SNAPSHOT = readFileSync(
    join(realVault.vaultRoot, realVault.notePath),
    "utf8",
  );
  config = { ...config, vaultRoot: clickRoot, notePath: clickRel, expanded: true };
  poller?.stop();
  startPoller();

  const before = readFileSync(clickFullPath, "utf8");
  applyGeometry(win, true);
  pushState();
  await new Promise((r) => setTimeout(r, 900));

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

    const after = readFileSync(clickFullPath, "utf8");
    const changedLines = before
      .split("\n")
      .map((line, i) => (line === after.split("\n")[i] ? null : { i, was: line, now: after.split("\n")[i] }))
      .filter(Boolean);

    const eventLog = (await win.webContents.executeJavaScript(
      "window.__eventLog ? window.__eventLog() : null",
    )) as string[] | null;

    clickResult = {
      /* Proves the click went to the fixture, never the user's note. */
      fixturePath: clickFullPath,
      realNoteUntouched:
        !realVault.notePath.includes("Click Fixture") &&
        readFileSync(join(realVault.vaultRoot, realVault.notePath), "utf8") ===
          REAL_NOTE_SNAPSHOT,
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

  config = { ...config, ...realVault, expanded: false };
  rmSync(clickRoot, { recursive: true, force: true });
  applyGeometry(win, false);
  pushState();
  poller?.stop();
  startPoller();
  await new Promise((r) => setTimeout(r, 600));

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
  const rendererBeforeOverflow = await win.webContents.executeJavaScript(
    "[window.innerWidth, window.innerHeight]",
  ) as number[];
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
  const rendererAfterOverflow = await win.webContents.executeJavaScript(
    "[window.innerWidth, window.innerHeight]",
  ) as number[];

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
      // Judge fixed size on the RENDERER, for the same reason as above.
      rendererBefore: rendererBeforeOverflow,
      rendererAfter: rendererAfterOverflow,
      rendererSizeFixed: rendererBeforeOverflow.join("x") === rendererAfterOverflow.join("x"),
      ...overflowDom,
    },
    taskClick: { ...clickResult, fixtureRemoved: !existsSync(clickRoot) },
    electron: process.versions.electron,
    chrome: process.versions.chrome,
    node: process.versions.node,
    platform: process.platform,
    arch: process.arch,

    window: {
      visible: win.isVisible(),
      focused: win.isFocused(),
      alwaysOnTop: win.isAlwaysOnTop(),
      fullScreenable: win.isFullScreenable(),
      minimizable: win.isMinimizable(),
      resizable: win.isResizable(),
      x: pos[0] ?? null,
      y: pos[1] ?? null,
      /*
       * Resting state, captured after all geometry has settled. This is the
       * figure that exposed the bug: the constructor clamped the window up to
       * 242x156 and nothing corrected it, so the widget rested ~4px wider than
       * its content target and clipped the paper on the right.
       */
      getSize: win.getSize(),
      getContentSize: win.getContentSize(),
      bounds,
      renderer: {
        innerWidth: await win.webContents.executeJavaScript("window.innerWidth"),
        innerHeight: await win.webContents.executeJavaScript("window.innerHeight"),
        clientWidth: await win.webContents.executeJavaScript(
          "document.documentElement.clientWidth",
        ),
        clientHeight: await win.webContents.executeJavaScript(
          "document.documentElement.clientHeight",
        ),
        devicePixelRatio: await win.webContents.executeJavaScript("window.devicePixelRatio"),
        /*
         * The reported symptom, measured rather than eyeballed: does the paper
         * fit inside the viewport, with its right casing visible rather than
         * clipped past the right edge?
         */
        paperRightCasingVisible: await win.webContents.executeJavaScript(
          "(() => { const p = document.querySelector('.paper'); if (!p) return null;" +
            " const r = p.getBoundingClientRect();" +
            " return { paperRight: Math.round(r.right), viewportWidth: document.documentElement.clientWidth," +
          " clippedRight: r.right > document.documentElement.clientWidth + 0.5 }; })()",
        ),
      },
      expectedCompact: COMPACT,
      expectedExpanded: EXPANDED,
      /*
       * The gate that matters: does the RENDERER measure the content target?
       * getSize() is the native window rect and is expected to be 1px larger
       * per axis on this display; it is recorded, not asserted.
       */
      restRendererMatchesCompact: config.expanded
        ? false
        : (await win.webContents.executeJavaScript(
            "window.innerWidth === 238 && window.innerHeight === 155",
          )) === true,
      frameInset: FRAME_INSET,
    },

    /* Expanded-state layout sample. */
    expandedDom,

    /* Ten cycles driven through the real tray-button click path. */
    cycles,
    cycleSummary: (() => {
      /*
       * Judged on the RENDERER's own dimensions, not on getBounds().
       *
       * getBounds() is the native window rect and legitimately differs from
       * the content target by the measured 1px invisible border. Asserting
       * bounds against a content target is a category error, and it is what
       * made this report read "not matching" while the renderer was in fact
       * exactly on target. innerWidth/innerHeight is the authoritative figure.
       */
      const inner = (s: Record<string, unknown>) =>
        `${s.innerWidth}x${s.innerHeight}`;
      const bw = (s: Record<string, unknown>) =>
        (s.bounds as { width: number; height: number; x: number; y: number });
      const ups = cycles.map((c) => (c as { expanded: Record<string, unknown> }).expanded);
      const downs = cycles.map((c) => (c as { collapsed: Record<string, unknown> }).collapsed);
      const allBounds = [...ups, ...downs].map(bw);
      const COMPACT_S = `${COMPACT.width}x${COMPACT.height}`;
      const EXPANDED_S = `${EXPANDED.width}x${EXPANDED.height}`;
      return {
        total: cycles.length,
        expandedRendererSizes: [...new Set(ups.map(inner))],
        collapsedRendererSizes: [...new Set(downs.map(inner))],
        expandedContentSizes: [
          ...new Set(ups.map((s) => (s.getContentSize as number[]).join("x"))),
        ],
        collapsedContentSizes: [
          ...new Set(downs.map((s) => (s.getContentSize as number[]).join("x"))),
        ],
        expandedWindowSizes: [...new Set(ups.map((s) => (s.getSize as number[]).join("x")))],
        collapsedWindowSizes: [...new Set(downs.map((s) => (s.getSize as number[]).join("x")))],
        distinctRendererSizes: [
          ...new Set([...ups, ...downs].map(inner)),
        ],
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
        /* The pass/fail gate: renderer inner size equals the content target. */
        collapsedRendererExact: downs.every((s) => inner(s) === COMPACT_S),
        expandedRendererExact: ups.every((s) => inner(s) === EXPANDED_S),
        noExtraSizes: new Set([...ups, ...downs].map(inner)).size === 2,
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

    /*
     * TYPOGRAPHY COHERENCE, measured in the real renderer.
     *
     * Records the ACTUALLY RESOLVED typeface of every text element. Chromium
     * reports the used font, so this catches a silent fallback that a
     * stylesheet reading would not: if a family is missing, the computed
     * font-family still reads back as the requested stack and the element
     * quietly renders in something else. Also records any horizontal overflow
     * per element, which is the risk when swapping a narrow proportional face
     * for a wider monospaced one.
     */
    typography: await win.webContents.executeJavaScript(`
      (() => {
        const describe = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const r = el.getBoundingClientRect();
          return {
            selector: sel,
            // The DECLARED stack, verbatim. This is NOT proof of what
            // rendered: Chromium echoes the declared list back even when every
            // family in it is missing. See effectiveTypeface below for the
            // face actually rasterised.
            declaredFontStack: cs.fontFamily,
            weight: cs.fontWeight,
            size: cs.fontSize,
            letterSpacing: cs.letterSpacing,
            textTransform: cs.textTransform,
            width: Math.round(r.width),
            scrollWidth: el.scrollWidth,
            clientWidth: el.clientWidth,
            // Horizontal overflow introduced by the new face, if any.
            overflowsX: el.scrollWidth > el.clientWidth + 1,
            visible: r.width > 0 && r.height > 0,
            text: (el.textContent || '').trim().slice(0, 40),
          };
        };
        return {
          elements: [
            describe('.project-title'),
            describe('.fraction'),
            describe('.next-label'),
            describe('.next-text'),
            describe('.phase-name'),
            describe('.phase-tally'),
            describe('.phase-stamp'),
            describe('.task-text'),
            describe('.task.is-done .task-text'),
            describe('.quest-count'),
            describe('.status'),
          ].filter(Boolean),
        };
      })()
    `),

    /*
     * EFFECTIVE typeface, identified by measurement.
     *
     * The stack above names Courier Prime first because that is the PREFERRED
     * face, but Courier Prime is not installed on this machine, so nothing
     * actually renders in it. Computed style cannot reveal that: it just
     * echoes the declared list back. This section identifies the face the
     * rasteriser really used, by cloning each element and re-measuring it in
     * one candidate family at a time. The candidate whose width matches the
     * original within half a pixel is the effective font.
     *
     * If this ever reports two different families across elements, the widget
     * has lost typographic coherence and the pass has failed.
     */
    effectiveTypeface: await win.webContents.executeJavaScript(`
      (() => {
        const CANDIDATES = ['Courier Prime', 'Courier New', 'Consolas', 'Constantia'];
        const host = document.createElement('div');
        host.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:nowrap;';
        document.body.appendChild(host);

        const identify = (sel) => {
          const el = document.querySelector(sel);
          if (!el) return null;
          const cs = getComputedStyle(el);
          const base = {
            fontSize: cs.fontSize,
            fontWeight: cs.fontWeight,
            letterSpacing: cs.letterSpacing,
            textTransform: cs.textTransform,
            fontStyle: cs.fontStyle,
          };
          const text = (el.textContent || '').trim();
          if (!text) return null;

          /*
           * Reference width, from a CLONE measured in exactly one way.
           *
           * Everything except the family must be held constant, and the only
           * reliable way to guarantee that is to mutate ONE element and
           * re-measure it. Two earlier attempts failed for instructive reasons:
           *
           * - Measuring the live element is wrong: its width is capped by its
           *   container, so it reflects wrapping rather than the font.
           * - Measuring a clone against separately-built probe spans is also
           *   wrong: the clone inherits ancestor-dependent state rules, so in
           *   the collapsed state it loses the state-specific title rule and
           *   measures at 12px while the probes used 9px. That produced a
           *   confident but false "unidentifiable" verdict.
           *
           * So: clone once, read its declared stack as the reference, then
           * swap only font-family on that same clone. Same node, same size,
           * same weight, same tracking, every time.
           */
          const clone = el.cloneNode(true);
          clone.style.position = 'absolute';
          clone.style.left = '-9999px';
          clone.style.top = '0';
          clone.style.visibility = 'hidden';
          clone.style.width = 'auto';
          clone.style.maxWidth = 'none';
          clone.style.minWidth = '0';
          clone.style.whiteSpace = 'pre';
          clone.style.overflow = 'visible';
          clone.style.textOverflow = 'clip';
          host.appendChild(clone);

          const readWidth = () =>
            Math.round(clone.getBoundingClientRect().width * 100) / 100;

          const declaredStack = getComputedStyle(clone).fontFamily;
          const trueWidth = readWidth();
          const scores = CANDIDATES.map((f) => {
            clone.style.fontFamily = f;
            return { family: f, width: readWidth() };
          });
          clone.style.fontFamily = declaredStack;
          host.removeChild(clone);

          const ranked = scores
            .map((s) => ({ family: s.family, delta: Math.abs(s.width - trueWidth) }))
            .sort((a, b) => a.delta - b.delta);
          return {
            selector: sel,
            trueWidth,
            effectiveFont: ranked[0].delta < 0.5 ? ranked[0].family : null,
            ambiguous: ranked[0].delta >= 0.5,
            ranked,
          };
        };

        const out = [
          identify('.project-title'),
          identify('.phase-name'),
          identify('.task-text'),
          identify('.next-text'),
          identify('.fraction'),
          identify('.quest-count'),
        ].filter(Boolean);
        host.remove();
        return {
          elements: out,
          distinctEffectiveFonts: [...new Set(out.map((o) => o.effectiveFont))],
          anyAmbiguous: out.some((o) => o.ambiguous),
          oneTypeface: new Set(out.map((o) => o.effectiveFont)).size === 1,
        };
      })()
    `),

    /*
     * WRAPPING under the new, wider face.
     *
     * Courier New sets every glyph on the same advance, so it is wider than
     * the proportional Constantia it replaced at the same nominal size. That
     * is the one genuine risk of this pass: text that used to fit on a line
     * may now wrap differently or clip. Measured in the EXPANDED state, where
     * the title is 12px and has room to wrap across two lines, using a
     * deliberately long title so the worst case is exercised rather than the
     * happy path.
     */
    wrapping: await (async (): Promise<Record<string, unknown>> => {
      applyGeometry(win, true);
      config = { ...config, expanded: true };
      pushState();
      await new Promise((r) => setTimeout(r, 500));

      const measure = () =>
        win.webContents.executeJavaScript(`
          (() => {
            const t = document.querySelector('.project-title');
            const pane = document.querySelector('.expanded');
            const rows = Array.from(document.querySelectorAll('.task-text'));
            const cs = t ? getComputedStyle(t) : null;
            const lh = cs ? parseFloat(cs.lineHeight) : 0;
            const tr = t ? t.getBoundingClientRect() : null;
            return {
              titleText: t ? t.textContent : null,
              titleHeight: tr ? Math.round(tr.height) : null,
              titleWidth: tr ? Math.round(tr.width) : null,
              titleClientW: t ? t.clientWidth : null,
              titleScrollW: t ? t.scrollWidth : null,
              titleLines: lh && tr ? Math.round(tr.height / lh) : null,
              titleOverflowsX: t ? t.scrollWidth > t.clientWidth + 1 : null,
              titleTruncated: cs ? cs.textOverflow === 'ellipsis' : null,
              viewportW: document.documentElement.clientWidth,
              paneScrollW: pane ? pane.scrollWidth : null,
              paneClientW: pane ? pane.clientWidth : null,
              paneHorizontalOverflow: pane ? pane.scrollWidth > pane.clientWidth + 1 : null,
              docHorizontalScroll:
                document.documentElement.scrollWidth >
                document.documentElement.clientWidth + 1,
              anyTaskOverflowsX: rows.some((r) => r.scrollWidth > r.clientWidth + 1),
              maxTaskHeight: rows.length
                ? Math.max(...rows.map((r) => Math.round(r.getBoundingClientRect().height)))
                : null,
            };
          })()
        `) as Promise<Record<string, unknown>>;

      const original = await measure();

      // Worst case: a title far longer than any real one.
      const titleEl = await win.webContents.executeJavaScript(
        "document.querySelector('.project-title') ? document.querySelector('.project-title').textContent : ''",
      ) as string;
      await win.webContents.executeJavaScript(`
        (() => {
          const t = document.querySelector('.project-title');
          if (t) t.textContent =
            'SCRIPT NEW YOUTUBE VIDEO ON NOTEBOOKLM AND CLAUDE WITH A DELIBERATELY LONG PROJECT TITLE';
        })()
      `);
      await new Promise((r) => setTimeout(r, 250));
      const longTitle = await measure();

      // Restore.
      await win.webContents.executeJavaScript(
        `(() => { const t = document.querySelector('.project-title'); if (t) t.textContent = ${JSON.stringify(titleEl)}; })()`,
      );
      await new Promise((r) => setTimeout(r, 200));

      applyGeometry(win, false);
      config = { ...config, expanded: false };
      pushState();
      await new Promise((r) => setTimeout(r, 400));

      return {
        original,
        longTitle,
        longTitleWrapsToMultipleLines:
          typeof longTitle.titleLines === "number" && longTitle.titleLines >= 2,
        longTitleClipped: longTitle.titleOverflowsX === true,
        noHorizontalScrollAnywhere:
          original.docHorizontalScroll === false &&
          longTitle.docHorizontalScroll === false &&
          original.paneHorizontalOverflow === false &&
          longTitle.paneHorizontalOverflow === false,
        noTaskOverflow: original.anyTaskOverflowsX === false,
      };
    })(),

    /*
     * NATIVE CAPTURES of both states, so the typography can be inspected as
     * pixels rather than inferred from computed styles. Written next to the
     * report; the app is a visible always-on-top window, so this is the real
     * thing, not an offscreen approximation.
     */
    captures: await (async (): Promise<Record<string, unknown>> => {
      const out: Record<string, unknown> = {};
      const grab = async (name: string, expanded: boolean): Promise<void> => {
        applyGeometry(win, expanded);
        config = { ...config, expanded };
        pushState();
        await new Promise((r) => setTimeout(r, 700));
        const image = await win.webContents.capturePage();
        const file = `${SELFTEST_OUT.replace(/\.json$/, "")}-${name}.png`;
        writeFileSync(file, image.toPNG());
        out[name] = { file, size: image.getSize() };
      };
      await grab("collapsed", false);
      await grab("expanded", true);
      applyGeometry(win, false);
      config = { ...config, expanded: false };
      pushState();
      await new Promise((r) => setTimeout(r, 400));
      return out;
    })(),

    errors: lastError,
    pollCount: poller?.pollCount ?? 0,

    /*
     * Autostart, read back from Electron rather than assumed.
     *
     * In an unpackaged development launch `packaged` is false and no login
     * item exists by design. Against the INSTALLED application this reports
     * openAtLogin true with the installed executable as the path, which is
     * what proves startup does not point into WSL.
     */
    autostart: loginItemState(),
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

  // Autostart is registered once the app is ready and only when packaged.
  syncLoginItem();

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

/* ------------------------------------------------------------------ *
 * Windows autostart
 * ------------------------------------------------------------------ */

/**
 * Start with Windows, using Electron's own login-item mechanism.
 *
 * Only meaningful for the PACKAGED application: Electron resolves the login
 * item against the installed executable, so the startup target is the real
 * installed app under Program Files / AppData, never the WSL source tree, a
 * shell script, or `npm run dev`. In development `app.isPackaged` is false, so
 * nothing is registered and the dev machine is left alone.
 *
 * `openAsHidden` is deliberately not used: the widget window is always-on-top
 * and frameless, and it is restored to its saved position on show, so there is
 * no console window to suppress and nothing to hide from the user.
 */
function syncLoginItem(): void {
  if (!app.isPackaged) return;

  try {
    // Path must be the installed executable. Passing it explicitly is what
    // pins the startup target to the packaged app rather than to whatever
    // happened to be running when the setting was written.
    const exePath = app.getPath("exe");
    app.setLoginItemSettings({
      openAtLogin: true,
      path: exePath,
      args: [],
    });
    console.log(`autostart enabled -> ${exePath}`);
  } catch (err) {
    // A failed autostart must never stop the widget from running.
    console.error("could not configure autostart:", err);
  }
}

/** Current login-item state, for the diagnostics IPC and the self-test. */
function loginItemState(): Record<string, unknown> {
  try {
    return {
      packaged: app.isPackaged,
      exePath: app.isPackaged ? app.getPath("exe") : null,
      ...(app.isPackaged ? { settings: app.getLoginItemSettings() } : {}),
    };
  } catch (err) {
    return { packaged: app.isPackaged, error: String(err) };
  }
}

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
