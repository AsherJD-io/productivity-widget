/**
 * Domain core for the floating productivity widget.
 *
 * Platform-agnostic and side-effect free: no filesystem, no DOM, no Electron.
 * This module is the single source of truth for how a project note becomes
 * everything the widget displays.
 *
 * The governing rule: STORED truth is titles, phases, tasks and checkbox
 * state. Every number the widget shows is DERIVED from that checkbox state on
 * every read. Nothing derived is ever written back to the note.
 */

export type {
  Task,
  Phase,
  Project,
  TaskId,
  TaskView,
  PhaseView,
  DerivedState,
} from "./types.ts";

export { parseProject } from "./parse.ts";
export { deriveState } from "./derive.ts";
export { toCollapsed, toExpanded } from "./view.ts";
export type { CollapsedView, ExpandedView } from "./view.ts";

export { SchemaViolationError, isForbiddenKey, normaliseKey } from "./schema.ts";

/* ---- Vault integration (Phase 2, read-only) ---- */

export {
  readProjectNote,
  resolveInVault,
  ProjectNoteMissingError,
  ProjectNoteUnreadableError,
  PathOutsideVaultError,
} from "./vault/reader.ts";
export type { LoadedProject, ReaderDeps } from "./vault/reader.ts";

export { listMarkdownNotes, EXCLUDED_DIRS } from "./vault/scan.ts";

export { ProjectPoller, changeKey } from "./vault/poller.ts";
export type { PollConfig, PollOutcome } from "./vault/poller.ts";
