/**
 * Renderer.
 *
 * This file contains NO business logic and NO filesystem access. It receives
 * derived state from the main process and renders it. It never computes
 * progress, never picks the next task, and never decides phase completion -
 * all of that already happened in the domain core, which is the only place it
 * happens. That is what keeps the two views impossible to desynchronise.
 *
 * The trailing `export {}` makes this a module, which is required for the
 * `declare global` Window augmentation below to take effect.
 */
export {};

interface TaskView {
  id: string | null;
  text: string;
  done: boolean;
  line: number;
}

interface PhaseView {
  title: string;
  line: number;
  total: number;
  completed: number;
  complete: boolean;
  tasks: TaskView[];
}

interface DerivedState {
  title: string;
  fraction: string;
  percent: number;
  nextTask: TaskView | null;
  phaseCount: number;
  total: number;
  completed: number;
  phases: PhaseView[];
  completePhases: PhaseView[];
}

interface WidgetPayload {
  state: DerivedState | null;
  source: string | null;
  expanded: boolean;
  error: string | null;
  vaultRoot: string;
  notePath: string;
}

declare global {
  interface Window {
    widget: {
      onState(cb: (p: WidgetPayload) => void): void;
      toggleTask(taskId: string): Promise<{ ok: boolean; kind?: string; message?: string }>;
      toggleExpand(): Promise<{ expanded: boolean }>;
      move(dx: number, dy: number): Promise<unknown>;
      refresh(): Promise<unknown>;
      revealNote(): Promise<unknown>;
      diagnostics(): Promise<Record<string, unknown>>;
    };
  }
}

const el = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing element #${id}`);
  return node as T;
};

const shell = el<HTMLDivElement>("shell");
const projectTitle = el<HTMLHeadingElement>("project-title");
const fraction = el<HTMLSpanElement>("fraction");
const progressFill = el<HTMLDivElement>("progress-fill");
const nextTask = el<HTMLSpanElement>("next-task");
const expandedPane = el<HTMLDivElement>("expanded");
const phaseList = el<HTMLDivElement>("phase-list");
const questCount = el<HTMLSpanElement>("quest-count");
const status = el<HTMLSpanElement>("status");
const expandToggle = el<HTMLButtonElement>("expand-toggle");

let current: WidgetPayload | null = null;

/* ------------------------------------------------------------------ *
 * Rendering
 * ------------------------------------------------------------------ */

function renderEmpty(payload: WidgetPayload): void {
  projectTitle.textContent = "No project";
  fraction.textContent = "0/0";
  progressFill.style.width = "0%";
  nextTask.textContent = "—";
  questCount.textContent = "0/0 quests";
  expandedPane.hidden = true;

  const box = document.createElement("div");
  box.className = "empty";
  box.innerHTML =
    `<div><strong>Project note not found.</strong></div>` +
    `<div style="margin-top:6px">Looking for:</div>` +
    `<div><code>${escapeHtml(payload.notePath)}</code></div>` +
    `<div style="margin-top:6px">in</div>` +
    `<div><code>${escapeHtml(payload.vaultRoot)}</code></div>` +
    `<div style="margin-top:8px">Nothing was created or modified.</div>`;
  phaseList.replaceChildren(box);
}

function render(payload: WidgetPayload): void {
  current = payload;
  const state = payload.state;

  shell.classList.toggle("is-expanded", payload.expanded);
  expandedPane.hidden = !payload.expanded;

  if (!state) {
    renderEmpty(payload);
    return;
  }

  projectTitle.textContent = state.title || "Untitled project";

  // Progress comes from the domain core. Nothing here recomputes it.
  fraction.textContent = state.fraction;
  progressFill.style.width = `${state.percent}%`;

  nextTask.textContent = state.nextTask ? state.nextTask.text : "All tasks complete";
  // The tray carries the quest fraction in the reference ("4/6 quests"), not a
  // remaining-count, so the centre of the tray matches the source.
  questCount.textContent = `${state.completed}/${state.total} quests`;

  if (payload.error) {
    status.textContent = shortError(payload.error);
    status.classList.add("is-error");
    status.title = payload.error;
  } else {
    status.textContent = "";
    status.classList.remove("is-error");
    status.title = "";
  }

  if (payload.expanded) renderPhases(state);
}

function renderPhases(state: DerivedState): void {
  const nodes: HTMLElement[] = [];

  for (const phase of state.phases) {
    const section = document.createElement("section");
    // The PHASE COMPLETE treatment keys off a DERIVED flag, not stored data.
    section.className = phase.complete ? "phase is-complete" : "phase";

    const head = document.createElement("div");
    head.className = "phase-head";

    const name = document.createElement("span");
    name.className = "phase-name";
    name.textContent = phase.title === "" ? "(untitled phase)" : phase.title;
    head.append(name);

    if (phase.total > 0) {
      const tally = document.createElement("span");
      tally.className = "phase-tally";
      tally.textContent = `${phase.completed}/${phase.total}`;
      head.append(tally);
    }

    if (phase.complete) {
      const stamp = document.createElement("span");
      stamp.className = "phase-stamp";
      stamp.textContent = "Phase complete";
      head.append(stamp);
    }

    section.append(head);

    for (const task of phase.tasks) {
      const row = document.createElement("div");
      row.className = task.done ? "task is-done" : "task";

      const box = document.createElement("span");
      box.className = "task-box";
      row.append(box);

      const text = document.createElement("span");
      text.className = "task-text";
      text.textContent = task.text;
      row.append(text);

      if (task.id) {
        row.classList.add("is-actionable");
        row.addEventListener("click", () => {
          void window.widget.toggleTask(task.id as string);
        });
      } else {
        row.classList.add("is-locked");
      }

      section.append(row);
    }

    nodes.push(section);
  }

  phaseList.replaceChildren(...nodes);
}

function shortError(message: string): string {
  if (message.startsWith("SchemaViolationError")) return "schema error";
  if (message.includes("not found")) return "note not found";
  return message.split(":")[0] ?? message;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === "&" ? "&amp;" : c === "<" ? "&lt;" : c === ">" ? "&gt;" : c === '"' ? "&quot;" : "&#39;",
  );
}

/* ------------------------------------------------------------------ *
 * Dragging
 *
 * The paper head is the drag handle. Interactive children opt out with
 * .no-drag so a click never turns into a drag. There is no dark header bar in
 * the reference, so the handle is the cream title area.
 * ------------------------------------------------------------------ */

function installDrag(): void {
  const handle = document.querySelector<HTMLElement>(".paper-head");
  if (!handle) return;

  let dragging = false;
  let startX = 0;
  let startY = 0;

  const isInteractive = (target: EventTarget | null): boolean =>
    target instanceof Element && target.closest(".no-drag") !== null;

  handle.addEventListener("mousedown", (event: MouseEvent) => {
    if (event.button !== 0) return;
    if (isInteractive(event.target)) return;

    dragging = true;
    startX = event.screenX;
    startY = event.screenY;
    event.preventDefault();
  });

  window.addEventListener("mousemove", (event: MouseEvent) => {
    if (!dragging) return;
    const dx = event.screenX - startX;
    const dy = event.screenY - startY;
    if (dx === 0 && dy === 0) return;
    startX = event.screenX;
    startY = event.screenY;
    void window.widget.move(dx, dy);
  });

  window.addEventListener("mouseup", () => {
    dragging = false;
  });

  // Never let a stray drag scroll or select the task list.
  window.addEventListener("dragstart", (e) => e.preventDefault());
  window.addEventListener("contextmenu", (e) => e.preventDefault());
}

expandToggle.addEventListener("click", () => {
  void window.widget.toggleExpand();
});

// Right-clicking the tray's quest count opens the note.
el<HTMLElement>("quest-count").addEventListener("contextmenu", (e) => {
  e.preventDefault();
  void window.widget.revealNote();
});

window.widget.onState(render);
installDrag();

// Expose diagnostics for manual verification from the Windows side.
(window as unknown as Record<string, unknown>).__diag = () => window.widget.diagnostics();
