import { test } from "node:test";
import assert from "node:assert/strict";

import { listMarkdownNotes } from "../src/vault/scan.ts";
import { makeTempVault, writeNote, cleanupTempVaults } from "./helpers/tempVault.ts";

test.after(cleanupTempVaults);

test("lists markdown notes in the vault", () => {
  const vault = makeTempVault();
  writeNote(vault, "Alpha.md", "# Alpha\n");
  writeNote(vault, "Beta.md", "# Beta\n");

  const found = listMarkdownNotes(vault);

  assert.deepEqual(found.sort(), ["Alpha.md", "Beta.md"]);
});

test("never descends into .obsidian", () => {
  const vault = makeTempVault();
  writeNote(vault, "Real.md", "# Real\n");
  writeNote(vault, ".obsidian/plugin-notes.md", "# plugin junk\n");

  const found = listMarkdownNotes(vault);

  assert.deepEqual(found, ["Real.md"]);
});

test("never descends into .trash", () => {
  const vault = makeTempVault();
  writeNote(vault, "Real.md", "# Real\n");
  writeNote(vault, ".trash/deleted.md", "# deleted\n");

  const found = listMarkdownNotes(vault);

  assert.deepEqual(found, ["Real.md"]);
});

test("never descends into .git or any other dot directory", () => {
  const vault = makeTempVault();
  writeNote(vault, "Real.md", "# Real\n");
  writeNote(vault, ".git/objects/note.md", "# internal\n");
  writeNote(vault, ".hidden/thing.md", "# hidden\n");

  const found = listMarkdownNotes(vault);

  assert.deepEqual(found, ["Real.md"]);
});

test("finds notes nested in ordinary subfolders", () => {
  const vault = makeTempVault();
  writeNote(vault, "Projects/Active/Widget.md", "# Widget\n");
  writeNote(vault, "Projects/Done/Old.md", "# Old\n");

  const found = listMarkdownNotes(vault);

  assert.deepEqual(found.sort(), ["Projects/Active/Widget.md", "Projects/Done/Old.md"]);
});

test("ignores non-markdown files", () => {
  const vault = makeTempVault();
  writeNote(vault, "Note.md", "# Note\n");
  writeNote(vault, "image.png", "not really a png");
  writeNote(vault, "data.json", "{}");

  const found = listMarkdownNotes(vault);

  assert.deepEqual(found, ["Note.md"]);
});

test("returns vault-relative posix-style paths", () => {
  const vault = makeTempVault();
  writeNote(vault, "Projects/Widget.md", "# Widget\n");

  const found = listMarkdownNotes(vault);

  assert.deepEqual(found, ["Projects/Widget.md"]);
  assert.equal(found[0]!.includes("\\"), false, "must not use Windows separators");
});
