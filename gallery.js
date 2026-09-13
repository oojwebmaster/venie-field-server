import crypto from 'node:crypto';

/**
 * VENIE FIELD — 작품 갤러리 (server/gallery.js)
 * ============================================================================
 *
 * 4단계입니다. 사람들이 그려서 세운 작품을 **서버에 남기고**, 관리자가
 * 승인한 것만 모두에게 보여 줍니다.
 *
 * ## ★★ 왜 따로 떼어 두었는가
 * 방(`room.js`)은 **지금 접속한 사람들의 상태**를 들고 있습니다 — 접속이
 * 끊기면 사라지는 것들이죠. 작품은 반대입니다. 아무도 없어도 들판에 서
 * 있어야 합니다. 둘을 한 파일에 섞으면 "누가 나갔을 때 무엇을 지울지"가
 * 매번 헷갈립니다. `server.js`는 여기에 **다섯 군데**서만 말을 겁니다.
 *
 * ## ★★ 그림은 WebSocket으로 내려보내지 않습니다
 * 512² webp 한 장이 40~150KB입니다. 여덟 장이면 1MB이고, **접속할 때마다**
 * 다시 받게 됩니다. 대신 `GET /art/<id>.webp`로 내주고 캐시 머리글을
 * 붙입니다 — 브라우저가 한 번만 받습니다. 소켓으로는 **어디에 무엇이
 * 있는지**(좌표·이름·승인 여부)만 오갑니다. 그건 한 장에 200바이트쯤입니다.
 *
 * ## ★★ PIN은 그대로 저장하지 않습니다
 * 회수할 때 쓰는 네 자리입니다. 그대로 두면 Upstash 콘솔을 보는 사람이
 * 남의 작품을 전부 거둘 수 있습니다. 해시(`sha256(salt + id + pin)`)만
 * 둡니다 — `id`를 섞는 이유는, 같은 PIN을 쓴 작품들이 **같은 해시**로
 * 나오면 하나만 풀려도 나머지가 함께 풀리기 때문입니다.
 *
 * ★ 네 자리는 만 가지뿐이라 계속 넣어 보면 언젠가 맞습니다. 그래서 작품마다
 *   시도 횟수를 세고, 너무 자주 틀리면 잠시 쉬게 합니다.
 *
 * ## Upstash에 쌓이는 모양
 * ```
 * vf:art:ids            SET      살아 있는 작품 id 전부
 * vf:art:<id>           STRING   메타 JSON (주인·이름·좌표·승인·핀해시)
 * vf:art:img:<id>       STRING   webp를 base64로
 * ```
 * 순위표와 **같은 DB**를 씁니다. 키 앞머리만 다릅니다.
 */

const PREFIX = 'vf:art';
const K_IDS = `${PREFIX}:ids`;
const kMeta = (id) => `${PREFIX}:${id}`;
const kImg = (id) => `${PREFIX}:img:${id}`;

/** 작품 하나의 최대 바이트 (base64 기준). Upstash 무료는 요청당 1MB입니다 */
const IMG_MAX = Number(process.env.ART_IMG_MAX || 360 * 1024);

export class Gallery {
  /**
   * @param {object} opt
   * @param {string} opt.storeUrl   Upstash REST 주소 (순위표와 같은 것)
   * @param {string} opt.storeToken
   * @param {string} opt.salt       ART_PIN_SALT
   * @param {number} opt.max        ART_MAX
   * @param {number} opt.titleMax
   * @param {(name:string)=>boolean} opt.isBad 비속어 판정 (badwords.js)
   */
  constructor(opt = {}) {
    this.url = (opt.storeUrl || '').replace(/\/$/, '');
    this.token = opt.storeToken || '';
    this.salt = opt.salt || '';
    this.max = opt.max || 300;
    this.titleMax = opt.titleMax || 10;
    this.isBad = opt.isBad || (() => false);
    /** id → 메타 (그림은 여기 두지 않습니다 — 메모리가 감당 못 합니다) */
    this.items = new Map();
    /** id → { n, until } 틀린 횟수 */
    this._tries = new Map();
    this.ready = false;
  }

  get on() { return !!(this.url && this.token); }

  /** ★ 소금이 없으면 **PIN을 저장하지 않습니다** — 평문으로 둘 바에는 */
  get sane() { return this.on && !!this.salt; }

  /* ───────────────────────────────────────────────────────── Upstash */

  async _cmd(...parts) {
    const path = parts.map((p) => encodeURIComponent(String(p))).join('/');
    const res = await fetch(`${this.url}/${path}`, {
      headers: { Authorization: `Bearer ${this.token}` },
    });
    if (!res.ok) throw new Error(`upstash ${res.status}`);
    return (await res.json())?.result;
  }

  /** ★ 값이 길면 주소에 못 싣습니다 — 본문으로 보냅니다 */
  async _set(key, value) {
    const res = await fetch(`${this.url}/set/${encodeURIComponent(key)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.token}` },
      body: value,
    });
    if (!res.ok) throw new Error(`upstash set ${res.status}`);
  }

  /**
   * 서버가 깨어날 때 한 번.
   *
   * ★★ **그림은 안 불러옵니다.** 메타만 들고 있다가, 브라우저가
   *   `/art/<id>.webp`를 물어볼 때 그때 한 장씩 꺼냅니다. 300장을 메모리에
   *   들고 있으면 Render 무료 플랜(512MB)이 그것만으로 찹니다.
   */
  async load() {
    if (!this.on) {
      console.log('작품 갤러리: 저장소가 없어 꺼져 있습니다 (SCORE_STORE_URL/TOKEN 확인)');
      return;
    }
    if (!this.salt) {
      console.log('작품 갤러리: ★ ART_PIN_SALT가 없습니다 —'
        + ' PIN을 안전하게 보관할 수 없어 등록을 받지 않습니다');
      return;
    }
    try {
      const ids = (await this._cmd('smembers', K_IDS)) || [];
      for (const id of ids) {
        const raw = await this._cmd('get', kMeta(id));
        if (!raw) { await this._cmd('srem', K_IDS, id); continue; }
        try { this.items.set(id, JSON.parse(raw)); } catch (e) { /* 깨진 줄은 버립니다 */ }
      }
      this.ready = true;
      const waiting = [...this.items.values()].filter((a) => !a.approved).length;
      console.log(`작품 갤러리: ${this.items.size}점 (승인 대기 ${waiting}점)`);
    } catch (e) {
      console.log('작품 갤러리를 불러오지 못했습니다:', e.message);
    }
  }

  /* ─────────────────────────────────────────────────────────── 자물쇠 */

  _hash(id, pin) {
    return crypto.createHash('sha256')
      .update(`${this.salt}:${id}:${pin}`)
      .digest('hex')
      .slice(0, 32);
  }

  /**
   * PIN이 맞는가.
   *
   * ★★ **틀린 횟수를 셉니다.** 네 자리는 만 가지뿐이라 계속 넣으면 언젠가
   *   맞습니다. 다섯 번 틀리면 30초 쉬게 합니다 — 사람이 잘못 친 것에는
   *   거의 걸리지 않고, 기계로 훑는 것은 만 번에 여든 시간이 걸립니다.
   * ★ 비교는 `timingSafeEqual`입니다. 문자열 `===`는 앞에서부터 다른 자리를
   *   만나면 곧바로 끝나서, 걸린 시간으로 몇 글자가 맞았는지 새어 나갑니다.
   */
  checkPin(id, pin) {
    const a = this.items.get(id);
    if (!a) return { ok: false, why: 'gone' };
    const t = this._tries.get(id);
    const now = Date.now();
    if (t && t.until > now) return { ok: false, why: 'slow', wait: Math.ceil((t.until - now) / 1000) };

    const want = Buffer.from(a.pinHash || '', 'hex');
    const got = Buffer.from(this._hash(id, String(pin || '')), 'hex');
    const same = want.length === got.length && crypto.timingSafeEqual(want, got);
    if (same) { this._tries.delete(id); return { ok: true }; }

    const n = (t?.n || 0) + 1;
    this._tries.set(id, { n, until: n >= 5 ? now + 30000 : 0 });
    return { ok: false, why: 'pin' };
  }

  /* ─────────────────────────────────────────────────────────── 등록 */

  /**
   * 새 작품을 받습니다.
   * @returns {{ok:true,art:object}|{ok:false,why:string}}
   */
  async add({ owner, title, pin, img, x, y, z, rotY }) {
    if (!this.sane) return { ok: false, why: 'off' };
    if (this.items.size >= this.max) return { ok: false, why: 'full' };

    const name = String(title || '').replace(/\s+/g, ' ').trim();
    if (!name) return { ok: false, why: 'title' };
    if ([...name].length > this.titleMax) return { ok: false, why: 'title' };
    /* ★★ 비속어는 **여기서도** 봅니다. 화면에서 이미 막고 있지만, 소켓은
     *   누구나 직접 두드릴 수 있습니다 — 화면의 검사는 친절이고, 여기가
     *   실제 문입니다. 닉네임과 똑같은 구조입니다. */
    if (this.isBad(name)) return { ok: false, why: 'bad' };
    if (!/^[0-9]{4}$/.test(String(pin || ''))) return { ok: false, why: 'pin' };

    const b64 = String(img || '');
    if (!b64) return { ok: false, why: 'img' };
    if (b64.length > IMG_MAX) return { ok: false, why: 'big' };
    /* ★ webp만 받습니다. 머리 4바이트가 'RIFF'이고 8~12가 'WEBP'입니다.
     *   확장자를 믿으면 png를 webp라고 우겨도 그대로 들어옵니다. */
    const head = Buffer.from(b64.slice(0, 24), 'base64');
    if (head.length < 12 || head.toString('ascii', 0, 4) !== 'RIFF'
      || head.toString('ascii', 8, 12) !== 'WEBP') {
      return { ok: false, why: 'format' };
    }

    const id = crypto.randomBytes(9).toString('base64url');
    const art = {
      id,
      owner: String(owner || '').slice(0, 24),
      title: name,
      pinHash: this._hash(id, String(pin)),
      x: +(+x).toFixed(3),
      y: +(+y).toFixed(3),
      z: +(+z).toFixed(3),
      rotY: +(+rotY).toFixed(4),
      approved: false,
      at: Date.now(),
    };
    if (![art.x, art.y, art.z, art.rotY].every(Number.isFinite)) return { ok: false, why: 'place' };

    await this._set(kImg(id), b64);
    await this._set(kMeta(id), JSON.stringify(art));
    await this._cmd('sadd', K_IDS, id);
    this.items.set(id, art);
    return { ok: true, art };
  }

  /** 그림 꺼내기 (`/art/<id>.webp`가 부릅니다) */
  async image(id) {
    if (!this.on || !this.items.has(id)) return null;
    const b64 = await this._cmd('get', kImg(id));
    return b64 ? Buffer.from(b64, 'base64') : null;
  }

  /** 거두기·삭제 — 흔적을 통째로 지웁니다 */
  async remove(id) {
    if (!this.items.has(id)) return false;
    this.items.delete(id);
    this._tries.delete(id);
    try {
      await this._cmd('del', kMeta(id));
      await this._cmd('del', kImg(id));
      await this._cmd('srem', K_IDS, id);
    } catch (e) {
      console.log('작품을 지우지 못했습니다:', e.message);
    }
    return true;
  }

  /** 승인/거절 */
  async setApproved(id, yes) {
    const a = this.items.get(id);
    if (!a) return false;
    a.approved = !!yes;
    try { await this._set(kMeta(id), JSON.stringify(a)); } catch (e) { /* 다음에 다시 */ }
    return true;
  }

  /* ─────────────────────────────────────────────────────── 내보내기 */

  /**
   * 소켓으로 보낼 한 점.
   * ★★ `pinHash`는 **절대 나가지 않습니다.** 메타를 통째로 보내면 그것도
   *   함께 나가고, 그러면 해시로 만들어 둔 뜻이 없어집니다.
   */
  wire(a) {
    return {
      id: a.id, o: a.owner, t: a.title,
      x: a.x, y: a.y, z: a.z, r: a.rotY,
      ok: a.approved ? 1 : 0,
    };
  }

  /**
   * 접속한 사람에게 보낼 목록.
   *
   * ★★ **승인된 것 + 내 것**입니다. 승인 대기 중인 남의 작품은 안 보내야
   *   합니다 — 승인제의 뜻이 그것이고, 부적절한 그림이 승인 전에 이미
   *   모두에게 보였다면 승인은 아무것도 막지 못한 셈입니다.
   */
  listFor(name) {
    const out = [];
    for (const a of this.items.values()) {
      if (a.approved || (name && a.owner === name)) out.push(this.wire(a));
    }
    return out;
  }

  /** 관리자 화면용 — 대기와 승인을 나눠 줍니다 */
  adminList() {
    const all = [...this.items.values()].sort((p, q) => q.at - p.at);
    return {
      waiting: all.filter((a) => !a.approved).map((a) => this.wire(a)),
      done: all.filter((a) => a.approved).map((a) => this.wire(a)),
      max: this.max,
    };
  }
}
