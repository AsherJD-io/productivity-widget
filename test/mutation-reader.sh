#!/usr/bin/env bash
# Reader-layer mutation check.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/vault/reader.ts

mutate() {
  local label="$1" from="$2" to="$3"
  cp "$F" "$F.bak"
  FROM="$from" TO="$to" TARGET="$F" python3 - <<'PY'
import os, pathlib, sys
p = pathlib.Path(os.environ["TARGET"]); s = p.read_text()
if os.environ["FROM"] not in s:
    print("NOT_APPLIED"); sys.exit(3)
p.write_text(s.replace(os.environ["FROM"], os.environ["TO"], 1))
PY
  if [ $? -ne 0 ] || cmp -s "$F" "$F.bak"; then
    echo "NOT APPLIED  $label"; mv "$F.bak" "$F"; return
  fi
  if node --test test/reader.test.ts >/dev/null 2>&1; then
    echo "SURVIVED  <-- $label"
  else
    echo "killed      $label"
    node --test test/reader.test.ts 2>&1 | grep -E "^✖" | grep -v "failing tests" | head -2 | sed 's/^/              /'
  fi
  mv "$F.bak" "$F"
}

echo "baseline: $(node --test test/reader.test.ts 2>&1 | grep -cE '^✔') passing"
echo

mutate "reader: trim source before parsing" \
  "state: derive(parse(source))," \
  "state: derive(parse(source.trim())),"

mutate "reader: ignore injected parse fn" \
  "const parse = deps.parse ?? parseProject;" \
  "const parse = parseProject;"

mutate "reader: ignore injected derive fn" \
  "const derive = deps.derive ?? deriveState;" \
  "const derive = deriveState;"

mutate "reader: derive from a fresh parse, not the returned one" \
  "state: derive(parse(source))," \
  "state: deriveState(parseProject('')),"

mutate "reader: swallow ENOENT as unreadable" \
  'if ((cause as NodeJS.ErrnoException).code === "ENOENT") {' \
  'if (false) {'

mutate "reader: allow path traversal outside vault" \
  'if (rel === "" || rel.startsWith("..") || rel.startsWith(`..${sep}`)) {' \
  'if (false) {'

mutate "reader: swallow schema violations" \
  "  const parse = deps.parse ?? parseProject;" \
  "  const parse = (s: string) => { try { return parseProject(s); } catch { return { title: '', phases: [] }; } };\n  const derive2 = deps.derive ?? deriveState;"

echo
echo "baseline restored: $(node --test test/reader.test.ts 2>&1 | grep -cE '^✔') passing"
node --test test/reader.test.ts >/dev/null 2>&1 && echo "reader suite green" || echo "READER SUITE BROKEN"
ls src/vault/*.bak 2>/dev/null && echo "WARNING leftover .bak"
