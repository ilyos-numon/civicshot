#!/usr/bin/env bash
# civicshot 첫 배포·설정 반영: 비밀 값 준비 → service.yaml 렌더(임시 파일) → gcloud run services replace → /health 확인.
#   환경 파일은 읽지 않는다. 비밀은 사용자가 값을 줄 때만, 활성 버전이 없을 때만 넣는다 (값은 출력하지 않는다. 임의 생성 안 함).
#     LLM 키: LLM_API_KEY 환경변수 → CIVICSHOT_LLM_API_KEY. 비밀에 활성 버전이 있으면 VISION_BACKEND·LLM_BACKEND=qwen, 없으면 fixture/template.
#     VAPID : VAPID_PUBLIC_KEY + VAPID_PRIVATE_KEY → CIVICSHOT_VAPID_PRIVATE_KEY. 공개 키가 없으면 푸시는 끈다(생략 가능).
#   코드 변경 배포는 GitHub Actions(.github/workflows/deploy.yml)가 이미지만 바꾼다.
#   setup.sh 를 먼저 실행해 서비스 계정·비밀·IAM 이 있어야 한다.
#
# 사용: GCP_PROJECT_ID=illy-portfolio [GCP_REGION=asia-northeast3] IMAGE=<이미지> bash deploy/gcp/apply-env.sh [--dry-run] [--allow-public-iam]
#   --dry-run           gcloud·curl 을 실행하지 않고 할 일만 출력
#   --allow-public-iam  서비스에 allUsers run.invoker 도 부여 (invoker-iam-disabled 가 막힐 때만)
# 이미지: IMAGE 환경변수, 없으면 지금 서비스가 쓰는 이미지. 둘 다 없으면 안내하고 끝낸다.
set -euo pipefail

DRY_RUN=0
ALLOW_PUBLIC_IAM=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --allow-public-iam) ALLOW_PUBLIC_IAM=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

if [ -z "${GCP_PROJECT_ID:-}" ]; then
  echo "✗ GCP_PROJECT_ID 가 비어 있습니다" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
P="$GCP_PROJECT_ID"
R="${GCP_REGION:-asia-northeast3}"
SVC="civicshot"
LLM_SECRET="CIVICSHOT_LLM_API_KEY"
VAPID_SECRET="CIVICSHOT_VAPID_PRIVATE_KEY"
TEMPLATE="$ROOT/deploy/gcp/service.yaml"

run() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then "$@"; fi
}

# 비밀에 활성 버전이 있으면 0
has_version() {
  [ -n "$(gcloud secrets versions list "$1" --filter='state=ENABLED' --format='value(name)' \
    --limit=1 --project="$P" 2>/dev/null)" ]
}

# ensure_secret 이름 값: 활성 버전이 있으면 유지, 없고 값이 있으면 추가. 쓸 수 있으면 0
ensure_secret() {
  local name="$1" value="$2"
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "+ gcloud secrets versions list $name --filter=state=ENABLED --limit=1 --project=$P"
    echo "+ (버전이 없고 값이 주어졌을 때만) printf %s <값> | gcloud secrets versions add $name --data-file=- --project=$P"
    [ -n "$value" ]
    return
  fi
  if ! gcloud secrets describe "$name" --project="$P" >/dev/null 2>&1; then
    echo "✗ 비밀 $name 이 없습니다. deploy/gcp/setup.sh 를 먼저 돌리세요" >&2
    exit 1
  fi
  if has_version "$name"; then
    echo "  · $name 유지 (활성 버전 있음)"
    return 0
  fi
  if [ -z "$value" ]; then
    echo "  · $name 값 없음 (건너뜀)"
    return 1
  fi
  printf '%s' "$value" | gcloud secrets versions add "$name" --data-file=- --project="$P" >/dev/null
  echo "  ✓ $name 새 버전 추가 (값은 출력하지 않음)"
}

if [ "$DRY_RUN" -eq 1 ]; then echo "(dry-run: 외부 명령을 실행하지 않습니다)"; fi
echo "프로젝트 $P · 리전 $R · 서비스 $SVC"

echo "1/8 gcloud 계정·프로젝트 접근 확인"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ gcloud auth list --filter=status:ACTIVE --format=value(account)"
  echo "+ gcloud projects describe $P --format=value(projectNumber)"
  PROJECT_NUMBER="${GCP_PROJECT_NUMBER:-PROJECT_NUMBER}"
else
  account="$(gcloud auth list --filter=status:ACTIVE --format='value(account)' 2>/dev/null | head -1 || true)"
  if [ -z "$account" ]; then
    echo "✗ 활성 gcloud 계정이 없습니다. gcloud auth login 후 다시 돌리세요" >&2
    exit 1
  fi
  if ! PROJECT_NUMBER="$(gcloud projects describe "$P" --format='value(projectNumber)' 2>/dev/null)" \
    || [ -z "$PROJECT_NUMBER" ]; then
    echo "✗ 계정 $account 로 프로젝트 $P 에 접근할 수 없습니다" >&2
    exit 1
  fi
  echo "  ✓ 계정 $account · 프로젝트 번호 $PROJECT_NUMBER"
fi
# Cloud Run 결정적 주소: 서비스가 없어도 미리 알 수 있다
BASE_URL="https://${SVC}-${PROJECT_NUMBER}.${R}.run.app"

echo "2/8 비밀 (값이 주어지고 활성 버전이 없을 때만 추가)"
USE_LLM=0
USE_VAPID=0
if ensure_secret "$LLM_SECRET" "${LLM_API_KEY:-}"; then USE_LLM=1; fi
if [ -n "${VAPID_PUBLIC_KEY:-}" ] && ensure_secret "$VAPID_SECRET" "${VAPID_PRIVATE_KEY:-}"; then USE_VAPID=1; fi
if [ "$USE_LLM" -eq 1 ]; then VB=qwen; LB=qwen; else VB=fixture; LB=template; fi
VB="${VISION_BACKEND:-$VB}"
LB="${LLM_BACKEND:-$LB}"
if { [ "$VB" = qwen ] || [ "$LB" = qwen ]; } && { [ -z "${LLM_BASE_URL:-}" ] || [ -z "${VISION_MODEL:-}" ]; }; then
  # 제공사마다 주소·모델 이름이 달라서, 기본값으로 덮어 서비스를 조용히 깨뜨리지 않는다.
  echo "✗ 실제 LLM 을 쓰려면 LLM_BASE_URL 과 VISION_MODEL 이 필요합니다. .env 를 먼저 올려 주세요: set -a; . ./.env; set +a" >&2
  exit 1
fi
LLM_BASE_URL="${LLM_BASE_URL:-https://dashscope-intl.aliyuncs.com/compatible-mode/v1}"
LLM_MODEL="${LLM_MODEL:-qwen3.7-flash}"
VISION_MODEL="${VISION_MODEL:-qwen3-vl-flash}"
VISION_TIMEOUT_MS="${VISION_TIMEOUT_MS:-30000}"
LLM_TIMEOUT_MS="${LLM_TIMEOUT_MS:-20000}"
RATE_LIMIT_PER_MINUTE="${RATE_LIMIT_PER_MINUTE:-5}"
RATE_LIMIT_PER_DAY="${RATE_LIMIT_PER_DAY:-20}"
RATE_LIMIT_DAILY_TOTAL="${RATE_LIMIT_DAILY_TOTAL:-300}"
echo "  사진 분류·문장: $VB / $LB · 푸시: $([ "$USE_VAPID" -eq 1 ] && echo 켬 || echo 끔)"

echo "3/8 이미지"
if [ -n "${IMAGE:-}" ]; then
  IMG="$IMAGE"
elif [ "$DRY_RUN" -eq 1 ]; then
  IMG="CURRENT_SERVICE_IMAGE"
  echo "+ gcloud run services describe $SVC --region=$R --project=$P --format=value(spec.template.spec.containers[0].image)"
else
  IMG="$(gcloud run services describe "$SVC" --region="$R" --project="$P" \
    --format='value(spec.template.spec.containers[0].image)' 2>/dev/null || true)"
fi
if [ -z "$IMG" ]; then
  echo "✗ 배포할 이미지가 없습니다. 서비스가 아직 없으면 이미지를 먼저 빌드·push 하고 IMAGE 로 주세요:" >&2
  echo "  IMAGE=$R-docker.pkg.dev/$P/civicshot/civicshot:<tag> GCP_PROJECT_ID=$P bash deploy/gcp/apply-env.sh" >&2
  exit 1
fi
echo "  이미지: $IMG"

echo "4/8 service.yaml 렌더 (저장소 파일은 바꾸지 않음)"
TMP_DIR="$(mktemp -d "${TMPDIR:-/tmp}/civicshot-service.XXXXXX")"
trap 'rm -rf "$TMP_DIR"' EXIT
OUT="$TMP_DIR/service.yaml"
unmark=()
if [ "$USE_LLM" -eq 1 ]; then unmark+=(-e 's/^#KEY#//'); fi
if [ "$USE_VAPID" -eq 1 ]; then unmark+=(-e 's/^#VAPID#//'); fi
# 켜진 비밀 줄의 표시를 걷어낸 뒤 주석 줄을 빼고 자리표시만 채운다 (sed 구분자 |)
sed "${unmark[@]:-s/^//}" "$TEMPLATE" \
  | grep -v '^[[:space:]]*#' \
  | sed -e "s|\${IMAGE}|${IMG}|g" -e "s|\${PROJECT_ID}|${P}|g" -e "s|\${BASE_URL}|${BASE_URL}|g" \
        -e "s|\${VISION_BACKEND}|${VB}|g" -e "s|\${LLM_BACKEND}|${LB}|g" \
        -e "s|\${LLM_BASE_URL}|${LLM_BASE_URL}|g" -e "s|\${LLM_MODEL}|${LLM_MODEL}|g" \
        -e "s|\${VISION_MODEL}|${VISION_MODEL}|g" -e "s|\${VISION_TIMEOUT_MS}|${VISION_TIMEOUT_MS}|g" \
        -e "s|\${LLM_TIMEOUT_MS}|${LLM_TIMEOUT_MS}|g" -e "s|\${RATE_LIMIT_PER_MINUTE}|${RATE_LIMIT_PER_MINUTE}|g" \
        -e "s|\${RATE_LIMIT_PER_DAY}|${RATE_LIMIT_PER_DAY}|g" -e "s|\${RATE_LIMIT_DAILY_TOTAL}|${RATE_LIMIT_DAILY_TOTAL}|g" \
        -e "s|\${VAPID_PUBLIC_KEY}|${VAPID_PUBLIC_KEY:-}|g" > "$OUT"
if grep -q '[$]{' "$OUT"; then
  echo "✗ service.yaml 에 자리표시가 남았습니다: $(grep -o '[$]{[A-Z_]*}' "$OUT" | sort -u | tr '\n' ' ')" >&2
  exit 1
fi
echo "  렌더: $OUT"
if [ "$DRY_RUN" -eq 1 ]; then grep -E 'image:|value:|name: (LLM|VAPID|VISION|TRUSTED|RATE)' "$OUT" | sed 's/^/    /'; fi

echo "5/8 Cloud Run 반영"
run gcloud run services replace "$OUT" --region="$R" --project="$P"

echo "6/8 공개 IAM"
if [ "$ALLOW_PUBLIC_IAM" -eq 1 ]; then
  run gcloud run services add-iam-policy-binding "$SVC" --region="$R" --project="$P" \
    --member=allUsers --role=roles/run.invoker
else
  echo "  · 건너뜀 (invoker-iam-disabled 로 공개. 403 이면 --allow-public-iam 으로 다시 돌리세요)"
fi

echo "7/8 서비스 주소"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ gcloud run services describe $SVC --region=$R --project=$P --format=value(status.url)"
else
  gcloud run services describe "$SVC" --region="$R" --project="$P" --format='value(status.url)' | sed 's/^/  /'
fi

EXPECT='{"ok":true,"adapter":"mock"}'
echo "8/8 확인 $BASE_URL/health"
if [ "$DRY_RUN" -eq 1 ]; then
  echo "+ curl -sf --retry 6 --retry-delay 10 --retry-all-errors $BASE_URL/health  → $EXPECT 기대"
  echo "(dry-run 끝: 외부 명령을 실행하지 않았습니다)"
  exit 0
fi
body="$(curl -sf --retry 6 --retry-delay 10 --retry-all-errors "$BASE_URL/health" || true)"
echo "  /health → ${body:-(응답 없음)}"
if [ "$(printf '%s' "$body" | tr -d '[:space:]')" != "$EXPECT" ]; then
  echo "✗ /health 가 $EXPECT 가 아닙니다" >&2
  exit 1
fi
echo "APPLY OK"
