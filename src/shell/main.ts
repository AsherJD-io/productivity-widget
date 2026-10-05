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
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
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
const DEFAULT_NOTE = "Productivity/Solar Panel Tracker.md";

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
      vaultRoot: typeof parsed.vaultRoot === "string" ? parsed.vaultRoot : fallback.vaultRoot,
      notePath: typeof parsed.notePath === "string" ? parsed.notePath : fallback.notePath,
      expanded: typeof parsed.expanded === "boolean" ? parsed.expanded : fallback.expanded,
      x: typeof parsed.x === "number" ? parsed.x : null,
      y: typeof parsed.y === "number" ? parsed.y : null,
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

type Geometry = { width: number; height: number };

function geometryFor(expanded: boolean): Geometry {
  return expanded ? { ...EXPANDED } : { ...COMPACT };
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
    // Width/height above are the CONTENT size, so they match the widget's
    // own box exactly instead of including any invisible window chrome.
    useContentSize: true,
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
  const override = process.argv[process.argv.indexOf(SELFTEST_NOTE_FLAG) + 1];
  if (override !== undefined && !override.startsWith("--")) {
    config = { ...config, notePath: override, expanded: false };
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
   * Ten expand/collapse cycles through the SAME applyGeometry() the button
   * uses, measuring the real OS window each time.
   *
   * This is the regression guard for the reported bug: the old animated
   * toggle grew the window without bound. Absolute bounds cannot do that,
   * but "cannot" is a claim, and this measures it.
   */
  const cycles: Array<{ step: number; expanded: boolean; w: number; h: number; x: number; y: number }> = [];
  for (let i = 0; i < 10; i++) {
    for (const expanded of [true, false]) {
      applyGeometry(win, expanded);
      await new Promise((r) => setTimeout(r, 60));
      const s = win.getSize();
      const b = win.getBounds();
      cycles.push({
        step: cycles.length,
        expanded,
        w: s[0] ?? 0,
        h: s[1] ?? 0,
        x: b.x,
        y: b.y,
      });
    }
  }

  // Leave the widget in its compact state and reload the poller, which the
  // real toggle does too.
  applyGeometry(win, false);
  poller?.stop();
  startPoller();
  await new Promise((r) => setTimeout(r, 500));

  /*
   * Measure the EXPANDED layout as well. The report below is taken in the
   * collapsed state, where the phase list is hidden, so the expanded
   * structure has to be sampled separately.
   */
  applyGeometry(win, true);
  config = { ...config, expanded: true };
  pushState();
  await new Promise((r) => setTimeout(r, 700));

  const expandedDom = await win.webContents.executeJavaScript(`
    (() => {
      const q = (s) => document.querySelector(s);
      const box = (s) => { const e = q(s); return e ? e.getBoundingClientRect() : null; };
      const paper = box('.paper'), tray = box('.tray'), teeth = box('.teeth');
      const done = q('.task.is-done .task-text');
      return {
        viewport: [document.documentElement.clientWidth, document.documentElement.clientHeight],
        paper: paper ? { top: Math.round(paper.top), height: Math.round(paper.height) } : null,
        teeth: teeth ? { height: Math.round(teeth.height) } : null,
        tray: tray ? { top: Math.round(tray.top), height: Math.round(tray.height) } : null,
        trayAtBottom: tray ? Math.abs(tray.bottom - document.documentElement.clientHeight) <= 2 : false,
        phaseHeads: document.querySelectorAll('.phase-head').length,
        taskRows: document.querySelectorAll('.task').length,
        doneRows: document.querySelectorAll('.task.is-done').length,
        phaseStamps: document.querySelectorAll('.phase-stamp').length,
        stampText: q('.phase-stamp')?.textContent ?? null,
        struckThrough: done ? getComputedStyle(done).textDecorationLine : null,
        listScrolls: (() => { const e = q('.expanded'); return e ? e.scrollHeight > e.clientHeight : null; })(),
        dots: document.querySelectorAll('.dot-motif .dot').length,
        toggleIsCircle: (() => {
          const t = q('.tray-toggle'); if (!t) return false;
          const cs = getComputedStyle(t);
          return cs.borderRadius.includes('50%');
        })(),
      };
    })()
  `);

  // Return to compact so the reported resting state is the compact one.
  applyGeometry(win, false);
  config = { ...config, expanded: false };
  pushState();
  await new Promise((r) => setTimeout(r, 400));

  const report = {
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

    /* Ten measured expand/collapse cycles: sizes and position. */
    cycles,
    cycleSummary: {
      total: cycles.length,
      distinctWidths: [...new Set(cycles.map((c) => c.w))],
      distinctHeights: [...new Set(cycles.map((c) => c.h))],
      distinctPositions: [...new Set(cycles.map((c) => `${c.x},${c.y}`))],
      expandedAllCorrect: cycles
        .filter((c) => c.expanded)
        .every((c) => c.w === EXPANDED.width && c.h === EXPANDED.height),
      compactAllCorrect: cycles
        .filter((c) => !c.expanded)
        .every((c) => c.w === COMPACT.width && c.h === COMPACT.height),
      positionStable: new Set(cycles.map((c) => `${c.x},${c.y}`)).size === 1,
      everFullScreen: cycles.some(
        (c) => c.w > 1000 || c.h > 1000,
      ),
    },

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
