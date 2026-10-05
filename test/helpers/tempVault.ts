import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

/**
 * Deterministic throwaway vault fixtures.
 *
 * These live in the OS temp directory, NEVER in the real Obsidian vault.
 * Phase 2 must not write to the real vault, so every test that needs a
 * writable vault builds an isolated one here and destroys it afterwards.
 *
 * FILESYSTEM CAVEAT, MEASURED NOT ASSUMED
 * ========================================
 * The poller's change key is `mtime:size`. That was verified reliable on
 * /mnt/c, which is where the real vault lives:
 *
 *   - 10/10 same-byte-length checkbox edits produced a new mtime
 *   - 20 rapid same-length writes produced 20 distinct mtime values
 *   - drvfs write latency is ~6-14ms, comfortably wider than the mtime tick
 *
 * On tmpfs (/tmp, ext4) the opposite is true: 20 rapid same-length writes
 * collapsed to a SINGLE mtime value, so a same-length edit inside one tick
 * is invisible to an mtime+size key. Tests that exercise same-length edits
 * must therefore either live on /mnt/c or wait out the tick.
 */

const created: string[] = [];

export function makeTempVault(): string {
  const dir = mkdtempSync(join(tmpdir(), "projvault-"));
  created.push(dir);
  return dir;
}

/**
 * Create a throwaway vault on /mnt/c, i.e. the same drvfs filesystem as the
 * real vault, but nowhere near it. Used for tests whose validity depends on
 * real drvfs mtime behaviour, and for Windows-side write tests.
 */
export function makeMntCVault(): string {
  const winTemp = execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "[IO.Path]::GetTempPath()",
  ])
    .toString()
    .trim();
  const posix = "/mnt/c" + winTemp.replace(/^([A-Za-z]:)?/, "").replace(/\\/g, "/").replace(/\/$/, "");
  const dir = mkdtempSync(join(posix, "projvault-"));
  created.push(dir);
  return dir;
}

export function cleanupTempVaults(): void {
  for (const dir of created.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
}

export function writeNote(vaultRoot: string, relativePath: string, contents: string): string {
  const full = join(vaultRoot, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  writeFileSync(full, contents, "utf8");
  return full;
}

/** Translate a WSL path under /mnt/<drive> into a Windows path for PowerShell. */
export function toWindowsPath(wslPath: string): string {
  const m = /^\/mnt\/([a-zA-Z])\/(.*)$/.exec(wslPath);
  if (!m) throw new Error(`not a /mnt path: ${wslPath}`);
  return `${m[1]!.toUpperCase()}:\\${m[2]!.replace(/\//g, "\\")}`;
}

/** Write a file from the Windows side, so the change originates off-WSL. */
export function writeNoteFromWindows(vaultRoot: string, relativePath: string, contents: string): void {
  const full = join(vaultRoot, relativePath);
  mkdirSync(join(full, ".."), { recursive: true });
  const winPath = toWindowsPath(full);

  execFileSync("powershell.exe", [
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `$c = @'\n${contents}\n'@; Set-Content -LiteralPath '${winPath}' -Value $c -NoNewline`,
  ]);
}

export const SAMPLE_NOTE = [
  "---",
  "project: Widget Build",
  "status: active",
  "---",
  "",
  "# Widget Build",
  "",
  "## Wiring",
  "- [x] run the cable ^a1",
  "- [ ] mount the panel ^a2",
  "",
  "## Commissioning",
  "- [ ] sign off ^b1",
  "",
].join("\n");

/** Same byte length as SAMPLE_NOTE: exactly one checkbox character differs. */
export const SAMPLE_NOTE_TOGGLED = SAMPLE_NOTE.replace("- [ ] mount the panel", "- [x] mount the panel");

/** Wait long enough for a new mtime tick on fast local filesystems. */
export function waitForMtimeTick(ms = 25): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
