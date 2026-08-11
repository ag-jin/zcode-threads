#!/usr/bin/env bash
# ZCode CDP port guard - 每 30 秒由 LaunchAgent 触发
# 检测 ZCode 是否带 CDP 端口；若未带则用 macOS 原生方式重启带端口
set -euo pipefail

PORT="${ZCODE_CDP_PORT:-9333}"
ZCODE_APP_PATH="/Applications/ZCode.app"
SKILL_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
STATE_DIR="$SKILL_ROOT/wakes"
LOG="$STATE_DIR/portguard.log"
LOCK_DIR="$STATE_DIR/portguard.lock"
RESTART_FLAG="$STATE_DIR/.last-restart"

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
touch "$LOG"
chmod 600 "$LOG"

log() {
  printf '%s %s\n' "$(date '+%Y-%m-%dT%H:%M:%S%z')" "$*" >> "$LOG"
}

cleanup() {
  rmdir "$LOCK_DIR" 2>/dev/null || true
}

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  exit 0
fi
trap cleanup EXIT

zcode_pids() {
  {
    pgrep -x ZCode || true
    pgrep -f '/Applications/ZCode.app/Contents/MacOS/ZCode' || true
  } | sort -u
}

zcode_running() {
  [[ -n "$(zcode_pids)" ]]
}

cdp_ready() {
  local version
  version="$(curl --silent --show-error --max-time 2 "http://127.0.0.1:${PORT}/json/version" 2>/dev/null || true)"
  [[ "$version" == *"ZCode"* || "$version" == *"Electron"* ]]
}

restart_zcode_with_cdp() {
  log "Restarting ZCode with --remote-debugging-port=$PORT via open -a"

  # 优雅退出
  osascript -e 'quit app "ZCode"' 2>/dev/null || true
  sleep 3

  # 强制退出残留
  for pid in $(zcode_pids); do
    kill -TERM "$pid" 2>/dev/null || true
  done
  sleep 2
  for pid in $(zcode_pids); do
    kill -9 "$pid" 2>/dev/null || true
  done
  sleep 1

  # 用 macOS 原生方式启动，带 CDP 端口参数
  open -a "$ZCODE_APP_PATH" --args --remote-debugging-port="$PORT"
  log "ZCode launched via open -a with CDP port $PORT, waiting"

  # 等待 CDP 就绪 (最多 30 秒)
  local i
  for i in $(seq 1 30); do
    sleep 1
    if cdp_ready; then
      log "CDP ready after ${i}s"
      touch "$RESTART_FLAG"
      return 0
    fi
  done

  log "CDP did not become ready within 30s after restart"
  return 1
}

# --- 主逻辑 ---

if ! zcode_running; then
  # ZCode 没运行，不自动启动
  exit 0
fi

if cdp_ready; then
  # 一切正常
  exit 0
fi

# ZCode 在运行但 CDP 不可用 -> 自动重启带端口
# 防止频繁重启: 距上次重启不足 120 秒则跳过
if [[ -f "$RESTART_FLAG" ]]; then
  last_mod=$(stat -f %m "$RESTART_FLAG" 2>/dev/null || echo 0)
  now=$(date +%s)
  diff=$((now - last_mod))
  if [[ $diff -lt 120 ]]; then
    log "Skipping restart: last restart was ${diff}s ago (< 120s cooldown)"
    exit 0
  fi
fi

restart_zcode_with_cdp
