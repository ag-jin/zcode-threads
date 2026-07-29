#!/usr/bin/env bash
# 重启 ZCode 并开启 loopback CDP 端口 9333
set -euo pipefail

CDP_PORT="${1:-9333}"
ZCODE_APP="/Applications/ZCode.app/Contents/MacOS/ZCode"
LOG_FILE="/tmp/zcode-cdp.log"
PID_FILE="/tmp/zcode-cdp.pid"

# 1. 退出当前 ZCode
echo "[1/4] 退出当前 ZCode..."
osascript -e 'quit app "ZCode"' 2>/dev/null || true
sleep 3

# 确认退出
for pid in $(pgrep -f '/Applications/ZCode.app/Contents/MacOS/ZCode' 2>/dev/null || true); do
  kill -TERM "$pid" 2>/dev/null || true
done
sleep 2

for pid in $(pgrep -f '/Applications/ZCode.app/Contents/MacOS/ZCode' 2>/dev/null || true); do
  kill -9 "$pid" 2>/dev/null || true
done
sleep 1

if pgrep -f '/Applications/ZCode.app/Contents/MacOS/ZCode' >/dev/null 2>&1; then
  echo "  ❌ ZCode 未能退出"
  exit 1
fi
echo "  ✅ ZCode 已退出"

# 2. 从命令行带 CDP 端口启动
echo "[2/4] 启动 ZCode --remote-debugging-port=$CDP_PORT..."
nohup "$ZCODE_APP" --remote-debugging-port="$CDP_PORT" > "$LOG_FILE" 2>&1 &
ZCODE_PID=$!
echo "$ZCODE_PID" > "$PID_FILE"
echo "  PID: $ZCODE_PID"

# 3. 等待 CDP 端口就绪
echo "[3/4] 等待 CDP 端口 $CDP_PORT 就绪..."
READY=0
for i in $(seq 1 30); do
  sleep 1
  RESULT=$(curl -s --max-time 1 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null || true)
  if echo "$RESULT" | grep -q "Browser" 2>/dev/null; then
    echo "  [$i] CDP 就绪 ✅"
    READY=1
    break
  fi
  printf "."
done
echo ""

if [ "$READY" -eq 0 ]; then
  echo "  ❌ CDP 端口 $CDP_PORT 未就绪"
  echo "  最近日志:"
  tail -5 "$LOG_FILE" 2>/dev/null
  exit 1
fi

# 4. 验证
echo "[4/4] 验证..."
BROWSER=$(curl -s --max-time 2 "http://127.0.0.1:$CDP_PORT/json/version" 2>/dev/null | node -e 'const d=JSON.parse(require("fs").readFileSync(0,"utf8"));console.log(d.Browser||"unknown")' 2>/dev/null || echo "unknown")
echo "  Browser: $BROWSER"
echo "  PID: $ZCODE_PID"
echo "  CDP: http://127.0.0.1:$CDP_PORT"
echo "  日志: $LOG_FILE"
echo ""
echo "✅ ZCode 已带 CDP 端口 $CDP_PORT 启动"
