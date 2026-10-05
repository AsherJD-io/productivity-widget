import { readFileSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

import type { DerivedState } from "../types.ts";
import { parseProject } from "../parse.ts";
import { deriveState } from "../derive.ts";

/**
 * Vault reader.
 *
 * READ-ONLY in Phase 2. Nothing in this module writes to the vault.
 *
 * This layer does no interpretation of its own: it reads bytes and hands
 * them to `parseProject()`, then hands the result to `deriveState()`. Those
 * two functions from Phase 1 remain the only place Markdown is understood,
 * so there is exactly one definition of what a task or a phase means.
 */

/** The configured project note could not be found in the vault. */
export class ProjectNoteMissingError extends Error {
  readonly notePath: string;

  constructor(notePath: string) {
    super(`Project note not found in vault: ${notePath}`);
    this.name = "ProjectNoteMissingError";
    this.notePath = notePath;
  }
}

/** The note exists but could not be read from disk. */
export class ProjectNoteUnreadableError extends Error {
  readonly notePath: string;
  override readonly cause?: unknown;

  constructor(notePath: string, cause: unknown) {
    super(`Could not read project note: ${notePath}`);
    this.name = "ProjectNoteUnreadableError";
    this.notePath = notePath;
    this.cause = cause;
  }
}

/** A configured path tried to escape the vault root. */
export class PathOutsideVaultError extends Error {
  constructor(notePath: string) {
    super(`Refusing to read a path outside the vault: ${notePath}`);
    this.name = "PathOutsideVaultError";
  }
}

export interface LoadedProject {
  /** Vault-relative path, e.g. "Projects/Widget Build.md". */
  readonly path: string;
  /** Absolute path on disk. */
  readonly absolutePath: string;
  /** The exact bytes read, handed unaltered to parseProject(). */
  readonly source: string;
  readonly state: DerivedState;
}

/** Injection seams, so tests can observe that the real functions are used. */
export interface ReaderDeps {
  readonly parse?: typeof parseProject;
  readonly derive?: typeof deriveState;
}

/**
 * Resolve a vault-relative note path to an absolute path, refusing
 * anything that escapes the vault root via `..` or an absolute path.
 */
export function resolveInVault(vaultRoot: string, notePath: string): string {
  if (isAbsolute(notePath)) throw new PathOutsideVaultError(notePath);

  const root = resolve(vaultRoot);
  const full = resolve(root, notePath);
  const rel = relative(root, full);

  if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {
    throw new PathOutsideVaultError(notePath);
  }

  return full;
}

/**
 * Read one configured project note and derive its display state.
 *
 * @throws {ProjectNoteMissingError} when the note does not exist.
 * @throws {ProjectNoteUnreadableError} when the read itself fails.
 * @throws {PathOutsideVaultError} when the path escapes the vault root.
 * @throws {SchemaViolationError} when the note stores a derived value.
 */
export function readProjectNote(
  vaultRoot: string,
  notePath: string,
  deps: ReaderDeps = {},
): LoadedProject {
  const parse = deps.parse ?? parseProject;
  const derive = deps.derive ?? deriveState;

  const absolutePath = resolveInVault(vaultRoot, notePath);

  let source: string;
  try {
    source = readFileSync(absolutePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ProjectNoteMissingError(notePath);
    }
    throw new ProjectNoteUnreadableError(notePath, cause);
  }

  // Exact bytes, unaltered, into the one and only parser.
  return {
    path: notePath,
    absolutePath,
    source,
    state: derive(parse(source)),
  };
}
