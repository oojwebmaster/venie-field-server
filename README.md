# 검사 스크립트

작업 환경에 GPU가 없어 **화면 결과는 확인할 수 없습니다.**
여기 있는 것은 "그려지긴 하는가 / 값이 터지지 않는가"를 숫자로 재는 도구입니다.

## 준비 (three.js 최소 스텁)

```bash
cd bennyfield          # bennyfield.html 이 있는 폴더
mkdir -p node_modules && cp -r test/three-stub/three node_modules/
echo '{"type":"module"}' > package.json
```

## 실행

```bash
cd test
node --import ./env.mjs dune_test.mjs            # 해변 풀 텍스처 실측
node --import ./env.mjs seagull_test.mjs        # 갈매기 6분 비행 시뮬레이션
node --import ./env.mjs seaprox_test.mjs        # 바닷가 근접도 곡선
node --import ./env.mjs bright_test.mjs         # 식생 최종 알베도 비교
node --import ./env.mjs band_test.mjs           # 해변 소품 배치 띠 (야자수 vs 해변 풀)
node --import ./env.mjs ocean_test.mjs          # 바다 수면이 지면에서 뜨는지 (--old 로 수정 전 비교)
node --import ./env.mjs ocean_edge.mjs          # 파도 주기 전체에서 물 가장자리 두께
T=2.4 node --import ./env.mjs ocean_profile.mjs # 부채꼴 가장자리 단면
node --import ./env.mjs lod_check.mjs           # 클립맵 LOD가 곶에서 갈리는 양
node --import ./env.mjs pick_test.mjs            # 개발모드 지면 찍기 정확도
node --import ./env.mjs access_test.mjs         # 개발자모드 권한 판정 (버튼 표시/고장 안내)
node place_test.mjs                             # 찍은 각도가 베니 정면과 맞는지 (env 불필요)
node --import ./env.mjs net_test.mjs             # 멀티플레이 보간·패킷 유실·대역폭
node lint.mjs                                   # alphaTest 리터럴 / onBeforeCompile 덮어쓰기

# 서버 로직 (별도)
cd ../server && npm test
```

## 각 검사가 잡는 것

| 스크립트 | 무엇을 잡는가 |
|---|---|
| `dune_test.mjs` | 테두리가 안쪽보다 밝지 않은가 · 밉 단계별 잎 면적이 유지되는가 · 단색이 아닌가 |
| `seagull_test.mjs` | NaN · 수면 아래로 내려감 · 무리 이탈(6분이 아니면 안 보입니다) · 뱅킹 뒤집힘 · 컬링 |
| `seaprox_test.mjs` | 앰비언스 교차 곡선이 계단처럼 튀지 않는가 · 내륙에서 0이 되는가 |
| `bright_test.mjs` | 텍스처 × 재질 color를 **선형에서** 곱한 최종 밝기. "어둡다/밝다"를 눈으로 다투지 않기 위한 것 |
| `band_test.mjs` | 소품이 실제로 어디에 놓이는가(물가로부터의 거리 분포). band만 봐서는 알 수 없습니다 |
| `ocean_test.mjs` | 부채꼴 격자 **삼각형 내부**를 뜯어, 살아남는 화소의 Y가 보간 때문에 얼마나 들려 있는지. 곶에서만 터지므로 물가 반경만 봐서는 안 잡힙니다 |
| `ocean_edge.mjs` | 파도가 **물러났을 때** 물 가장자리가 얼마나 두꺼운가. 밀려올 때만 보면 못 잡습니다 — t=0~9.0을 16개 시점으로 찍습니다 |
| `pick_test.mjs` | 화면을 찍었을 때 정말 지면 위 좌표가 나오는가. 레이캐스트가 못 쓰는 이유와 걸음 폭 상한이 필요한 이유를 함께 잽니다 |
| `access_test.mjs` | check_admin.php의 각 응답(정상·404·PHP오류·시간초과)에 대해 버튼을 보일지, 고장 안내를 띄울지 |
| `place_test.mjs` | 마커 화살표가 베니 정면과 같은 방향인가. 각도 규약은 파일마다 달라서(`dirDeg`는 atan2(z,x)) 눈으로는 90° 틀어진 것을 못 잡습니다 |
| `net_test.mjs` | 남들이 순간이동하지 않는가 · 359°→1° 회전이 반대로 돌지 않는가 · 패킷 유실에서 발산하지 않는가 · 보내는 양 |
| `lint.mjs` | 재질에 박힌 alphaTest 숫자(텍스처와 어긋나는 사고의 원인) |
