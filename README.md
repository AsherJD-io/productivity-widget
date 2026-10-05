# Productivity Widget

A small always-on-top Windows window that reads a task list out of an Obsidian
vault, works out your progress from it, and floats on the desktop instead of
sitting in a browser tab.

The note is the only place progress is stored. The widget stores nothing, so
the number on screen and the checkboxes in the note cannot disagree.

## Install and run

Run `ProductivityWidget-Setup-0.1.0-x64.exe`. It is a standard per-user NSIS
installer and it asks where to put things. The default is:

```
C:\Users\<you>\AppData\Local\Programs\Productivity Widget\
```

It creates a Desktop shortcut and a Start Menu shortcut. On a machine with
OneDrive Desktop redirection the Desktop shortcut lands in
`C:\Users\<you>\OneDrive\Desktop\`, which is still the desktop Windows shows.

After installation you do not need WSL, npm, Node, a terminal or this source
tree. The installed app is self contained.

Clicking a checkbox writes the change straight back to the note. Edits you make
in Obsidian are picked up by the running widget.

### Startup

The installed app registers itself as a Windows login item on first launch,
through `app.setLoginItemSettings`, pointed at the installed executable:

```
HKCU\Software\Microsoft\Windows\CurrentVersion\Run
  electron.app.Productivity Widget
    = "C:\Users\<you>\AppData\Local\Programs\Productivity Widget\Productivity Widget.exe"
```

No WSL path, shell script or npm invocation is involved. Registration is
skipped when `app.isPackaged` is false, so development launches leave the
setting alone.

One small always-on-top window. Frameless and transparent, no taskbar button,
always-on-top at the `screen-saver` level so it stays above ordinary
application windows.

## What it shows

- Collapsed: project title, a progress pill, the next unfinished task, a quest
  counter.
- Expanded: the full task list grouped by phase, scrolling vertically, with
  per-phase completion.
- The `4/6` fraction is computed from checkbox state on every read and never
  written to the note.
- The next unfinished task is the first unchecked task in document order.
- A phase is complete when it has at least one task and all of them are
  checked. An empty phase is not complete.

Clicking a checkbox rewrites the note; the widget then reloads from disk.

## Architecture

```
Obsidian vault (external, read/write)
        |
        v
   vault/reader      read a note from disk
        |
        v
     parse          note text -> Project (titles, phases, tasks)
        |
        v
     derive         Project -> DerivedState (all numbers computed here)
        |
        v
      view          DerivedState -> renderer payloads
        |
        v
   ui/renderer      DOM only, no filesystem, no Node
        ^
        |  IPC
        |
   shell/main        Electron main: window, IPC, poller, writer
```

### Domain core

`src/parse.ts`, `src/derive.ts`, `src/schema.ts` and `src/view.ts` have no
filesystem, no DOM and no Electron, so they run unchanged under plain `node`.

Stored truth is titles, phases, tasks and checkbox state. Every number is
derived from that on every read. `src/schema.ts` enforces this rather than
just documenting it: a note carrying a frontmatter key that would duplicate
derived state (`progress`, `completed`, `total`, `next_task` and the like) is
rejected at parse time. Keys are normalised before matching, so `next_task`,
`NextTask` and `next-task` all trip it.

`src/vault/scan.ts` enumerates candidate notes but is discovery only. The
configured note path is explicit and nothing is auto-detected. It never descends
into dot-directories, which covers `.obsidian`, `.trash` and `.git`.

### Vault access

- `src/vault/reader.ts` reads a note from the vault.
- `src/vault/poller.ts` detects changes by polling `mtimeMs:size` from `stat()`.
  `fs.watch` on the drvfs-backed vault registers and then never fires, so
  event-based watching would look fine and do nothing. Interval is 1s while
  expanded and 5s while collapsed.
- `src/vault/writer.ts` is the only thing that writes. It writes a temp file
  beside the note and renames it over the target. It refuses to write if the
  note changed on disk since the snapshot the UI was rendered from; on conflict
  nothing is written and the UI reloads the newer document.

### Shell

`src/shell/main.ts` owns the window (frameless, transparent, always-on-top, two
fixed sizes), the IPC surface, the poller and the writer.
`src/shell/preload.cts` exposes a named API to the renderer through
`contextBridge`; the renderer gets no Node, no filesystem and no `ipcRenderer`.

IPC channels are `widget:state`, `widget:toggle-task`, `widget:toggle-expand`,
`widget:move`, `widget:refresh`, `widget:reveal-note` and
`widget:diagnostics`.

## The vault boundary

This repository is the application. The Obsidian vault is external application
data.

- The vault is not bundled, vendored, copied or symlinked in here.
- `Productivity/To-Do List.md` lives in the user's vault and is not committed.
- `.gitignore` carries rules against vault-shaped artefacts, including
  `.To-Do List.md.tmp-write`, which is the writer's temp filename.

Reads and writes happen at runtime, on the user's machine.

## Configuration

Widget-only settings live in one JSON file in the app's user-data directory:

```
C:\Users\<you>\AppData\Roaming\Productivity Widget\widget-config.json
```

| key | meaning |
| --- | --- |
| `vaultRoot` | absolute path to the Obsidian vault |
| `notePath` | vault-relative path to the project note |
| `expanded` | whether the widget starts expanded |
| `x`, `y` | last window position |

Defaults are compiled in as `DEFAULT_VAULT_ROOT` and `DEFAULT_NOTE` in
`src/shell/main.ts` and point at the vault used during development.

Both paths are validated on load. A note path is accepted only if it is
vault-relative and resolves to a `.md` file inside the vault; absolute paths,
`..` traversal, `node_modules`, and `.exe` values are rejected. A load failure
falls back to the defaults rather than propagating. Widget state stays in this
file and is never mixed into the vault note.

There is no settings UI. To point the widget at a different vault, edit the
file while the app is closed.

## Development

Development happens in WSL, in this tree:

```
/home/asher/vibes/productivity
```

The packaged Windows app is the end-user runtime. WSL is only for building it.
Node 22.6 or newer.

```bash
cd /home/asher/vibes/productivity
npm install
```

| command | purpose |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `test/` |
| `npm test` | `node --test test/` |
| `npm run verify` | typecheck then tests |
| `npm run build` | compile to `dist/` and copy the HTML/CSS |
| `npm run dev` | build, then launch the development build on Windows |
| `npm run mutate` | mutation checks over the domain core |
| `npm run package:win` | build and produce the NSIS installer |
| `npm run package:dir` | build and produce an unpacked Windows app directory |

Also present: `test:watch`, `test:verbose`, `smoke` (runs against the real
vault), `measure`, and `start` as an alias for `dev`.

Current state: typecheck clean, 114 tests passing across 8 test files, build
clean.

`npm run build` is `tsc` plus a copy of `index.html` and `widget.css`. No
bundler, so the HTML and CSS have to be moved by hand into `dist/`.

`npm run dev` stages `dist/` to a local Windows directory before launching.
The source tree is on WSL's ext4 filesystem, reachable from Windows only over
a `\\wsl.localhost\...` UNC path, and loading the app's own `main.js` over that
path is unreliable. The staged copy is disposable build output.

### Packaging

```bash
npm run package:win
```

`electron-builder` writes `release/ProductivityWidget-Setup-0.1.0-x64.exe`. Only
`dist/` and `package.json` are packaged and the Electron runtime is bundled, so
the installed app depends on none of this repository, on WSL, or on a globally
installed Node.

`makensis` has to run somewhere that can execute Windows binaries. On this
machine the packaging step was run from a Windows working copy with Windows
Node, because WSL has neither `wine` nor `makensis`. The configuration under
`build` in `package.json` is platform independent.

To check the result, run the installer, then launch:

```
C:\Users\<you>\AppData\Local\Programs\Productivity Widget\Productivity Widget.exe
```

### Self-test

Launching the installed exe with `--selftest` measures the live window, runs ten
expand/collapse cycles through the real tray-button path, drives a checkbox
with a trusted mouse event and verifies the file on disk, asserts drag regions,
checks wrapping and overflow, and writes a JSON report plus PNG captures of both
states:

```bash
"Productivity Widget.exe" --selftest --selftest-out C:\path\to\report.json
```

The tray button is exercised with a synthetic DOM `.click()`, not an OS event,
because Electron cannot inject a trusted OS click into its own window from
inside the process. The checkbox click does use `sendInputEvent`, which takes
the same path a real click does. Both run against throwaway fixtures in
`tmpdir()`, never the real note.

`--selftest-note` points the run at a different note for one invocation without
touching the saved config. It is ignored unless the value passes the same
validation as a configured note path.

### Layout

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
test/                   node:test suites, plus mutation and vault-touching scripts
```

The two reference screenshots at the repository root are 238x155 and 398x605.
The presentation layer was measured against them, so they are tracked
deliberately.

### Windows runtime notes

Window geometry is the fiddly part and there are two facts behind it, both
measured on this machine at display scale 1.25 rather than assumed.

- `getContentSize()` equals `getSize()` for this frameless transparent window.
  There is no outer frame to subtract, so content semantics and window
  semantics are the same coordinate system here.
- Requesting N produces N+1. Chromium reserves a 1px border on a frameless
  window and `thickFrame: false` does not remove it. `FRAME_INSET = 1` in
  `main.ts` subtracts it once, in one place, so the renderer lands on 238x155
  and 398x605 exactly.

The `BrowserWindow` constructor and `setBounds` are also not equivalent on
Windows. Constructing below the minimum frameless size is silently clamped up, a
request of 237x154 coming back as 242x159, which is what clipped the paper on
the right in an earlier revision. `useContentSize: true` does not avoid it;
identical numbers come back. Geometry is re-asserted after load instead, and
`applyGeometry()` is the only place any size is decided. The constructor, the
toggle and the self-test all go through it.

The GPU child process cannot be spawned on this machine, so the main process
appends `--disable-gpu`, `--disable-gpu-compositing` and `--in-process-gpu`
before anything else. `--disable-gpu` alone is not enough, because the
compositor still wants a GPU process. `scripts/launch.mjs` passes the same
switches on the command line for the development build.

Dragging uses the native `-webkit-app-region: drag` path on the shell and paper
head only. Interactive elements opt out with `no-drag`. An earlier revision also
implemented dragging in JavaScript over a `widget:move` call, which was a second
competing mechanism. That code is gone, though the handler and the preload
method are still exported.