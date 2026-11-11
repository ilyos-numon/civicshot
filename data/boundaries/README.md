# 행정 경계 데이터

| 파일 | 내용 | 커밋 |
|------|------|------|
| `sig-seoul.geojson` | 서울 25개 구 (코드 앞 두 자리 `11`), 10% 단순화 | 예 |
| `sig.geojson` | 전국 250개 시군구, 10% 단순화 | 아니요 (로컬 전용, `scripts/fetch-boundaries.sh` 로 생성) |

- 출처: southkorea/southkorea-maps 저장소의 `kostat/2018/json/skorea-municipalities-2018-geo.json` (통계청 2018 시군구 경계 기반)
- 가공: `npx mapshaper -simplify 10% keep-shapes`, 좌표 정밀도 0.00001
- 라이선스: **확인 필요** — 원 저장소와 원자료(통계청)의 이용 조건을 배포 전에 확인한다.
- 서버는 `sig.geojson` 이 있으면 그것을, 없으면 `sig-seoul.geojson` 을 쓴다.
- 부서명(`../departments.json`)은 일반화한 이름이며 실제 담당자·연락처는 담지 않는다.
