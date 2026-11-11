# 찍고끝 데모 이미지 (서버 + 빌드된 PWA 한 컨테이너). 프로젝트 루트에서:
#   docker build -t civicshot:local .
#   docker run --rm -p 8880:8870 civicshot:local
# Node 24 는 TypeScript 타입을 그대로 지워 실행하므로 서버는 빌드 없이 src/server/main.ts 로 돈다.
# 상태 확인 경로: /health (Cloud Run 은 /healthz 를 앱에 넘기지 않는다).
# 쓰기는 DATA_DIR(/tmp/civicshot) 에만 한다. 루트 파일시스템이 읽기 전용이어도 돈다.

# 1) 빌드: 타입체크 + vite build → dist/client
FROM node:24-alpine AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY . .
RUN npm run build

# 2) 실행
FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY data/boundaries ./data/boundaries
COPY data/departments.json ./data/departments.json
COPY tests/e2e/fixtures/vision ./tests/e2e/fixtures/vision
COPY --from=build /app/dist/client ./dist/client
ENV PORT=8870 HOST=:: TZ=Asia/Seoul \
    DATA_DIR=/tmp/civicshot \
    DEMO_MODE=1 SUBMISSION_ADAPTER=mock GEOCODER=offline \
    VISION_BACKEND=fixture LLM_BACKEND=template \
    VISION_FIXTURE_DIR=/app/tests/e2e/fixtures/vision \
    CLIENT_DIST_DIR=/app/dist/client \
    SELF_BASE_URL=http://localhost:8870 PUBLIC_BASE_URL=http://localhost:8870
USER node
EXPOSE 8870
# exec 형식, 빈 인자 없음 (Cloud Run 은 빈 exec 인자를 버린다)
CMD ["node", "src/server/main.ts"]
