#!/usr/bin/env bash
# README 데모 GIF 재생성: scripts/record-demo.ts 가 격리 서버(API 8881, Vite 8883)를 띄워 녹화(webm)하고
# 화면 5장을 assets/screenshots/ 에 저장한다. 이 스크립트는 webm 을 ffmpeg 팔레트 방식으로 assets/demo.gif 로 바꾼다.
# 전제: npm install, npx playwright install chromium, ffmpeg. .env 는 읽지 않는다.
set -euo pipefail
cd "$(dirname "$0")/.."
GIF="assets/demo.gif"

FFMPEG="$(command -v ffmpeg || true)"
if [ -z "$FFMPEG" ] && [ -x /opt/homebrew/bin/ffmpeg ]; then FFMPEG=/opt/homebrew/bin/ffmpeg; fi
if [ -z "$FFMPEG" ]; then
  echo "ffmpeg not found; install it first (brew install ffmpeg)" >&2
  exit 1
fi

for port in 8881 8883; do
  if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then
    echo "port $port is busy; stop the process using it first" >&2
    exit 1
  fi
done

WORK="$(mktemp -d "${TMPDIR:-/tmp}/civicshot-demo.XXXXXX")"
trap 'rm -rf "$WORK"' EXIT

node scripts/record-demo.ts "$WORK/video"
WEBM="$(ls "$WORK"/video/*.webm | head -1)"
test -s "$WEBM"

mkdir -p "$(dirname "$GIF")"
# 폭 400px, 10fps, 128색 팔레트. 끝 화면을 1.5초 늘려 반복 재생 전에 결과를 읽을 수 있게 한다.
PRE="fps=10,scale=400:-1:flags=lanczos,tpad=stop_mode=clone:stop_duration=1.5"
"$FFMPEG" -v error -y -i "$WEBM" -vf "$PRE,palettegen=stats_mode=diff:max_colors=128" "$WORK/pal.png"
"$FFMPEG" -v error -y -i "$WEBM" -i "$WORK/pal.png" -lavfi "${PRE}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -loop 0 "$GIF"
ls -la "$GIF"
