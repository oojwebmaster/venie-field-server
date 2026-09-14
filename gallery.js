import crypto from 'node:crypto';

/**
 * VENIE FIELD — 작품 갤러리 (server/gallery.js)
 * ============================================================================
 *
 * 방문자가 그린 그림을 **서버에 맡아 두고**, 승인된 것만 모두에게 보여 줍니다.
 *
 * ## ★★ 세 줄 요약
 * 1. 그림은 **webp 한 장**입니다. 다른 형식은 받지 않습니다(머리글을 봅니다).
 * 2. 승인 전에는 **주인에게만** 보입니다. 새로고침해도, 다음 날 와도 그대로입니다.
 * 3. **7일 동안 승인되지 않으면 사라집니다** — 지우는 일을 사람이 기억하고
 *    있어야 하는 구조는 언젠가 반드시 잊힙니다.
 *
 * ## ★★ 왜 이미지는 WebSocket으로 보내지 않는가
 * `server.js`가 2048바이트가 넘는 메시지를 읽지도 않고 끊습니다. 512칸 webp는
 * 40~150KB라 애초에 들어갈 수가 없습니다. 쪼개서 보내는 길도 있지만 그러면
 * **브라우저 캐시를 못 씁니다** — 어제 본 그림을 오늘 또 받게 됩니다.
 * 그래서 그림만 HTTP로 오갑니다(`POST /art/<id>` · `GET /art/<id>.webp`).
 * 주소에 들어가는 번호가 임의의 11글자라, 승인 전 그림의 주소는 **아무도
 * 찍어 맞힐 수 없습니다.**
 *
 * ## ★★ 올리는 순서 — 자리표(ticket)를 먼저 받습니다
 * ```
 *   ① WS  {t:'art', a:'new'}  → 서버가 번호와 자리표를 줍니다 (2분짜리, 1회용)
 *   ② HTTP POST /art/<번호>?tk=<자리표>  ← webp 본문
 *   ③ WS  {t:'art', a:'place'} → 좌표를 적습니다 (여기서 '승인 대기'가 됩니다)
 * ```
 * ①이 없으면 **아무나 이 주소로 그림을 쌓을 수 있습니다.** 접속해서 놀고
 * 있는 사람만 자리표를 받을 수 있고, 자리표 하나에 그림 한 장입니다.
 *
 * ## ★★ 좌표에서 y(높이)를 **저장하지 않습니다**
 * 지형은 기기마다 조금씩 다릅니다(PC와 모바일의 높이 차가 최대 0.40m).
 * 높이를 적어 두면 남의 화면에서 작품이 땅에 파묻히거나 공중에 뜹니다.
 * x·z만 적고 높이는 **각자의 지형에서 다시 잽니다**(`world.groundAt`).
 *
 * ## PIN
 * 로그인이 없으므로 주인을 가리는 것은 PIN 하나뿐입니다. 그래서
 *   · 그대로 저장하지 않습니다 — 작품마다 다른 소금 + `ART_PIN_SALT`로 해시
 *   · 견줄 때 `timingSafeEqual` — 한 글자씩 맞춰 보며 시간을 재는 공격을 막습니다
 *   · 다섯 번 틀리면 10분 잠깁니다
 */

/** 상태 — 전선에는 숫자로 갑니다(`s`) */
export const ART = { DRAFT: 0, PENDING: 1, APPROVED: 2 };

const DAY = 86400 * 1000;
/** 자리표가 살아 있는 시간 — 그리고 나서 올리기까지 넉넉합니다 */
const TICKET_MS = 120 * 1000;
/** PIN을 이만큼 틀리면 */
const PIN_TRIES = 5;
/** 이 시간 동안 잠깁니다 */
const PIN_LOCK_MS = 10 * 60 * 1000;

/**
 * 이름을 **열쇠꼴**로 다듬습니다.
 *
 * ★★ `room.js`가 같은 이름이 동시에 접속하면 'Don 2'를 만듭니다. 그것을
 *   주인 이름으로 적으면 **다음 날 Don으로 들어왔을 때 제 작품이 안 보입니다.**
 *   순위표가 `baseName`을 쓰는 것과 완전히 같은 이유입니다.
 * ★ 대소문자도 가립니다 — 'don'과 'Don'이 다른 사람이 되면, 본인은 제 작품이
 *   사라졌다고 느끼지만 어디에도 오류가 남지 않습니다.
 */
export function ownerKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLowerCase();
}

/**
 * webp인가 — **머리글을 직접 봅니다.**
 *
 * ★★ 브라우저는 webp를 못 만들면 **말없이 png를 돌려줍니다.** 게임 쪽에서도
 *   확인하지만, 게임 쪽 검사는 고쳐서 보낼 수 있으므로 여기서 다시 봅니다.
 *   RIFF 컨테이너라 `52 49 46 46` …(크기 4바이트)… `57 45 42 50`입니다.
 */
export function isWebp(buf) {
  return !!buf && buf.length > 16
    && buf.toString('latin1', 0, 4) === 'RIFF'
    && buf.toString('latin1', 8, 12) === 'WEBP';
}

/** 유한한 수만 (NaN이 좌표에 들어가면 그 작품은 영영 화면 밖에 섭니다) */
const num = (v) => (Number.isFinite(v) ? v : null);

export class Gallery {
  /**
   * @param {object} opt
   *   storeUrl/storeToken  Upstash REST (없으면 **메모리에만** — 서버가 자면 사라집니다)
   *   pinSalt   ART_PIN_SALT
   *   max       총량 상한 (ART_MAX)
   *   ttlDays   승인되지 않은 작품이 살아 있는 날 수 (ART_TTL_DAYS)
   *   prefix    키 앞머리 (기본 `vf:art`)
   *   log       한 줄 남기기
   */
  constructor(opt = {}) {
    this.store = opt.storeUrl && opt.storeToken
      ? { url: String(opt.storeUrl).replace(/\/$/, ''), token: opt.storeToken } : null;
    this.pinSalt = opt.pinSalt || '';
    this.max = Number(opt.max) || 300;
    this.ttl = Math.max(1, Number(opt.ttlDays) || 7) * DAY;
    this.prefix = opt.prefix || 'vf:art';
    this.log = opt.log || (() => {});
    /** id → meta */
    this.items = new Map();
    /** id → { at, key } 아직 그림이 안 올라온 자리표 */
    this._tickets = new Map();
    /** 열쇠꼴 이름 → { n, until } PIN 틀린 횟수 */
    this._tries = new Map();
    this.ready = false;
  }

  get size() { return this.items.size; }

  /**
   * 한 번이라도 승인을 받은 작품인가.
   *
   * ★★ `state`만으로는 모자랍니다 — 승인된 작품을 주인이 거두면 잠시
   *   `DRAFT`가 되는데, 그 순간을 '승인 안 된 것'으로 보면 7일 시한이
   *   되살아나고 스윕이 걷어 갑니다. 승인은 **그림에 대한 것**이라
   *   손에 들려 있는 동안에도 유지돼야 합니다.
   */
  static approvedOnce(m) {
    return !!m && (m.state === ART.APPROVED || (m.approved || 0) > 0);
  }

  get pendingCount() {
    let n = 0;
    for (const m of this.items.values()) if (!Gallery.approvedOnce(m)) n++;
    return n;
  }

  /* ─────────────────────────────────────────────────────────── 저장소 */

  /**
   * Upstash REST에 명령 하나.
   *
   * ★ 순위표(`server.js`)는 `/get/키`·`/set/키` 꼴을 쓰지만, 여기서는
   *   **JSON 배열 한 줄**로 보냅니다 — `EX`(만료)·`PERSIST`·`SADD`처럼
   *   인자가 여럿인 명령을 주소에 욱여넣으면 200KB짜리 그림이 주소가 됩니다.
   */
  async _cmd(args) {
    if (!this.store) return null;
    const res = await fetch(this.store.url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.store.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(args),
    });
    const j = await res.json();
    if (j && j.error) throw new Error(j.error);
    return j ? j.result : null;
  }

  /** 여러 명령을 한 번에 (접속 수가 아니라 **요청 수**가 요금제의 단위입니다) */
  async _pipe(list) {
    if (!this.store || !list.length) return [];
    const res = await fetch(`${this.store.url}/pipeline`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.store.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(list),
    });
    const j = await res.json();
    if (Array.isArray(j)) return j.map((r) => (r && r.error ? null : r && r.result));
    if (j && j.error) throw new Error(j.error);
    return [];
  }

  _kMeta(id) { return `${this.prefix}:${id}`; }

  _kImg(id) { return `${this.prefix}:img:${id}`; }

  _kIds() { return `${this.prefix}:ids`; }

  /**
   * 서버가 깨어날 때 한 번. **그림은 안 불러옵니다** — 메타만 기억해 두고
   * 그림은 달라고 할 때 그때그때 꺼냅니다(300장이면 45MB, 무료 플랜에 과합니다).
   */
  async load() {
    if (!this.store) { this.ready = true; return; }
    try {
      const ids = (await this._cmd(['SMEMBERS', this._kIds()])) || [];
      if (!ids.length) { this.ready = true; this.log('작품 없음'); return; }
      const rows = await this._pipe(ids.map((id) => ['GET', this._kMeta(id)]));
      const lost = [];
      ids.forEach((id, i) => {
        let m = null;
        try { m = rows[i] ? JSON.parse(rows[i]) : null; } catch (e) { m = null; }
        /* ★★ 값이 비었으면 **만료돼 사라진 것**입니다(7일). 목록에서도 빼
         *   줍니다 — 안 그러면 깰 때마다 없는 번호를 읽으러 갑니다. */
        if (!m || !m.id) { lost.push(id); return; }
        this.items.set(m.id, m);
      });
      if (lost.length) {
        await this._cmd(['SREM', this._kIds(), ...lost]).catch(() => {});
        this.log(`만료된 작품 ${lost.length}건을 목록에서 지웠습니다`);
      }
      this.log(`작품 ${this.items.size}점을 불러왔습니다`
        + ` (승인 ${this.items.size - this.pendingCount} · 대기 ${this.pendingCount})`);
    } catch (e) {
      this.log(`작품을 불러오지 못했습니다: ${e.message}`);
    }
    this.ready = true;
    await this.sweep();
  }

  /* ──────────────────────────────────────────────────────────────── PIN */

  _hash(pin, salt) {
    return crypto.createHash('sha256')
      .update(`${salt}:${this.pinSalt}:${pin}`).digest('hex');
  }

  /**
   * ★ `timingSafeEqual` — 길이가 다르면 예외를 던지므로 먼저 재 둡니다.
   *   그냥 `===`로 견주면 앞에서부터 맞는 만큼 시간이 더 걸려, 그 차이로
   *   한 글자씩 알아낼 수 있습니다. 네 자리 PIN에는 과한 걱정이지만
   *   **맞는 방법이 어렵지 않을 때는 맞는 방법으로 둡니다.**
   */
  _pinOk(meta, pin) {
    if (!meta || !meta.pinHash) return false;
    const a = Buffer.from(this._hash(String(pin || ''), meta.salt || ''), 'utf8');
    const b = Buffer.from(meta.pinHash, 'utf8');
    if (a.length !== b.length) return false;
    return crypto.timingSafeEqual(a, b);
  }

  /** 그 사람이 지금 PIN을 물어볼 수 있는가 (다섯 번 틀리면 10분) */
  _locked(who, now) {
    const t = this._tries.get(who);
    return !!(t && t.until > now);
  }

  _miss(who, now) {
    const t = this._tries.get(who) || { n: 0, until: 0 };
    t.n++;
    if (t.n >= PIN_TRIES) { t.until = now + PIN_LOCK_MS; t.n = 0; }
    this._tries.set(who, t);
  }

  _hit(who) { this._tries.delete(who); }

  /* ─────────────────────────────────────────────────────── 만들기·올리기 */

  /**
   * 자리 하나를 맡습니다 — 아직 저장소에는 아무것도 안 씁니다.
   * @returns {{ok:true,id:string,ticket:string}|{ok:false,why:string}}
   */
  reserve(owner, title, pin, now = Date.now()) {
    if (this.items.size >= this.max) return { ok: false, why: 'full' };
    const key = ownerKey(owner);
    if (!key) return { ok: false, why: 'name' };
    const t = String(title || '').trim().slice(0, 24);
    if (!t) return { ok: false, why: 'title' };
    if (!/^[0-9]{4,8}$/.test(String(pin || ''))) return { ok: false, why: 'pin' };
    /* 자리표가 쌓이지 않게 — 안 쓴 것은 2분이면 사라집니다 */
    for (const [k, v] of this._tickets) if (v.at + TICKET_MS < now) this._tickets.delete(k);
    /* ★ 번호는 **찍어 맞힐 수 없어야** 합니다. 승인 전 그림의 주소가 곧
     *   그 그림을 볼 수 있는 권한이기 때문입니다(목록에는 안 나옵니다). */
    const id = crypto.randomBytes(8).toString('base64url');
    const salt = crypto.randomBytes(8).toString('hex');
    const ticket = crypto.randomBytes(12).toString('base64url');
    this._tickets.set(id, {
      at: now,
      ticket,
      meta: {
        id,
        owner: String(owner).trim().slice(0, 24),
        key,
        title: t,
        salt,
        pinHash: this._hash(String(pin), salt),
        x: null,
        z: null,
        r: 0,
        state: ART.DRAFT,
        created: now,
        moved: now,
      },
    });
    return { ok: true, id, ticket };
  }

  /**
   * 그림이 올라왔습니다 — **여기서 비로소 저장소에 씁니다.**
   *
   * ★ 자리표 단계에서 미리 써 두면, 올리다 끊긴 사람들의 빈 껍데기가
   *   그대로 쌓입니다. 그림이 있어야 작품입니다.
   * @param {Buffer} buf webp 원본
   */
  async putImage(id, ticket, buf, now = Date.now()) {
    const slot = this._tickets.get(id);
    if (!slot || slot.ticket !== ticket) return { ok: false, why: 'ticket' };
    if (slot.at + TICKET_MS < now) { this._tickets.delete(id); return { ok: false, why: 'expired' }; }
    /* ★★ webp가 아니면 여기서 끝입니다. 사파리가 말없이 png를 돌려주는 길이
     *   있어서, 게임 쪽 확인만 믿으면 png가 `.webp` 이름으로 쌓입니다. */
    if (!isWebp(buf)) return { ok: false, why: 'format' };
    this._tickets.delete(id);
    const meta = slot.meta;
    this.items.set(id, meta);
    const b64 = buf.toString('base64');
    try {
      /* ★★ **만료 시각을 저장소에 맡깁니다**(EX). 서버가 자고 있어도,
       *   배포 중이어도 7일이 지나면 사라집니다 — 지우는 일을 우리 코드가
       *   기억하고 있어야 하는 구조는 언젠가 반드시 잊힙니다.
       *   승인하는 순간 `PERSIST`로 이 시한을 풉니다. */
      const sec = Math.round(this.ttl / 1000);
      await this._pipe([
        ['SET', this._kImg(id), b64, 'EX', sec],
        ['SET', this._kMeta(id), JSON.stringify(meta), 'EX', sec],
        ['SADD', this._kIds(), id],
      ]);
    } catch (e) {
      this.log(`작품 저장 실패 (${id}): ${e.message}`);
      /* ★ 저장소가 말을 안 들어도 **이번 판에서는 살려 둡니다.** 사람이
       *   몇 분 그린 것을 "저장을 못 했으니 없던 일로" 할 수는 없습니다. */
    }
    return { ok: true, id, bytes: buf.length };
  }

  /** 그림 한 장 꺼내기 (HTTP `GET /art/<id>.webp`) */
  async image(id) {
    const m = this.items.get(id);
    if (!m) return null;
    if (this._cache && this._cache.id === id) return this._cache.buf;
    try {
      const b64 = await this._cmd(['GET', this._kImg(id)]);
      if (!b64) return null;
      const buf = Buffer.from(b64, 'base64');
      /* ★ 한 장만 들고 있습니다. 브라우저가 `immutable`로 캐시하므로 같은
       *   그림을 다시 달라고 하는 일이 거의 없습니다 — 여기에 캐시를 크게
       *   잡으면 무료 플랜의 메모리만 먹습니다. */
      this._cache = { id, buf };
      return buf;
    } catch (e) {
      this.log(`그림을 꺼내지 못했습니다 (${id}): ${e.message}`);
      return null;
    }
  }

  /* ───────────────────────────────────────────────────── 세우기·거두기 */

  /**
   * 좌표를 적습니다 — 여기서 '승인 대기'가 됩니다.
   *
   * ★ **이미 승인된 작품은 승인된 채로 옮겨집니다.** 승인은 그림에 대한
   *   것이지 자리에 대한 것이 아닙니다. 옮길 때마다 다시 걸어야 한다면
   *   주인은 옮기기를 그만두게 됩니다.
   */
  async place(id, owner, x, z, r, now = Date.now()) {
    const m = this.items.get(id);
    if (!m) return { ok: false, why: 'gone' };
    if (m.key !== ownerKey(owner)) return { ok: false, why: 'owner' };
    const px = num(x);
    const pz = num(z);
    if (px === null || pz === null) return { ok: false, why: 'spot' };
    m.x = Math.round(px * 100) / 100;
    m.z = Math.round(pz * 100) / 100;
    m.r = Math.round((num(r) || 0) * 1000) / 1000;
    /* ★★ **한 번 승인된 그림은 승인된 채로 옮겨집니다.** 거뒀다 다시 세울 때
     *   `state`만 보면 그 사이 DRAFT가 되어 있어서 승인이 조용히 풀립니다 —
     *   주인은 며칠 뒤 "내 작품이 다시 대기 중"이 된 것을 보게 되고,
     *   어디에도 이유가 남지 않습니다. 그래서 **승인 시각**을 봅니다. */
    m.state = Gallery.approvedOnce(m) ? ART.APPROVED : ART.PENDING;
    m.moved = now;
    await this._save(m);
    return { ok: true, meta: m };
  }

  /**
   * 거둡니다 — PIN이 맞아야 합니다.
   *
   * ★★ **대조는 여기서만 합니다.** 브라우저 안에 정답이 있으면 콘솔에서
   *   꺼내 볼 수 있어 잠금이 아닙니다(4단계 ③-4).
   */
  async recall(id, owner, pin, now = Date.now()) {
    const m = this.items.get(id);
    if (!m) return { ok: false, why: 'gone' };
    const who = ownerKey(owner) || 'anon';
    if (this._locked(who, now)) return { ok: false, why: 'locked' };
    if (!this._pinOk(m, pin)) { this._miss(who, now); return { ok: false, why: 'pin' }; }
    this._hit(who);
    /* ★ 주인 이름을 **여기서 갈아 끼웁니다.** PIN이 맞았다는 것은 본인이라는
     *   뜻이고, 이름을 바꿔 들어온 사람이 제 작품을 영영 못 찾는 것보다
     *   따라가게 두는 편이 맞습니다. */
    const wasPlaced = m.state !== ART.DRAFT;
    m.key = who;
    m.owner = String(owner).trim().slice(0, 24) || m.owner;
    m.state = ART.DRAFT;
    m.x = null;
    m.z = null;
    m.moved = now;
    await this._save(m);
    return { ok: true, meta: m, wasPlaced };
  }

  /* ────────────────────────────────────────────────────────────── 관리자 */

  async approve(id, now = Date.now()) {
    const m = this.items.get(id);
    if (!m) return null;
    m.state = m.x === null ? ART.DRAFT : ART.APPROVED;
    m.approved = now;
    await this._save(m);
    /* ★★ 승인한 작품에서 **시한을 풉니다.** 이걸 빼먹으면 7일 뒤에
     *   승인된 작품이 조용히 사라집니다 — 그때는 아무도 원인을 모릅니다. */
    try { await this._pipe([['PERSIST', this._kMeta(id)], ['PERSIST', this._kImg(id)]]); } catch (e) { /* 다음 승인 때 다시 시도됩니다 */ }
    return m;
  }

  /** 승인을 거둡니다 — 다시 주인에게만 보입니다(7일 시한도 되살아납니다) */
  async reject(id, now = Date.now()) {
    const m = this.items.get(id);
    if (!m) return null;
    m.state = m.x === null ? ART.DRAFT : ART.PENDING;
    m.approved = 0;
    m.moved = now;
    await this._save(m);
    try {
      const sec = Math.round(this.ttl / 1000);
      await this._pipe([
        ['EXPIRE', this._kMeta(id), sec],
        ['EXPIRE', this._kImg(id), sec],
      ]);
    } catch (e) { /* 스윕이 다시 잡습니다 */ }
    return m;
  }

  async remove(id) {
    const m = this.items.get(id);
    if (!m) return false;
    this.items.delete(id);
    if (this._cache && this._cache.id === id) this._cache = null;
    try {
      await this._pipe([
        ['DEL', this._kMeta(id)],
        ['DEL', this._kImg(id)],
        ['SREM', this._kIds(), id],
      ]);
    } catch (e) {
      this.log(`작품을 지우지 못했습니다 (${id}): ${e.message}`);
    }
    return true;
  }

  /**
   * 7일이 지난 **승인되지 않은** 작품을 걷습니다.
   *
   * ★ 저장소의 EX가 이미 지워 주지만, 그건 **다음에 깨어날 때**에나
   *   드러납니다. 서버가 오래 떠 있으면 메모리의 목록에 유령이 남아
   *   "분명 사라졌어야 할 작품이 아직 서 있는" 상태가 됩니다.
   * @returns {string[]} 걷힌 번호들 (그대로 방송하면 됩니다)
   */
  async sweep(now = Date.now()) {
    const gone = [];
    for (const m of [...this.items.values()]) {
      if (Gallery.approvedOnce(m)) continue;
      if (now - (m.created || 0) < this.ttl) continue;
      gone.push(m.id);
    }
    for (const id of gone) await this.remove(id);
    if (gone.length) this.log(`승인되지 않은 작품 ${gone.length}점이 ${this.ttl / DAY}일이 지나 사라졌습니다`);
    return gone;
  }

  async _save(m) {
    if (!this.store) return;
    try {
      if (Gallery.approvedOnce(m)) {
        await this._cmd(['SET', this._kMeta(m.id), JSON.stringify(m)]);
      } else {
        /* ★ 남은 시한을 **그대로 이어 갑니다.** 매번 7일로 되감으면,
         *   작품을 자주 옮기는 사람의 것은 영영 만료되지 않습니다. */
        const left = Math.max(60, Math.round((this.ttl - (Date.now() - (m.created || 0))) / 1000));
        await this._cmd(['SET', this._kMeta(m.id), JSON.stringify(m), 'EX', left]);
      }
    } catch (e) {
      this.log(`작품 상태를 저장하지 못했습니다 (${m.id}): ${e.message}`);
    }
  }

  /* ───────────────────────────────────────────────────────────── 내보내기 */

  /** 전선에 싣는 꼴 — 짧게. 높이(y)는 **일부러 없습니다**(각자의 지형에서 잽니다) */
  static wire(m) {
    return {
      i: m.id, t: m.title, o: m.owner, x: m.x, z: m.z, r: m.r || 0, s: m.state,
    };
  }

  /**
   * 이 사람에게 보여 줄 것들.
   *
   * ★★ **승인 전 작품은 주인에게만 갑니다.** '보내 놓고 클라이언트가 가리는'
   *   방식이면 개발자도구를 열어 볼 줄 아는 누구에게나 보입니다. 아예
   *   보내지 않아야 안 보이는 것입니다.
   */
  visibleTo(owner) {
    const key = ownerKey(owner);
    const out = [];
    for (const m of this.items.values()) {
      /* 좌표가 없는 것은 **아직 손에 든 것**입니다 — 들판에 세울 수 없습니다 */
      if (m.x === null || m.z === null) continue;
      if (m.state === ART.APPROVED) { out.push(Gallery.wire(m)); continue; }
      if (key && m.key === key) out.push(Gallery.wire(m));
    }
    return out;
  }

  /**
   * 지금 이 사람이 **손에 들고 있어야 할** 것 (좌표 없이 맡겨 둔 작품).
   *
   * ★ 창을 닫을 때 머리에 이고 있던 작품이 여기 남습니다. 다음에 들어오면
   *   다시 머리에 얹어 줍니다 — 세울 자리를 서버가 고르는 것보다
   *   **주인이 고르게 두는 편**이 언제나 낫습니다.
   */
  heldBy(owner) {
    const key = ownerKey(owner);
    if (!key) return null;
    let best = null;
    for (const m of this.items.values()) {
      if (m.state !== ART.DRAFT || m.key !== key) continue;
      if (!best || (m.created || 0) > (best.created || 0)) best = m;
    }
    return best ? Gallery.wire(best) : null;
  }

  /** 관리자 화면용 — 전부, 최근 것부터 */
  adminList() {
    return [...this.items.values()]
      .sort((a, b) => (b.created || 0) - (a.created || 0))
      .map((m) => ({
        id: m.id,
        title: m.title,
        owner: m.owner,
        state: m.state,
        created: m.created,
        placed: m.x !== null,
        x: m.x,
        z: m.z,
        /* 남은 날 — 관리자가 "오늘 안 보면 사라진다"를 알 수 있어야 합니다 */
        days: Gallery.approvedOnce(m) ? null
          : Math.max(0, Math.round((this.ttl - (Date.now() - (m.created || 0))) / DAY * 10) / 10),
      }));
  }
}
