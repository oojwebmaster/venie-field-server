/**
 * 해변 비치볼의 서버 쪽 (세션 8) — **누가 임자인가**와 마지막 상태만 들고 있습니다.
 *
 * ★ 서버는 지형을 모르므로 물리를 돌리지 않습니다. 공을 마지막으로 친 사람(임자)의
 *   브라우저가 계산해 보내고, 서버는 그것을 모두에게 나눠 줍니다(src/ball.js 머리말).
 *
 * | 메시지 | 누가 | 서버가 하는 일 |
 * |---|---|---|
 * | `{t:'ball', a:'hit', s}` | 공을 친 사람 | **언제나** 받습니다 → 임자를 그 사람으로 · 나머지에게 알림 |
 * | `{t:'ball', a:'up', s}`  | 임자 | 임자일 때만 받습니다(늦게 온 옛 임자의 것은 버림) |
 * | 들어옴 | 누구나 | 임자가 없으면 그 사람이 임자 · welcome에 `bl:{s,o}` |
 * | 나감 | 임자 | 남은 사람 하나를 새 임자로 → `{t:'ball', s, o, own:1}` |
 *
 * s = [x, y, z, vx, vy, vz, qx, qy, qz, qw] — 형식이 틀리거나 말이 안 되는 값은 버립니다.
 */
export class BallState {
  constructor() {
    this.s = null;
    this.owner = null;
    this.seq = 0;
  }

  /** 받은 상태를 다듬습니다. 틀리면 null */
  static clean(s) {
    if (!Array.isArray(s) || s.length !== 10) return null;
    const o = s.map(Number);
    if (!o.every(Number.isFinite)) return null;
    if (Math.abs(o[0]) > 2000 || Math.abs(o[2]) > 2000 || o[1] < -200 || o[1] > 500) return null;
    for (let i = 3; i < 6; i++) o[i] = Math.max(-60, Math.min(60, o[i]));
    const ql = Math.hypot(o[6], o[7], o[8], o[9]);
    if (ql < 1e-6) { o[6] = 0; o[7] = 0; o[8] = 0; o[9] = 1; } else for (let i = 6; i < 10; i++) o[i] /= ql;
    const r = (x, k) => Math.round(x * k) / k;
    return o.map((x, i) => r(x, i < 6 ? 1000 : 10000));
  }

  /** 공을 쳤다 — 언제나 받고 임자가 바뀝니다 */
  hit(id, s) {
    const c = BallState.clean(s);
    if (!c) return false;
    this.s = c;
    this.owner = id;
    this.seq++;
    return true;
  }

  /** 임자의 갱신 — 임자가 아니면 버립니다 */
  update(id, s) {
    if (id !== this.owner) return false;
    const c = BallState.clean(s);
    if (!c) return false;
    this.s = c;
    this.seq++;
    return true;
  }

  /** 들어옴 — 임자가 없으면 이 사람이 임자 */
  join(id) {
    if (this.owner === null || this.owner === undefined) { this.owner = id; return true; }
    return false;
  }

  /**
   * 나감 — 임자였으면 남은 사람 중 하나에게 넘깁니다.
   * @returns {boolean} 임자가 바뀌었는가
   */
  leave(id, remaining) {
    if (this.owner !== id) return false;
    this.owner = remaining.length ? remaining[0] : null;
    return true;
  }

  wire() {
    return { s: this.s, o: this.owner };
  }
}
