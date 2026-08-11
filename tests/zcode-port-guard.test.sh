#!/usr/bin/env bash
set -euo pipefail

SCRIPT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)/scripts/zcode-port-guard.sh"
TEST_ROOT="$(mktemp -d)"
trap 'rm -rf "$TEST_ROOT"' EXIT

mkdir -p "$TEST_ROOT/skill/scripts" "$TEST_ROOT/bin"
cp "$SCRIPT" "$TEST_ROOT/skill/scripts/zcode-port-guard.sh"

cat > "$TEST_ROOT/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

cat > "$TEST_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
exit 1
EOF

cat > "$TEST_ROOT/bin/open" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$OPEN_LOG"
EOF

chmod +x "$TEST_ROOT/bin/pgrep" "$TEST_ROOT/bin/curl" "$TEST_ROOT/bin/open"
export OPEN_LOG="$TEST_ROOT/open.log"

PATH="$TEST_ROOT/bin:/usr/bin:/bin" /bin/bash "$TEST_ROOT/skill/scripts/zcode-port-guard.sh"

if [[ -e "$OPEN_LOG" ]]; then
  printf '%s\n' "FAIL: guard launched ZCode while no ZCode process was running"
  exit 1
fi

printf '%s\n' "PASS: guard leaves a closed ZCode application closed"

cat > "$TEST_ROOT/bin/pgrep" <<'EOF'
#!/usr/bin/env bash
if [[ "${1:-}" == "-x" && "${2:-}" == "ZCode" ]]; then
  printf '%s\n' "999999"
  exit 0
fi
exit 1
EOF

cat > "$TEST_ROOT/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [[ -e "$READY_FLAG" ]]; then
  printf '%s\n' '{"Browser":"ZCode"}'
  exit 0
fi
exit 1
EOF

cat > "$TEST_ROOT/bin/open" <<'EOF'
#!/usr/bin/env bash
printf '%s\n' "$*" >> "$OPEN_LOG"
touch "$READY_FLAG"
EOF

cat > "$TEST_ROOT/bin/osascript" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

cat > "$TEST_ROOT/bin/sleep" <<'EOF'
#!/usr/bin/env bash
exit 0
EOF

chmod +x "$TEST_ROOT/bin/pgrep" "$TEST_ROOT/bin/curl" "$TEST_ROOT/bin/open" \
  "$TEST_ROOT/bin/osascript" "$TEST_ROOT/bin/sleep"
export READY_FLAG="$TEST_ROOT/cdp-ready"

PATH="$TEST_ROOT/bin:/usr/bin:/bin" /bin/bash "$TEST_ROOT/skill/scripts/zcode-port-guard.sh"

if [[ ! -e "$OPEN_LOG" || "$(wc -l < "$OPEN_LOG")" -ne 1 ]]; then
  printf '%s\n' "FAIL: guard did not restart a running ZCode process with unavailable CDP"
  exit 1
fi

printf '%s\n' "PASS: guard recognizes a running ZCode process and restores CDP"
