#!/usr/bin/env bash
# 시군구 경계(통계청 2018, southkorea-maps 저장소) 를 내려받아 단순화한다.
#   data/boundaries/sig.geojson       전국 250개 시군구 (로컬 전용, 커밋 금지)
#   data/boundaries/sig-seoul.geojson 서울 25구 추출본 (커밋 대상)
set -euo pipefail
cd "$(dirname "$0")/.."

SRC_URL="https://raw.githubusercontent.com/southkorea/southkorea-maps/master/kostat/2018/json/skorea-municipalities-2018-geo.json"
OUT_DIR="data/boundaries"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT

mkdir -p "$OUT_DIR"
echo "내려받는 중: $SRC_URL"
curl -sfL -m 120 -o "$TMP/sig-raw.json" "$SRC_URL"

npx mapshaper "$TMP/sig-raw.json" -simplify 10% keep-shapes -o precision=0.00001 format=geojson "$OUT_DIR/sig.geojson" force
npx mapshaper "$OUT_DIR/sig.geojson" -filter "String(code).slice(0,2) === '11'" -o precision=0.00001 format=geojson "$OUT_DIR/sig-seoul.geojson" force

ls -l "$OUT_DIR"/sig*.geojson
echo "출처: southkorea/southkorea-maps (kostat 2018 시군구). 라이선스: 확인 필요 — data/boundaries/README.md 참고."
echo "주의: sig.geojson(전국)은 커밋하지 않는다."
