/* 이 파일은 `node --import ./env.mjs test/shell_bake.mjs`가 만듭니다 — 손으로 고치지 마세요.
 *
 * 조개가 놓일 수 있는 자리의 목록입니다. 값은 **0.1m 단위 정수 쌍**(x, z)이고
 * y는 넣지 않습니다 — 높이는 각 기기가 자기 지형에서 읽습니다.
 *
 * ★ src/shells.js 와 server/shells.js 는 **완전히 같은 파일**이어야 합니다.
 *   게임은 FTP로 카페24에, 서버는 GitHub로 Render에 올라가 파일을 공유할 수
 *   없어서 두 벌을 둡니다. (spawns.js와 같은 이유 · wire_test.mjs가 비교합니다)
 *
 * ★ 물감표(spawns.js)와 **겹치지 않습니다.** 물감은 해수면 +1.5m 위,
 *   조개는 파도 언저리(+0.32 ~ +1.05m)입니다.
 *
 * 지형을 바꾸거나 `config.world.shell.zone`을 고치면 이 표는 통째로
 * 무의미해집니다. 그래서 둘을 함께 넣은 지문을 굽고, 게임이 시작할 때 대조해
 * 어긋나면 콘솔과 개발모드 패널에 경고를 남깁니다.
 */
import { terrainFingerprint } from './spawns.js';

export const SHELL_FINGERPRINT = '1jaoj0r';

/**
 * 지금 CONFIG가 이 표를 구울 때와 같은가 (지형 + 조개 구역 설정).
 * 결과가 SHELL_FINGERPRINT와 다르면 표는 통째로 무의미합니다 —
 * `node --import ./env.mjs test/shell_bake.mjs`로 다시 구우세요.
 */
export function shellFingerprint(CONFIG) {
  const Z = CONFIG.world.shell.zone;
  const B = CONFIG.world.beach;
  const parts = [
    terrainFingerprint(CONFIG),
    Z.band && Z.band[0], Z.band && Z.band[1], Z.maskMin, Z.maxSlope, Z.minGap,
    Z.clearTree, Z.clearRock, Z.clearPalm, Z.clearDriftwood, Z.clearGrass,
    Z.clearPaint, Z.clearProp,
    (Z.reserved || []).join('|'),
    B.maxSlope,
    B.palms.enabled ? 1 : 0, B.palms.tile, B.palms.perTile, B.palms.clump,
    B.palms.band && B.palms.band.join(','),
    B.driftwood.enabled ? 1 : 0, B.driftwood.tile, B.driftwood.perTile,
    B.driftwood.clump, B.driftwood.kinds, B.driftwood.band && B.driftwood.band.join(','),
    B.duneGrass.enabled ? 1 : 0, B.duneGrass.tile, B.duneGrass.perTile,
    B.duneGrass.clump, B.duneGrass.band && B.duneGrass.band.join(','), B.duneGrass.maskMin,
  ];
  let h = 2166136261 >>> 0;
  for (let k = 0; k < parts.length; k++) {
    const s = String(parts[k]);
    for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0;
    h = Math.imul(h ^ 0x9e3779b9, 16777619) >>> 0;
  }
  return h.toString(36);
}

/* eslint-disable */
const D = [
  -399, -2262, -343, -2142, -310, -1962, -308, -1864, -606, -1794, -497, -1809, -816, -1741, -729, -1764, -540, -1753, -368, -1764,
  -697, -1688, -945, -1628, -809, -1635, -1100, -1586, -1006, -1594, -1211, -1475, -1137, -1464, -1052, -1487, -1273, -1376, -1392, -1321,
  -1533, -1118, -1575, -1045, -1630, -931, -1700, -883, -1664, -807, -1808, -695, -1695, -704, -1809, -598, -1717, -621, -1870, -528,
  -1756, -531, -1804, -479, -1868, -447, -1810, -370, -1918, -341, -1911, -229, -1975, -152, -1904, -114, -1995, -70, -1919, -7,
  -1996, 40, -1904, 126, -1976, 156, -1938, 233, -1906, 329, -1986, 382, -1858, 387, -1962, 451, -1821, 453, -1914, 542,
  -1779, 674, -1862, 722, -1808, 783, -1718, 785, -1763, 845, -1707, 888, -1691, 1004, -1586, 994, -1637, 1059, -1657, 1147,
  -1575, 1188, -1594, 1259, -1657, 1387, -1805, 1467,
];
/* eslint-enable */

export const SHELL_SPAWN_COUNT = D.length / 2;

/** i번째 후보의 월드 좌표 (x, z). 범위 밖 인덱스는 감아 씁니다 */
export function shellSpawnAt(i) {
  const n = SHELL_SPAWN_COUNT;
  const k = ((i % n) + n) % n * 2;
  return { x: D[k] / 10, z: D[k + 1] / 10 };
}
