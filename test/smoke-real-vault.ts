/**
 * READ-ONLY smoke test against the REAL Obsidian vault.
 *
 * This is deliberately NOT a unit test: it depends on the real vault
 * existing, so it lives outside the suite. It writes nothing. It exists to
 * prove the Phase 2 reader and scanner work against the actual target path
 * rather than only against throwaway fixtures.
 */
import { listMarkdownNotes } from "../src/vault/scan.ts";
import { readProjectNote, resolveInVault } from "../src/vault/reader.ts";
import { ProjectPoller } from "../src/vault/poller.ts";

const VAULT = "/mnt/c/Users/Asher/Downloads/Asher/Dev/Git/Obsidian/23asher.io";

console.log("vault:", VAULT, "\n");

console.log("--- 1. scanner over the real vault ---");
const notes = listMarkdownNotes(VAULT);
console.log("markdown notes found:", JSON.stringify(notes));
console.log("excluded .obsidian   :", !notes.some((n) => n.includes(".obsidian")));
console.log("excluded .git        :", !notes.some((n) => n.includes(".git")));
console.log();

console.log("--- 2. reader over the real vault (read-only) ---");
const loaded = readProjectNote(VAULT, "Welcome.md");
console.log("path        :", loaded.path);
console.log("absolutePath:", loaded.absolutePath);
console.log("bytes read  :", loaded.source.length);
console.log("derived title  :", JSON.stringify(loaded.state.title));
console.log("derived fraction:", loaded.state.fraction);
console.log("derived percent :", loaded.state.percent);
console.log("phases         :", loaded.state.phaseCount);
console.log("next task      :", loaded.state.nextTask);
console.log();

console.log("--- 3. path resolution stays inside the vault ---");
console.log("Welcome.md       ->", resolveInVault(VAULT, "Welcome.md"));
for (const bad of ["../outside.md", "/etc/passwd", "../../Windows/System32/x.md"]) {
  try {
    resolveInVault(VAULT, bad);
    console.log(`UNSAFE ACCEPTED: ${bad}`);
  } catch (err) {
    console.log(`refused ${bad.padEnd(34)} -> ${(err as Error).name}`);
  }
}
console.log();

console.log("--- 4. missing note reports cleanly ---");
try {
  readProjectNote(VAULT, "Does Not Exist.md");
  console.log("UNEXPECTED: no error");
} catch (err) {
  console.log(`${(err as Error).name}: ${(err as Error).message}`);
}
console.log();

console.log("--- 5. poller against the real vault, read-only ---");
const poller = new ProjectPoller({
  vaultRoot: VAULT,
  projectNotes: ["Welcome.md"],
  intervalMs: 1000,
});
const first = poller.pollNow();
console.log("first poll changed :", first.changed);
console.log("change key         :", first.key);
console.log("current fraction   :", poller.current?.fraction);

const t0 = process.hrtime.bigint();
const N = 50;
for (let i = 0; i < N; i++) poller.pollNow();
const t1 = process.hrtime.bigint();
console.log(`unchanged poll cost: ${(Number(t1 - t0) / 1e6 / N).toFixed(3)}ms each (N=${N})`);

const second = poller.pollNow();
console.log("second poll changed:", second.changed, "(expected false: nothing was written)");
console.log("state identity held:", poller.current === first.loaded?.state);
poller.stop();

console.log("\nSMOKE TEST COMPLETE - vault was read only, never written.");
