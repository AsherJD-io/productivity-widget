import type { DerivedState } from "./types.ts";

/**
 * View projections.
 *
 * The collapsed and expanded widget states are two renderings of ONE
 * `DerivedState`. Neither recomputes progress, and neither writes anything.
 * Expanding or collapsing is therefore incapable of changing stored data or
 * of the two views disagreeing, because there is only one source for every
 * number they show.
 */

/** Everything the compact widget renders. */
export interface CollapsedView {
  readonly title: string;
  readonly fraction: string;
  readonly percent: number;
  /** Text of the first unfinished task, or null when none remain. */
  readonly nextText: string | null;
  readonly nextId: string | null;
  /** Count of tasks still to do. */
  readonly remaining: number;
  readonly total: number;
  readonly completed: number;
}

/** Everything the expanded widget renders. */
export interface ExpandedView {
  readonly title: string;
  readonly fraction: string;
  readonly total: number;
  readonly completed: number;
  readonly phases: DerivedState["phases"];
  readonly completePhases: DerivedState["completePhases"];
}

export function toCollapsed(state: DerivedState): CollapsedView {
  return {
    title: state.title,
    fraction: state.fraction,
    percent: state.percent,
    nextText: state.nextTask?.text ?? null,
    nextId: state.nextTask?.id ?? null,
    remaining: state.total - state.completed,
    total: state.total,
    completed: state.completed,
  };
}

export function toExpanded(state: DerivedState): ExpandedView {
  return {
    title: state.title,
    fraction: state.fraction,
    total: state.total,
    completed: state.completed,
    phases: state.phases,
    completePhases: state.completePhases,
  };
}
