/**
 * VENIE FIELD — 갤러리 (server/gallery.js)
 * ============================================================================
 *
 * 4단계입니다. 사람들이 세운 작품을 **서버가 들고** 있다가, 관리자가 승인한
 * 것만 모두에게 보여 줍니다.
 *
 * ```
 * 세움 ──▶ 승인 대기 ──관리자──▶ 승인됨 ──▶ 모두에게 보임
 *   │         │  (세운 본인에게만 보임)        │
 *   └── 회수 ─┴───────────────────────────────┘  (이름 + PIN)
 * ```
 *
 * ## ★★ 왜 승인제인가
 * **여자친구분의 포트폴리오 사이트입니다.** 익명 방문자가 그린 것이 작품
 * 옆에 영구히 걸립니다. 누가 부적절한 그림을 걸면 그건 작가의 작품 옆에
 * 남습니다. 64칸 시절이라면 몰라도, 512칸 붓으로는 무엇이든 그릴 수 있습니다.
 *
 * ## ★ Room을 건드리지 않았습니다
 * 이 파일은 `Room`도 `ws`도 모릅니다. 그림을 받아 두고, 물어보면 내어 주고,
 * 승인하면 표시를 바꾸는 것이 전부입니다. `server.js`가 소켓과 이어 줍니다.
 * 방(사람·아이템·점수)과 갤러리는 **수명이 다릅니다** — 사람은 나가면
 * 사라지지만 작품은 남습니다.
 *
 * ## 보관 (Upstash)
 * | 열쇠 | 무엇 | 크기 |
 * |---|---|---|
 * | `venie:arts` | 그림을 뺀 **목록** (작품명·자리·주인·PIN) | 작음 |
 * | `venie:art:<id>` | 그림 한 장 (webp base64) | 40~150KB |
 *
 * ★★ 그림을 목록과 **한 열쇠에 넣지 않습니다.** 예순 장이면 10MB짜리 값
 *   하나가 되어, 작품명 한 글자를 고치려 해도 10MB를 다시 씁니다. 목록만
 *   자주 쓰고 그림은 만들 때 한 번 쓰는 것이 맞습니다.
 */

/** 그림 하나의 최대 크기 (base64 글자 수). 512² webp가 보통 40~150KB입니다 */
const IMG_MAX = Number(process.env.ART_IMG_MAX || 400_000);
/** 세워 둘 수 있는 최대 개수 */
const ART_MAX = Number(process.env.ART_MAX || 60);
/** 한 사람이 동시에 세워 둘 수 있는 개수 */
const ART_PER_USER = Number(process.env.ART_PER_USER || 6);
/** 회수 시도: 이 시간(ms) 안에 이만큼까지 */
const TRY_WINDOW = 60_000;
const TRY_MAX = Number(process.env.ART_TRY_MAX || 5);

const now = () => Date.now();

/** 작품명 다듬기 — 보이는 글자이므로 방 이름과 같은 잣대로 */
export function sanitizeTitle(raw, max = 16) {
  if (typeof raw !== 'string') return '';
  return raw
    /* ★ 방향 재정의 문자 — 이름을 거꾸로 뒤집어 남을 사칭하는 데 쓰입니다 */
    .replace(/[\u202a-\u202e\u2066-\u2069\u200b-\u200f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max);
}

const isNum = (v) => Number.isFinite(v);
const isPin = (v) => typeof v === 'string' && /^[0-9]{4,8}$/.test(v);

/**
 * 그림 문자열이 쓸 만한가.
 *
 * ★★ 여기서 막지 않으면 **아무나 서버 메모리를 채울 수 있습니다.**
 *   webp가 아닌 것을 보내도 클라이언트가 알아서 못 그릴 뿐 서버는 그대로
 *   들고 있게 됩니다. 형식과 크기를 둘 다 봅니다.
 */
export function isImage(v) {
  if (typeof v !== 'string') return false;
  if (v.length > IMG_MAX) return false;
  return /^data:image\/(webp|png|jpeg);base64,[A-Za-z0-9+/=]+$/.test(v);
}

export class Gallery {
  /**
   * @param {object} opt
   *   store  { get(key), set(key, val), del(key) } — 없으면 메모리에만
   */
  constructor(opt = {}) {
    this.store = opt.store || null;
    this.max = opt.max ?? ART_MAX;
    this.perUser = opt.perUser ?? ART_PER_USER;
    /** id → { id, owner, title, pin, x, y, z, yaw, approved, at } */
    this.arts = new Map();
    /** id → base64 그림 */
    this.images = new Map();
    this._seq = 1;
    /** 회수 시도 기록: `${sid}|${id}` → [시각, …] */
    this._tries = new Map();
    this.onChange = null;      // 목록이 바뀌면 (저장을 미루기 위해)
  }

  _id() {
    /* 시각 + 순번 + 무작위. 시각만 쓰면 같은 밀리초에 둘이 들어올 때 겹칩니다 */
    return `${now().toString(36)}${(this._seq++).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  }

  /* ─────────────────────────────────────────────────────────────── 세우기 */

  /**
   * 작품을 세웁니다.
   * @returns {{ok:true, art}|{ok:false, why:string}}
   */
  place(owner, m) {
    const title = sanitizeTitle(m?.title);
    if (!title) return { ok: false, why: '작품명이 없습니다' };
    if (!isPin(m?.pin)) return { ok: false, why: 'PIN이 올바르지 않습니다' };
    if (!isImage(m?.img)) return { ok: false, why: '그림을 읽을 수 없습니다' };
    if (![m.x, m.y, m.z, m.yaw].every(isNum)) return { ok: false, why: '자리가 올바르지 않습니다' };
    if (this.arts.size >= this.max) return { ok: false, why: '갤러리가 가득 찼습니다' };
    const mine = [...this.arts.values()].filter((a) => a.owner === owner).length;
    if (mine >= this.perUser) {
      return { ok: false, why: `한 사람이 세울 수 있는 작품은 ${this.perUser}개까지입니다` };
    }

    const art = {
      id: this._id(),
      owner: String(owner || '').slice(0, 24),
      title,
      pin: m.pin,
      x: m.x, y: m.y, z: m.z, yaw: m.yaw,
      approved: false,
      at: now(),
    };
    this.arts.set(art.id, art);
    this.images.set(art.id, m.img);
    this._saveImage(art.id, m.img);
    this.onChange?.();
    return { ok: true, art };
  }

  /* ─────────────────────────────────────────────────────────────── 회수 */

  /**
   * 작품을 걷어 갑니다 — **이름과 PIN이 둘 다 맞아야** 합니다.
   *
   * ★★ 이름만으로 막으면 같은 이름을 적고 들어온 사람이 남의 작품을 걷어
   *   갑니다. 닉네임은 누구나 적을 수 있습니다.
   * ★★ 시도 횟수를 막습니다. 네 자리는 만 가지뿐이라, 막지 않으면 PIN은
   *   자물쇠가 아니라 장식입니다.
   */
  recall(sid, owner, id, pin) {
    const art = this.arts.get(id);
    if (!art) return { ok: false, why: '없는 작품입니다' };
    if (art.owner !== owner) return { ok: false, why: 'other' };

    const key = `${sid}|${id}`;
    const t = now();
    const list = (this._tries.get(key) || []).filter((x) => t - x < TRY_WINDOW);
    if (list.length >= TRY_MAX) {
      this._tries.set(key, list);
      return { ok: false, why: 'rate' };
    }
    if (art.pin !== pin) {
      list.push(t);
      this._tries.set(key, list);
      return { ok: false, why: 'pin' };
    }
    this._tries.delete(key);
    const img = this.images.get(id) || null;
    this._remove(id);
    return { ok: true, art, img };
  }

  /* ───────────────────────────────────────────────────────────── 관리자 */

  approve(id) {
    const a = this.arts.get(id);
    if (!a || a.approved) return null;
    a.approved = true;
    this.onChange?.();
    return a;
  }

  /** 거절·삭제는 같은 일입니다 — 지웁니다 */
  remove(id) {
    const a = this.arts.get(id);
    if (!a) return null;
    this._remove(id);
    return a;
  }

  _remove(id) {
    this.arts.delete(id);
    this.images.delete(id);
    this._delImage(id);
    this.onChange?.();
  }

  /* ────────────────────────────────────────────────────────────── 내보내기 */

  /**
   * 이 사람에게 보여 줄 목록.
   *
   * ★★ **PIN은 절대 나가지 않습니다.** 한 번 나가면 회수 잠금이 통째로
   *   무의미해지고, 그 사실은 아무도 눈치채지 못합니다.
   * ★ 승인 안 된 것은 **세운 본인에게만** 보입니다. 그래야 어디에 세웠는지
   *   알고 옮기거나 걷을 수 있습니다.
   */
  listFor(owner, withImages = true) {
    const out = [];
    for (const a of this.arts.values()) {
      if (!a.approved && a.owner !== owner) continue;
      out.push(this.wire(a, withImages));
    }
    return out;
  }

  wire(a, withImage = true) {
    const o = {
      id: a.id, owner: a.owner, title: a.title,
      x: a.x, y: a.y, z: a.z, yaw: a.yaw, approved: a.approved, at: a.at,
    };
    if (withImage) o.img = this.images.get(a.id) || null;
    return o;
  }

  /** 관리자 화면용 — 승인 대기와 승인된 것 모두 */
  adminList() {
    return [...this.arts.values()]
      .sort((p, q) => (p.approved === q.approved ? q.at - p.at : (p.approved ? 1 : -1)))
      .map((a) => this.wire(a, true));
  }

  get pendingCount() {
    let n = 0;
    for (const a of this.arts.values()) if (!a.approved) n++;
    return n;
  }

  /* ────────────────────────────────────────────────────────────── 보관 */

  /** 목록만 (그림 제외) — 자주 쓰는 쪽 */
  metaWire() {
    return [...this.arts.values()].map((a) => ({
      id: a.id, owner: a.owner, title: a.title, pin: a.pin,
      x: a.x, y: a.y, z: a.z, yaw: a.yaw, approved: a.approved, at: a.at,
    }));
  }

  async saveMeta() {
    if (!this.store) return;
    try {
      await this.store.set('venie:arts', JSON.stringify(this.metaWire()));
    } catch (e) {
      console.log('갤러리 목록을 저장하지 못했습니다:', e.message);
    }
  }

  async _saveImage(id, img) {
    if (!this.store) return;
    try {
      await this.store.set(`venie:art:${id}`, img);
    } catch (e) {
      console.log('그림을 저장하지 못했습니다:', e.message);
    }
  }

  async _delImage(id) {
    if (!this.store) return;
    try {
      await this.store.del(`venie:art:${id}`);
    } catch (e) { /* 지우기는 실패해도 게임에 영향이 없습니다 */ }
  }

  /**
   * 서버가 깨어날 때 되살립니다.
   *
   * ★ 그림을 못 읽은 작품은 **버립니다.** 이름표만 떠 있고 캔버스가 빈
   *   유령이 되느니 없는 편이 낫습니다.
   */
  async load() {
    if (!this.store) return;
    let meta = null;
    try {
      const raw = await this.store.get('venie:arts');
      meta = raw ? JSON.parse(raw) : null;
    } catch (e) {
      console.log('갤러리 목록을 불러오지 못했습니다:', e.message);
      return;
    }
    if (!Array.isArray(meta)) return;

    let lost = 0;
    for (const a of meta) {
      if (!a || typeof a.id !== 'string') continue;
      let img = null;
      try {
        img = await this.store.get(`venie:art:${a.id}`);
      } catch (e) { img = null; }
      if (!isImage(img)) { lost++; continue; }
      this.arts.set(a.id, {
        id: a.id,
        owner: String(a.owner || ''),
        title: sanitizeTitle(a.title),
        pin: String(a.pin || ''),
        x: Number(a.x) || 0, y: Number(a.y) || 0, z: Number(a.z) || 0,
        yaw: Number(a.yaw) || 0,
        approved: !!a.approved,
        at: Number(a.at) || now(),
      });
      this.images.set(a.id, img);
    }
    console.log(`갤러리를 불러왔습니다 — ${this.arts.size}점`
      + `(승인 대기 ${this.pendingCount}점)${lost ? ` · 그림을 잃은 ${lost}점은 버렸습니다` : ''}`);
  }
}
