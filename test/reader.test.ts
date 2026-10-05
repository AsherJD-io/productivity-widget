import { test } from "node:test";
import assert from "node:assert/strict";

import { readProjectNote, ProjectNoteMissingError, PathOutsideVaultError } from "../src/vault/reader.ts";
import { parseProject } from "../src/parse.ts";
import { deriveState } from "../src/derive.ts";
import { SchemaViolationError } from "../src/schema.ts";
import { makeTempVault, writeNote, SAMPLE_NOTE, cleanupTempVaults } from "./helpers/tempVault.ts";

test.after(cleanupTempVaults);

test("reads a project note and derives its state", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget Build.md", SAMPLE_NOTE);

  const loaded = readProjectNote(vault, "Widget Build.md");

  assert.equal(loaded.path, "Widget Build.md");
  assert.equal(loaded.state.title, "Widget Build");
  assert.equal(loaded.state.fraction, "1/3");
});

test("passes the exact source bytes into parseProject", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget Build.md", SAMPLE_NOTE);
  const seen: string[] = [];

  readProjectNote(vault, "Widget Build.md", {
    parse: (source) => {
      seen.push(source);
      return parseProject(source);
    },
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0], SAMPLE_NOTE);
});

test("derives state from the object parseProject returned", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget Build.md", SAMPLE_NOTE);
  const parsed: unknown[] = [];
  const derived: unknown[] = [];

  readProjectNote(vault, "Widget Build.md", {
    parse: (source) => {
      const project = parseProject(source);
      parsed.push(project);
      return project;
    },
    derive: (project) => {
      derived.push(project);
      return deriveState(project);
    },
  });

  assert.equal(parsed.length, 1);
  assert.equal(derived.length, 1);
  assert.equal(derived[0], parsed[0], "deriveState must receive the parsed project itself");
});

test("reports a missing project note cleanly", () => {
  const vault = makeTempVault();

  assert.throws(
    () => readProjectNote(vault, "Nope.md"),
    (err: unknown) => err instanceof ProjectNoteMissingError && err.notePath === "Nope.md",
  );
});

test("surfaces a schema violation cleanly", () => {
  const vault = makeTempVault();
  writeNote(vault, "Bad.md", "---\nprogress: 4/6\n---\n\n# Bad\n\n## P\n- [ ] a ^a1\n");

  assert.throws(() => readProjectNote(vault, "Bad.md"), SchemaViolationError);
});

test("refuses to read outside the vault root", () => {
  const vault = makeTempVault();

  assert.throws(() => readProjectNote(vault, "../escape.md"), PathOutsideVaultError);
  assert.throws(() => readProjectNote(vault, "/etc/passwd"), PathOutsideVaultError);
});

test("reads a note nested in a subfolder of the vault", () => {
  const vault = makeTempVault();
  writeNote(vault, "Projects/Active/Widget.md", SAMPLE_NOTE);

  const loaded = readProjectNote(vault, "Projects/Active/Widget.md");

  assert.equal(loaded.state.fraction, "1/3");
});
