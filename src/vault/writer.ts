import { readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import type { DerivedState, Task, TaskId } from "../types.ts";
import { parseProject } from "../parse.ts";
import { deriveState } from "../derive.ts";
import { SchemaViolationError } from "../schema.ts";
import {
  resolveInVault,
  ProjectNoteMissingError,
  ProjectNoteUnreadableError,
} from "./reader.ts";

/**
 * Vault writer.
 *
 * THE PRIMARY RULE
 * ================
 * A checkbox click changes exactly one character: the checkbox state of the
 * one targeted task. Nothing else in the file may change.
 *
 * This is achieved structurally, not by discipline. The writer never
 * re-serialises the document. It parses only to LOCATE the target line, then
 * performs a single-character splice on the original source string. Every
 * other byte - indentation, trailing spaces, comments, frontmatter, ordering,
 * blank lines, line endings, BOM, final-newline presence - is preserved by
 * construction, because it is never touched.
 *
 * A regenerate-the-document approach would be shorter to write and wrong:
 * it would silently normalise whitespace and line endings, which is exactly
 * the kind of change that makes an Obsidian vault churn in git.
 *
 * IDENTITY
 * ========
 * Tasks are addressed by their Obsidian block id. Line numbers are not stable
 * across reordering; task text is not stable across rewording. A task with no
 * block id is refused rather than guessed at, because guessing risks ticking
 * the wrong box in the user's real notes.
 *
 * ATOMICITY
 * =========
 * Verified during the Phase 1 inspection that write-temp-then-rename works on
 * /mnt/c. A crash mid-write therefore leaves the original note intact rather
 * than a truncated one.
 */

/* ------------------------------------------------------------------ *
 * Failures
 * ------------------------------------------------------------------ */

export type WriteFailureKind =
  | "note-missing"
  | "note-unreadable"
  | "task-missing"
  | "task-has-no-id"
  | "conflict"
  | "atomic-write-failed"
  | "verification-failed"
  | "schema-violation";

/** The requested block id is not present in the note. */
export class TargetTaskMissingError extends Error {
  readonly taskId: TaskId;
  constructor(taskId: TaskId) {
    super(`No task with block id "${taskId}" in the note`);
    this.name = "TargetTaskMissingError";
    this.taskId = taskId;
  }
}

/** The requested task exists but carries no block id, so cannot be addressed. */
export class TaskHasNoBlockIdError extends Error {
  constructor() {
    super(
      "Task has no Obsidian block id, so it cannot be addressed safely. " +
        "Add a trailing block id such as ` ^a1b2c3` to the task line.",
    );
    this.name = "TaskHasNoBlockIdError";
  }
}

/** The note changed on disk since the UI snapshot. Nothing was written. */
export class StaleSnapshotError extends Error {
  readonly notePath: string;
  constructor(notePath: string) {
    super(
      `Note "${notePath}" changed on disk since the snapshot was taken. ` +
        `Aborting the write to avoid clobbering the newer edit.`,
    );
    this.name = "StaleSnapshotError";
    this.notePath = notePath;
  }
}

/** The temp write or the atomic rename failed. Original left untouched. */
export class AtomicWriteError extends Error {
  override readonly cause?: unknown;
  constructor(cause: unknown) {
    super("Atomic write failed; the original note was left unchanged");
    this.name = "AtomicWriteError";
    this.cause = cause;
  }
}

/** The file after writing did not match what we intended to write. */
export class PostWriteVerificationError extends Error {
  constructor(detail: string) {
    super(`Post-write verification failed: ${detail}`);
    this.name = "PostWriteVerificationError";
  }
}

/* ------------------------------------------------------------------ *
 * Result
 * ------------------------------------------------------------------ */

export interface WriteSuccess {
  readonly ok: true;
  readonly notePath: string;
  readonly taskId: TaskId;
  readonly done: boolean;
  /** The full source now on disk. */
  readonly source: string;
  /** Freshly derived state, read back from disk after the write. */
  readonly state: DerivedState;
}

export interface WriteFailure {
  readonly ok: false;
  readonly kind: WriteFailureKind;
  readonly error: Error;
  /**
   * State derived from the CURRENT disk contents, when available.
   *
   * On `conflict` this is what lets the UI re-render from the newer edit
   * instead of retrying blindly. Null when the note could not be read.
   */
  readonly state: DerivedState | null;
}

export type WriteResult = WriteSuccess | WriteFailure;

/**
 * Filesystem seams.
 *
 * Present so tests can inject faults (a corrupted write, a truncated file)
 * and prove that post-write verification actually catches them, rather than
 * merely asserting that a correct write looks correct.
 */
export interface WriterDeps {
  readonly readFile?: (path: string) => string;
  readonly writeFile?: (path: string, data: string) => void;
  readonly rename?: (from: string, to: string) => void;
  readonly unlink?: (path: string) => void;
}

const DEFAULT_DEPS: Required<WriterDeps> = {
  readFile: (path) => readFileSync(path, "utf8"),
  writeFile: (path, data) => {
    writeFileSync(path, data, { encoding: "utf8" });
  },
  rename: (from, to) => renameSync(from, to),
  unlink: (path) => unlinkSync(path),
};

export interface WriteRequest {
  readonly vaultRoot: string;
  readonly notePath: string;
  readonly taskId: TaskId;
  /**
   * The exact source the caller's UI state was derived from.
   *
   * Required. The writer will not operate from assumed state: if the file on
   * disk no longer matches this string, the write is refused.
   */
  readonly snapshot: string;
  /** Desired checkbox state. Omit to toggle whatever is there now. */
  readonly done?: boolean;
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/** `  - [ ] ` with the checkbox character isolated in group 2. */
const CHECKBOX_RE = /^(\s*[-*+]\s+\[)([ xX])(\]\s)/;

function failure(kind: WriteFailureKind, error: Error, state: DerivedState | null): WriteFailure {
  return { ok: false, kind, error, state };
}

/** Byte offset of the start of each line, so a line index maps to an offset. */
function lineOffsets(source: string): number[] {
  const offsets: number[] = [0];
  for (let i = 0; i < source.length; i++) {
    if (source[i] === "\n") offsets.push(i + 1);
  }
  return offsets;
}

/** Find a task anywhere in the project by block id. */
function findByBlockId(tasks: readonly Task[], taskId: TaskId): Task | undefined {
  return tasks.find((t) => t.id === taskId);
}

function allTasks(project: { phases: readonly { tasks: readonly Task[] }[] }): Task[] {
  return project.phases.flatMap((p) => p.tasks);
}

/**
 * Splice a single character into `source` at an absolute offset.
 * Every other byte is preserved verbatim.
 */
function replaceCharAt(source: string, offset: number, char: string): string {
  return source.slice(0, offset) + char + source.slice(offset + 1);
}

/* ------------------------------------------------------------------ *
 * The write
 * ------------------------------------------------------------------ */

/**
 * Set (or toggle) the checkbox of exactly one task, addressed by block id.
 *
 * Never throws for expected conditions; every failure is returned as a
 * typed result so the UI can react rather than crash.
 */
export function setTaskChecked(request: WriteRequest, deps: WriterDeps = {}): WriteResult {
  const { vaultRoot, notePath, taskId, snapshot } = request;

  const io: Required<WriterDeps> = {
    readFile: deps.readFile ?? DEFAULT_DEPS.readFile,
    writeFile: deps.writeFile ?? DEFAULT_DEPS.writeFile,
    rename: deps.rename ?? DEFAULT_DEPS.rename,
    unlink: deps.unlink ?? DEFAULT_DEPS.unlink,
  };

  let absolutePath: string;
  try {
    absolutePath = resolveInVault(vaultRoot, notePath);
  } catch (err) {
    return failure("note-missing", err as Error, null);
  }

  /* 1. Read the current file from disk. */
  let current: string;
  try {
    current = io.readFile(absolutePath);
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === "ENOENT") return failure("note-missing", new ProjectNoteMissingError(notePath), null);
    return failure("note-unreadable", new ProjectNoteUnreadableError(notePath, err), null);
  }

  /* 2. Parse it, so we can locate the target line. */
  let project;
  try {
    project = parseProject(current);
  } catch (err) {
    if (err instanceof SchemaViolationError) {
      return failure("schema-violation", err, null);
    }
    return failure("schema-violation", err as Error, null);
  }

  const currentState = deriveState(project);

  /* 3 + 4. Locate the target task by stable block id. */
  const task = findByBlockId(allTasks(project), taskId);
  if (task === undefined) {
    return failure("task-missing", new TargetTaskMissingError(taskId), currentState);
  }

  /*
   * 5. Conflict guard.
   *
   * Compare the WHOLE source, not just the target line. Any change anywhere
   * in the document means the caller's view is out of date, so refuse.
   */
  if (current !== snapshot) {
    return failure("conflict", new StaleSnapshotError(notePath), currentState);
  }

  /* 6. Decide the target state. */
  const intended = request.done ?? !task.done;

  /* 7. Splice exactly one character. */
  const offsets = lineOffsets(current);
  const lineStart = offsets[task.line];
  if (lineStart === undefined) {
    return failure(
      "verification-failed",
      new PostWriteVerificationError(`line ${task.line} has no offset in the source`),
      currentState,
    );
  }

  const lineText = current.slice(lineStart, lineStart + task.raw.length + 1);
  const match = CHECKBOX_RE.exec(lineText);
  if (match === null) {
    return failure(
      "verification-failed",
      new PostWriteVerificationError(`line ${task.line} has no recognisable checkbox`),
      currentState,
    );
  }

  const checkboxOffset = lineStart + match[1]!.length;
  const expectedSource = replaceCharAt(current, checkboxOffset, intended ? "x" : " ");

  /* 8 + 9. Write to a temp file in the same directory, then atomically replace. */
  /*
   * Temp file path, built with path helpers rather than string slicing.
   *
   * The previous code did:
   *   absolutePath.slice(0, absolutePath.lastIndexOf("/") + 1)
   * On Windows the separator is a backslash, so lastIndexOf("/") returned -1,
   * slice(0, 0) returned "", and the temp file was written to the process
   * working directory instead of beside the note. The subsequent rename then
   * failed, and every checkbox click from the widget returned
   * "atomic-write-failed" without touching the Markdown. This is why the user
   * had to open Obsidian to tick tasks.
   */
  const tempPath = join(dirname(absolutePath), `.${basename(absolutePath)}.tmp-write`);

  try {
    io.writeFile(tempPath, expectedSource);
    io.rename(tempPath, absolutePath);
  } catch (err) {
    try {
      io.unlink(tempPath);
    } catch {
      // Temp file may never have been created; nothing to clean up.
    }
    return failure("atomic-write-failed", new AtomicWriteError(err), currentState);
  }

  /* 10. Immediately re-read. */
  let written: string;
  try {
    written = io.readFile(absolutePath);
  } catch (err) {
    return failure("note-unreadable", new ProjectNoteUnreadableError(notePath, err), null);
  }

  /* 11 + 12. Parse, derive, and verify byte-for-byte. */
  if (written !== expectedSource) {
    return failure(
      "verification-failed",
      new PostWriteVerificationError("file contents differ from the intended result"),
      currentState,
    );
  }

  let newState: DerivedState;
  try {
    newState = deriveState(parseProject(written));
  } catch (err) {
    return failure("verification-failed", new PostWriteVerificationError(String(err)), currentState);
  }

  const verifyTask = findByBlockId(allTasks(parseProject(written)), taskId);
  if (verifyTask === undefined || verifyTask.done !== intended) {
    return failure(
      "verification-failed",
      new PostWriteVerificationError(`task "${taskId}" is not ${intended ? "checked" : "unchecked"}`),
      currentState,
    );
  }

  return {
    ok: true,
    notePath,
    taskId,
    done: intended,
    source: written,
    state: newState,
  };
}
