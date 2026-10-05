import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProject } from "../src/parse.ts";
import { SchemaViolationError } from "../src/schema.ts";

function note(frontmatter: string, body = "## Wiring\n- [ ] mount ^a1\n"): string {
  return `---\n${frontmatter}\n---\n\n# Tracker\n\n${body}`;
}

test("rejects a stored progress field in frontmatter", () => {
  const md = note("progress: 4/6");

  assert.throws(() => parseProject(md), SchemaViolationError);
});

test("rejects a stored completed count in frontmatter", () => {
  const md = note("completed: 4");

  assert.throws(() => parseProject(md), SchemaViolationError);
});

test("rejects a stored total count in frontmatter", () => {
  const md = note("total: 6");

  assert.throws(() => parseProject(md), SchemaViolationError);
});

test("rejects a stored percentage in frontmatter", () => {
  const md = note("percent: 67");

  assert.throws(() => parseProject(md), SchemaViolationError);
});

test("rejects a stored next-task pointer in frontmatter", () => {
  const md = note("next_task: mount the panel");

  assert.throws(() => parseProject(md), SchemaViolationError);
});

test("rejects a stored phase-complete flag in frontmatter", () => {
  const md = note("phase_complete: true");

  assert.throws(() => parseProject(md), SchemaViolationError);
});

test("catches derived fields regardless of key casing or separators", () => {
  assert.throws(() => parseProject(note("NextTask: mount")), SchemaViolationError);
  assert.throws(() => parseProject(note("PERCENTAGE: 67")), SchemaViolationError);
  assert.throws(() => parseProject(note("phase-complete: true")), SchemaViolationError);
});

test("names the offending key in the error message", () => {
  const md = note("progress: 4/6");

  assert.throws(
    () => parseProject(md),
    (err: unknown) => err instanceof SchemaViolationError && /progress/.test((err as Error).message),
  );
});

test("allows legitimate frontmatter such as project title and status", () => {
  const md = note("project: Solar Panel Tracker\nstatus: active");

  const project = parseProject(md);

  assert.equal(project.title, "Solar Panel Tracker");
});

test("allows a note with no frontmatter at all", () => {
  const project = parseProject("# Tracker\n\n## Wiring\n- [ ] mount ^a1\n");

  assert.equal(project.title, "Tracker");
});
