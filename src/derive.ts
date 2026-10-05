import type { DerivedState, PhaseView, Project, TaskView } from "./types.ts";

/**
 * Derive every display value from stored truth.
 *
 * This is the ONLY place progress, counts, fractions, percentages,
 * next-task and phase-complete are computed. None of it is stored in the
 * Markdown note, which is what keeps the two from drifting apart.
 *
 * Both the collapsed and the expanded UI render from this one object.
 */
export function deriveState(project: Project): DerivedState {
  const phases: PhaseView[] = project.phases.map((phase) => {
    const tasks: TaskView[] = phase.tasks.map((task) => ({
      id: task.id,
      text: task.text,
      done: task.done,
      line: task.line,
    }));

    const completed = tasks.filter((t) => t.done).length;

    return {
      title: phase.title,
      line: phase.line,
      total: tasks.length,
      completed,
      // Requirement 6: an empty phase is NOT complete. A phase with no
      // tasks has completed === total === 0, so the naive equality would
      // wrongly report it as done.
      complete: tasks.length > 0 && completed === tasks.length,
      tasks,
    };
  });

  const total = phases.reduce((sum, p) => sum + p.total, 0);
  const completed = phases.reduce((sum, p) => sum + p.completed, 0);

  // Document order is phase order, and within a phase, task order. So the
  // first unchecked task across all phases is simply the first one found
  // while walking phases in order.
  const nextTask = phases.flatMap((p) => p.tasks).find((t) => !t.done) ?? null;

  return {
    title: project.title,
    fraction: `${completed}/${total}`,
    // Guard the division: a project with no tasks is 0%, never NaN.
    percent: total === 0 ? 0 : Math.round((completed / total) * 100),
    nextTask,
    phaseCount: phases.length,
    total,
    completed,
    phases,
    completePhases: phases.filter((p) => p.complete),
  };
}
