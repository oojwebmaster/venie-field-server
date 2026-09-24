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
 * ★ (세션 8-3) **아무도 없는 채로 오래(기본 30분) 지나면 해변 가운데로.** 누가 공을
 *   구석에 두고 나가면 다음 사람이 찾기 어렵습니다. 타이머를 돌리지 않고 **다음 사람이
 *   들어올 때** 비어 있던 시간을 봅니다 — 아무도 없는 동안에는 어차피 아무도 공을
 *   보지 않으므로 결과가 같고, 비용이 0입니다. 방이 빌 때 한 번 저장소에 적어 두므로
 *   (무료 플랜이 잠들었다 깨어나도) 시간을 제대로 잽니다.
 *
 * ★★ (세션 8-4) **임자 번호(epoch)** — 임자가 바뀔 때마다(친 것·넘김·치움) 1씩 늘고 모든
 *   메시지에 `e`로 붙습니다. 두 사람이 공을 주고받을 때, 이미 빼앗긴 옛 임자의 갱신이
 *   길 위에 남아 있다가 늦게 도착해 **임자를 도로 뒤집던** 것을 막습니다(클라이언트가
 *   옛 번호의 메시지를 버립니다). 친 사람에게는 `{a:'ok', e}`로 **자기 번호**를 알려 줘,
 *   동시에 쳤을 때 누가 이겼는지 번호로 가립니다.
 *
 * s = [x, y, z, vx, vy, vz, qx, qy, qz, qw, 파도시계] — 형식이 틀리거나 말이 안 되는 값은 버립니다.
 *   (파도시계는 세션 8-2에 붙었습니다 — 10개짜리 옛 형식도 받습니다)
 * ★ (세션 8-2) **받은 시각**을 적어 두고 `age`(초)로 함께 나눠 줍니다. 임자가
 *   백그라운드로 가서 끊기면 마지막 상태가 오래된 것이 되는데, 넘겨받는 사람·새로
 *   들어온 사람이 그만큼 **같은 물리로 따라잡아** 옛 자리에서 시작하지 않게 합니다.
 */
export class BallState {
  constructor() {
    this.s = null;
    this.owner = null;
    this.seq = 0;
    this.at = 0;              // 마지막 상태를 받은 시각(ms)
    this.emptyAt = 0;         // 방이 빈 시각(ms) — 0이면 누가 있음
    this.epoch = 0;           // 임자 번호 — 임자가 바뀔 때마다 1씩
  }

  /** 방이 비었습니다 */
  markEmpty(now = Date.now()) {
    this.owner = null;
    this.emptyAt = now;
    this.epoch++;
  }

  /**
   * 들어오기 **직전**에 부릅니다 — 오래 비어 있었으면 공을 치웁니다(s=null → 첫 임자가
   * 해변 가운데에 놓습니다). 누가 들어오면 빈 시각은 지웁니다.
   * @returns {boolean} 치웠는가
   */
  maybeReset(now, afterMs) {
    const was = this.emptyAt;
    this.emptyAt = 0;
    if (was && now - was >= afterMs && this.s) {
      this.s = null;
      this.at = 0;
      return true;
    }
    return false;
  }

  /** 저장소에 적을 것 (방이 빌 때 한 번) */
  saved() {
    return { s: this.s, at: this.emptyAt || this.at };
  }

  /** 서버가 켜질 때 저장소에서 — 오래됐으면 버립니다(해변 가운데에서 시작) */
  restore(v, now, afterMs) {
    if (!v || !Array.isArray(v.s) || !Number.isFinite(v.at)) return false;
    if (now - v.at >= afterMs) return false;
    const c = BallState.clean(v.s);
    if (!c) return false;
    this.s = c;
    this.at = v.at;
    this.emptyAt = v.at;
    return true;
  }

  /** 받은 상태를 다듬습니다. 틀리면 null */
  static clean(s) {
    if (!Array.isArray(s) || (s.length !== 10 && s.length !== 11)) return null;
    const o = s.map(Number);
    if (!o.every(Number.isFinite)) return null;
    if (Math.abs(o[0]) > 2000 || Math.abs(o[2]) > 2000 || o[1] < -200 || o[1] > 500) return null;
    for (let i = 3; i < 6; i++) o[i] = Math.max(-60, Math.min(60, o[i]));
    const ql = Math.hypot(o[6], o[7], o[8], o[9]);
    if (ql < 1e-6) { o[6] = 0; o[7] = 0; o[8] = 0; o[9] = 1; } else for (let i = 6; i < 10; i++) o[i] /= ql;
    if (o.length === 11) o[10] = Math.max(0, Math.min(1e7, o[10]));
    const r = (x, k) => Math.round(x * k) / k;
    return o.map((x, i) => r(x, i < 6 ? 1000 : i < 10 ? 10000 : 100));
  }

  /** 공을 쳤다 — 언제나 받고 임자가 바뀝니다 */
  hit(id, s, now = Date.now()) {
    const c = BallState.clean(s);
    if (!c) return false;
    this.s = c;
    this.owner = id;
    this.seq++;
    this.at = now;
    this.epoch++;
    return true;
  }

  /** 임자의 갱신 — 임자가 아니면 버립니다 */
  update(id, s, now = Date.now()) {
    if (id !== this.owner) return false;
    const c = BallState.clean(s);
    if (!c) return false;
    this.s = c;
    this.seq++;
    this.at = now;
    return true;
  }

  /** 들어옴 — 임자가 없으면 이 사람이 임자 */
  join(id) {
    if (this.owner === null || this.owner === undefined) { this.owner = id; this.epoch++; return true; }
    return false;
  }

  /**
   * 나감 — 임자였으면 남은 사람 중 하나에게 넘깁니다.
   * @returns {boolean} 임자가 바뀌었는가
   */
  leave(id, remaining) {
    if (this.owner !== id) return false;
    this.owner = remaining.length ? remaining[0] : null;
    this.epoch++;
    return true;
  }

  wire(now = Date.now()) {
    const age = this.s ? Math.max(0, (now - this.at) / 1000) : 0;
    return { s: this.s, o: this.owner, e: this.epoch, age: Math.round(age * 100) / 100 };
  }
}
