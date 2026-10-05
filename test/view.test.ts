import { test } from "node:test";
import assert from "node:assert/strict";

import { parseProject } from "../src/parse.ts";
import { deriveState } from "../src/derive.ts";
import { toCollapsed, toExpanded } from "../src/view.ts";

const NOTE = [
  "# Tracker",
  "",
  "## Wiring",
  "- [x] run the cable ^a1",
  "- [ ] mount the panel ^a2",
  "",
  "## Commissioning",
  "- [x] sign off ^b1",
  "- [ ] take photos ^b2",
  "",
].join("\n");

test("collapsed view exposes exactly what the compact widget renders", () => {
  const state = deriveState(parseProject(NOTE));

  const collapsed = toCollapsed(state);

  assert.equal(collapsed.title, "Tracker");
  assert.equal(collapsed.fraction, "2/4");
  assert.equal(collapsed.percent, 50);
  assert.equal(collapsed.nextText, "mount the panel");
  assert.equal(collapsed.remaining, 2);
});

test("expanded view exposes the phase grouping and per-task state", () => {
  const state = deriveState(parseProject(NOTE));

  const expanded = toExpanded(state);

  assert.equal(expanded.phases.length, 2);
  assert.deepEqual(
    expanded.phases.map((p) => [p.title, p.complete]),
    [
      ["Wiring", false],
      ["Commissioning", false],
    ],
  );
  assert.deepEqual(
    expanded.phases[0]!.tasks.map((t) => [t.text, t.done]),
    [
      ["run the cable", true],
      ["mount the panel", false],
    ],
  );
});

test("both views are projections of one state object and cannot disagree", () => {
  const project = parseProject(NOTE);
  const state = deriveState(project);

  const collapsed = toCollapsed(state);
  const expanded = toExpanded(state);

  // The fraction is computed once, in derive, and both views read the
  // same value. Neither recomputes it, so they cannot drift apart.
  assert.equal(collapsed.fraction, expanded.fraction);
  assert.equal(collapsed.total, expanded.total);
  assert.equal(collapsed.completed, expanded.completed);
});

test("switching between views never mutates the underlying state", () => {
  const state = deriveState(parseProject(NOTE));
  const before = JSON.stringify(state);

  toCollapsed(state);
  toExpanded(state);

  assert.equal(JSON.stringify(state), before);
});

/** Collect every key name anywhere in a value. */
function allKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (typeof value !== "object" || value === null) return into;
  for (const [key, child] of Object.entries(value)) {
    into.add(key);
    allKeys(child, into);
  }
  return into;
}

test("stored project shape exposes no derived fields", () => {
  const project = parseProject(NOTE);

  const stored = allKeys(project);

  // Sanity: the traversal must actually reach nested keys, otherwise this
  // assertion would pass vacuously.
  assert.ok(stored.has("title"), "traversal should reach top-level keys");
  assert.ok(stored.has("tasks"), "traversal should recurse into phase tasks");
  assert.ok(stored.has("done"), "traversal should reach task leaf keys");

  for (const forbidden of ["fraction", "percent", "progress", "nextTask", "complete"]) {
    assert.equal(stored.has(forbidden), false, `stored shape must not contain "${forbidden}"`);
  }
});

test("flipping a single checkbox moves the fraction by exactly one", () => {
  const before = deriveState(parseProject(NOTE));
  const after = deriveState(parseProject(NOTE.replace("- [ ] mount", "- [x] mount")));

  assert.equal(before.fraction, "2/4");
  assert.equal(after.fraction, "3/4");
  assert.equal(after.completed - before.completed, 1);
  assert.equal(after.total, before.total);
});
