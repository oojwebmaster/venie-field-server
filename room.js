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

/** 색 문자열의 형식 확인 — 남이 보낸 값이 그대로 남의 화면 재질에 들어갑니다 */
const isColor = (v) => typeof v === 'string' && /^#[0-9a-fA-F]{6}$/.test(v);

export class Room {
  /**
   * @param {object} opt
   *   maxPlayers  이 인원을 넘으면 새 접속을 거절합니다
   *   nameMax     이름 최대 길이
   *   staleAfter  이 시간(ms) 동안 아무 것도 안 보내면 끊긴 것으로 봅니다
   */
  constructor(opt = {}) {
    this.opt = {
      maxPlayers: 24,
      nameMax: 12,
      staleAfter: 30000,
      // ── 물감 아이템 (src/config.js의 world.paint와 같은 값이어야 합니다) ──
      itemCount: 14,        // 동시에 떠 있는 개수
      itemRespawn: 60000,   // 먹히고 다시 나타나기까지(ms)
      itemColors: 7,        // 색 가짓수 (palette.js의 PAINTS 길이)
      spawnCount: 0,        // 스폰 후보 자리 수 (server.js가 spawns.js에서 넣어 줍니다)
      claimRange: 12,       // 이보다 멀리서 주웠다고 하면 거절합니다(m)
      keepColorOnRespawn: true,
      spawnAt: null,        // (i) => { x, z } — 거리 검사에만 씁니다
      ...opt,
    };
    this.players = new Map();
    this._nextId = 1;
    /* ★ 물감은 **서버가 진실을 갖습니다.**
     * 클라이언트가 "내가 먹었다"고 말하는 것을 각자 믿으면 두 사람이 같은
     * 물감을 먹고 둘 다 색이 바뀝니다. 여기서 딱 한 번만 승인합니다. */
    this.items = [];
    this._nextItemId = 1;
    /** 먹힌 뒤 돌아올 예약 [{ at, color }] */
    this._respawnQueue = [];
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
      /* 몸에 묻은 물감 색 '#rrggbb' (기본색이면 null).
       * ★ 스냅샷에 넣지 않습니다 — 바뀌는 일이 드문 값을 초당 20번 실어
       *   보낼 이유가 없습니다. join/welcome과 color 메시지로만 전합니다. */
      color: null,
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
   * 몸 색 알림. 색을 **섞는 계산은 각자의 브라우저**가 합니다 —
   * 순수한 겉모습이고, 그 식(palette.js)을 서버에 한 벌 더 두면
   * 언젠가 반드시 어긋나기 때문입니다. 서버는 형식만 보고 나눠 줍니다.
   * @returns {boolean} 받아들였는가
   */
  setColor(id, hex) {
    const p = this.players.get(id);
    if (!p) return false;
    if (hex !== null && !isColor(hex)) return false;
    p.color = hex === null ? null : hex.toLowerCase();
    return true;
  }

  /* ======================================================== 물감 아이템 */

  /**
   * 지금 떠 있어야 할 개수만큼 채우고, 예약된 것을 돌려놓습니다.
   * `server.js`의 틱 루프가 부릅니다.
   * @returns {{added: object[]}} 새로 생긴 아이템 (그대로 방송하면 됩니다)
   */
  tickItems(now = Date.now()) {
    const O = this.opt;
    const added = [];
    if (!O.spawnCount) return { added };

    // ① 시간이 된 예약부터
    for (let i = this._respawnQueue.length - 1; i >= 0; i--) {
      if (this._respawnQueue[i].at > now) continue;
      const job = this._respawnQueue.splice(i, 1)[0];
      const it = this._spawn(O.keepColorOnRespawn ? job.color : null);
      if (it) added.push(it);
    }
    // ② 그래도 모자라면 채웁니다 (서버가 막 켜졌을 때)
    while (this.items.length + this._respawnQueue.length < O.itemCount) {
      const it = this._spawn(null);
      if (!it) break;
      added.push(it);
    }
    return { added };
  }

  _spawn(color) {
    const O = this.opt;
    // 이미 쓰고 있는 자리는 피합니다 (물감 둘이 겹쳐 뜨면 하나만 보입니다)
    const used = new Set(this.items.map((i) => i.spawn));
    let spawn = -1;
    for (let k = 0; k < 32; k++) {
      const c = Math.floor(Math.random() * O.spawnCount);
      if (!used.has(c)) { spawn = c; break; }
    }
    if (spawn < 0) return null;
    const it = {
      id: this._nextItemId++,
      spawn,
      color: color === null ? this._scarcestColor() : color,
      born: Date.now(),
    };
    this.items.push(it);
    return it;
  }

  /**
   * 지금 가장 적은 색을 고릅니다.
   * ★ 그냥 무작위로 뽑으면 일곱 색 중 두세 색이 통째로 빠진 채 한참 갑니다
   *   (14개를 7색에서 균등하게 뽑으면 한 색도 안 나올 확률이 색마다 11%,
   *   적어도 한 색이 빠질 확률은 절반이 넘습니다). 산책하다 만나는 물감이
   *   빨강뿐이면 '섞는 재미'가 통째로 사라집니다.
   */
  _scarcestColor() {
    const n = this.opt.itemColors;
    const tally = new Array(n).fill(0);
    for (const i of this.items) tally[i.color % n]++;
    for (const q of this._respawnQueue) if (q.color !== null) tally[q.color % n]++;
    const min = Math.min(...tally);
    const pool = [];
    for (let i = 0; i < n; i++) if (tally[i] === min) pool.push(i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 누군가 물감을 주웠다고 알려 왔습니다.
   *
   * ★ **먼저 온 사람이 가져갑니다.** 두 사람이 같은 순간에 손을 뻗어도
   *   여기서 한 번만 통과하므로, 나머지 한 명에게는 그냥 사라진 것으로 보입니다.
   * ★ 위치는 각자의 브라우저가 판정합니다(왕복 200ms를 기다리면 손맛이 죽습니다).
   *   그래서 서버는 "말이 되는 거리인가"만 봅니다 — 지도 반대편에서 주웠다고
   *   말하는 것은 막습니다.
   *
   * @returns {{ok:true,item:object}|{ok:false,reason:string}}
   */
  takeItem(playerId, itemId, now = Date.now()) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'noplayer' };
    const idx = this.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return { ok: false, reason: 'gone' };
    const it = this.items[idx];

    const at = this.opt.spawnAt ? this.opt.spawnAt(it.spawn) : null;
    if (at) {
      const d = Math.hypot(p.x - at.x, p.z - at.z);
      if (d > this.opt.claimRange) return { ok: false, reason: 'far' };
    }

    this.items.splice(idx, 1);
    this._respawnQueue.push({ at: now + this.opt.itemRespawn, color: it.color });
    return { ok: true, item: it };
  }

  /** 접속할 때 한 번 받는 아이템 명단 */
  itemList() {
    return this.items.map(Room.itemWire);
  }

  /** 전선에 싣는 형태 — i(아이디) · s(스폰 번호) · c(색 번호) */
  static itemWire(it) {
    return { i: it.id, s: it.spawn, c: it.color };
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
