import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProject } from "../src/parse.ts";
import { deriveState } from "../src/derive.ts";

/** 6 tasks, 4 checked, across two phases. The canonical example. */
const SIX_WITH_FOUR = [
  "# Tracker",
  "",
  "## Wiring",
  "- [x] run the cable ^a1",
  "- [x] mount the panel ^a2",
  "",
  "## Commissioning",
  "- [x] torque the clamp ^b1",
  "- [x] sign off ^b2",
  "- [ ] take photos ^b3",
  "- [ ] file the permit ^b4",
  "",
].join("\n");

test("derives the fraction 4/6 from six tasks with four checked", () => {
  const state = deriveState(parseProject(SIX_WITH_FOUR));

  assert.equal(state.fraction, "4/6");
});

test("derives total and completed counts purely from checkbox state", () => {
  const state = deriveState(parseProject(SIX_WITH_FOUR));

  assert.equal(state.total, 6);
  assert.equal(state.completed, 4);
});

test("does not divide by zero on a project with no tasks", () => {
  const state = deriveState(parseProject("# Empty\n\n## Phase 1\n\nnothing here\n"));

  assert.equal(state.total, 0);
  assert.equal(state.completed, 0);
  assert.equal(state.fraction, "0/0");
  assert.equal(state.percent, 0);
});

test("next task is the first unchecked task in document order", () => {
  const md = [
    "# Tracker",
    "",
    "## Wiring",
    "- [x] run the cable ^a1",
    "- [ ] mount the panel ^a2",
    "- [ ] torque the clamp ^a3",
    "",
  ].join("\n");

  const state = deriveState(parseProject(md));

  assert.equal(state.nextTask?.id, "a2");
  assert.equal(state.nextTask?.text, "mount the panel");
});

test("next task crosses phase boundaries into the next phase", () => {
  const md = [
    "# Tracker",
    "",
    "## Wiring",
    "- [x] run the cable ^a1",
    "",
    "## Commissioning",
    "- [ ] sign off ^b1",
    "",
  ].join("\n");

  const state = deriveState(parseProject(md));

  assert.equal(state.nextTask?.id, "b1");
});

test("next task is null when every task is checked", () => {
  const md = ["# Tracker", "", "## Wiring", "- [x] all done ^a1", "- [x] and more ^a2", ""].join("\n");

  const state = deriveState(parseProject(md));

  assert.equal(state.nextTask, null);
});

test("a phase is complete only when every one of its tasks is checked", () => {
  const md = [
    "# Tracker",
    "",
    "## Wiring",
    "- [x] run the cable ^a1",
    "- [x] mount the panel ^a2",
    "",
    "## Commissioning",
    "- [x] sign off ^b1",
    "- [ ] take photos ^b2",
    "",
  ].join("\n");

  const state = deriveState(parseProject(md));

  assert.equal(state.phases[0]!.complete, true);
  assert.equal(state.phases[1]!.complete, false);
});

test("an empty phase is NOT complete", () => {
  const md = ["# Tracker", "", "## Planning", "", "## Wiring", "- [ ] mount ^a1", ""].join("\n");

  const state = deriveState(parseProject(md));
  const empty = state.phases[0]!;

  assert.equal(empty.title, "Planning");
  assert.equal(empty.total, 0);
  assert.equal(empty.complete, false);
});

test("a phase with zero tasks is never counted as a complete phase", () => {
  const md = ["# Tracker", "", "## Planning", "no tasks at all", ""].join("\n");

  const state = deriveState(parseProject(md));

  assert.equal(state.completePhases.length, 0);
});

test("lists complete phases for the PHASE COMPLETE treatment", () => {
  const md = [
    "# Tracker",
    "",
    "## Wiring",
    "- [x] run the cable ^a1",
    "",
    "## Commissioning",
    "- [ ] sign off ^b1",
    "",
    "## Handover",
    "- [x] file the permit ^c1",
    "- [x] archive notes ^c2",
    "",
  ].join("\n");

  const state = deriveState(parseProject(md));

  assert.deepEqual(
    state.completePhases.map((p) => p.title),
    ["Wiring", "Handover"],
  );
});
