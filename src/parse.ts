import type { Phase, Project, Task } from "./types.ts";
import { assertNoDerivedFields } from "./schema.ts";

/** `- [ ] text`, `- [x] text`, `* [X] text`, `+ [ ] text`, any indent. */
const TASK_RE = /^(\s*)[-*+]\s+\[([ xX])\]\s+(.*)$/;

/** Trailing Obsidian block id: whitespace, `^`, then id chars, end of line. */
const BLOCK_ID_RE = /\s+\^([A-Za-z0-9-]+)\s*$/;

/**
 * Read YAML frontmatter if the note opens with a `---` fence.
 * Only flat `key: value` pairs are supported, which is all this schema uses.
 */
function parseFrontmatter(lines: readonly string[]): { map: Map<string, string>; bodyStart: number } {
  const map = new Map<string, string>();

  if (lines[0]?.trim() !== "---") return { map, bodyStart: 0 };

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.trim() === "---") return { map, bodyStart: i + 1 };

    const pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
    if (pair) map.set(pair[1]!, pair[2]!.trim());
  }

  // Unterminated fence: treat the whole document as body.
  return { map, bodyStart: 0 };
}

/**
 * Parse a project note into stored truth.
 *
 * Tolerates LF and CRLF line endings. Returns no derived values:
 * progress, next-task and phase-complete are computed by derive.ts.
 *
 * @throws {SchemaViolationError} if frontmatter stores a derived value.
 */
export function parseProject(source: string): Project {
  // Split on \n, then drop a trailing \r so CRLF documents parse identically to LF.
  const rawLines = source.split("\n").map((line) => line.replace(/\r$/, ""));

  const { map: frontmatter, bodyStart } = parseFrontmatter(rawLines);

  // Enforce requirement 3 before doing anything else with the note.
  assertNoDerivedFields(frontmatter);

  const lines = rawLines.slice(bodyStart);

  let title = "";
  const phases: { title: string; line: number; tasks: Task[] }[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;

    if (title === "") {
      const h1 = /^#\s+(.*\S)\s*$/.exec(line);
      if (h1) {
        title = h1[1]!;
        continue;
      }
    }

    const h2 = /^##\s+(.*\S)\s*$/.exec(line);
    if (h2) {
      phases.push({ title: h2[1]!, line: bodyStart + i, tasks: [] });
      continue;
    }

    const task = TASK_RE.exec(line);
    if (task) {
      if (phases.length === 0) phases.push({ title: "", line: bodyStart - 1, tasks: [] });

      const body = task[3]!;
      const blockId = BLOCK_ID_RE.exec(body);

      phases[phases.length - 1]!.tasks.push({
        id: blockId ? blockId[1]! : null,
        text: blockId ? body.slice(0, blockId.index).replace(/\s+$/, "") : body,
        done: task[2]!.toLowerCase() === "x",
        line: bodyStart + i,
        raw: line,
      });
    }
  }

  // Frontmatter `project:` is the title of record; the H1 is a fallback.
  const declared = frontmatter.get("project") ?? frontmatter.get("title") ?? "";

  return { title: declared !== "" ? declared : title, phases: phases as Phase[] };
}
