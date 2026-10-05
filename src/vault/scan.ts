import { readdirSync, statSync, type Dirent } from "node:fs";
import { join } from "node:path";

/**
 * Vault scanner.
 *
 * Used for DISCOVERY only. The MVP configures its project notes explicitly
 * and does not depend on this, but a scanner is needed eventually and it is
 * the natural place to enforce one hard rule:
 *
 *   NEVER descend into dot-directories.
 *
 * That covers `.obsidian` (Obsidian's own config and its constantly-rewritten
 * workspace state), `.trash` (deleted notes), `.git` (version control
 * internals) and anything else starting with a dot. Obsidian does not index
 * these, so neither do we.
 */

/** Directories that are never traversed, beyond the general dot rule. */
export const EXCLUDED_DIRS: ReadonlySet<string> = new Set([".obsidian", ".trash", ".git"]);

function isExcludedDir(name: string): boolean {
  return EXCLUDED_DIRS.has(name) || name.startsWith(".");
}

function isMarkdown(name: string): boolean {
  return name.toLowerCase().endsWith(".md");
}

/**
 * Recursively list Markdown notes in the vault as vault-relative paths
 * using forward slashes, sorted for deterministic output.
 *
 * Read-only. Never writes, never follows symlinks out of the vault.
 */
export function listMarkdownNotes(vaultRoot: string): string[] {
  const found: string[] = [];

  const walk = (dir: string, prefix: string): void => {
    // Dirent (not the Buffer overload of readdirSync): we only need names
    // and types, never file contents.
    let entries: Dirent[];
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      // Unreadable directory: skip it rather than failing the whole scan.
      return;
    }

    for (const entry of entries) {
      const name = entry.name;

      if (entry.isDirectory()) {
        if (isExcludedDir(name)) continue;
        walk(join(dir, name), prefix === "" ? name : `${prefix}/${name}`);
        continue;
      }

      // Obsidian has no symlinked notes in practice; skip anything that is
      // not a plain file so a link cannot lead us outside the vault.
      if (!entry.isFile()) continue;
      if (!isMarkdown(name)) continue;

      found.push(prefix === "" ? name : `${prefix}/${name}`);
    }
  };

  // Confirm the root is actually a directory before walking.
  try {
    if (!statSync(vaultRoot).isDirectory()) return [];
  } catch {
    return [];
  }

  walk(vaultRoot, "");

  return found.sort();
}
