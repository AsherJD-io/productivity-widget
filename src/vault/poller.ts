import { statSync } from "node:fs";

import type { DerivedState } from "../types.ts";
import { readProjectNote, resolveInVault, type LoadedProject } from "./reader.ts";

/**
 * Stat-based vault poller.
 *
 * WHY POLLING AND NOT WATCHING
 * ===========================
 * This was established empirically during the Phase 1 inspection, not
 * assumed. On this machine the vault lives on /mnt/c, which WSL exposes
 * through the Microsoft 9p filesystem. The following were tested directly
 * against the real vault path:
 *
 *   - raw ctypes inotify, IN_ALL mask, WSL-side writes      -> 0 events
 *   - raw ctypes inotify, writes issued from Windows        -> 0 events
 *   - the identical code against ext4 (/home/asher)          -> 6 events
 *   - Node fs.watch on /mnt/c, create/modify/delete         -> 0 events
 *   - Node fs.watch on ext4, identical code                -> 3 events
 *
 * The watch registers successfully and then never fires, so chokidar,
 * watchdog and fs.watch all appear to work and silently do nothing.
 * Stat polling does work, and a full vault scan measured ~19.5ms, so
 * polling the one configured note is cheap.
 *
 * CHANGE KEY
 * ==========
 * `mtimeMs:size` from stat(). Verified on this filesystem: mtime has
 * sub-millisecond resolution and successive writes produce distinct
 * values. Windows/WSL clock skew measured +0.131s, which is irrelevant
 * because the key only ever compares a file against its own previous
 * value, never against wall-clock time.
 */

export interface PollConfig {
  readonly vaultRoot: string;
  /** Explicitly configured project notes. Nothing is auto-detected. */
  readonly projectNotes: readonly string[];
  /** Interval while the widget is active. Default 1000ms. */
  readonly intervalMs?: number;
  /** Interval while collapsed/idle. Default 5000ms. */
  readonly idleIntervalMs?: number;
  /** Decides which interval applies. Defaults to always active. */
  readonly isIdle?: () => boolean;
}

export interface PollOutcome {
  /** True when the note's change key moved, or on the very first load. */
  readonly changed: boolean;
  readonly loaded: LoadedProject | null;
  readonly error: Error | null;
  /** The mtime:size key observed this poll, or null when absent. */
  readonly key: string | null;
}

interface Entry {
  key: string | null;
  loaded: LoadedProject | null;
}

const DEFAULT_INTERVAL_MS = 1000;
const DEFAULT_IDLE_INTERVAL_MS = 5000;

/** `mtimeMs:size`, or null when the file is absent. */
export function changeKey(absolutePath: string): string | null {
  try {
    const st = statSync(absolutePath);
    return `${st.mtimeMs}:${st.size}`;
  } catch {
    return null;
  }
}

export class ProjectPoller {
  readonly #config: Required<Omit<PollConfig, "projectNotes">> & {
    projectNotes: readonly string[];
  };

  readonly #entries = new Map<string, Entry>();
  #timer: ReturnType<typeof setTimeout> | null = null;
  #running = false;

  /** Total pollNow() invocations. Lets tests prove work is not repeated. */
  #pollCount = 0;

  /** How many times pollNow() has actually run. */
  get pollCount(): number {
    return this.#pollCount;
  }

  /** Fired only when a note's content actually changed. */
  onChange: ((loaded: LoadedProject) => void) | null = null;
  /** Fired when a configured note cannot be read or is invalid. */
  onError: ((error: Error, notePath: string) => void) | null = null;

  constructor(config: PollConfig) {
    this.#config = {
      vaultRoot: config.vaultRoot,
      projectNotes: config.projectNotes,
      intervalMs: config.intervalMs ?? DEFAULT_INTERVAL_MS,
      idleIntervalMs: config.idleIntervalMs ?? DEFAULT_IDLE_INTERVAL_MS,
      isIdle: config.isIdle ?? (() => false),
    };
  }

  /** The most recently loaded state, or null before the first poll. */
  get current(): DerivedState | null {
    for (const entry of this.#entries.values()) return entry.loaded?.state ?? null;
    return null;
  }

  /** Number of notes this poller is tracking. */
  get trackedCount(): number {
    return this.#entries.size;
  }

  /**
   * Poll every configured note once, synchronously.
   *
   * A note is only re-read and re-derived when its change key moved. An
   * unchanged note keeps its previous LoadedProject object identity, which
   * is how callers (and tests) can tell that no parsing happened.
   */
  pollNow(): PollOutcome {
    this.#pollCount++;
    let anyChanged = false;
    let lastLoaded: LoadedProject | null = null;
    let lastError: Error | null = null;
    let lastKey: string | null = null;

    for (const notePath of this.#config.projectNotes) {
      /*
       * resolveInVault throws PathOutsideVaultError for an unusable path.
       * That must never escape pollNow(): the poller runs from a setTimeout
       * in the Electron main process, where an uncaught throw opens a crash
       * dialog and kills the widget. A bad path is a configuration problem,
       * so it is reported through onError and the loop continues.
       */
      let absolutePath: string;
      try {
        absolutePath = resolveInVault(this.#config.vaultRoot, notePath);
      } catch (err) {
        const error = err instanceof Error ? err : new Error(String(err));
        this.onError?.(error, notePath);
        lastError = error;
        this.#entries.set(notePath, { key: null, loaded: null });
        continue;
      }

      const key = changeKey(absolutePath);

      const previous = this.#entries.get(notePath);
      const firstSight = previous === undefined;

      // Fast path: nothing moved on disk. Keep the existing object so the
      // absence of re-parsing is observable, and skip all further work.
      if (!firstSight && key !== null && key === previous.key) {
        lastLoaded = previous!.loaded;
        lastKey = key;
        continue;
      }

      let loaded: LoadedProject | null = null;
      let error: Error | null = null;

      try {
        loaded = readProjectNote(this.#config.vaultRoot, notePath);
      } catch (err) {
        error = err instanceof Error ? err : new Error(String(err));
        this.onError?.(error, notePath);
      }

      this.#entries.set(notePath, { key, loaded });

      if (error === null && loaded !== null) {
        // First load is a change too, so consumers get an initial render.
        anyChanged = true;
        lastLoaded = loaded;
        this.onChange?.(loaded);
      }

      lastError = error;
      lastKey = key;
    }

    return {
      changed: anyChanged,
      loaded: lastLoaded,
      error: lastError,
      key: lastKey,
    };
  }

  /** Interval currently in force. */
  get currentIntervalMs(): number {
    return this.#config.isIdle() ? this.#config.idleIntervalMs : this.#config.intervalMs;
  }

  /**
   * Force an immediate poll, e.g. when the window regains focus.
   * Returns the same outcome as pollNow().
   */
  refresh(): PollOutcome {
    return this.pollNow();
  }

  start(): void {
    if (this.#running) return;
    this.#running = true;

    const tick = (): void => {
      if (!this.#running) return;
      try {
        this.pollNow();
      } catch {
        // Never let a poll error kill the loop.
      }
      if (this.#running) {
        this.#timer = setTimeout(tick, this.currentIntervalMs);
        // Do not hold the event loop open on shutdown.
        this.#timer.unref?.();
      }
    };

    this.pollNow();
    this.#timer = setTimeout(tick, this.currentIntervalMs);
    this.#timer.unref?.();
  }

  stop(): void {
    this.#running = false;
    if (this.#timer !== null) {
      clearTimeout(this.#timer);
      this.#timer = null;
    }
  }

  /** Forget cached keys so the next poll reloads unconditionally. */
  invalidate(): void {
    this.#entries.clear();
  }
}
