/**
 * Phase 2 detection-characteristics measurement.
 * Read-only with respect to the real vault: it uses its own throwaway
 * fixture on /mnt/c, the same filesystem as the vault.
 */
import { ProjectPoller } from "../src/vault/poller.ts";
import {
  makeMntCVault,
  writeNote,
  writeNoteFromWindows,
  cleanupTempVaults,
  SAMPLE_NOTE,
  SAMPLE_NOTE_TOGGLED,
} from "./helpers/tempVault.ts";

const NOTE = "Widget.md";

function measure(
  label: string,
  intervalMs: number,
  act: (vault: string) => Promise<void>,
  runs = 5,
): Promise<void> {
  const latencies: number[] = [];
  return new Promise<void>((resolve) => {
    let done = 0;
    const step = async () => {
      if (done >= runs) {
        latencies.sort((a, b) => a - b);
        const min = latencies[0];
        const max = latencies[latencies.length - 1];
        const median = latencies[Math.floor(latencies.length / 2)];
        if (min === undefined || max === undefined || median === undefined) {
          console.log(`${label}: no samples`);
          resolve();
          return;
        }
        console.log(
          `${label.padEnd(34)} interval=${String(intervalMs).padStart(4)}ms  ` +
            `min=${min.toFixed(1)}ms  median=${median.toFixed(1)}ms  max=${max.toFixed(1)}ms`,
        );
        resolve();
        return;
      }
      const vault = makeMntCVault();
      writeNote(vault, NOTE, SAMPLE_NOTE);
      const poller = new ProjectPoller({
        vaultRoot: vault,
        projectNotes: [NOTE],
        intervalMs,
      });

      let detected = 0;
      poller.onChange = (loaded) => {
        if (loaded.state.fraction === "2/3") detected = Date.now() - t0;
      };

      poller.start();
      const t0 = Date.now();
      await act(vault);
      await new Promise((r) => setTimeout(r, intervalMs * 6 + 400));
      poller.stop();
      latencies.push(detected === 0 ? NaN : detected);
      done++;
      step();
    };
    step();
  });
}

console.log("=== DETECTION LATENCY on /mnt/c (same filesystem as the vault) ===\n");

const writeLocal = async (vault: string): Promise<void> => {
  writeNote(vault, NOTE, SAMPLE_NOTE_TOGGLED);
};
const writeWindows = async (vault: string): Promise<void> => {
  writeNoteFromWindows(vault, NOTE, SAMPLE_NOTE_TOGGLED);
};

console.log("-- WSL-side write (same size, one character changed) --");
await measure("250ms poll", 250, writeLocal);
await measure("1000ms poll (default active)", 1000, writeLocal);
await measure("5000ms poll (default idle)", 5000, writeLocal, 3);

console.log("\n-- Windows-side write via powershell.exe (what Obsidian does) --");
await measure("1000ms poll (default active)", 1000, writeWindows, 3);
await measure("5000ms poll (default idle)", 5000, writeWindows, 3);

console.log("\n=== STEADY-STATE COST (idle polling of one note) ===\n");
{
  const vault = makeMntCVault();
  writeNote(vault, NOTE, SAMPLE_NOTE);
  const poller = new ProjectPoller({ vaultRoot: vault, projectNotes: [NOTE] });
  poller.pollNow();

  const t0 = process.hrtime.bigint();
  const N = 2000;
  for (let i = 0; i < N; i++) poller.pollNow();
  const t1 = process.hrtime.bigint();

  const per = Number(t1 - t0) / 1e6 / N;
  console.log(`unchanged poll: ${per.toFixed(4)}ms each over ${N} polls`);
  console.log(`at 1s interval : ${((per / 1000) * 100).toFixed(4)}% of one core`);
  console.log(`at 5s interval : ${((per / 5000) * 100).toFixed(5)}% of one core`);
  console.log(`parses avoided : ${N - 1} (only the first poll parsed)`);
}

cleanupTempVaults();
