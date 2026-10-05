/**
 * Phase 6B verification: re-read the production note through the REAL code
 * path and confirm the derived values agree with the Markdown by hand.
 *
 * Read-only. Nothing is written.
 */
import { readProjectNote } from "../src/vault/reader.ts";
import { listMarkdownNotes } from "../src/vault/scan.ts";
import { toCollapsed, toExpanded } from "../src/view.ts";

const WSL_VAULT = "/mnt/c/Users/Asher/Downloads/Asher/Dev/Git/Obsidian/23asher.io";
const WIN_VAULT = "C:\\Users\\Asher\\Downloads\\Asher\\Dev\\Git\\Obsidian\\23asher.io";
const NOTE = "Productivity/Solar Panel Tracker.md";

let failures = 0;
function check(label: string, actual: unknown, expected: unknown): void {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (!ok) failures++;
  console.log(`  ${ok ? "OK  " : "FAIL"} ${label}: ${JSON.stringify(actual)}${ok ? "" : ` (expected ${JSON.stringify(expected)})`}`);
}

console.log("=== A. scanner finds the new note, excludes config ===\n");
const notes = listMarkdownNotes(WSL_VAULT);
console.log("  notes:", JSON.stringify(notes), "\n");
check("includes the project note", notes.includes(NOTE), true);
check("excludes .obsidian", notes.some((n) => n.includes(".obsidian")), false);
check("excludes .git", notes.some((n) => n.includes(".git")), false);

console.log("\n=== B. parse + derive through the real reader (WSL path) ===\n");
const loaded = readProjectNote(WSL_VAULT, NOTE);
const s = loaded.state;
check("title", s.title, "Solar Panel Tracker");
check("phases", s.phases.map((p) => p.title), ["Survey", "Mounting", "Wiring", "Commissioning"]);
check("total tasks", s.total, 16);
check("completed", s.completed, 3);
check("fraction", s.fraction, "3/16");
check("percent", s.percent, 19);
check("next task id", s.nextTask?.id, "m-01");
check("next task text", s.nextTask?.text, "Order the mounting rails");

console.log("\n=== C. phase completion is DERIVED (empty phase rule aside) ===\n");
check("Survey complete", s.phases[0]!.complete, true);
check("Mounting complete", s.phases[1]!.complete, false);
check("Wiring complete", s.phases[2]!.complete, false);
check("Commissioning complete", s.phases[3]!.complete, false);
check("completePhases", s.completePhases.map((p) => p.title), ["Survey"]);

console.log("\n=== D. every task carries a block id ===\n");
const allTasks = s.phases.flatMap((p) => p.tasks);
const missing = allTasks.filter((t) => t.id === null);
check("tasks without a block id", missing.length, 0);
check("block ids are unique", new Set(allTasks.map((t) => t.id)).size, allTasks.length);

console.log("\n=== E. the note stores NO derived values ===\n");
const fm = loaded.source.split("---")[1] ?? "";
check("frontmatter keys", fm.trim().split("\n").map((l) => l.split(":")[0]), ["project", "status"]);
for (const forbidden of ["progress", "completed", "total", "percent", "next", "phase_complete"]) {
  check(`frontmatter has no "${forbidden}"`, new RegExp(`^${forbidden}:`, "m").test(fm), false);
}

console.log("\n=== F. both views agree, from one state object ===\n");
const c = toCollapsed(s);
const e = toExpanded(s);
check("collapsed fraction", c.fraction, "3/16");
check("expanded fraction", e.fraction, "3/16");
check("collapsed remaining", c.remaining, 13);
check("collapsed next", c.nextText, "Order the mounting rails");
check("expanded phases", e.phases.length, 4);
check("Survey shows PHASE COMPLETE inputs", e.phases[0]!.complete, true);
check("completed tasks still present in expanded", e.phases[0]!.tasks.length, 3);

console.log("\n=== G. same note via the WINDOWS path Electron will use ===\n");
if (process.platform !== "win32") {
  // This check is only meaningful when executed by Windows Node, which is
  // what Electron runs. Linux Node cannot read a C:\\ path at all.
  console.log(`  SKIP  platform is ${process.platform}, not win32.`);
  console.log("        The identical check runs under the native Windows Electron");
  console.log("        process; see test/e2e-windows.mjs for that run.");
} else {
  const winLoaded = readProjectNote(WIN_VAULT, NOTE);
  check("windows path parses identically", winLoaded.state.fraction, s.fraction);
  check("windows path total identical", winLoaded.state.total, s.total);
  check("windows path next task", winLoaded.state.nextTask?.id, "m-01");
}

console.log(`\n${failures === 0 ? "ALL CHECKS PASSED" : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
