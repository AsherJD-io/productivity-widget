import { test } from "node:test";
import assert from "node:assert/strict";
import { statSync, writeFileSync, utimesSync } from "node:fs";
import { join } from "node:path";

import { ProjectPoller } from "../src/vault/poller.ts";
import { ProjectNoteMissingError } from "../src/vault/reader.ts";
import { SchemaViolationError } from "../src/schema.ts";
import {
  makeTempVault,
  makeMntCVault,
  writeNote,
  writeNoteFromWindows,
  cleanupTempVaults,
  SAMPLE_NOTE,
  SAMPLE_NOTE_TOGGLED,
  waitForMtimeTick,
} from "./helpers/tempVault.ts";

test.after(cleanupTempVaults);

function pollerFor(vault: string, ...notes: string[]): ProjectPoller {
  return new ProjectPoller({ vaultRoot: vault, projectNotes: notes });
}

/* ---------- requirement 4: external modification is detected ---------- */

test("detects an external modification to the project note", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  assert.equal(poller.pollNow().changed, true, "first poll loads the note");
  assert.equal(poller.pollNow().changed, false, "an untouched note is not a change");

  // Simulate the user ticking a box in Obsidian.
  await waitForMtimeTick();
  writeNote(vault, "Widget.md", SAMPLE_NOTE_TOGGLED);

  const afterEdit = poller.pollNow();
  assert.equal(afterEdit.changed, true, "the edit must be detected");
  assert.equal(afterEdit.loaded?.state.fraction, "2/3");
});

test("detects a same-length checkbox toggle on the real drvfs filesystem", () => {
  const vault = makeMntCVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();

  // Same byte length, one character differs. This is exactly what the
  // widget itself will write, so it is the case that must not be missed.
  assert.equal(SAMPLE_NOTE.length, SAMPLE_NOTE_TOGGLED.length, "fixture must be the same size");
  writeNote(vault, "Widget.md", SAMPLE_NOTE_TOGGLED);

  const after = poller.pollNow();
  assert.equal(after.changed, true, "same-length toggle must be detected on /mnt/c");
  assert.equal(after.loaded?.state.fraction, "2/3");
});

test("fires onChange only when content actually changed", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");
  const seen: string[] = [];
  poller.onChange = (loaded) => seen.push(loaded.state.fraction);

  poller.pollNow();
  poller.pollNow();
  poller.pollNow();
  assert.deepEqual(seen, ["1/3"], "three polls of one file yield one notification");

  await waitForMtimeTick();
  writeNote(vault, "Widget.md", SAMPLE_NOTE_TOGGLED);
  poller.pollNow();

  assert.deepEqual(seen, ["1/3", "2/3"]);
});

/* ---------- requirement 10: no needless re-parsing ---------- */

test("repeated unchanged polls do not re-parse the note", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  const first = poller.pollNow();
  const stateAfterFirst = poller.current;

  for (let i = 0; i < 25; i++) poller.pollNow();

  assert.equal(first.changed, true);
  assert.equal(
    poller.current,
    stateAfterFirst,
    "an unchanged poll must return the identical DerivedState object",
  );
});

test("unchanged polls report changed=false every time", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();
  for (let i = 0; i < 10; i++) {
    assert.equal(poller.pollNow().changed, false);
  }
});

test("a real change yields a brand new state object", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();
  const before = poller.current;

  await waitForMtimeTick();
  writeNote(vault, "Widget.md", SAMPLE_NOTE_TOGGLED);
  poller.pollNow();

  assert.notEqual(poller.current, before, "a genuine change must re-derive");
});

/* ---------- requirements 6 and 7: .obsidian and .trash are ignored ---------- */

test(".obsidian churn does not trigger a project reload", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  writeNote(vault, ".obsidian/workspace.json", '{"main":{}}');
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();
  const before = poller.current;
  let reloads = 0;
  poller.onChange = () => reloads++;

  // Obsidian rewrites workspace.json continuously in real use.
  for (let i = 0; i < 20; i++) {
    writeNote(vault, ".obsidian/workspace.json", JSON.stringify({ main: { revision: i } }));
    assert.equal(poller.pollNow().changed, false, `.obsidian write ${i} must not reload`);
  }

  assert.equal(reloads, 0);
  assert.equal(poller.current, before);
});

test(".trash churn does not trigger a project reload", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  writeNote(vault, ".trash/deleted.md", "# deleted\n");
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();
  const before = poller.current;
  let reloads = 0;
  poller.onChange = () => reloads++;

  for (let i = 0; i < 10; i++) {
    writeNote(vault, ".trash/deleted.md", `# deleted ${i}\n`);
    assert.equal(poller.pollNow().changed, false, `.trash write ${i} must not reload`);
  }

  assert.equal(reloads, 0);
  assert.equal(poller.current, before);
});

test("adding an unrelated note does not reload the tracked project", () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();
  const before = poller.current;

  writeNote(vault, "Some Other Note.md", "# Unrelated\n");
  assert.equal(poller.pollNow().changed, false, "only configured notes are polled");

  assert.equal(poller.current, before);
});

/* ---------- requirements 8 and 9: clean error reporting ---------- */

test("reports a missing project note cleanly instead of throwing", () => {
  const vault = makeTempVault();
  const poller = pollerFor(vault, "Nope.md");

  const errors: Array<[Error, string]> = [];
  poller.onError = (err, notePath) => errors.push([err, notePath]);

  const outcome = poller.pollNow();

  assert.equal(outcome.changed, false);
  assert.equal(outcome.loaded, null);
  assert.ok(errors[0]![0] instanceof ProjectNoteMissingError);
  assert.equal(errors[0]![1], "Nope.md");
});

test("reports a note that appears later without needing a restart", () => {
  const vault = makeTempVault();
  const poller = pollerFor(vault, "Later.md");

  assert.equal(poller.pollNow().changed, false, "missing is not a change");

  writeNote(vault, "Later.md", SAMPLE_NOTE);

  const recovered = poller.pollNow();
  assert.equal(recovered.changed, true);
  assert.equal(recovered.loaded?.state.title, "Widget Build");
});

test("surfaces a schema violation cleanly", () => {
  const vault = makeTempVault();
  writeNote(vault, "Bad.md", "---\nprogress: 4/6\n---\n\n# Bad\n\n## P\n- [ ] a ^a1\n");
  const poller = pollerFor(vault, "Bad.md");

  const errors: Error[] = [];
  poller.onError = (err) => errors.push(err);

  const outcome = poller.pollNow();

  assert.equal(outcome.changed, false);
  assert.equal(outcome.loaded, null);
  assert.ok(errors[0] instanceof SchemaViolationError);
});

test("recovers once an invalid note is fixed", async () => {
  const vault = makeTempVault();
  const bad = "---\nprogress: 4/6\n---\n\n# Bad\n\n## P\n- [ ] a ^a1\n";
  writeNote(vault, "Note.md", bad);
  const poller = pollerFor(vault, "Note.md");

  assert.equal(poller.pollNow().loaded, null, "invalid note does not load");

  await waitForMtimeTick();
  writeNote(vault, "Note.md", SAMPLE_NOTE);

  const fixed = poller.pollNow();
  assert.equal(fixed.changed, true);
  assert.equal(fixed.loaded?.state.fraction, "1/3");
});

/* ---------- requirement 5: Windows-side modifications ---------- */

test("detects a modification made from the Windows side", () => {
  const vault = makeMntCVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();
  assert.equal(poller.current?.fraction, "1/3");

  // Written by powershell.exe, i.e. originating on the Windows host, which
  // is what Obsidian itself does.
  writeNoteFromWindows(vault, "Widget.md", SAMPLE_NOTE_TOGGLED);

  const after = poller.pollNow();
  assert.equal(after.changed, true, "a Windows-side write must be detected");
  assert.equal(after.loaded?.state.fraction, "2/3");
});

test("detects a Windows-side file creation", () => {
  const vault = makeMntCVault();
  const poller = pollerFor(vault, "Created.md");

  assert.equal(poller.pollNow().loaded, null);

  writeNoteFromWindows(vault, "Created.md", SAMPLE_NOTE);

  const after = poller.pollNow();
  assert.equal(after.changed, true);
  assert.equal(after.loaded?.state.title, "Widget Build");
});

/* ---------- configuration and lifecycle ---------- */

test("uses configurable polling intervals", () => {
  let idle = false;
  const poller = new ProjectPoller({
    vaultRoot: makeTempVault(),
    projectNotes: ["X.md"],
    intervalMs: 250,
    idleIntervalMs: 4000,
    isIdle: () => idle,
  });

  assert.equal(poller.currentIntervalMs, 250);

  idle = true;
  assert.equal(poller.currentIntervalMs, 4000);

  idle = false;
  assert.equal(poller.currentIntervalMs, 250);
});

test("defaults to a one second active interval and five second idle", () => {
  const poller = new ProjectPoller({ vaultRoot: makeTempVault(), projectNotes: ["X.md"] });

  assert.equal(poller.currentIntervalMs, 1000);
});

test("refresh forces an immediate poll on window focus", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");

  poller.pollNow();

  await waitForMtimeTick();
  writeNote(vault, "Widget.md", SAMPLE_NOTE_TOGGLED);

  // No interval has elapsed; only the focus refresh can surface this.
  const focused = poller.refresh();

  assert.equal(focused.changed, true);
  assert.equal(focused.loaded?.state.fraction, "2/3");
});

test("start and stop drive repeated polling", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = new ProjectPoller({
    vaultRoot: vault,
    projectNotes: ["Widget.md"],
    intervalMs: 10,
  });

  const seen: string[] = [];
  poller.onChange = (loaded) => seen.push(loaded.state.fraction);

  poller.start();
  await new Promise((r) => setTimeout(r, 60));
  poller.stop();

  assert.deepEqual(seen, ["1/3"], "start performs an initial load");

  // Nothing changed, so further ticks must not notify again.
  await new Promise((r) => setTimeout(r, 40));
  assert.deepEqual(seen, ["1/3"], "ticking on an unchanged file must stay silent");
});

test("stop halts polling", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = new ProjectPoller({
    vaultRoot: vault,
    projectNotes: ["Widget.md"],
    intervalMs: 10,
  });

  poller.start();
  poller.stop();
  assert.equal(poller.current?.fraction, "1/3", "state from the initial load is retained");

  // Prove the loop is genuinely dead: no further polls may occur at all.
  // Relying only on the fraction would pass even if a timer survived,
  // because the running-flag guard alone would suppress the reload.
  const pollsAtStop = poller.pollCount;
  await new Promise((r) => setTimeout(r, 80));

  assert.equal(poller.pollCount, pollsAtStop, "no poll may run after stop()");
});

test("an active poller does keep polling", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = new ProjectPoller({
    vaultRoot: vault,
    projectNotes: ["Widget.md"],
    intervalMs: 10,
  });

  poller.start();
  const before = poller.pollCount;
  await new Promise((r) => setTimeout(r, 80));
  poller.stop();

  assert.ok(poller.pollCount > before, "a running poller must tick");
});

test("the size component of the change key catches an edit that preserves mtime", async () => {
  const vault = makeTempVault();
  writeNote(vault, "Widget.md", SAMPLE_NOTE);
  const poller = pollerFor(vault, "Widget.md");
  poller.pollNow();

  const file = join(vault, "Widget.md");
  const originalMtimeMs = statSync(file).mtimeMs;

  // A sync tool or restore can rewrite content while preserving mtime.
  // mtime alone would miss this; the size component must catch it.
  const longer = SAMPLE_NOTE.replace(
    "- [ ] sign off ^b1",
    "- [ ] sign off, then file the paperwork with the council ^b1",
  );
  await waitForMtimeTick();
  writeFileSync(file, longer, "utf8");
  // Pass exact fractional seconds so mtime is restored bit-for-bit.
  utimesSync(file, originalMtimeMs / 1000, originalMtimeMs / 1000);

  assert.equal(
    statSync(file).mtimeMs,
    originalMtimeMs,
    "mtime must be restored exactly, otherwise this test does not isolate size",
  );
  assert.notEqual(statSync(file).size, SAMPLE_NOTE.length, "size must differ");

  const after = poller.pollNow();

  assert.equal(after.changed, true, "a content change under a preserved mtime must be detected");
  assert.ok(after.loaded!.source.length > SAMPLE_NOTE.length);
});

test("tracks every configured note", () => {
  const vault = makeTempVault();
  writeNote(vault, "One.md", SAMPLE_NOTE);
  writeNote(vault, "Two.md", SAMPLE_NOTE_TOGGLED);

  const poller = new ProjectPoller({ vaultRoot: vault, projectNotes: ["One.md", "Two.md"] });
  poller.pollNow();

  assert.equal(poller.trackedCount, 2);
});
