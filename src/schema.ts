/**
 * Schema guard.
 *
 * The central rule of this project: progress is DERIVED, never STORED.
 * Every one of these values is a pure function of the checkbox states, so
 * storing any of them creates a second source of truth that can silently
 * drift out of agreement with the tasks it claims to describe.
 *
 * This module makes that rule enforceable rather than aspirational. Any
 * note carrying one of these keys is rejected at parse time.
 */

export class SchemaViolationError extends Error {
  readonly key: string;

  constructor(key: string) {
    super(
      `Stored schema violation: frontmatter key "${key}" stores a derived value. ` +
        `Progress, counts, percentages, next-task and phase-complete are computed from ` +
        `task checkbox state and must never be written to the note.`,
    );
    this.name = "SchemaViolationError";
    this.key = key;
  }
}

/**
 * Keys that would duplicate derived state.
 * Compared after normalisation (lowercased, separators removed), so
 * `next_task`, `NextTask` and `next-task` are all caught.
 */
const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "progress",
  "completed",
  "complete",
  "completion",
  "done",
  "total",
  "totals",
  "count",
  "counts",
  "taskcount",
  "taskcounts",
  "completedcount",
  "totalcount",
  "percent",
  "percentage",
  "pct",
  "fraction",
  "ratio",
  "next",
  "nexttask",
  "nexttasks",
  "currenttask",
  "current",
  "phasestatus",
  "phasecomplete",
  "phasecompleted",
  "completedphases",
  "overdue",
]);

/** Lowercase and strip separators so `next_task` === `Next-Task`. */
export function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[\s_-]/g, "");
}

export function isForbiddenKey(key: string): boolean {
  return FORBIDDEN_KEYS.has(normaliseKey(key));
}

/**
 * Throw if any key in the frontmatter stores a derived value.
 * Returns normally when the frontmatter is clean.
 */
export function assertNoDerivedFields(frontmatter: ReadonlyMap<string, string>): void {
  for (const key of frontmatter.keys()) {
    if (isForbiddenKey(key)) throw new SchemaViolationError(key);
  }
}
