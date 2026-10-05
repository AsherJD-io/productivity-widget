/**
 * Launch the widget as a NATIVE WINDOWS application.
 *
 * Two environment facts drove this design, both measured rather than assumed:
 *
 * 1. The source tree is on WSL's ext4 filesystem, reachable from Windows
 *    only through the \\wsl.localhost\<distro>\... UNC path. Electron can
 *    open a window from there, but loading the app's own main.js over 9P is
 *    unreliable and slow. So the BUILT OUTPUT is staged to a local Windows
 *    directory and launched from there. Source stays in WSL; the run artifact
 *    is a few small files that get re-staged on every launch.
 *
 * 2. The GPU child process cannot be spawned on this machine, which kills a
 *    stock Electron launch with "GPU process isn't usable. Goodbye." and
 *    exit code 3. These switches make it work; main.ts sets the same switches
 *    so the app is robust however it is started.
 *
 * A WSLg launch was ruled out during the Phase 1 inspection: Microsoft
 * documents that WSLg "does not provide a full desktop experience", and
 * always-on-top above native Windows applications could not be verified there.
 */
import { spawn } from "node:child_process";
import { chmodSync, cpSync, existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(root, "dist");

/** Local Windows staging directory. */
const STAGE_WSL = "/mnt/c/Users/Asher/AppData/Local/productivity-widget/app";

const electronExe = resolve(root, "node_modules/electron/dist/electron.exe");

if (!existsSync(electronExe)) {
  console.error(`Windows Electron binary missing:\n  ${electronExe}`);
  process.exit(1);
}

// A Windows PE unpacked from a zip on a WSL filesystem has no exec bit, and
// WSL interop will not run it without one. Meaningless on Windows itself.
try {
  chmodSync(electronExe, 0o755);
} catch {
  // Already executable, or the filesystem disagrees. Let spawn report.
}

if (!existsSync(join(dist, "shell", "main.js"))) {
  console.error(`dist/ is not built. Run: npm run build`);
  process.exit(1);
}

// Stage the build next to the app on the Windows side.
rmSync(STAGE_WSL, { recursive: true, force: true });
mkdirSync(STAGE_WSL, { recursive: true });
cpSync(dist, STAGE_WSL, { recursive: true });
/*
 * NOTE: `"type": "module"` is deliberately NOT set here.
 *
 * With it present, Electron 44 fails to load shell/main.js at all: the app
 * exits 0 immediately with no output whatsoever, not even an error. Without
 * it, Node's syntax detection reparses main.js as an ES module (emitting a
 * harmless MODULE_TYPELESS_PACKAGE_JSON warning) and the app runs correctly.
 * That behaviour was confirmed by direct comparison.
 */
writeFileSync(
  join(STAGE_WSL, "package.json"),
  `${JSON.stringify(
    { name: "productivity-widget", version: "0.1.0", main: "shell/main.js" },
    null,
    2,
  )}\n`,
  "utf8",
);

const STAGE_WIN = STAGE_WSL.replace(/^\/mnt\/([a-zA-Z])\//, (_m, d) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\");

const GPU_SWITCHES = ["--disable-gpu", "--disable-gpu-compositing", "--in-process-gpu"];

// Pass through any WIDGET_* variables so the self-test can be driven from
// the environment, which Electron forwards to the app untouched.
const env = { ...process.env };
for (const [key, value] of Object.entries(env)) {
  if (key.startsWith("WIDGET_")) console.log(`  env       : ${key}=${value}`);
}

console.log("Launching native Windows Electron");
console.log(`  source     : ${root}`);
console.log(`  staged to  : ${STAGE_WIN}`);
console.log(`  executable : ${electronExe}`);
console.log(`  switches   : ${GPU_SWITCHES.join(" ")}`);
console.log("");

const child = spawn(electronExe, [STAGE_WIN, ...GPU_SWITCHES, ...process.argv.slice(2)], {
  stdio: "inherit",
  env,
});

child.on("error", (err) => {
  console.error("failed to start Electron:", err.message);
  process.exit(1);
});

child.on("exit", (code) => {
  console.log(`Electron exited with code ${code}`);
  process.exit(code ?? 0);
});
