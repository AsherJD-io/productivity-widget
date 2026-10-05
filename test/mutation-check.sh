#!/usr/bin/env bash
# Mutation check: deliberately break one rule at a time and confirm the
# suite catches it. A test suite that survives mutation proves nothing.
set -uo pipefail
cd "$(dirname "$0")/.."

mutate() {
  local label="$1" file="$2" from="$3" to="$4"
  cp "$file" "$file.bak"
  FROM="$from" TO="$to" TARGET="$file" python3 - <<'PY'
import os, pathlib
p = pathlib.Path(os.environ["TARGET"])
s = p.read_text()
frm, to = os.environ["FROM"], os.environ["TO"]
if frm not in s:
    print("MUTATION_NOT_APPLIED")
    raise SystemExit(3)
p.write_text(s.replace(frm, to, 1))
PY
  if [ $? -ne 0 ]; then
    echo "NOT APPLIED  $label"; mv "$file.bak" "$file"; return
  fi
  if cmp -s "$file" "$file.bak"; then
    echo "NOT APPLIED  $label (no-op)"; mv "$file.bak" "$file"; return
  fi
  if node --test test/ >/dev/null 2>&1; then
    echo "SURVIVED  <-- $label"
  else
    echo "killed      $label"
    node --test test/ 2>&1 | grep -E "^✖" | grep -v "failing tests" | head -3 | sed 's/^/              /'
  fi
  mv "$file.bak" "$file"
}

echo "baseline: $(node --test test/ 2>&1 | grep -cE '^✔') passing"
node --test test/ >/dev/null 2>&1 || { echo "BASELINE NOT GREEN"; exit 1; }
echo

mutate "progress: percent always 100" \
  "src/derive.ts" \
  "total === 0 ? 0 : Math.round((completed / total) * 100)" \
  "100"

mutate "progress: fraction inverted to total/completed" \
  "src/derive.ts" \
  'fraction: `${completed}/${total}`' \
  'fraction: `${total}/${completed}`'

mutate "progress: fraction hardcoded 4/6" \
  "src/derive.ts" \
  'fraction: `${completed}/${total}`' \
  'fraction: "4/6"'

mutate "parse: stop stripping CR (CRLF regression)" \
  "src/parse.ts" \
  'source.split("\n").map((line) => line.replace(/\r$/, ""))' \
  'source.split("\n")'

mutate "parse: drop block id from task text" \
  "src/parse.ts" \
  'text: blockId ? body.slice(0, blockId.index).replace(/\s+$/, "") : body' \
  'text: body'

mutate "parse: never mark tasks done" \
  "src/parse.ts" \
  "done: task[2]!.toLowerCase() === \"x\"" \
  "done: false"

echo
echo "baseline restored: $(node --test test/ 2>&1 | grep -cE '^✔') passing"
node --test test/ >/dev/null 2>&1 && echo "suite green" || echo "SUITE BROKEN"
ls src/*.bak test/*.bak 2>/dev/null && echo "WARNING: leftover .bak files"
