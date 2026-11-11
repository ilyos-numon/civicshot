# E2E fixture

## photos/
- `streetlight.jpg`·`bench.jpg`·`sidewalk.jpg`: 1280x960 단색 배경에 큰 글자(가로등·벤치·보도블록)를 합성한 JPEG. EXIF GPS IFD(0x8825)에 서울 시내의 서로 다른 좌표가 들어 있다.
- `nogps.jpg`: 같은 방식으로 만들었지만 GPS 정보가 없다.
- 만든 방법: python3 + Pillow 11.3 으로 `Image.new` → `ImageDraw.text` → `Image.Exif().get_ifd(0x8825)` 에 위경도(도·분·초)를 넣고 `save(..., exif=...)` 로 한 번 생성했다. 생성 스크립트는 저장소에 두지 않는다.

## vision/
- `<sha256>.json`: 해당 사진 파일 바이트의 sha256 이름으로 저장한 분류 결과(`Classification`, `source: "fixture"`).
- 해시 재생성: `shasum -a 256 tests/e2e/fixtures/photos/*.jpg`
  - streetlight → `9e1d3079...`, bench → `79efa5b6...`, sidewalk → `292c2c10...`
