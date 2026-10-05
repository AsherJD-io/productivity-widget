# Productivity Widget

A floating desktop quest widget for Windows. It reads a task list out of an
Obsidian vault, derives your progress from it, and shows the result in a small
always-on-top window that sits on the desktop instead of in a browser tab.

The vault note stays the source of truth. The widget never stores progress of
its own, so the number on screen and the checkboxes in your note cannot drift
apart.

---

## End user

### Install

Run the installer:

```
ProductivityWidget-Setup-0.1.0-x64.exe
```

It is a standard per-user NSIS installer. It installs to:

```
C:\Users\<you>\AppData\Local\Programs\Productivity Widget\
```

and creates both a **Desktop shortcut** and a **Start Menu shortcut**. Note
that on a machine with OneDrive Desktop redirection the Desktop shortcut lands
in `C:\Users\<you>\OneDrive\Desktop\`, which is still the desktop Windows shows.

### Daily use

Launch it from the Desktop or Start Menu. After that you do not need WSL, npm,
Node, a terminal, or the source tree. The installed application is
self-contained.

Clicking a checkbox writes the change straight back to the note in Obsidian.
Edits you make in Obsidian are picked up by the running widget.

### Starts with Windows

The installed application registers itself as a Windows login item on first
launch, using Electron's `app.setLoginItemSettings`. The startup target is the
installed executable:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  electron.app.Productivity Widget
    = "C:\Users\<you>\AppData\Local\Programs\Productivity Widget\Productivity Widget.exe"
```

No WSL path, shell script, or npm invocation is involved. The widget is
unobtrusive: one small always-on-top window, no console, no taskbar button.

---

## What it shows

- **Collapsed view** — project title, a progress pill, the next unfinished
  task, and a quest counter.
- **Expanded view** — the full task list grouped by phase, scrollable
  vertically, with per-phase completion.
- **Task completion** — click a checkbox; the note is rewritten and the widget
  refreshes from disk.
- **Derived progress** — the `4/6` style fraction is computed from checkbox
  state on every read. It is never written to the note.
- **Next unfinished task** — the first unchecked task in document order.
- **Phase completion** — a phase is complete when every task in it is checked.

---

## Architecture

```
Obsidian vault (external, read/write)
        │
        ▼
   vault/reader      read a note from disk
        │
        ▼
     parse          note text -> Project (titles, phases, tasks)
        │
        ▼
     derive         Project -> DerivedState (all numbers computed here)
        │
        ▼
      view          DerivedState -> renderer payloads
        │
        ▼
   ui/renderer      DOM only, no filesystem, no Node
        ▲
        │  IPC (widget:state, widget:toggle-task, widget:toggle-expand)
        │
   shell/main        Electron main: window, IPC, poller, writer
```

### The domain core

`src/parse.ts`, `src/derive.ts`, `src/schema.ts` and `src/view.ts` are
platform-agnostic and side-effect free: no filesystem, no DOM, no Electron.
They are the single source of truth for how a note becomes everything the
widget displays, and they run unchanged under plain `node`.

The governing rule is that **stored truth is titles, phases, tasks and checkbox
state**. Every number is derived from that on every read. `src/schema.ts`
enforces the rule rather than merely documenting it: a note carrying a
frontmatter key that would duplicate derived state (`progress`, `completed`,
`total`, `next_task`, and similar) is rejected at parse time.

### Vault access

- `src/vault/reader.ts` reads a note from the vault.
- `src/vault/poller.ts` detects changes by polling `mtimeMs:size` from `stat()`,
  not by filesystem events. `fs.watch` on the drvfs-backed vault registers
  successfully and then never fires, so event-based watching would silently do
  nothing. The poll interval is 1s while the widget is expanded and 5s while it
  is collapsed.
- `src/vault/writer.ts` is the only thing that writes. It writes a temporary
  file and renames it onto the note, and it refuses to write if the note changed
  on disk since the snapshot the UI was rendered from. On conflict nothing is
  written and the UI reloads the newer document.

### The shell

`src/shell/main.ts` owns the native window (frameless, transparent,
always-on-top, two fixed sizes), the IPC surface, the poller and the writer.
`src/shell/preload.cts` exposes a narrow named API to the renderer; the
renderer has no Node, no filesystem and no `ipcRenderer`.

---

## The data boundary

This repository is the **application**. The Obsidian vault is **external
application data**.

- The vault is not bundled, vendored, copied, or symlinked into this repository.
- `Productivity/To-Do List.md` lives in the user's Obsidian vault and is never
  committed here.
- `.gitignore` carries an explicit rule against vault-shaped artefacts.

The application reads and writes the vault at runtime, on the user's machine,
where it belongs.

---

## Configuration

Widget-only settings live in a JSON file in the app's user-data directory:

```
C:\Users\<you>\AppData\Roaming\Productivity Widget\widget-config.json
```

| key | meaning |
| --- | --- |
| `vaultRoot` | absolute path to the Obsidian vault |
| `notePath` | vault-relative path to the project note |
| `expanded` | whether the widget starts expanded |
| `x`, `y` | last window position, so the widget returns where it was |

Defaults are compiled in (`DEFAULT_VAULT_ROOT`, `DEFAULT_NOTE` in
`src/shell/main.ts`) and point at the vault used during development.

Both paths are validated on load. A note path is accepted only if it is
vault-relative and resolves to a `.md` file inside the vault; absolute paths,
`..` traversal and executable-looking values are rejected. This file holds
widget state only — it is kept strictly out of the vault note.

There is no settings UI. To point the widget at a different vault, edit
`widget-config.json` while the app is closed.

---

## Developer

The development environment is **WSL**. The source of truth is:

```
/home/asher/vibes/productivity
```

The **packaged Windows application** is the end-user runtime; WSL is only for
building it.

### Setup

```bash
cd /home/asher/vibes/productivity
npm install
```

Node 22.6 or newer.

### Commands

All of these have been run and pass:

| command | purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` across `src/` and `test/` |
| `npm test` | `node --test test/` |
| `npm run build` | compile to `dist/` and copy the HTML/CSS assets |
| `npm run dev` | build, then launch the development build on Windows |
| `npm run verify` | typecheck followed by tests |
| `npm run mutate` | mutation checks over the domain core |
| `npm run package:win` | build and produce the Windows NSIS installer |
| `npm run package:dir` | build and produce an unpacked Windows app directory |

Current results: typecheck clean, **114 tests passing** across 8 test files,
build clean.

### Running the development build

`npm run dev` compiles to `dist/`, stages it to a local Windows directory, and
launches the Windows Electron binary against it.

The staging step exists because the source tree is on WSL's ext4 filesystem,
reachable from Windows only over a `\\wsl.localhost\...` UNC path. Loading the
app's own `main.js` over that path is unreliable, so the compiled output is
copied to a local Windows directory first. The WSL tree remains the source of
truth; the staged copy is disposable build output.

### Packaging the Windows installer

```bash
npm run package:win
```

`electron-builder` produces an NSIS installer in `release/`:

```
release/ProductivityWidget-Setup-0.1.0-x64.exe
```

Only `dist/` and `package.json` are packaged. The Electron runtime is bundled
into the installer, so the installed application does not depend on this
repository, on WSL, or on a globally installed Node.

Note that the NSIS toolchain (`makensis`) has to run somewhere it can execute
Windows binaries. On this machine the packaging step was run from a Windows
working copy with Windows Node, because WSL has neither `wine` nor `makensis`.
The configuration itself lives in `package.json` under `build` and is
platform-independent.

To test the installer, run it, then launch the installed executable directly:

```
C:\Users\<you>\AppData\Local\Programs\Productivity Widget\Productivity Widget.exe
```

### Self-test

The app can verify itself in the real Windows runtime. Launching it with
`--selftest` measures the live window, exercises the toggle through the actual
tray-button click path ten times, drives a checkbox with a trusted input event
against a temporary fixture note, checks drag regions and scrolling, and writes
a JSON report plus PNG captures of both states:

```bash
"Productivity Widget.exe" --selftest --selftest-out C:\path\to\report.json
```

The fixture note is created in the OS temp directory and deleted afterwards.
It is never written into the user's vault.

### Repository structure

```
src/
  index.ts              domain core barrel export
  types.ts              shared types
  schema.ts             rejects notes that store derived state
  parse.ts              note text -> Project
  derive.ts             Project -> DerivedState
  view.ts               DerivedState -> renderer payloads
  vault/
    reader.ts           read a note
    scan.ts             enumerate candidate notes
    poller.ts           mtime/size change detection
    writer.ts           conflict-guarded atomic write
  shell/
    main.ts             Electron main process
    preload.cts         contextBridge surface
  ui/
    index.html          renderer markup
    renderer.ts         renderer logic
    widget.css          presentation
scripts/
  copy-assets.mjs       post-build asset copy
  launch.mjs            WSL -> Windows development launcher
build/
  icon.ico, icon.png    application icon
test/                   node:test suites plus mutation scripts
```

The two reference screenshots at the repository root are the visual reference
the presentation layer was measured against. They are tracked deliberately.

### Native runtime facts

- On a display with a non-integer scale factor, Windows clamps frameless window
  sizes to whole device pixels, so some integer heights cannot be requested at
  all. The two widget sizes are 238x155 and 398x605 in content pixels; the
  expanded height currently lands on 604 for this reason. This is a platform
  constraint, not a layout bug.
- The GPU child process cannot be spawned on this machine, so the main process
  sets `--disable-gpu`, `--disable-gpu-compositing` and `--in-process-gpu`
  before anything else. `scripts/launch.mjs` passes the same switches on the
  command line for the development build.