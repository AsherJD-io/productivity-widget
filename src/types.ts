/**
 * Domain types for the project note.
 *
 * INVARIANT: this file describes STORED truth only.
 * Progress, counts, fractions, percentages, next-task and phase-complete
 * are all DERIVED and live in derive.ts. They must never appear here.
 */

/** Obsidian block id, stored without the leading `^`. */
export type TaskId = string;

export interface Task {
  /** Stable Obsidian block id, or null when the line has none. */
  readonly id: TaskId | null;
  /** Task title with the trailing block id removed. */
  readonly text: string;
  /** Checkbox state. This single field is the source of all progress. */
  readonly done: boolean;
  /** 0-based index of the line in the source document. */
  readonly line: number;
  /** The original line, verbatim, for surgical rewriting. */
  readonly raw: string;
}

export interface Phase {
  readonly title: string;
  /** 0-based index of the H2 line, or -1 for the implicit leading phase. */
  readonly line: number;
  readonly tasks: readonly Task[];
}

/** Parsed stored truth. Contains no derived values. */
export interface Project {
  readonly title: string;
  readonly phases: readonly Phase[];
}

/* ------------------------------------------------------------------ *
 * DERIVED VALUES
 *
 * Everything below is COMPUTED from `Project` on every read. None of it
 * is ever persisted to the Markdown note. If a UI state seems to need a
 * new field, derive it here rather than storing it.
 * ------------------------------------------------------------------ */

/** A task plus the completion flags the renderer needs. */
export interface TaskView {
  readonly id: TaskId | null;
  readonly text: string;
  readonly done: boolean;
  readonly line: number;
}

/** A phase plus its derived completion. */
export interface PhaseView {
  readonly title: string;
  readonly line: number;
  readonly total: number;
  readonly completed: number;
  /** True only when the phase has at least one task and all are checked. */
  readonly complete: boolean;
  readonly tasks: readonly TaskView[];
}

/**
 * The single derived state model consumed by BOTH the collapsed and the
 * expanded UI. Expanding or collapsing must never change stored data;
 * it only changes which parts of this object get rendered.
 */
export interface DerivedState {
  readonly title: string;

  /* Collapsed needs at least this much. */
  readonly fraction: string;
  readonly percent: number;
  readonly nextTask: TaskView | null;
  readonly phaseCount: number;

  /* Expanded needs the rest. */
  readonly total: number;
  readonly completed: number;
  readonly phases: readonly PhaseView[];
  /** Every phase that is complete, for the "PHASE COMPLETE" treatment. */
  readonly completePhases: readonly PhaseView[];
}
