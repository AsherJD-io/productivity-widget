#!/usr/bin/env bash
# Poller-layer mutation check.
set -uo pipefail
cd "$(dirname "$0")/.."
F=src/vault/poller.ts

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
  if node --test test/poller.test.ts >/dev/null 2>&1; then
    echo "SURVIVED  <-- $label"
  else
    echo "killed      $label"
    node --test test/poller.test.ts 2>&1 | grep -E "^✖" | grep -v "failing tests" | head -2 | sed 's/^/              /'
  fi
  mv "$F.bak" "$F"
}

echo "baseline: $(node --test test/poller.test.ts 2>&1 | grep -cE '^✔') passing"
node --test test/poller.test.ts >/dev/null 2>&1 || { echo "BASELINE NOT GREEN"; exit 1; }
echo

mutate "poller: drop fast path, always re-parse" \
  "      if (!firstSight && key !== null && key === previous.key) {" \
  "      if (false) {"

mutate "poller: change key = size only" \
  'return `${st.mtimeMs}:${st.size}`;' \
  'return `${st.size}`;'

mutate "poller: change key = mtime only" \
  'return `${st.mtimeMs}:${st.size}`;' \
  'return `${st.mtimeMs}`;'

mutate "poller: always report a change" \
  "      if (!firstSight && key !== null && key === previous.key) {" \
  "      if (false) {"

mutate "poller: never report a change" \
  "        anyChanged = true;" \
  "        anyChanged = false;"

mutate "poller: swallow read errors silently" \
  "        this.onError?.(error, notePath);" \
  "        void 0;"

mutate "poller: ignore the idle flag" \
  "return this.#config.isIdle() ? this.#config.idleIntervalMs : this.#config.intervalMs;" \
  "return this.#config.intervalMs;"

mutate "poller: swap active and idle intervals" \
  "return this.#config.isIdle() ? this.#config.idleIntervalMs : this.#config.intervalMs;" \
  "return this.#config.isIdle() ? this.#config.intervalMs : this.#config.idleIntervalMs;"

mutate "poller: refresh does not poll" \
  "  refresh(): PollOutcome {" \
  "  refresh(): PollOutcome { if (true) return { changed: false, loaded: null, error: null, key: null };"

mutate "poller: stop does not clear the timer" \
  "      clearTimeout(this.#timer);" \
  "      void 0;"

mutate "poller: notify on every poll, changed or not" \
  "      if (error === null && loaded !== null) {" \
  "      if (false) {"

echo
echo "baseline restored: $(node --test test/poller.test.ts 2>&1 | grep -cE '^✔') passing"
node --test test/poller.test.ts >/dev/null 2>&1 && echo "poller suite green" || echo "POLLER SUITE BROKEN"
ls src/vault/*.bak 2>/dev/null && echo "WARNING leftover .bak"
exit 0
