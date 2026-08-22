/**
 * VENIE FIELD — 방(room) 로직
 *
 * ★ 네트워크와 **완전히 분리**해 둡니다. 소켓 없이 Node에서 그대로 돌려
 *   접속·이탈·상태갱신·스냅샷을 검증할 수 있어야 하기 때문입니다.
 *   (이 프로젝트의 원칙: 추측 다섯 번보다 측정 한 번)
 *
 * ## 지금은 '중계'만 합니다
 * 위치는 각 클라이언트가 정하고 서버는 그대로 나눠 줍니다. 포트폴리오에 붙는
 * 산책 게임이라 치팅에 걸 것이 없기 때문입니다.
 *
 * ★ 다만 **나중에 서버가 진실을 갖게 될 것들**(랜덤 스폰되는 물감, NPC)을 위해
 *   자리를 비워 둡니다. `Room.tick()`이 이미 서버 주도의 루프이고,
 *   스냅샷에 `items` 자리를 넣어 두었습니다. 그때 프로토콜을 새로 짜지 않아도
 *   됩니다.
 */

/** 이름 정리 — 화면에 그대로 뜨는 값이라 서버에서 반드시 다시 다듬습니다 */
export function sanitizeName(raw, max = 12) {
  if (typeof raw !== 'string') return '';
  return raw
    // 줄바꿈·탭은 **공백으로** 바꿉니다. 그냥 지우면 '줄\n바꿈'이 '줄바꿈'으로 붙습니다
    .replace(/[\t\n\r]/g, ' ')
    // 나머지 제어문자와 방향 재정의 문자는 제거 (이름을 거꾸로 뒤집는 데 쓰입니다)
    .replace(/[\u0000-\u001f\u007f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

/** 유한한 수인지 (NaN·Infinity가 들어오면 다른 클라이언트의 보간이 통째로 깨집니다) */
const num = (v, fallback = 0) => (Number.isFinite(v) ? v : fallback);

export class Room {
  /**
   * @param {object} opt
   *   maxPlayers  이 인원을 넘으면 새 접속을 거절합니다
   *   nameMax     이름 최대 길이
   *   staleAfter  이 시간(ms) 동안 아무 것도 안 보내면 끊긴 것으로 봅니다
   */
  constructor(opt = {}) {
    this.opt = { maxPlayers: 24, nameMax: 12, staleAfter: 30000, ...opt };
    this.players = new Map();
    this._nextId = 1;
    // 나중에 서버가 소유할 것들이 들어올 자리 (물감 아이템 등)
    this.items = [];
  }

  get size() { return this.players.size; }

  /** @returns {{ok:true,player:object}|{ok:false,reason:string}} */
  join(name, now = Date.now()) {
    if (this.players.size >= this.opt.maxPlayers) {
      return { ok: false, reason: 'full' };
    }
    const clean = sanitizeName(name, this.opt.nameMax);
    if (!clean) return { ok: false, reason: 'name' };

    const id = this._nextId++;
    const player = {
      id,
      name: this._uniqueName(clean),
      x: 0, y: 0, z: 0,
      yaw: Math.PI,
      // 애니메이션 상태 — 원격 캐릭터가 이 값으로 걷기/헤엄치기를 섞습니다
      mv: 0,      // 이동 블렌드 0~1
      sw: 0,      // 수영 블렌드 0~1
      air: 0,     // 공중(점프) 0/1
      color: null,  // ★ 물감 기능이 들어올 자리. 지금은 아무도 안 씁니다
      seen: now,
      joined: now,
    };
    this.players.set(id, player);
    return { ok: true, player };
  }

  /**
   * 같은 이름이 있으면 뒤에 숫자를 붙입니다.
   * 이름표가 겹치면 누가 누군지 알 수 없으므로 서버가 갈라 줍니다.
   */
  _uniqueName(name) {
    const taken = new Set([...this.players.values()].map((p) => p.name));
    if (!taken.has(name)) return name;
    for (let n = 2; n < 100; n++) {
      const candidate = `${name} ${n}`;
      if (!taken.has(candidate)) return candidate;
    }
    return name;
  }

  leave(id) {
    return this.players.delete(id);
  }

  /**
   * 클라이언트가 보낸 자기 상태를 받습니다.
   * ★ 들어오는 값은 전부 의심합니다 — NaN 하나가 섞이면 그 플레이어를 보간하는
   *   **다른 모든 클라이언트**의 위치 계산이 통째로 깨집니다.
   */
  setState(id, s, now = Date.now()) {
    const p = this.players.get(id);
    if (!p || !s) return false;
    p.x = num(s.x, p.x);
    p.y = num(s.y, p.y);
    p.z = num(s.z, p.z);
    p.yaw = num(s.yaw, p.yaw);
    p.mv = Math.max(0, Math.min(1, num(s.mv, 0)));
    p.sw = Math.max(0, Math.min(1, num(s.sw, 0)));
    p.air = s.air ? 1 : 0;
    p.seen = now;
    return true;
  }

  /** 지금 방에 있는 사람들의 이름표 (접속 직후 한 번 받습니다) */
  roster(exceptId = null) {
    const out = [];
    for (const p of this.players.values()) {
      if (p.id !== exceptId) out.push(Room.meta(p));
    }
    return out;
  }

  /** 오래 조용한 플레이어를 정리합니다 (소켓이 조용히 죽는 경우) */
  sweep(now = Date.now()) {
    const gone = [];
    for (const [id, p] of this.players) {
      if (now - p.seen > this.opt.staleAfter) { this.players.delete(id); gone.push(id); }
    }
    return gone;
  }

  /** 접속·이탈 알림에 쓰는 형태 (이름을 포함) */
  static meta(p) {
    return { id: p.id, n: p.name, ...(p.color ? { c: p.color } : {}) };
  }

  /**
   * 스냅샷에 실을 형태.
   *
   * ★ **이름은 넣지 않습니다.** 이름은 바뀌지 않는데 초당 12번 실어 보내면
   *   그만큼이 통째로 낭비입니다. 접속할 때(`welcome`) 명단을 받고,
   *   그 뒤로는 들어오고 나갈 때만(`join`/`leave`) 갱신합니다.
   *   WebSocket은 TCP 위라 순서와 도착이 보장되므로 이 방식이 안전합니다.
   */
  static wire(p) {
    return {
      id: p.id,
      x: Math.round(p.x * 100) / 100,
      y: Math.round(p.y * 100) / 100,
      z: Math.round(p.z * 100) / 100,
      r: Math.round(p.yaw * 1000) / 1000,
      mv: Math.round(p.mv * 100) / 100,
      sw: Math.round(p.sw * 100) / 100,
      a: p.air,
    };
  }

  /**
   * 한 명에게 보낼 스냅샷. **자기 자신은 뺍니다** —
   * 내 위치는 내가 이미 알고 있고, 받아서 덮으면 조작이 뚝뚝 끊깁니다.
   */
  snapshot(forId, now = Date.now()) {
    const list = [];
    for (const p of this.players.values()) {
      if (p.id === forId) continue;
      list.push(Room.wire(p));
    }
    return { t: 'snap', ts: now, p: list };
  }
}
