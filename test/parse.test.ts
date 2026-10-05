import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProject } from "../src/parse.ts";

test("parses the project title from an H1 heading", () => {
  const md = ["# Solar Panel Tracker", "", "## Phase 1", "- [ ] do a thing", ""].join("\n");

  const project = parseProject(md);

  assert.equal(project.title, "Solar Panel Tracker");
});

test("groups checkbox tasks under their H2 phase and records checkbox state", () => {
  const md = [
    "# Tracker",
    "",
    "## Wiring",
    "- [x] run the cable",
    "- [ ] mount the panel",
    "",
    "## Commissioning",
    "- [ ] sign off",
    "",
  ].join("\n");

  const project = parseProject(md);

  assert.equal(project.phases.length, 2);

  assert.equal(project.phases[0]!.title, "Wiring");
  assert.deepEqual(
    project.phases[0]!.tasks.map((t) => [t.text, t.done]),
    [
      ["run the cable", true],
      ["mount the panel", false],
    ],
  );

  assert.equal(project.phases[1]!.title, "Commissioning");
  assert.deepEqual(
    project.phases[1]!.tasks.map((t) => [t.text, t.done]),
    [["sign off", false]],
  );
});

test("reads a trailing Obsidian block id as the task's stable id", () => {
  const md = ["# Tracker", "", "## Wiring", "- [ ] mount the panel ^t-4f2a", ""].join("\n");

  const project = parseProject(md);
  const task = project.phases[0]!.tasks[0]!;

  assert.equal(task.id, "t-4f2a");
});

test("keeps the block id out of the task text", () => {
  const md = ["# Tracker", "", "## Wiring", "- [ ] mount the panel ^t-4f2a", ""].join("\n");

  const project = parseProject(md);

  assert.equal(project.phases[0]!.tasks[0]!.text, "mount the panel");
});

test("leaves id null when a task line has no block id", () => {
  const md = ["# Tracker", "", "## Wiring", "- [x] already done", ""].join("\n");

  const project = parseProject(md);

  assert.equal(project.phases[0]!.tasks[0]!.id, null);
});

test("preserves the raw line verbatim for surgical rewriting", () => {
  const md = ["# Tracker", "", "## Wiring", "  - [ ] indented task ^abc", ""].join("\n");

  const project = parseProject(md);
  const task = project.phases[0]!.tasks[0]!;

  assert.equal(task.raw, "  - [ ] indented task ^abc");
  assert.equal(task.line, 3);
});

test("parses a CRLF document identically to the same document with LF", () => {
  const lf = ["# Tracker", "", "## Wiring", "- [x] run cable ^a1", "- [ ] mount ^b2", ""].join("\n");
  const crlf = lf.replace(/\n/g, "\r\n");

  const fromLf = parseProject(lf);
  const fromCrlf = parseProject(crlf);

  assert.deepEqual(fromCrlf, fromLf);
});

test("strips the CR from task text on a CRLF document", () => {
  const crlf = ["# Tracker", "", "## Wiring", "- [ ] mount the panel ^b2", ""].join("\r\n");

  const project = parseProject(crlf);
  const task = project.phases[0]!.tasks[0]!;

  assert.equal(task.text, "mount the panel");
  assert.equal(task.id, "b2");
});
