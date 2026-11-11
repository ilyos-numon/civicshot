#!/usr/bin/env bash
# civicshot 전용 GCP 준비 (여러 번 돌려도 된다: 이미 있는 것은 건너뜀).
#   자원: API 켜기 → Artifact Registry 저장소·정리 정책 → 런타임 SA(civicshot-run) → 배포 SA(civicshot-deploy)
#         → WIF 풀 github-pool(있으면 재사용)·프로바이더 github-civicshot(저장소 조건) → 비밀 CIVICSHOT_LLM_API_KEY·CIVICSHOT_VAPID_PRIVATE_KEY (이름만)
#   IAM : 비밀 접근 · run.developer · AR 쓰기 · 런타임 SA 사용 · WIF 사용자
# 비밀 값은 이 스크립트에 없다. 값은 사용자가 줄 때만 deploy/gcp/apply-env.sh 가 버전이 없을 때 넣는다(임의 생성 안 함).
# 결제 연결 한도 때문에 새 프로젝트를 만들지 않고 기존 프로젝트에 서비스만 더한다.
#
# 사용: GCP_PROJECT_ID=illy-portfolio GCP_REGION=asia-northeast3 GITHUB_REPO=ilyos-numon/civicshot bash deploy/gcp/setup.sh [--dry-run] [--resources-only] [--verify]
#   --dry-run         gcloud 를 실행하지 않고 실행할 명령만 출력
#   --resources-only  IAM 부여를 빼고 자원만 만든다
#   --verify          읽기 명령만으로 자원·IAM 을 확인. 모두 있으면 마지막 줄 SETUP OK, 아니면 SETUP INCOMPLETE 와 exit 1
set -euo pipefail

DRY_RUN=0
RESOURCES_ONLY=0
VERIFY=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    --resources-only) RESOURCES_ONLY=1 ;;
    --verify) VERIFY=1 ;;
    -h|--help) sed -n '2,12p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 2 ;;
  esac
done

missing=()
for name in GCP_PROJECT_ID GCP_REGION GITHUB_REPO; do
  if [ -z "${!name:-}" ]; then missing+=("$name"); fi
done
if [ "${#missing[@]}" -gt 0 ]; then
  echo "필수 환경변수가 비어 있습니다: ${missing[*]}" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"
PROJECT="$GCP_PROJECT_ID"
REGION="$GCP_REGION"
SERVICE="civicshot"
ARTIFACT_REPO="civicshot"
RUN_SA_NAME="civicshot-run"
DEPLOY_SA_NAME="civicshot-deploy"
RUN_SA="${RUN_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
DEPLOY_SA="${DEPLOY_SA_NAME}@${PROJECT}.iam.gserviceaccount.com"
POOL="github-pool"
PROVIDER="github-civicshot"
SECRETS=(CIVICSHOT_LLM_API_KEY CIVICSHOT_VAPID_PRIVATE_KEY)
CLEANUP_POLICY="$ROOT/deploy/gcp/ar-cleanup-policy.json"
APIS=(run.googleapis.com artifactregistry.googleapis.com secretmanager.googleapis.com
  iamcredentials.googleapis.com iam.googleapis.com sts.googleapis.com)
CONDITION="assertion.repository=='${GITHUB_REPO}' && assertion.ref=='refs/heads/main'"
MAPPING="google.subject=assertion.sub,attribute.repository=assertion.repository"

if [ "$DRY_RUN" -eq 1 ]; then
  PROJECT_NUMBER="${GCP_PROJECT_NUMBER:-<PROJECT_NUMBER>}"
else
  PROJECT_NUMBER="$(gcloud projects describe "$PROJECT" --format='value(projectNumber)')"
fi
WIF_MEMBER="principalSet://iam.googleapis.com/projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/attribute.repository/${GITHUB_REPO}"
WIF_PROVIDER="projects/${PROJECT_NUMBER}/locations/global/workloadIdentityPools/${POOL}/providers/${PROVIDER}"

# --verify: 읽기 명령만 쓴다
if [ "$VERIFY" -eq 1 ]; then
  bad=()
  ok() { echo "✓ $1"; }
  ng() { echo "✗ $1"; bad+=("$2"); }
  # has_binding 역할 구성원 get-iam-policy 명령... : 바인딩이 있으면 0
  has_binding() {
    local role="$1" member="$2"
    shift 2
    "$@" --flatten='bindings[].members' --format='csv[no-heading](bindings.role,bindings.members)' 2>/dev/null \
      | grep -Fxq "${role},${member}"
  }

  enabled="$(gcloud services list --enabled --project="$PROJECT" --format='value(config.name)' 2>/dev/null || true)"
  for api in "${APIS[@]}"; do
    if printf '%s\n' "$enabled" | grep -Fxq "$api"; then ok "① API $api"; else ng "① API $api" "api:$api"; fi
  done
  if gcloud artifacts repositories describe "$ARTIFACT_REPO" --location="$REGION" --project="$PROJECT" >/dev/null 2>&1; then
    ok "② AR 저장소 $ARTIFACT_REPO"
    policies="$(gcloud artifacts repositories describe "$ARTIFACT_REPO" --location="$REGION" --project="$PROJECT" \
      --format='value(cleanupPolicies)' 2>/dev/null || true)"
    if printf '%s' "$policies" | grep -q 'keep-latest-2'; then ok "② AR 정리 정책"; else ng "② AR 정리 정책" "ar-cleanup"; fi
  else
    ng "② AR 저장소 $ARTIFACT_REPO" "ar"
    ng "② AR 정리 정책" "ar-cleanup"
  fi
  if gcloud iam service-accounts describe "$RUN_SA" --project="$PROJECT" >/dev/null 2>&1; then ok "③ SA $RUN_SA"; else ng "③ SA $RUN_SA" "run-sa"; fi
  if gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT" >/dev/null 2>&1; then ok "④ SA $DEPLOY_SA"; else ng "④ SA $DEPLOY_SA" "deploy-sa"; fi
  if gcloud iam workload-identity-pools describe "$POOL" --location=global --project="$PROJECT" >/dev/null 2>&1; then
    ok "⑤ WIF 풀 $POOL"
  else
    ng "⑤ WIF 풀 $POOL" "wif-pool"
  fi
  cond="$(gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" \
    --location=global --project="$PROJECT" --format='value(attributeCondition)' 2>/dev/null || true)"
  if [ -n "$cond" ]; then ok "⑤ WIF 프로바이더 $PROVIDER"; else ng "⑤ WIF 프로바이더 $PROVIDER" "wif-provider"; fi
  if [ "$cond" = "$CONDITION" ]; then ok "⑤ 프로바이더 조건 $CONDITION"; else ng "⑤ 프로바이더 조건 $CONDITION" "wif-condition"; fi
  for SECRET in "${SECRETS[@]}"; do
    if gcloud secrets describe "$SECRET" --project="$PROJECT" >/dev/null 2>&1; then ok "⑥ 비밀 $SECRET"; else ng "⑥ 비밀 $SECRET" "secret:$SECRET"; fi
  done

  for SECRET in "${SECRETS[@]}"; do
    if has_binding roles/secretmanager.secretAccessor "serviceAccount:${RUN_SA}" \
      gcloud secrets get-iam-policy "$SECRET" --project="$PROJECT"; then
      ok "a 비밀 접근 $SECRET (런타임 SA)"
    else
      ng "a 비밀 접근 $SECRET (런타임 SA)" "iam-a:$SECRET"
    fi
  done
  if has_binding roles/run.developer "serviceAccount:${DEPLOY_SA}" \
    gcloud projects get-iam-policy "$PROJECT"; then
    ok "b run.developer (배포 SA)"
  else
    ng "b run.developer (배포 SA)" "iam-b"
  fi
  if has_binding roles/artifactregistry.writer "serviceAccount:${DEPLOY_SA}" \
    gcloud artifacts repositories get-iam-policy "$ARTIFACT_REPO" --location="$REGION" --project="$PROJECT"; then
    ok "c AR 쓰기 (배포 SA)"
  else
    ng "c AR 쓰기 (배포 SA)" "iam-c"
  fi
  if has_binding roles/iam.serviceAccountUser "serviceAccount:${DEPLOY_SA}" \
    gcloud iam service-accounts get-iam-policy "$RUN_SA" --project="$PROJECT"; then
    ok "d 런타임 SA 사용 (배포 SA)"
  else
    ng "d 런타임 SA 사용 (배포 SA)" "iam-d"
  fi
  if has_binding roles/iam.workloadIdentityUser "$WIF_MEMBER" \
    gcloud iam service-accounts get-iam-policy "$DEPLOY_SA" --project="$PROJECT"; then
    ok "e WIF 사용자 (GitHub $GITHUB_REPO)"
  else
    ng "e WIF 사용자 (GitHub $GITHUB_REPO)" "iam-e"
  fi

  if [ "${#bad[@]}" -eq 0 ]; then
    echo "SETUP OK"
    exit 0
  fi
  echo "SETUP INCOMPLETE ${bad[*]}"
  exit 1
fi

run() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 0 ]; then "$@"; fi
}

# 있으면 0. dry-run 에서는 gcloud 를 부르지 않고 "없음"으로 보고 만드는 명령을 출력한다
exists() {
  if [ "$DRY_RUN" -eq 1 ]; then return 1; fi
  "$@" >/dev/null 2>&1
}

skip() { echo "= 이미 있음: $*"; }

# 새 서비스 계정은 IAM 에 보이기까지 몇 초 걸린다
wait_sa() {
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  local _
  for _ in 1 2 3 4 5 6; do
    exists gcloud iam service-accounts describe "$1" --project="$PROJECT" && return 0
    sleep 5
  done
}

# IAM 바인딩. 새 서비스 계정은 describe 에 보인 뒤에도 몇십 초 동안 바인딩이
# "Service account ... does not exist" 로 실패할 수 있어(IAM 전파 지연) 그 오류일 때만 10초 간격 최대 6회 다시 시도한다
bind() {
  echo "+ $*"
  if [ "$DRY_RUN" -eq 1 ]; then return 0; fi
  local attempt out
  for attempt in 1 2 3 4 5 6; do
    if out="$("$@" 2>&1 >/dev/null)"; then return 0; fi
    if [ "$attempt" -lt 6 ] && printf '%s' "$out" | grep -q 'does not exist'; then
      echo "  · 서비스 계정이 아직 IAM 에 퍼지지 않음, 10초 뒤 다시 시도 ($attempt/6)"
      sleep 10
      continue
    fi
    printf '%s\n' "$out" >&2
    return 1
  done
}

echo "# 프로젝트 $PROJECT · 리전 $REGION · 저장소 $GITHUB_REPO"

echo "# ① API 켜기"
run gcloud services enable "${APIS[@]}" --project="$PROJECT"

echo "# ② Artifact Registry 저장소·정리 정책"
if exists gcloud artifacts repositories describe "$ARTIFACT_REPO" --location="$REGION" --project="$PROJECT"; then
  skip "artifact repo $ARTIFACT_REPO"
else
  run gcloud artifacts repositories create "$ARTIFACT_REPO" --repository-format=docker \
    --location="$REGION" --description="civicshot images" --project="$PROJECT"
fi
run gcloud artifacts repositories set-cleanup-policies "$ARTIFACT_REPO" --policy="$CLEANUP_POLICY" \
  --no-dry-run --location="$REGION" --project="$PROJECT"

echo "# ③ 런타임 서비스 계정"
if exists gcloud iam service-accounts describe "$RUN_SA" --project="$PROJECT"; then
  skip "service account $RUN_SA"
else
  run gcloud iam service-accounts create "$RUN_SA_NAME" --display-name="civicshot runtime" --project="$PROJECT"
fi

echo "# ④ 배포 서비스 계정"
if exists gcloud iam service-accounts describe "$DEPLOY_SA" --project="$PROJECT"; then
  skip "service account $DEPLOY_SA"
else
  run gcloud iam service-accounts create "$DEPLOY_SA_NAME" --display-name="civicshot deploy (GitHub Actions)" \
    --project="$PROJECT"
fi

echo "# ⑤ Workload Identity Federation (GitHub Actions)"
if exists gcloud iam workload-identity-pools describe "$POOL" --location=global --project="$PROJECT"; then
  skip "workload identity pool $POOL"
else
  run gcloud iam workload-identity-pools create "$POOL" --location=global \
    --display-name="GitHub Actions" --project="$PROJECT"
fi
if exists gcloud iam workload-identity-pools providers describe "$PROVIDER" --workload-identity-pool="$POOL" \
  --location=global --project="$PROJECT"; then
  skip "workload identity provider $PROVIDER"
else
  run gcloud iam workload-identity-pools providers create-oidc "$PROVIDER" --workload-identity-pool="$POOL" \
    --location=global --issuer-uri="https://token.actions.githubusercontent.com" \
    --attribute-mapping="$MAPPING" --attribute-condition="$CONDITION" --project="$PROJECT"
fi

echo "# ⑥ Secret Manager 비밀 (이름만, 값은 deploy/gcp/apply-env.sh 가 넣는다)"
for SECRET in "${SECRETS[@]}"; do
  if exists gcloud secrets describe "$SECRET" --project="$PROJECT"; then
    skip "secret $SECRET"
  else
    run gcloud secrets create "$SECRET" --replication-policy=automatic --project="$PROJECT"
  fi
done

if [ "$RESOURCES_ONLY" -eq 1 ]; then
  echo "# IAM 건너뜀 (--resources-only)"
else
  echo "# IAM"
  wait_sa "$RUN_SA"
  wait_sa "$DEPLOY_SA"
  # a 런타임 SA 가 비밀을 읽는다
  for SECRET in "${SECRETS[@]}"; do
    bind gcloud secrets add-iam-policy-binding "$SECRET" --member="serviceAccount:${RUN_SA}" \
      --role=roles/secretmanager.secretAccessor --project="$PROJECT"
  done
  # b 배포 SA 가 Cloud Run 서비스를 배포한다
  bind gcloud projects add-iam-policy-binding "$PROJECT" --member="serviceAccount:${DEPLOY_SA}" \
    --role=roles/run.developer --condition=None --quiet
  # c 배포 SA 가 이 저장소에만 이미지를 push 한다
  bind gcloud artifacts repositories add-iam-policy-binding "$ARTIFACT_REPO" --location="$REGION" \
    --member="serviceAccount:${DEPLOY_SA}" --role=roles/artifactregistry.writer --project="$PROJECT"
  # d 배포 SA 가 런타임 SA 로 서비스를 띄운다
  bind gcloud iam service-accounts add-iam-policy-binding "$RUN_SA" --member="serviceAccount:${DEPLOY_SA}" \
    --role=roles/iam.serviceAccountUser --project="$PROJECT"
  # e GitHub 저장소의 Actions 가 배포 SA 를 쓴다
  bind gcloud iam service-accounts add-iam-policy-binding "$DEPLOY_SA" --role=roles/iam.workloadIdentityUser \
    --member="$WIF_MEMBER" --project="$PROJECT"
fi

echo
echo "# GitHub 저장소 Variables 에 적을 값 (서비스 $SERVICE)"
echo "GCP_PROJECT_ID=$PROJECT"
echo "GCP_REGION=$REGION"
echo "ARTIFACT_REPO=$ARTIFACT_REPO"
echo "GCP_WIF_PROVIDER=$WIF_PROVIDER"
echo "GCP_DEPLOY_SA=$DEPLOY_SA"
if [ "$DRY_RUN" -eq 1 ]; then echo "(dry-run: gcloud 를 실행하지 않았습니다)"; fi
