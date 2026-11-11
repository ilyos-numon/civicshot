#!/usr/bin/env bash
# README 기능별 GIF·스크린샷을 다시 만든다.
#   bash scripts/make-feature-gifs.sh              # 전체
#   bash scripts/make-feature-gifs.sh emergency    # 일부 장면만
set -euo pipefail
cd "$(dirname "$0")/.."
OUT_DIR="test-results/feature-gifs"
GIF_DIR="assets/gifs"
MAX_BYTES=2621440

FFMPEG="$(command -v ffmpeg || true)"
if [ -z "$FFMPEG" ] && [ -x /opt/homebrew/bin/ffmpeg ]; then FFMPEG=/opt/homebrew/bin/ffmpeg; fi
if [ -z "$FFMPEG" ]; then
  echo "ffmpeg not found; install it first (brew install ffmpeg)" >&2
  exit 1
fi
FFPROBE="$(dirname "$FFMPEG")/ffprobe"
if [ ! -x "$FFPROBE" ]; then FFPROBE="$(command -v ffprobe)"; fi

ALL=(sample-to-receipt admin-to-citizen merge-duplicates offline-queue qr-status location-picker emergency check-and-limit)
if [ "$#" -gt 0 ]; then SCENES=("$@"); else SCENES=("${ALL[@]}"); fi
for s in "${SCENES[@]}"; do
  case " ${ALL[*]} " in *" $s "*) ;; *) echo "unknown scene: $s (one of: ${ALL[*]})" >&2; exit 1 ;; esac
done

ports_of() {
  case "$1" in
    location-picker|emergency|check-and-limit) echo "8894 8895 8896" ;;
    *) echo "8891 8892" ;;
  esac
}

cleanup() {
  for p in 8891 8892 8894 8895 8896; do lsof -ti "tcp:$p" -sTCP:LISTEN 2>/dev/null | xargs kill 2>/dev/null || true; done
  rm -rf "$OUT_DIR"
}
trap cleanup EXIT

# 장면 json(영상·앞부분·건너뛸 구간)으로 ffmpeg 필터를 만든다. 인자: json fps width
filter_of() {
  node -e '
    const [json, fps, width] = process.argv.slice(1);
    const m = JSON.parse(require("fs").readFileSync(json, "utf8"));
    const parts = m.inputs.map((x, i) =>
      `[${i}:v]trim=start=${x.lead.toFixed(3)}:duration=${m.duration.toFixed(3)},setpts=PTS-STARTPTS,fps=${fps}[v${i}]`);
    let last = "v0";
    if (m.inputs.length > 1) {
      parts.push(m.inputs.map((_, i) => `[v${i}]`).join("") + `hstack=inputs=${m.inputs.length}[st]`);
      last = "st";
    }
    const chain = [];
    if (m.cuts.length) {
      const expr = m.cuts.map(([a, b]) => `between(t\\,${a.toFixed(2)}\\,${b.toFixed(2)})`).join("+");
      chain.push(`select=not(${expr})`, `setpts=N/${fps}/TB`);
    }
    chain.push(`scale=${width}:-1:flags=lanczos`, "mpdecimate=hi=64*24:lo=64*8:frac=0.5", "tpad=stop_mode=clone:stop_duration=1");
    parts.push(`[${last}]` + chain.join(",") + "[out]");
    process.stdout.write(parts.join(";"));
  ' "$1" "$2" "$3"
}

encode() {
  local scene="$1" colors="$2" fps="$3" width="$4"
  local json="$OUT_DIR/$scene.json" pal="$OUT_DIR/$scene.pal.png" gif="$GIF_DIR/$scene.gif"
  local graph ins=()
  graph="$(filter_of "$json" "$fps" "$width")"
  while IFS= read -r f; do ins+=(-i "$f"); done < <(node -e 'for (const x of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).inputs) console.log(x.file)' "$json")
  "$FFMPEG" -v error -y "${ins[@]}" -filter_complex "${graph};[out]palettegen=stats_mode=diff:max_colors=${colors}" "$pal"
  "$FFMPEG" -v error -y "${ins[@]}" -i "$pal" -filter_complex "${graph};[out][${#SCENE_INPUTS[@]}:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" -fps_mode vfr -loop 0 "$gif"
}

rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR" "$GIF_DIR"

for scene in "${SCENES[@]}"; do
  echo "== $scene"
  for port in $(ports_of "$scene"); do
    if lsof -ti "tcp:$port" -sTCP:LISTEN >/dev/null 2>&1; then
      echo "port $port is busy; stop the process using it first" >&2
      exit 1
    fi
  done
  node scripts/record-features.ts "$scene" "$OUT_DIR"
  SCENE_INPUTS=()
  while IFS= read -r f; do test -s "$f"; SCENE_INPUTS+=("$f"); done < <(node -e 'for (const x of JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")).inputs) console.log(x.file)' "$OUT_DIR/$scene.json")
  if [ "${#SCENE_INPUTS[@]}" -gt 1 ]; then BASE_W=720; else BASE_W=400; fi
  GIF="$GIF_DIR/$scene.gif"
  STEP=0
  for ladder in "128 10 $BASE_W" "96 9 $BASE_W" "64 8 $((BASE_W * 9 / 10))" "64 8 $((BASE_W * 8 / 10))"; do
    read -r COLORS FPS WIDTH <<<"$ladder"
    encode "$scene" "$COLORS" "$FPS" "$WIDTH"
    SIZE="$(stat -f%z "$GIF" 2>/dev/null || stat -c%s "$GIF")"
    if [ "$SIZE" -le "$MAX_BYTES" ]; then break; fi
    STEP=$((STEP + 1))
  done
  if [ "$SIZE" -gt "$MAX_BYTES" ]; then
    echo "$scene: GIF ${SIZE} bytes is over ${MAX_BYTES} after the size ladder" >&2
    exit 1
  fi
  GDUR="$("$FFPROBE" -v error -show_entries format=duration -of csv=p=0 "$GIF")"
  echo "$scene: gif ${GDUR}s ${SIZE} bytes (${COLORS} colors ${FPS}fps ${WIDTH}px, ladder step ${STEP})"
  rm -f "${SCENE_INPUTS[@]}"
done
echo "GIFs $(pwd)/$GIF_DIR, screenshots $(pwd)/assets/screenshots"
