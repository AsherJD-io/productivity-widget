#!/usr/bin/env bash
# Scanner mutation check.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/vault/scan.ts

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
  if node --test test/scan.test.ts >/dev/null 2>&1; then
    echo "SURVIVED  <-- $label"
  else
    echo "killed      $label"
    node --test test/scan.test.ts 2>&1 | grep -E "^✖" | grep -v "failing tests" | head -2 | sed 's/^/              /'
  fi
  mv "$F.bak" "$F"
}

echo "baseline: $(node --test test/scan.test.ts 2>&1 | grep -cE '^✔') passing"
echo

mutate "scan: allow .obsidian"  "return EXCLUDED_DIRS.has(name) || name.startsWith(\".\");" "return name === \".trash\";"
mutate "scan: allow .trash"     "return EXCLUDED_DIRS.has(name) || name.startsWith(\".\");" "return name === \".obsidian\";"
mutate "scan: allow all dots"  "return EXCLUDED_DIRS.has(name) || name.startsWith(\".\");" "return false;"
mutate "scan: accept any file" "if (!isMarkdown(name)) continue;" "if (false) continue;"
mutate "scan: never recurse"   "walk(join(dir, name), prefix === \"\" ? name : \`\${prefix}/\${name}\`);" "void 0;"
mutate "scan: windows separators" "found.push(prefix === \"\" ? name : \`\${prefix}/\${name}\`);" "found.push(prefix === \"\" ? name : prefix + '\\\\' + name);"

echo
echo "baseline restored: $(node --test test/scan.test.ts 2>&1 | grep -cE '^✔') passing"
node --test test/scan.test.ts >/dev/null 2>&1 && echo "scan suite green" || echo "SCAN SUITE BROKEN"
ls src/vault/*.bak 2>/dev/null && echo "WARNING leftover .bak"
exit 0
