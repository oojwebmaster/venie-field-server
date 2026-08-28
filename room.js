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
import { ITEMS } from './items.js';

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
  /* ★★ `src/shell.js`의 KIND_* 상수와 **같은 숫자**여야 합니다.
   *   전선에는 `k` 한 글자로만 실려 가므로, 어긋나면 진주조개가 일반 조개로
   *   보이면서 점수만 5점 들어오는(원인을 못 찾을) 상태가 됩니다.
   *   0(물감)은 `k`를 아예 안 보내는 것과 같습니다. */
  static KIND = { PAINT: 0, SHELL: 1, PEARL: 2 };

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
      /* ── 아이템 ──────────────────────────────────────────────────────────
       * ★★ 숫자를 **여기에 적지 않습니다.** `items.js` 한 파일이 진실이고
       *   게임(`src/items.js`)과 서버(`server/items.js`)가 같은 사본을
       *   나눠 갖습니다. 여기에 기본값을 또 적으면 그게 세 번째 사본이 되고,
       *   셋 중 하나만 고쳐졌을 때 **아무 오류 없이** 어긋납니다. */
      itemCount: ITEMS.paint.count,
      itemRespawn: ITEMS.paint.respawn * 1000,
      itemColors: 7,        // 색 가짓수 (palette.js의 PAINTS 길이)
      /* 아이템 하나의 점수. ★ **서버가 점수를 줍니다.**
       * 클라이언트가 "나 1점 올랐어"를 보내면 그건 그냥 점수 입력창입니다.
       * 이미 획득을 한 번만 승인하고 있으므로 그 자리에서 함께 올립니다.
       * 나중에 아이템마다 값이 달라지면 아이템 레코드의 `score`를 채우면 됩니다. */
      itemScore: ITEMS.paint.score,
      boardKeep: 24,        // 순위표에 남겨 두는 인원 (보여 주는 건 상위 5명)
      spawnCount: 0,        // 스폰 후보 자리 수 (server.js가 spawns.js에서 넣어 줍니다)
      claimRange: ITEMS.paint.claimRange,   // 이보다 멀리서 주웠다고 하면 거절(m)
      keepColorOnRespawn: ITEMS.paint.keepColorOnRespawn,
      spawnAt: null,        // (i) => { x, z } — 거리 검사에만 씁니다

      /* ── 조개 아이템 (src/config.js의 world.shell과 같은 값이어야 합니다) ──
       * ★ 물감과 **표가 다릅니다.** 물감은 해수면 +1.5m 위(모래사장이 통째로
       *   빠져 있음), 조개는 파도 언저리입니다. 그래서 자리 번호를 나눠 쓸 수
       *   없고, 스폰 표와 개수·리스폰 시간을 따로 가집니다. */
      shellCount: ITEMS.shell.count,
      shellRespawn: ITEMS.shell.respawn * 1000,
      shellScore: ITEMS.shell.score,
      pearlScore: ITEMS.shell.pearlScore,
      pearlChance: ITEMS.shell.pearlChance,
      pearlMax: ITEMS.shell.pearlMax,
      shellSpawnCount: 0,     // 조개 스폰 후보 자리 수 (server.js가 shells.js에서)
      shellSpawnAt: null,     // (i) => { x, z }
      ...opt,
    };
    this.players = new Map();
    this._nextId = 1;
    /* ★ 물감은 **서버가 진실을 갖습니다.**
     * 클라이언트가 "내가 먹었다"고 말하는 것을 각자 믿으면 두 사람이 같은
     * 물감을 먹고 둘 다 색이 바뀝니다. 여기서 딱 한 번만 승인합니다. */
    this.items = [];
    this._nextItemId = 1;
    /** 먹힌 뒤 돌아올 예약 [{ at, kind, color }] */
    this._respawnQueue = [];

    /* ── NPC 자리 ─────────────────────────────────────────────────────────
     * npcId → 지금 말 걸고 있는 사람의 id.
     *
     * ★★ 서버가 아는 것은 **이것뿐**입니다. 대사 내용도, 지금 몇 번째 줄인지도
     *   모릅니다 — 알아야 할 이유가 없기 때문입니다. 대사는 각자의 브라우저
     *   안에서만 흐르고, 그래서 "내 말풍선이 남에게 보이면 안 된다"가
     *   조심해서 지키는 규칙이 아니라 **애초에 불가능한 일**이 됩니다. */
    this.npcBusy = new Map();

    /* ── 순위표 ──
     * ★ 게임에 저장 기능이 없으므로 **한 판(서버가 깨어 있는 동안)** 의
     *   기록입니다. 사람이 나가도 이름과 점수는 남고, 무료 플랜 서버가
     *   잠들면 함께 사라집니다.
     * @type {{name:string, score:number, at:number}[]} 점수 내림차순 */
    this.board = [];

    /* ── 모두에게 나눠 주는 설정 ──
     * ★ 화면 효과처럼 **접속한 모두가 같아야 하는 값**을 여기 둡니다.
     *   개발자모드에서 끄면 그 순간 모든 사람에게서 꺼집니다.
     *   각자의 config를 고치는 방식이면 파일을 다시 올려야 하고, 그때까지
     *   사람마다 화면이 다릅니다.
     * ★ 서버 메모리라 재시작하면 기본값으로 돌아갑니다 — 그래도 되는 값만
     *   여기 둡니다(점수처럼 잃으면 안 되는 것은 순위표 쪽 저장소로). */
    this.settings = { blur: null };
  }

  get size() { return this.players.size; }

  /** @returns {{ok:true,player:object}|{ok:false,reason:string}} */
  /**
   * @param {object} opt
   *   sid   ★ **브라우저 탭 하나를 가리키는 표식.** 아래 `findBySid` 참고
   *   score 이어받을 점수 (같은 sid의 앞 접속에서 가져옵니다)
   */
  join(name, now = Date.now(), opt = {}) {
    if (this.players.size >= this.opt.maxPlayers) {
      return { ok: false, reason: 'full' };
    }
    const clean = sanitizeName(name, this.opt.nameMax);
    if (!clean) return { ok: false, reason: 'name' };

    const id = this._nextId++;
    const player = {
      id,
      /* 화면에 뜨는 이름. 같은 이름이 **지금 동시에** 접속해 있으면 뒤에 숫자를
       * 붙입니다 — 머리 위 이름표가 구분돼야 하기 때문입니다. */
      name: this._uniqueName(clean),
      /* ★ 순위표는 이쪽(숫자가 안 붙은 원래 이름)으로 기록합니다.
       * 표시 이름으로 기록하면, 껐다 켜는 사이 옛 접속이 아직 안 정리돼
       * 'Don 2'로 들어간 순간 순위표에 **없던 사람이 새로 생깁니다.**
       * 실제로 Don(15점) 옆에 Don 2(5점)가 따로 뜬 적이 있습니다. */
      baseName: clean,
      x: 0, y: 0, z: 0,
      yaw: Math.PI,
      // 애니메이션 상태 — 원격 캐릭터가 이 값으로 걷기/헤엄치기를 섞습니다
      mv: 0,      // 이동 블렌드 0~1
      sw: 0,      // 수영 블렌드 0~1
      air: 0,     // 공중(점프) 0/1
      /* ★ 같은 탭이 다시 붙은 것이면(sid가 같으면) 점수를 이어받습니다.
       * 앱을 잠깐 내렸다 올렸을 뿐인데 점수가 0이 되면 '끊겼다'가 아니라
       * '내 기록이 날아갔다'로 느껴집니다. */
      score: opt.score || 0,
      /* 이 탭의 표식. 재접속인지 아닌지를 가리는 유일한 단서입니다 */
      sid: opt.sid || null,
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

  /**
   * @returns {{gone:boolean, freedNpc:string[]}} 풀린 NPC 자리도 함께 —
   *   ★ 대화 도중 창을 닫으면 그 NPC가 영영 '대화중'으로 잠깁니다.
   */
  /**
   * 같은 탭의 **앞 접속**을 찾습니다.
   *
   * ★★ 앱을 백그라운드로 내렸다 돌아오면 소켓이 죽습니다. 그런데 서버는
   *   `staleAfter`(30초)가 지나야 그 사람을 지웁니다. 그 사이에 다시 붙으면
   *   서버 눈에는 **같은 이름의 두 사람**이라, 새로 온 쪽에 'donsign 2'라는
   *   이름이 붙고 옛 몸뚱이가 유령처럼 옆에 서 있게 됩니다.
   *   (실제로 그 증상을 보고 이 함수를 만들었습니다)
   *
   *   이름으로 판별하면 안 됩니다 — 진짜로 같은 이름을 쓰는 다른 사람을
   *   쫓아내게 됩니다. 브라우저 탭마다 한 번 뽑은 임의의 표식(sid)이라야
   *   "아까 그 사람이 맞다"를 확신할 수 있습니다.
   */
  findBySid(sid) {
    if (!sid) return null;
    for (const p of this.players.values()) if (p.sid === sid) return p;
    return null;
  }

  leave(id) {
    const freedNpc = this.releaseAllNpc(id);
    return { gone: this.players.delete(id), freedNpc };
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

  /**
   * 모두에게 나눠 주는 설정 바꾸기 (관리자 전용 — server.js가 열쇠를 봅니다).
   * @returns {boolean} 아는 이름이었는가
   */
  setSetting(key, value) {
    if (!(key in this.settings)) return false;
    // null이면 '서버는 관여하지 않음' — 각자의 config 기본값을 씁니다
    this.settings[key] = value === null ? null : !!value;
    return true;
  }

  /** 전선에 실을 형태 — 서버가 정한 것만 (null인 것은 빼고) */
  settingsWire() {
    const out = {};
    for (const [k, v] of Object.entries(this.settings)) if (v !== null) out[k] = v;
    return out;
  }

  /* =============================================================== 순위표 */

  /**
   * 점수를 올리고 순위표에 반영합니다.
   * @returns {number} 그 사람의 새 누적 점수
   */
  addScore(id, points) {
    const p = this.players.get(id);
    if (!p || !Number.isFinite(points)) return 0;
    p.score += points;
    // 표시 이름(‘Don 2’)이 아니라 **원래 이름**으로 기록합니다
    this._record(p.baseName || p.name, p.score);
    return p.score;
  }

  /**
   * 이름 하나당 한 줄. **그 이름의 최고 기록**만 남습니다.
   *
   * ★ 껐다 다시 들어와도 새 줄이 생기지 않고, 예전 기록을 **넘겼을 때만**
   *   숫자가 갱신됩니다. 같은 이름을 다른 사람이 써도 마찬가지라,
   *   순위표는 언제나 '그 이름으로 낸 최고 점수'를 뜻합니다.
   */
  _record(name, score) {
    const found = this.board.find((e) => e.name === name);
    if (found) {
      if (score <= found.score) return;
      found.score = score;
      found.at = Date.now();
    } else {
      this.board.push({ name, score, at: Date.now() });
    }
    // 동점이면 먼저 도달한 사람이 위
    this.board.sort((a, b) => b.score - a.score || a.at - b.at);
    if (this.board.length > this.opt.boardKeep) this.board.length = this.opt.boardKeep;
  }

  /** 상위 n명 — 전선에는 이름(n)과 점수(s)만 */
  topScores(n = 5) {
    return this.board.slice(0, n).map((e) => ({ n: e.name, s: e.score }));
  }

  /**
   * 관리자가 기록 한 줄을 지웁니다.
   *
   * 걸러지지 않은 비속어 닉네임뿐 아니라 **시험 삼아 남긴 기록**을 치우는
   * 데에도 씁니다. 그래서 이름을 막지는 않습니다 — 막아 버리면 그 이름을
   * 두 번 다시 못 쓰게 되고, 나중에 진짜 그 이름으로 놀고 싶어도 순위표에
   * 안 올라갑니다. 지운 뒤 그 사람이 계속 놀고 있으면 다시 올라오는데,
   * 그때 또 지우면 됩니다.
   */
  removeScore(name) {
    const before = this.board.length;
    this.board = this.board.filter((e) => e.name !== name);
    return this.board.length !== before;
  }

  /* ==================================================== 아이템 (물감·조개) */

  /**
   * 지금 떠 있어야 할 개수만큼 채우고, 예약된 것을 돌려놓습니다.
   * `server.js`의 틱 루프가 부릅니다.
   * @returns {{added: object[]}} 새로 생긴 아이템 (그대로 방송하면 됩니다)
   */
  tickItems(now = Date.now()) {
    const O = this.opt;
    const added = [];

    // ① 시간이 된 예약부터 (종류별로 자기 규칙에 따라 다시 태어납니다)
    for (let i = this._respawnQueue.length - 1; i >= 0; i--) {
      if (this._respawnQueue[i].at > now) continue;
      const job = this._respawnQueue.splice(i, 1)[0];
      const it = job.kind === Room.KIND.PAINT
        ? this._spawnPaint(O.keepColorOnRespawn ? job.color : null)
        /* ★ 조개는 **종류를 다시 뽑습니다.** 진주조개를 먹었다고 진주조개가
         *   돌아오면 '드물다'가 무의미해집니다. 반대로 일반 조개를 먹은
         *   자리에서 진주가 날 수도 있어야 합니다. */
        : this._spawnShell();
      if (it) added.push(it);
    }

    // ② 그래도 모자라면 채웁니다 (서버가 막 켜졌을 때)
    if (O.spawnCount) {
      while (this._countOf(Room.KIND.PAINT) < O.itemCount) {
        const it = this._spawnPaint(null);
        if (!it) break;
        added.push(it);
      }
    }
    if (O.shellSpawnCount) {
      while (this._countOf(Room.KIND.SHELL) < O.shellCount) {
        const it = this._spawnShell();
        if (!it) break;
        added.push(it);
      }
    }
    return { added };
  }

  /**
   * 이 종류가 지금 몇 개인가 (되살아나기를 기다리는 것까지).
   * ★ 예약분을 빼먹으면 채우기 루프가 매 틱마다 새로 만들어, 2분 뒤에
   *   조개가 열두 개가 됩니다.
   * @param {number} kind Room.KIND.PAINT면 물감, 아니면 조개(진주 포함)
   */
  _countOf(kind) {
    const isPaint = kind === Room.KIND.PAINT;
    const match = (k) => (isPaint ? k === Room.KIND.PAINT : k !== Room.KIND.PAINT);
    let n = 0;
    for (const it of this.items) if (match(it.kind)) n++;
    for (const q of this._respawnQueue) if (match(q.kind)) n++;
    return n;
  }

  /** 그 종류가 이미 쓰고 있는 자리 (겹쳐 뜨면 하나만 보입니다) */
  _usedSpawns(isPaint) {
    const used = new Set();
    for (const it of this.items) {
      if ((it.kind === Room.KIND.PAINT) === isPaint) used.add(it.spawn);
    }
    return used;
  }

  _spawnPaint(color) {
    const O = this.opt;
    if (!O.spawnCount) return null;
    const used = this._usedSpawns(true);
    let spawn = -1;
    for (let k = 0; k < 32; k++) {
      const c = Math.floor(Math.random() * O.spawnCount);
      if (!used.has(c)) { spawn = c; break; }
    }
    if (spawn < 0) return null;
    const it = {
      id: this._nextItemId++,
      kind: Room.KIND.PAINT,
      spawn,
      color: color === null ? this._scarcestColor() : color,
      // 아이템이 자기 점수를 들고 있습니다 — 종류가 늘어도 화면은 그대로입니다
      score: O.itemScore,
      born: Date.now(),
    };
    this.items.push(it);
    return it;
  }

  /**
   * 조개 하나. 진주조개인지 여기서 정합니다.
   *
   * ★ **확률과 상한을 함께** 봅니다. 확률만 두면 운 나쁜 날 해변에 진주가
   *   셋 널리고, 상한만 두면 하나를 먹자마자 다음 것이 곧바로 나옵니다.
   *   `pearlChance`(10%)로 뽑되 `pearlMax`(1)를 넘지 않게 합니다.
   */
  _spawnShell() {
    const O = this.opt;
    if (!O.shellSpawnCount) return null;
    const used = this._usedSpawns(false);
    let spawn = -1;
    for (let k = 0; k < 32; k++) {
      const c = Math.floor(Math.random() * O.shellSpawnCount);
      if (!used.has(c)) { spawn = c; break; }
    }
    if (spawn < 0) return null;

    let pearls = 0;
    for (const it of this.items) if (it.kind === Room.KIND.PEARL) pearls++;
    const kind = pearls < O.pearlMax && Math.random() < O.pearlChance
      ? Room.KIND.PEARL : Room.KIND.SHELL;

    const it = {
      id: this._nextItemId++,
      kind,
      spawn,
      color: 0,
      score: kind === Room.KIND.PEARL ? O.pearlScore : O.shellScore,
      born: Date.now(),
    };
    this.items.push(it);
    return it;
  }

  /**
   * 지금 가장 적은 색을 고릅니다 (물감 전용).
   * ★ 그냥 무작위로 뽑으면 일곱 색 중 두세 색이 통째로 빠진 채 한참 갑니다
   *   (14개를 7색에서 균등하게 뽑으면 한 색도 안 나올 확률이 색마다 11%,
   *   적어도 한 색이 빠질 확률은 절반이 넘습니다). 산책하다 만나는 물감이
   *   빨강뿐이면 '섞는 재미'가 통째로 사라집니다.
   */
  _scarcestColor() {
    const n = this.opt.itemColors;
    const tally = new Array(n).fill(0);
    for (const i of this.items) if (i.kind === Room.KIND.PAINT) tally[i.color % n]++;
    for (const q of this._respawnQueue) {
      if (q.kind === Room.KIND.PAINT && q.color !== null) tally[q.color % n]++;
    }
    const min = Math.min(...tally);
    const pool = [];
    for (let i = 0; i < n; i++) if (tally[i] === min) pool.push(i);
    return pool[Math.floor(Math.random() * pool.length)];
  }

  /**
   * 누군가 아이템을 주웠다고 알려 왔습니다.
   *
   * ★ **먼저 온 사람이 가져갑니다.** 두 사람이 같은 순간에 손을 뻗어도
   *   여기서 한 번만 통과하므로, 나머지 한 명에게는 그냥 사라진 것으로 보입니다.
   * ★ 위치는 각자의 브라우저가 판정합니다(왕복 200ms를 기다리면 손맛이 죽습니다).
   *   그래서 서버는 "말이 되는 거리인가"만 봅니다 — 지도 반대편에서 주웠다고
   *   말하는 것은 막습니다. **자리 표가 종류마다 다르므로 표도 함께 골라야
   *   합니다** — 잘못 고르면 눈앞의 조개를 주웠는데 '너무 멀다'고 거절당합니다.
   *
   * @returns {{ok:true,item:object}|{ok:false,reason:string}}
   */
  takeItem(playerId, itemId, now = Date.now()) {
    const p = this.players.get(playerId);
    if (!p) return { ok: false, reason: 'noplayer' };
    const idx = this.items.findIndex((i) => i.id === itemId);
    if (idx < 0) return { ok: false, reason: 'gone' };
    const it = this.items[idx];
    const isPaint = it.kind === Room.KIND.PAINT;

    const at = isPaint
      ? (this.opt.spawnAt ? this.opt.spawnAt(it.spawn) : null)
      : (this.opt.shellSpawnAt ? this.opt.shellSpawnAt(it.spawn) : null);
    if (at) {
      const d = Math.hypot(p.x - at.x, p.z - at.z);
      if (d > this.opt.claimRange) return { ok: false, reason: 'far' };
    }

    this.items.splice(idx, 1);
    this._respawnQueue.push({
      at: now + (isPaint ? this.opt.itemRespawn : this.opt.shellRespawn),
      kind: isPaint ? Room.KIND.PAINT : Room.KIND.SHELL,
      color: isPaint ? it.color : null,
    });
    return { ok: true, item: it };
  }

  /* ======================================================== NPC 대화 자리 */

  /**
   * 이 NPC에게 말을 걸겠다고 자리를 맡습니다.
   * ★ 먼저 온 사람이 가져갑니다 — 두 사람이 같은 순간에 눌러도 여기서
   *   한 번만 통과하므로, 나머지 한 명은 '이미 대화중'을 봅니다.
   * @returns {{ok:true}|{ok:false, by:number}}
   */
  claimNpc(playerId, npcId) {
    if (!this.players.has(playerId)) return { ok: false, by: 0 };
    const cur = this.npcBusy.get(npcId);
    /* 같은 사람이 다시 요청하면 그냥 통과시킵니다. 메시지가 두 번 오는
     * 것(재전송·중복 클릭)만으로 자기 자리를 자기가 빼앗기면 안 됩니다. */
    if (cur && cur !== playerId) return { ok: false, by: cur };
    this.npcBusy.set(npcId, playerId);
    return { ok: true };
  }

  /** 대화를 끝냈습니다. ★ 남의 자리는 못 놓습니다 */
  releaseNpc(playerId, npcId) {
    if (this.npcBusy.get(npcId) !== playerId) return false;
    this.npcBusy.delete(npcId);
    return true;
  }

  /**
   * 그 사람이 잡고 있던 자리를 전부 놓습니다.
   * ★★ **나갈 때 반드시 불러야 합니다.** 대화 도중 창을 닫으면 그 NPC는
   *   영영 '대화중'으로 잠겨, 아무도 말을 걸 수 없게 됩니다.
   * @returns {string[]} 풀린 NPC id들 (그대로 방송하면 됩니다)
   */
  releaseAllNpc(playerId) {
    const freed = [];
    for (const [npcId, who] of this.npcBusy) {
      if (who === playerId) { this.npcBusy.delete(npcId); freed.push(npcId); }
    }
    return freed;
  }

  /** 접속할 때 한 번 받는 '지금 대화중인 NPC' 명단 */
  npcBusyList() {
    return [...this.npcBusy].map(([n, by]) => ({ n, by }));
  }

  /** 접속할 때 한 번 받는 아이템 명단 */
  itemList() {
    return this.items.map(Room.itemWire);
  }

  /**
   * 전선에 싣는 형태 — i(아이디) · s(자리 번호) · v(점수)
   * · c(색 번호, 물감만) · k(종류, 물감이 아닐 때만)
   *
   * ★ 물감이 대부분이므로 물감을 기본값(k 없음)으로 둡니다. 종류 하나 때문에
   *   가장 흔한 메시지가 커지면 안 됩니다.
   */
  static itemWire(it) {
    const w = { i: it.id, s: it.spawn, v: it.score };
    if (it.kind === Room.KIND.PAINT || !it.kind) w.c = it.color;
    else w.k = it.kind;
    return w;
  }

  /**
   * '내가 먹었다'는 승인 응답. 화면은 이걸 받고서야 연출을 시작합니다.
   *
   * ★★ **반드시 `itemWire`를 거쳐 만듭니다.** 예전에는 여기서 필드를 손으로
   *   적었는데(`{ i, c, v, sc }`) 종류(`k`)를 빠뜨렸습니다. 그러면
   *   조개를 먹어도 화면은 `k = 0`(물감)으로 읽고, 조개의 `color`가 0이라
   *   **'빨강 물감을 먹었습니다'가 뜨면서 몸이 빨개집니다.**
   *   점수는 `v`로 제대로 오기 때문에 "점수는 맞는데 색만 이상한" 상태가 되어
   *   원인을 짚기 어렵습니다. 실제로 그렇게 나왔습니다.
   *
   *   목록(`add`·`itemList`)과 승인(`took`)이 **같은 함수에서** 나오면
   *   한쪽에만 필드를 더하는 실수 자체가 불가능해집니다.
   */
  static tookWire(it, total) {
    return { t: 'item', a: 'took', ...Room.itemWire(it), sc: total };
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
    const freedNpc = [];
    for (const [id, p] of this.players) {
      if (now - p.seen > this.opt.staleAfter) {
        this.players.delete(id);
        gone.push(id);
        // ★ 소켓이 조용히 죽은 경우에도 NPC를 풀어 줘야 합니다
        freedNpc.push(...this.releaseAllNpc(id));
      }
    }
    gone.freedNpc = freedNpc;   // 예전 호출부(배열로 쓰는 곳)를 깨지 않습니다
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
