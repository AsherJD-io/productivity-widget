import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, renameSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import {
  setTaskChecked,
  TargetTaskMissingError,
  StaleSnapshotError,
  PostWriteVerificationError,
} from "../src/vault/writer.ts";
import { ProjectNoteMissingError } from "../src/vault/reader.ts";
import { SchemaViolationError } from "../src/schema.ts";
import { makeTempVault, makeMntCVault, writeNote, cleanupTempVaults, waitForMtimeTick } from "./helpers/tempVault.ts";

test.after(cleanupTempVaults);

const NOTE = "Widget.md";

/** Deliberately messy: trailing spaces, tabs, odd indentation, blank lines. */
const MESSY_NOTE = [
  "---",
  "project: Messy",
  "---",
  "",
  "# Messy",
  "",
  "## Wiring   ",
  "",
  "- [x] run the cable ^a1   ",
  "\t- [ ] tab indented task ^a2",
  "  - [ ]   extra   spaces   ^a3  ",
  "",
  "",
  "## Commissioning",
  "- [ ] sign off ^b1",
  "- [ ] take photos ^b2",
  "",
].join("\n");

function setup(contents = MESSY_NOTE): string {
  const vault = makeTempVault();
  writeNote(vault, NOTE, contents);
  return vault;
}

function onDisk(vault: string): string {
  return readFileSync(join(vault, NOTE), "utf8");
}

/** Every line except the given one, for byte-comparison of the untouched rest. */
function allLinesExcept(source: string, blockId: string): string[] {
  return source.split("\n").filter((l) => !l.includes(`^${blockId}`));
}

/* ---------- 1, 2: checkbox direction ---------- */

test("checks an unchecked task by block id", () => {
  const vault = setup();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, true);
  assert.ok(onDisk(vault).includes("[x] tab indented task ^a2"));
});

test("unchecks a checked task by block id", () => {
  const vault = setup();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: MESSY_NOTE,
    done: false,
  });

  assert.equal(result.ok, true);
  assert.ok(onDisk(vault).includes("- [ ] run the cable ^a1   "), "trailing spaces preserved");
});

test("toggles the checkbox when no target state is given", () => {
  const vault = setup();

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a1", snapshot: MESSY_NOTE });
  assert.ok(onDisk(vault).includes("- [ ] run the cable ^a1"));

  const after = onDisk(vault);
  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a1", snapshot: after });
  assert.ok(onDisk(vault).includes("- [x] run the cable ^a1"));
});

/* ---------- 3, 4: identity is the block id ---------- */

test("selects the target by block id, not by position", () => {
  const vault = setup();

  // a3 is the third task, but addressing must be by id.
  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a3", snapshot: MESSY_NOTE, done: true });

  assert.ok(onDisk(vault).includes("[x]   extra   spaces   ^a3"));
  assert.ok(onDisk(vault).includes("- [ ] tab indented task ^a2"), "a2 must be untouched");
});

test("duplicate task text still updates only the block-id task", () => {
  const dupes = [
    "# Dupes",
    "",
    "## P",
    "- [ ] do the thing ^first",
    "- [ ] do the thing ^second",
    "- [ ] do the thing ^third",
    "",
  ].join("\n");
  const vault = setup(dupes);

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "second", snapshot: dupes, done: true });

  const after = onDisk(vault);
  assert.ok(after.includes("- [x] do the thing ^second"));
  assert.ok(after.includes("- [ ] do the thing ^first"));
  assert.ok(after.includes("- [ ] do the thing ^third"));
});

/* ---------- 5, 6: block ids survive reordering and rewording ---------- */

test("block-id targeting still works after the tasks are reordered", async () => {
  const original = ["# R", "", "## P", "- [ ] alpha ^a1", "- [ ] beta ^a2", ""].join("\n");
  const vault = makeTempVault();
  writeNote(vault, NOTE, original);

  // Obsidian or the user reorders the lines.
  const reordered = ["# R", "", "## P", "- [ ] beta ^a2", "- [ ] alpha ^a1", ""].join("\n");
  await waitForMtimeTick();
  writeNote(vault, NOTE, reordered);

  // The UI polled, saw the reorder, and re-rendered from the new content.
  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: reordered,
    done: true,
  });

  assert.equal(result.ok, true);
  const after = onDisk(vault);
  assert.ok(after.includes("- [x] alpha ^a1"), "the right task, despite moving");
  assert.ok(after.includes("- [ ] beta ^a2"));
  assert.equal(after, reordered.replace("- [ ] alpha ^a1", "- [x] alpha ^a1"), "new order preserved");
});

test("block-id targeting still works after the task text is reworded", async () => {
  const original = ["# R", "", "## P", "- [ ] mount the panel ^a1", "- [ ] other ^a2", ""].join("\n");
  const vault = makeTempVault();
  writeNote(vault, NOTE, original);

  const reworded = ["# R", "", "## P", "- [ ] mount the panel, carefully ^a1", "- [ ] other ^a2", ""].join("\n");
  await waitForMtimeTick();
  writeNote(vault, NOTE, reworded);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: reworded,
    done: true,
  });

  assert.equal(result.ok, true);
  assert.ok(onDisk(vault).includes("- [x] mount the panel, carefully ^a1"));
});

/* ---------- 7, 8, 9: byte preservation ---------- */

test("unrelated task lines remain byte-identical", () => {
  const vault = setup();

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true });

  assert.deepEqual(allLinesExcept(onDisk(vault), "a2"), allLinesExcept(MESSY_NOTE, "a2"));
});

test("unrelated whitespace remains byte-identical", () => {
  const vault = setup();

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true });

  const after = onDisk(vault);
  // Trailing spaces on a heading, trailing spaces on a task, a tab indent and
  // repeated interior spaces must all survive a write to a different task.
  assert.ok(after.includes("## Wiring   "), "trailing spaces on the phase heading");
  assert.ok(after.includes("- [x] run the cable ^a1   "), "trailing spaces on an unrelated task");
  assert.ok(after.includes("\t- [x] tab indented task ^a2"), "tab indent on the target task");
  assert.ok(after.includes("  - [ ]   extra   spaces   ^a3  "), "repeated interior and trailing spaces");
});

test("the whole document differs by exactly one character", () => {
  const vault = setup();

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true });

  const after = onDisk(vault);
  assert.equal(after.length, MESSY_NOTE.length, "same length: one char swapped, none added");

  let differences = 0;
  for (let i = 0; i < MESSY_NOTE.length; i++) {
    if (MESSY_NOTE[i] !== after[i]) differences++;
  }
  assert.equal(differences, 1, `expected exactly 1 differing character, found ${differences}`);
});

test("a note without a trailing newline keeps that shape", () => {
  const noNewline = ["# R", "", "## P", "- [ ] alpha ^a1"].join("\n");
  const vault = setup(noNewline);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: noNewline,
    done: true,
  });

  assert.equal(result.ok, true);
  assert.equal(onDisk(vault).endsWith("\n"), false, "must not append a newline");
});

/* ---------- 10, 11: line endings ---------- */

test("an LF source stays LF", () => {
  const lf = ["# R", "", "## P", "- [ ] alpha ^a1", "- [ ] beta ^a2", ""].join("\n");
  const vault = setup(lf);

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a1", snapshot: lf, done: true });

  const after = onDisk(vault);
  assert.equal(after.includes("\r\n"), false, "no CRLF introduced");
  assert.equal((after.match(/\n/g) ?? []).length, (lf.match(/\n/g) ?? []).length);
});

test("a CRLF source stays CRLF, byte for byte", () => {
  const lf = ["# R", "", "## P", "- [ ] alpha ^a1", "- [ ] beta ^a2", ""].join("\n");
  const crlf = lf.replace(/\n/g, "\r\n");
  const vault = setup(crlf);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: crlf,
    done: true,
  });

  assert.equal(result.ok, true);

  const after = readFileSync(join(vault, NOTE));
  assert.ok(after.includes(Buffer.from("\r\n")), "CRLF preserved");

  // Exactly one byte differs from the CRLF original.
  const original = Buffer.from(crlf, "utf8");
  let differences = 0;
  for (let i = 0; i < original.length; i++) {
    if (original[i] !== after[i]) differences++;
  }
  assert.equal(differences, 1, `expected 1 differing byte, found ${differences}`);
  assert.equal(after.length, original.length, "no bytes added or removed");
});

/* ---------- 12: conflict protection ---------- */

test("a stale snapshot aborts the write and changes nothing", async () => {
  const vault = setup();

  // The UI holds the original snapshot. Meanwhile the note is edited.
  const edited = MESSY_NOTE.replace("# Messy", "# Messy Renamed");
  await waitForMtimeTick();
  writeNote(vault, NOTE, edited);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "conflict");
  assert.ok(onDisk(vault) === edited, "the newer external edit must survive untouched");
});

test("a conflict returns the fresh state so the UI can re-render", () => {
  const vault = setup();
  const edited = MESSY_NOTE.replace("- [ ] sign off ^b1", "- [x] sign off ^b1");
  writeNote(vault, NOTE, edited);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.ok(result.state !== null, "fresh state must be supplied");
  // MESSY_NOTE has 5 tasks, 1 checked. The external edit checks b1, so the
  // fresh state is 2/5, which differs from the stale UI's 1/5.
  assert.equal(result.state.fraction, "2/5", "reflects the external edit, not the stale UI");
});

test("a conflict is detected for a change anywhere, not just the target line", () => {
  const vault = setup();
  // Change an unrelated task's text. The target line a2 is untouched.
  const edited = MESSY_NOTE.replace("- [ ] take photos ^b2", "- [ ] take photographs ^b2");
  assert.notEqual(edited, MESSY_NOTE, "the edit must actually change something");
  assert.ok(edited.includes("- [ ] tab indented task ^a2"), "target line itself is unchanged");
  writeNote(vault, NOTE, edited);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "conflict");
  assert.equal(onDisk(vault), edited, "the external edit survives");
});

test("a conflict is detected even when the target line is unchanged", () => {
  const vault = setup();
  // Append a trailing comment; the task lines are untouched.
  const edited = `${MESSY_NOTE}\n<!-- edited -->\n`;
  writeNote(vault, NOTE, edited);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "conflict");
});

/* ---------- 13, 14, 15, 16: error handling ---------- */

test("a missing block id reports a clean error", () => {
  const vault = setup();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "nosuch",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "task-missing");
  assert.ok(result.error instanceof TargetTaskMissingError);
  assert.equal(onDisk(vault), MESSY_NOTE, "nothing written");
});

test("a task with no block id cannot be addressed and is not guessed at", () => {
  const noIds = ["# R", "", "## P", "- [ ] untargetable task", ""].join("\n");
  const vault = setup(noIds);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "untargetable",
    snapshot: noIds,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "task-missing");
  assert.equal(onDisk(vault), noIds, "no fallback identity strategy was attempted");
});

test("a missing note reports a clean error", () => {
  const vault = makeTempVault();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: "Nope.md",
    taskId: "a1",
    snapshot: "",
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "note-missing");
  assert.ok(result.error instanceof ProjectNoteMissingError);
});

test("a path outside the vault is refused", () => {
  const vault = setup();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: "../escape.md",
    taskId: "a1",
    snapshot: "",
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(onDisk(vault), MESSY_NOTE, "vault untouched");
});

test("a schema violation reports a clean error and writes nothing", () => {
  const bad = "---\nprogress: 4/6\n---\n\n# Bad\n\n## P\n- [ ] a ^a1\n";
  const vault = setup(bad);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: bad,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "schema-violation");
  assert.ok(result.error instanceof SchemaViolationError);
  assert.equal(onDisk(vault), bad, "nothing written");
});

/* ---------- 17, 18, 19: atomicity and verification ---------- */

test("the atomic write leaves a complete, valid file", () => {
  const vault = setup();

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true });

  const after = onDisk(vault);
  assert.ok(after.length > 0);
  assert.ok(after.startsWith("---"), "frontmatter intact, so not truncated");
  assert.ok(after.trimEnd().endsWith("- [ ] take photos ^b2"), "last line intact");
});

test("no temporary file is left behind", () => {
  const vault = setup();

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true });

  const files = readdirSync(vault);
  assert.deepEqual(files, [NOTE], `expected only the note, found ${JSON.stringify(files)}`);
  assert.equal(existsSync(join(vault, ".Widget.md.tmp-write")), false);
});

test("post-write state confirms the intended task state", () => {
  const vault = setup();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  const target = result.state.phases
    .flatMap((p) => p.tasks)
    .find((t) => t.id === "a2");
  assert.equal(target?.done, true);
  assert.equal(result.done, true);
});

test("derived state after the write is correct", () => {
  const vault = setup();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;

  // Before: 1 of 5 checked. After: 2 of 5.
  assert.equal(result.state.fraction, "2/5");
  assert.equal(result.state.total, 5);
  assert.equal(result.state.completed, 2);
});

test("derived state comes from disk, not from the pre-write parse", () => {
  const vault = setup();

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: MESSY_NOTE,
    done: false,
  });

  assert.equal(result.ok, true);
  if (!result.ok) return;
  assert.equal(result.state.completed, 0, "a1 was the only checked task and is now unchecked");
  assert.equal(result.source, onDisk(vault), "returned source matches what is on disk");
});

/* ---------- 20, 21: edge cases ---------- */

test("a zero-task project is safe to write against", () => {
  const empty = ["# Empty", "", "## Planning", "no tasks yet", ""].join("\n");
  const vault = setup(empty);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "anything",
    snapshot: empty,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "task-missing");
  assert.equal(result.state?.fraction, "0/0", "no division by zero");
  assert.equal(onDisk(vault), empty);
});

test("a note with no phases at all is safe", () => {
  const bare = "# Just a title\n";
  const vault = setup(bare);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a1",
    snapshot: bare,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "task-missing");
  assert.equal(onDisk(vault), bare);
});

test("multiple phases all remain intact after a write", () => {
  const vault = setup();

  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "b2", snapshot: MESSY_NOTE, done: true });

  const after = onDisk(vault);
  assert.ok(after.includes("## Wiring   "), "phase 1 heading");
  assert.ok(after.includes("## Commissioning"), "phase 2 heading");
  assert.ok(after.includes("[x] take photos ^b2"));
  assert.equal(after, MESSY_NOTE.replace("- [ ] take photos ^b2", "- [x] take photos ^b2"));
});

test("a nested task with different bullet and indent style is handled", () => {
  const styles = [
    "# S",
    "",
    "## P",
    "* [ ] star bullet ^s1",
    "+ [ ] plus bullet ^p1",
    "    - [ ] deep indent ^d1",
    "",
  ].join("\n");
  const vault = setup(styles);

  for (const id of ["s1", "p1", "d1"]) {
    const snapshot = onDisk(vault);
    const result = setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: id, snapshot, done: true });
    assert.equal(result.ok, true, `write for ${id}`);
  }

  const after = onDisk(vault);
  assert.ok(after.includes("* [x] star bullet ^s1"));
  assert.ok(after.includes("+ [x] plus bullet ^p1"));
  assert.ok(after.includes("    - [x] deep indent ^d1"));
});

test("the poller sees the writer's change immediately", async () => {
  const vault = setup();
  const { ProjectPoller } = await import("../src/vault/poller.ts");

  const poller = new ProjectPoller({ vaultRoot: vault, projectNotes: [NOTE] });
  poller.pollNow();
  assert.equal(poller.current?.fraction, "1/5");

  await waitForMtimeTick();
  setTaskChecked({ vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true });

  // Poll straight after the widget's own write, as the design requires.
  const after = poller.pollNow();
  assert.equal(after.changed, true);
  assert.equal(poller.current?.fraction, "2/5");
  poller.stop();
});

test("works against the real drvfs filesystem the vault uses", () => {
  const vault = makeMntCVault();
  writeNote(vault, NOTE, MESSY_NOTE);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, true);
  assert.equal(onDisk(vault), MESSY_NOTE.replace("\t- [ ] tab", "\t- [x] tab"));
  assert.deepEqual(readdirSync(vault), [NOTE], "no temp file left on /mnt/c");
});

/* ---------- fault injection: does verification actually verify? ---------- */

test("detects a corrupted post-write file instead of trusting the write", () => {
  const vault = setup();
  let reads = 0;

  const result = setTaskChecked(
    { vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true },
    {
      // First read is the pre-write read; the second must come from disk.
      readFile: () => {
        reads++;
        return reads === 1 ? MESSY_NOTE : MESSY_NOTE.replace("a2", "a9");
      },
    },
  );

  assert.equal(result.ok, false, "a corrupted write must not be reported as success");
  assert.equal(result.kind, "verification-failed");
});

test("detects a post-write file missing the intended change", () => {
  const vault = setup();
  let reads = 0;

  const result = setTaskChecked(
    { vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true },
    {
      readFile: () => {
        reads++;
        // The second read returns the file completely unchanged.
        return MESSY_NOTE;
      },
    },
  );

  assert.equal(result.ok, false);
  assert.equal(result.kind, "verification-failed");
});

test("detects corruption in an unrelated line even when the target task is correct", () => {
  const vault = setup();
  let reads = 0;
  const intended = MESSY_NOTE.replace("\t- [ ] tab indented task ^a2", "\t- [x] tab indented task ^a2");

  const result = setTaskChecked(
    { vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true },
    {
      readFile: () => {
        reads++;
        // The target task is correct in this content, but an unrelated line
        // has drifted. Only a whole-document byte comparison catches that.
        return reads === 1 ? MESSY_NOTE : intended.replace("take photos ^b2", "take photographs ^b2");
      },
    },
  );

  assert.equal(result.ok, false, "drift anywhere in the document must be caught");
  assert.equal(result.kind, "verification-failed");
});

test("does not report success without re-reading from disk", () => {
  const vault = setup();
  let reads = 0;

  setTaskChecked(
    { vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true },
    {
      readFile: () => {
        reads++;
        return MESSY_NOTE;
      },
    },
  );

  assert.equal(reads, 2, "the writer must read twice: before and after the write");
});

/* ---------- conflict strictness ---------- */

test("a whitespace-only external change is still a conflict", () => {
  const vault = setup();
  // Someone added a trailing space on an unrelated line. Byte preservation
  // says that matters, so we must not write over it.
  const edited = MESSY_NOTE.replace("## Commissioning", "## Commissioning ");
  assert.notEqual(edited, MESSY_NOTE);
  writeNote(vault, NOTE, edited);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false, "trailing whitespace is content, not noise");
  assert.equal(result.kind, "conflict");
  assert.equal(onDisk(vault), edited);
});

test("a line-ending change is still a conflict", () => {
  const vault = setup();
  const edited = MESSY_NOTE.replace(/\n/g, "\r\n");
  writeNote(vault, NOTE, edited);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false);
  assert.equal(result.kind, "conflict");
});

/* ---------- block-id identity is case sensitive ---------- */

test("block ids are matched case-sensitively", () => {
  const cased = ["# C", "", "## P", "- [ ] lower ^abc", "- [ ] upper ^ABC", ""].join("\n");
  const vault = setup(cased);

  // ^abc and ^ABC are distinct tasks. Addressing ^abc must not touch ^ABC.
  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "abc",
    snapshot: cased,
    done: true,
  });

  assert.equal(result.ok, true);
  const after = onDisk(vault);
  assert.ok(after.includes("- [x] lower ^abc"), "the exact id was targeted");
  assert.ok(after.includes("- [ ] upper ^ABC"), "the differently-cased id is a different task");
});

test("block-id matching is exact, not case-insensitive and not a prefix match", () => {
  // Decoys deliberately placed BEFORE the real target so that a laxer
  // matcher (case-insensitive, or prefix) would pick one of them up first.
  const tricky = [
    "# T",
    "",
    "## P",
    "- [ ] upper ^ABC",
    "- [ ] longer ^abc-def",
    "- [ ] target ^abc",
    "",
  ].join("\n");
  const vault = setup(tricky);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "abc",
    snapshot: tricky,
    done: true,
  });

  assert.equal(result.ok, true);
  const after = onDisk(vault);
  assert.ok(after.includes("- [x] target ^abc"), "the exact id was targeted");
  assert.ok(after.includes("- [ ] upper ^ABC"), "case decoy untouched");
  assert.ok(after.includes("- [ ] longer ^abc-def"), "prefix decoy untouched");
});

/* ---------- conflict strictness at end of document ---------- */

test("trailing whitespace at the very end of the file is still a conflict", () => {
  const vault = setup();
  // A difference at the very tail of the file. Note that trimEnd() on both
  // sides would hide this, which is exactly what the mutation being tested
  // would do, so it is the discriminating case.
  const edited = `${MESSY_NOTE}   `;
  assert.notEqual(edited, MESSY_NOTE, "the edit must change the file");
  assert.equal(edited.trimEnd(), MESSY_NOTE.trimEnd(), "only a whole-document trim would hide this");
  writeNote(vault, NOTE, edited);

  const result = setTaskChecked({
    vaultRoot: vault,
    notePath: NOTE,
    taskId: "a2",
    snapshot: MESSY_NOTE,
    done: true,
  });

  assert.equal(result.ok, false, "a difference at the tail of the document must still conflict");
  assert.equal(result.kind, "conflict");
});

/* ---------- atomicity is observable ---------- */

test("writes through a temporary file and renames it onto the note", () => {
  const vault = setup();
  const notePath = join(vault, NOTE);
  const writeTargets: string[] = [];
  const renamePairs: Array<[string, string]> = [];

  const result = setTaskChecked(
    { vaultRoot: vault, notePath: NOTE, taskId: "a2", snapshot: MESSY_NOTE, done: true },
    {
      writeFile: (path, data) => {
        writeTargets.push(path);
        writeFileSync(path, data, { encoding: "utf8" });
      },
      rename: (from, to) => {
        renamePairs.push([from, to]);
        renameSync(from, to);
      },
    },
  );

  assert.equal(result.ok, true);

  // The write must NOT land on the note itself, or a crash mid-write would
  // leave a truncated note in place of the user's file.
  assert.equal(writeTargets.length, 1);
  assert.notEqual(writeTargets[0], notePath, "must not write directly onto the note");
  assert.ok(
    writeTargets[0]!.startsWith(vault) && writeTargets[0] !== notePath,
    "temp file must live in the same directory as the note",
  );

  assert.deepEqual(renamePairs, [[writeTargets[0], notePath]], "temp must be renamed onto the note");
});
