#!/usr/bin/env bash
# Writer-layer mutation check.
#
# The writer's whole value proposition is that it changes exactly one byte.
# Every mutation below breaks one part of that promise; the suite must catch
# each one. A surviving mutation means a real safety hole.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/vault/writer.ts

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
  if node --test test/writer.test.ts >/dev/null 2>&1; then
    echo "SURVIVED  <-- $label"
  else
    echo "killed      $label"
    node --test test/writer.test.ts 2>&1 | grep -E "^✖" | grep -v "failing tests" | head -2 | sed 's/^/              /'
  fi
  mv "$F.bak" "$F"
}

echo "baseline: $(node --test test/writer.test.ts 2>&1 | grep -cE '^✔') passing"
node --test test/writer.test.ts >/dev/null 2>&1 || { echo "BASELINE NOT GREEN"; exit 1; }
echo

echo "--- target selection ---"
mutate "target: first task instead of by id" \
  "return tasks.find((t) => t.id === taskId);" \
  "return tasks[0];"
mutate "target: last task instead of by id" \
  "return tasks.find((t) => t.id === taskId);" \
  "return tasks[tasks.length - 1];"
mutate "target: match on text rather than id" \
  "return tasks.find((t) => t.id === taskId);" \
  "return tasks.find((t) => t.text.includes(taskId));"

echo "--- block-id matching ---"
mutate "id: match block id case-insensitively" \
  "return tasks.find((t) => t.id === taskId);" \
  "return tasks.find((t) => t.id?.toLowerCase() === taskId.toLowerCase());"
mutate "id: match block id by prefix" \
  "return tasks.find((t) => t.id === taskId);" \
  "return tasks.find((t) => t.id?.startsWith(taskId));"

echo "--- checkbox direction ---"
mutate "direction: always write x" \
  'const expectedSource = replaceCharAt(current, checkboxOffset, intended ? "x" : " ");' \
  'const expectedSource = replaceCharAt(current, checkboxOffset, "x");'
mutate "direction: always write space" \
  'const expectedSource = replaceCharAt(current, checkboxOffset, intended ? "x" : " ");' \
  'const expectedSource = replaceCharAt(current, checkboxOffset, " ");'
mutate "direction: invert the intended state" \
  "const intended = request.done ?? !task.done;" \
  "const intended = !(request.done ?? !task.done);"

echo "--- stale-snapshot comparison ---"
mutate "guard: disabled, never conflicts" \
  "  if (current !== snapshot) {" \
  "  if (false) {"
mutate "guard: compare only the target line, not the document" \
  "  if (current !== snapshot) {" \
  "  if (task.raw !== (parseProject(snapshot).phases.flatMap((p) => p.tasks).find((t) => t.id === taskId)?.raw ?? \"\")) {"
mutate "guard: ignore trailing-whitespace-only differences" \
  "  if (current !== snapshot) {" \
  "  if (current.trimEnd() !== snapshot.trimEnd()) {"

echo "--- preservation of unrelated content ---"
mutate "preserve: normalise CRLF to LF" \
  "const expectedSource = replaceCharAt(current, checkboxOffset, intended ? \"x\" : \" \");" \
  "const expectedSource = replaceCharAt(current.replace(/\r\n/g, \"\\n\"), checkboxOffset, intended ? \"x\" : \" \");"
mutate "preserve: trim trailing whitespace on every line" \
  "const expectedSource = replaceCharAt(current, checkboxOffset, intended ? \"x\" : \" \");" \
  "const expectedSource = replaceCharAt(current.split(\"\\n\").map((l) => l.trimEnd()).join(\"\\n\"), checkboxOffset, intended ? \"x\" : \" \");"
mutate "preserve: append a trailing newline" \
  "const expectedSource = replaceCharAt(current, checkboxOffset, intended ? \"x\" : \" \");" \
  "const expectedSource = replaceCharAt(current, checkboxOffset, intended ? \"x\" : \" \") + (current.endsWith(\"\\n\") ? \"\" : \"\\n\");"
mutate "preserve: splice two characters instead of one" \
  "return source.slice(0, offset) + char + source.slice(offset + 1);" \
  "return source.slice(0, offset) + char + char + source.slice(offset + 1);"

echo "--- atomic replacement ---"
mutate "atomic: write in place instead of temp+rename" \
  "    io.writeFile(tempPath, expectedSource);
    io.rename(tempPath, absolutePath);" \
  "    io.writeFile(absolutePath, expectedSource);"
mutate "atomic: skip the rename" \
  "    io.rename(tempPath, absolutePath);" \
  "    void 0;"
mutate "atomic: write a truncated file" \
  "    io.writeFile(tempPath, expectedSource);" \
  "    io.writeFile(tempPath, expectedSource.slice(0, Math.floor(expectedSource.length / 2)));"

echo "--- post-write verification ---"
mutate "verify: skip the byte-for-byte re-read check" \
  "  if (written !== expectedSource) {" \
  "  if (false) {"
mutate "verify: skip the task-state check" \
  "  if (verifyTask === undefined || verifyTask.done !== intended) {" \
  "  if (false) {"
mutate "verify: do not re-read from disk, reuse the intended string" \
  "    written = io.readFile(absolutePath);" \
  "    written = expectedSource;"

echo
echo "baseline restored: $(node --test test/writer.test.ts 2>&1 | grep -cE '^✔') passing"
node --test test/writer.test.ts >/dev/null 2>&1 && echo "writer suite green" || echo "WRITER SUITE BROKEN"
ls src/vault/*.bak 2>/dev/null && echo "WARNING leftover .bak"
exit 0
