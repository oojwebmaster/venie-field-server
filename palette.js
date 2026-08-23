/**
 * VENIE FIELD — 물감 색 (색상환과 혼합)
 * ============================================================================
 *
 * ★ src/palette.js 와 server/palette.js 는 **완전히 같은 파일**이어야 합니다.
 *   게임은 FTP로 카페24에, 서버는 GitHub로 Render에 올라가 파일을 공유할 수
 *   없어서 두 벌을 둡니다. (badwords.js·spawns.js와 같은 이유이고
 *   `test/wire_test.mjs`가 바이트 단위로 비교합니다)
 *   그래서 이 파일은 **아무것도 import 하지 않습니다** — 브라우저에서도
 *   Node에서도 그대로 돌아야 합니다.
 *
 * ## 왜 RGB 평균이 아니라 '화가의 색상환'인가
 *
 * 요구사항은 "빨강을 먹은 상태에서 파랑을 먹으면 보라"입니다. RGB로 평균을
 * 내면 파스텔끼리라 우연히 보라 비슷하게 나오기는 합니다. 그런데 **노랑 + 파랑**을
 * 같은 식으로 하면 (0.98,0.90,0.50)과 (0.45,0.55,0.95)의 평균이라
 * (0.72,0.73,0.73) — **회색**이 됩니다. 물감 게임에서 노랑과 파랑을 섞었는데
 * 초록이 안 나오면 그 순간 가짜가 됩니다.
 *
 * 그래서 색을 **RYB(빨강-노랑-파랑) 색상환 위의 각도**로 다룹니다.
 * 미술 시간에 배우는 그 색상환이고, 사용자가 머릿속에 갖고 있는 모델도 이것입니다.
 *
 *      빨강 0°   주황 60°   노랑 120°   초록 180°   파랑 240°   남색 268°   보라 300°
 *
 * 두 색을 섞으면 **짧은 쪽 호의 가운데**로 갑니다.
 *   · 빨강(0) + 파랑(240)  → 짧은 쪽은 −120 → −60 = **300 보라** ✔
 *   · 노랑(120) + 파랑(240) → +120 → **180 초록** ✔
 *   · 빨강(0) + 노랑(120)  → +120 → **60 주황** ✔
 *
 * 이 색상환의 마주 보는 짝(빨강↔초록, 주황↔파랑, 노랑↔보라)이 정확히 **보색**이고,
 * 실제 물감도 보색끼리 섞으면 **탁한 회갈색**이 됩니다. 그래서 각도 차가 클수록
 * 채도를 떨어뜨립니다 — 계속 섞으면 점점 탁해지는 것이 물감의 진짜 성질이고,
 * 그 상태는 물에 들어가면 씻깁니다.
 *
 * ## 상태는 두 숫자뿐입니다
 *   h — 색상환 각도(0~360)
 *   s — 맑기(1 = 순색, 0 = 완전히 탁함)
 * 화면에 쓸 색은 `tintHex({h, s})` 하나로 나옵니다. 전선(wire)에는 이 결과
 * 문자열만 실어 보냅니다 — 남의 브라우저는 섞을 일이 없기 때문입니다.
 */

/* ── 색상환 기준점 ────────────────────────────────────────────────────────
 * 12개를 두는 이유: 사이 각도는 이웃 둘을 섞어 만드는데, 기준점이 7개뿐이면
 * 빨강(0)과 주황(60) 사이가 RGB 직선이 되어 중간에서 탁해 보입니다.
 *
 * ★ 처음에는 옅은 파스텔이었습니다. 그런데 **몸 색이 바뀌어도 변화가 잘
 *   안 느껴졌습니다** — 파스텔끼리는 밝기가 다 비슷해서, 빨강에서 파랑으로
 *   가도 '조금 톤이 달라진' 정도로만 보입니다. 게다가 여기서 섞으면 채도가
 *   더 떨어지므로(보색일수록 탁해짐) 출발점이 옅으면 결과는 거의 회색입니다.
 *   그래서 **선명한 쪽으로** 옮겼습니다. 원색만큼 날카롭지는 않게,
 *   밝기(L)를 55~62% 근처로 맞춰 일곱 색이 서로 같은 무게로 보이도록 했습니다.
 */
export const WHEEL = [
  { deg: 0, hex: '#ef4b4b' },     // 빨강
  { deg: 30, hex: '#f2683a' },
  { deg: 60, hex: '#f58c2a' },    // 주황
  { deg: 90, hex: '#f4ad2b' },
  { deg: 120, hex: '#f0cc33' },   // 노랑
  { deg: 150, hex: '#9ecb3c' },
  { deg: 180, hex: '#43c463' },   // 초록
  { deg: 210, hex: '#2fbfae' },
  { deg: 240, hex: '#3d9ae0' },   // 파랑
  { deg: 268, hex: '#5566d8' },   // 남색
  { deg: 300, hex: '#a457d4' },   // 보라
  { deg: 330, hex: '#e055a3' },
];

/** 유저가 주울 수 있는 일곱 색. 무지개 순서 그대로입니다 */
export const PAINTS = [
  { key: 'red', name: '빨강', deg: 0 },
  { key: 'orange', name: '주황', deg: 60 },
  { key: 'yellow', name: '노랑', deg: 120 },
  { key: 'green', name: '초록', deg: 180 },
  { key: 'blue', name: '파랑', deg: 240 },
  { key: 'indigo', name: '남색', deg: 268 },
  { key: 'violet', name: '보라', deg: 300 },
];

/** 보색끼리 섞였을 때 도달하는 색 — 회색이 아니라 **회갈색**이어야 물감으로 읽힙니다.
 * 순색이 선명해진 만큼 이쪽도 조금 어둡게 내려 대비를 살립니다. */
export const MUD = '#9c9187';

/* 섞임의 성격 (여기만 만지면 됩니다) */
export const MIX = {
  /* 각도 차가 클수록 탁해지는 최대치. 1이면 보색에서 완전히 MUD가 됩니다 */
  mud: 0.85,
  /* 어느 각도 차부터 탁해지기 시작하는가(0~1, 1 = 180°).
   * ★ 0.45보다 낮추면 빨강+파랑(0.67)이 눈에 띄게 탁해져 '보라'로 안 읽힙니다.
   *   실제로 처음에 선형으로 뒀다가 보라가 잿빛이 되어 이 구간을 넣었습니다. */
  mudFrom: 0.45,
  /* 같은(가까운) 색을 다시 먹으면 맑기가 조금 돌아옵니다.
   * 없으면 한 번 탁해진 뒤로는 물에 씻기 전까지 영영 탁한 채라 답답합니다. */
  recover: 0.35,
  /** 맑기의 하한 — 0까지 내려가면 '물감을 먹었다'는 느낌 자체가 사라집니다 */
  minS: 0.12,
};

/* ── 작은 색 도구들 (three.js 없이) ───────────────────────────────────────── */

/** '#rrggbb' → { r, g, b } (0~1, sRGB 그대로) */
export function hexToRgb(hex) {
  const n = parseInt(String(hex).replace('#', ''), 16);
  return { r: ((n >> 16) & 255) / 255, g: ((n >> 8) & 255) / 255, b: (n & 255) / 255 };
}

/** { r, g, b }(0~1) → '#rrggbb' */
export function rgbToHex(c) {
  const q = (v) => {
    const k = Math.round(Math.min(1, Math.max(0, v)) * 255);
    return k < 16 ? `0${k.toString(16)}` : k.toString(16);
  };
  return `#${q(c.r)}${q(c.g)}${q(c.b)}`;
}

/** 각도를 0~360으로 */
export function wrap360(d) {
  const x = d % 360;
  return x < 0 ? x + 360 : x;
}

/** 두 각도의 차를 −180~180으로 (섞을 때 **짧은 쪽**으로 가기 위해) */
export function wrap180(d) {
  const x = wrap360(d + 180);
  return x - 180;
}

/**
 * 색상환 각도 → 파스텔 RGB.
 * 이웃한 두 기준점을 각도 비율로 섞습니다.
 */
export function wheelRgb(deg) {
  const h = wrap360(deg);
  const n = WHEEL.length;
  let i = n - 1;
  for (let k = 0; k < n; k++) {
    if (WHEEL[k].deg > h) { i = k - 1; break; }
    if (k === n - 1) i = n - 1;
  }
  if (i < 0) i = n - 1;
  const a = WHEEL[i];
  const b = WHEEL[(i + 1) % n];
  const span = wrap360(b.deg - a.deg) || 360;
  const t = wrap360(h - a.deg) / span;
  const ca = hexToRgb(a.hex);
  const cb = hexToRgb(b.hex);
  return {
    r: ca.r + (cb.r - ca.r) * t,
    g: ca.g + (cb.g - ca.g) * t,
    b: ca.b + (cb.b - ca.b) * t,
  };
}

/**
 * 물감 상태 { h, s } → 화면에 칠할 색.
 * 맑기(s)가 낮을수록 회갈색(MUD) 쪽으로 끌어당깁니다.
 */
export function tintRgb(tint) {
  if (!tint) return null;
  const pure = wheelRgb(tint.h);
  const mud = hexToRgb(MUD);
  const s = Math.min(1, Math.max(0, tint.s));
  return {
    r: mud.r + (pure.r - mud.r) * s,
    g: mud.g + (pure.g - mud.g) * s,
    b: mud.b + (pure.b - mud.b) * s,
  };
}

/** 물감 상태 → '#rrggbb'. 기본 색(tint = null)이면 null */
export function tintHex(tint) {
  const c = tintRgb(tint);
  return c ? rgbToHex(c) : null;
}

/** i번째 물감의 상태 (순색) */
export function paintTint(index) {
  const p = PAINTS[((index % PAINTS.length) + PAINTS.length) % PAINTS.length];
  return { h: p.deg, s: 1 };
}

/** i번째 물감의 색 문자열 — 튜브의 'Color' 재질에 그대로 넣습니다 */
export function paintHex(index) {
  return tintHex(paintTint(index));
}

function smoothstep(a, b, x) {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
}

/**
 * 지금 몸 색(current)에 물감(paintIndex)을 섞습니다.
 *
 * @param {{h:number,s:number}|null} current 기본 색이면 null
 * @param {number} paintIndex PAINTS의 인덱스
 * @returns {{h:number,s:number}} 새 물감 상태
 */
export function mixPaint(current, paintIndex) {
  const add = paintTint(paintIndex);
  // ① 기본 색이면 **먹은 색 그대로** 됩니다 (섞을 것이 없습니다)
  if (!current) return { h: add.h, s: add.s };

  // ② 색상환의 짧은 쪽 호로 절반만큼 이동
  const d = wrap180(add.h - current.h);
  const h = wrap360(current.h + d * 0.5);

  // ③ 각도 차가 클수록 탁해집니다 (보색이면 회갈색)
  const k = Math.abs(d) / 180;
  let s = current.s * (1 - MIX.mud * smoothstep(MIX.mudFrom, 1, k));
  // ④ 가까운 색을 덧칠하면 맑기가 조금 돌아옵니다
  s += MIX.recover * (1 - k) * (1 - k) * (1 - s);
  return { h, s: Math.min(1, Math.max(MIX.minS, s)) };
}

/**
 * 전선에서 받은 색 문자열을 믿을 수 있는가.
 * ★ 남이 보낸 문자열은 그대로 `material.color`에 들어갑니다. 형식을 확인하지
 *   않으면 이상한 값 하나가 다른 사람 화면의 재질을 망가뜨릴 수 있습니다.
 */
export function isColorString(v) {
  return typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);
}
