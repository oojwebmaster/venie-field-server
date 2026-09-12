import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, sanitizeName } from './room.js';
import { isBadName } from './badwords.js';
import { SPAWN_COUNT, spawnAt } from './spawns.js';
import { SHELL_SPAWN_COUNT, shellSpawnAt } from './shells.js';
import { ITEMS, TICK_HZ } from './items.js';
import { PAINTS } from './palette.js';
import { Gallery } from './gallery.js';

/**
 * VENIE FIELD — 멀티플레이 중계 서버 (Node + ws)
 *
 * Render 무료 플랜에 그대로 올라갑니다. 설정은 환경변수로만 받습니다.
 *
 * ## Render 무료 플랜에서 알아야 할 것
 * - 들어오는 트래픽이 15분 없으면 잠들고, 다시 깨는 데 1분쯤 걸립니다.
 *   **연결된 WebSocket에서 오는 메시지도 트래픽으로 쳐 주므로**, 한 명이라도
 *   접속해 있으면 잠들지 않습니다. 클라이언트가 20초마다 핑을 보냅니다.
 * - 그래도 **첫 방문자는 최대 1분을 기다릴 수 있습니다.** 그래서 게임은
 *   서버 없이도 그냥 돌아가야 하고, 실제로 그렇게 만들어 두었습니다
 *   (`src/net.js` — 연결은 배경에서 계속 재시도합니다).
 * - PORT는 Render가 환경변수로 줍니다. **반드시 그 값을 써야** 헬스체크를 통과합니다.
 */

const PORT = Number(process.env.PORT) || 8080;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 24;
const NAME_MAX = Number(process.env.NAME_MAX) || 12;
/* 허용할 출처. 쉼표로 여러 개.
 * ★ 브라우저는 WebSocket에 CORS를 적용하지 않습니다 — 즉 **서버가 직접 막지 않으면
 *   누구나 남의 사이트에서 이 서버에 붙일 수 있습니다.** 무료 플랜의 대역폭을
 *   지키기 위해서라도 여기서 걸러야 합니다. 비워 두면 전부 허용합니다. */
const ORIGINS = (process.env.ALLOW_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

/**
 * ★★ 출처를 **호스트 이름으로** 견줍니다 — 글자 그대로 비교하지 않습니다.
 *
 * 예전에는 `ORIGINS.includes(origin)`이었습니다. 그래서 다음이 전부
 * **다른 출처**로 취급돼 거절당했습니다.
 *
 * ```
 *   https://ooj.co.kr        ← ALLOW_ORIGIN에 적어 둔 것
 *   https://www.ooj.co.kr    ✘ 거절
 *   http://ooj.co.kr         ✘ 거절
 *   https://ooj.co.kr:443    ✘ 거절
 * ```
 *
 * ★ 실제로 이것 때문에 **인스타그램 프로필 링크로 들어온 사람만 아무도
 *   만나지 못했습니다.** 크롬·사파리에서 직접 들어갈 때와 인앱 브라우저가
 *   따라가는 주소의 `www` 유무가 달랐던 것입니다. 게임 쪽에는 아무 오류도
 *   나지 않고 그냥 '혼자'가 되므로 원인을 짐작하기가 아주 어렵습니다.
 *
 * 지금은 **호스트가 같거나 그 하위 도메인이면** 받습니다. 여전히 남의
 * 사이트는 막습니다(그게 이 검사의 목적입니다).
 *
 * ★ `Origin: null`은 기본으로 막습니다 — sandbox 붙은 iframe·파일에서 연
 *   페이지가 그렇습니다. 필요하면 ALLOW_ORIGIN에 `null`을 적어 주세요.
 */
function hostOf(v) {
  try { return new URL(v).hostname.toLowerCase(); } catch (e) { return String(v).toLowerCase(); }
}
const ALLOW_HOSTS = ORIGINS.map(hostOf);
function originAllowed(origin) {
  if (!ORIGINS.length) return true;                 // 비워 두면 전부 허용
  if (ORIGINS.includes(origin)) return true;        // 글자 그대로 맞으면 통과
  if (!origin || origin === 'null') return false;
  const h = hostOf(origin);
  return ALLOW_HOSTS.some((a) => h === a || h.endsWith(`.${a}`) || a.endsWith(`.${h}`));
}

/* ── 아이템 (물감 · 조개) ────────────────────────────────────────────────
 * ★★ **개수·확률·점수는 환경변수가 아니라 `items.js`에서 옵니다.**
 *
 *   예전에는 `ITEM_COUNT` 같은 환경변수로 받았습니다. 그런데 게임 쪽에도
 *   같은 숫자가 `config.js`에 있어서, 둘이 어긋나도 **아무 오류가 나지
 *   않았습니다** — 서버는 자기 값대로 띄우고 게임은 자기 값대로 그리므로
 *   화면을 한참 세어 봐야 알 수 있었습니다.
 *   지금은 `src/items.js` = `server/items.js` 한 파일이 진실이고,
 *   `wire_test.mjs`가 두 사본을 바이트로 비교합니다.
 *
 * ★ 여전히 환경변수인 것들은 **코드에 적으면 안 되는 것**뿐입니다 —
 *   비밀(ADMIN_KEY·SCORE_STORE_TOKEN)과 배포 환경(PORT·ALLOW_ORIGIN).
 *
 * ★ 좌표는 서버가 만들지 않습니다. 지형은 시드 기반 결정적 생성이라 서버가
 *   들고 있을 이유가 없고, 여기서 지형을 굽는 것은 무료 플랜에 과합니다.
 *   대신 오프라인에서 구워 둔 후보표(spawns.js · shells.js)를 클라이언트와
 *   **같은 파일로** 나눠 갖고, 서버는 그 **번호만** 고릅니다.
 */
const PAINT = ITEMS.paint;
const SHELL = ITEMS.shell;

/* ★ 예전 환경변수가 Render에 남아 있으면 알려 줍니다.
 * 그냥 무시하면 "지웠는데 왜 그대로지?"가 됩니다 — 값이 코드로 옮겨 왔다는
 * 사실 자체를 모르면 원인을 찾을 방법이 없습니다. */
const LEGACY_ENV = ['TICK_HZ', 'ITEM_COUNT', 'ITEM_RESPAWN', 'ITEM_SCORE',
  'ITEM_CLAIM_RANGE', 'SHELL_COUNT', 'SHELL_RESPAWN', 'SHELL_SCORE',
  'PEARL_SCORE', 'PEARL_CHANCE', 'PEARL_MAX'].filter((k) => process.env[k] !== undefined);

/* 순위표에서 기록을 지울 수 있는 관리자 키.
 * ★ 개발자모드는 워드프레스 관리자 쿠키로 확인하는데 **이 서버는 그걸 볼 수
 *   없습니다**(다른 호스팅입니다). 그래서 지우기만 따로 열쇠를 둡니다.
 *   설정하지 않으면 아무도 못 지웁니다 — 빈 문자열을 열쇠로 인정하면
 *   누구나 남의 기록을 지울 수 있게 됩니다. */
const ADMIN_KEY = process.env.ADMIN_KEY || '';

/* ── 순위표 보관 ──────────────────────────────────────────────────────────
 * ★★ Render 무료 플랜은 **15분 놀면 서버를 잠재웁니다.** 깨어날 때는 프로세스가
 *   새로 뜨므로 메모리에 있던 순위표가 통째로 사라집니다. 배포를 다시 해도
 *   마찬가지입니다. "서버 파일을 건드리지 않았는데 점수가 사라졌다"의 원인이
 *   이것입니다 — 게임 파일(FTP)과는 아무 상관이 없습니다.
 *   무료 플랜에는 디스크도 없어서 파일로 적어 둬도 재시작하면 지워집니다.
 *
 * 그래서 **바깥 저장소**에 맡길 수 있게 열어 둡니다. Upstash Redis 같은
 * REST 방식 KV면 무엇이든 됩니다(무료 등급으로 충분합니다).
 *   SCORE_STORE_URL    예: https://xxxx.upstash.io
 *   SCORE_STORE_TOKEN  그 서비스의 토큰
 * 비워 두면 예전처럼 메모리에만 둡니다(서버가 자면 사라집니다). */
const STORE_URL = (process.env.SCORE_STORE_URL || '').replace(/\/$/, '');
const STORE_TOKEN = process.env.SCORE_STORE_TOKEN || '';
const STORE_KEY = process.env.SCORE_STORE_KEY || 'venie:board';
const storeOn = !!(STORE_URL && STORE_TOKEN);

async function loadBoard() {
  if (!storeOn) return;
  try {
    const res = await fetch(`${STORE_URL}/get/${encodeURIComponent(STORE_KEY)}`, {
      headers: { Authorization: `Bearer ${STORE_TOKEN}` },
    });
    const j = await res.json();
    const rows = j?.result ? JSON.parse(j.result) : null;
    if (Array.isArray(rows)) {
      room.board = rows.filter((e) => e && typeof e.name === 'string' && Number.isFinite(e.score));
      console.log(`순위표를 불러왔습니다 — ${room.board.length}줄`);
    }
  } catch (e) {
    console.log('순위표를 불러오지 못했습니다:', e.message);
  }
}

/* ★ 점수가 오를 때마다 쓰면 요청이 폭발합니다. 바뀐 것만 기억해 뒀다가
 * 잠잠해지면 한 번에 씁니다. 서버가 갑자기 잠들어도 최대 이 시간만큼만 잃습니다. */
let saveTimer = null;
function saveBoardSoon() {
  if (!storeOn || saveTimer) return;
  saveTimer = setTimeout(async () => {
    saveTimer = null;
    try {
      await fetch(`${STORE_URL}/set/${encodeURIComponent(STORE_KEY)}`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${STORE_TOKEN}` },
        body: JSON.stringify(room.board),
      });
    } catch (e) {
      console.log('순위표를 저장하지 못했습니다:', e.message);
    }
  }, Number(process.env.SCORE_SAVE_DELAY || 8) * 1000);
}

/* ── ★★ 작품 갤러리 (4단계) ────────────────────────────────────────────────
 * 순위표와 **같은 Upstash**를 씁니다 — 키 앞머리만 다릅니다(`vf:art:*`).
 * 전용 주소를 따로 주고 싶으면 `ART_STORE_URL`/`ART_STORE_TOKEN`을 쓰세요.
 *
 * ★ `ART_PIN_SALT`가 없으면 **등록을 받지 않습니다.** PIN을 평문으로 둘
 *   바에는 기능을 끄는 편이 낫습니다 — 있는 줄 알았던 자물쇠가 없는 것이
 *   가장 나쁩니다. 시작할 때 콘솔에 한 줄 남깁니다. */
const gallery = new Gallery({
  storeUrl: process.env.ART_STORE_URL || STORE_URL,
  storeToken: process.env.ART_STORE_TOKEN || STORE_TOKEN,
  salt: process.env.ART_PIN_SALT || '',
  max: Number(process.env.ART_MAX) || 300,
  titleMax: Number(process.env.ART_TITLE_MAX) || 10,
  isBad: isBadName,
});

const room = new Room({
  maxPlayers: MAX_PLAYERS,
  nameMax: NAME_MAX,
  itemColors: PAINTS.length,
  spawnCount: SPAWN_COUNT,
  spawnAt,
  shellSpawnCount: SHELL_SPAWN_COUNT,
  shellSpawnAt,
  /* 나머지(개수·리스폰·점수·확률)는 Room이 `items.js`에서 그대로 읽습니다 —
   * 여기서 한 번 더 적으면 그게 곧 세 번째 사본이 됩니다. */
});
const sockets = new Map();   // id -> ws

/* ── HTTP: 헬스체크 ──────────────────────────────────────────────────────────
 * Render는 포트가 열려 있는지로 배포 성공을 판단합니다. 그리고 이 주소를
 * 외부 핑 서비스(cron-job.org 등)로 두드리면 무료 플랜이 잠드는 것을 막습니다. */
const server = http.createServer((req, res) => {
  if (req.url === '/health' || req.url === '/') {
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      players: room.size,
      uptime: Math.round(process.uptime()),
    }));
    return;
  }
  /* ── ★★ 그림 내주기 ────────────────────────────────────────────────────
   * `GET /art/<id>.webp`
   *
   * ★★ 소켓으로 보내지 않는 이유: 512² webp 한 장이 40~150KB이고, 소켓으로
   *   보내면 **접속할 때마다** 다시 받습니다. 여기로 내주면 브라우저가 캐시
   *   머리글을 보고 한 번만 받습니다.
   * ★ 작품은 한 번 올라오면 내용이 안 바뀝니다(고치려면 거둬서 다시
   *   그려야 합니다). 그래서 `immutable`을 붙여도 안전합니다 — 붙이면
   *   브라우저가 다시 물어보지도 않습니다. */
  const art = /^\/art\/([A-Za-z0-9_-]{1,32})\.webp$/.exec(req.url || '');
  if (art) {
    gallery.image(art[1]).then((buf) => {
      if (!buf) { res.writeHead(404).end(); return; }
      res.writeHead(200, {
        'Content-Type': 'image/webp',
        'Content-Length': buf.length,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
      });
      res.end(buf);
    }).catch(() => res.writeHead(500).end());
    return;
  }
  res.writeHead(404).end();
});

/* ── ★★ 메시지 크기 ────────────────────────────────────────────────────────
 * 보통 메시지는 2KB면 넉넉합니다(좌표·이름·점수). **단 하나** 작품 등록만
 * 예외입니다 — 512² webp를 base64로 실어 40~150KB가 됩니다.
 *
 * ★★ 그래서 **두 단계**로 봅니다. 상한 하나를 통째로 올리면, 아무 메시지나
 *   600KB로 보내도 되는 문이 열립니다. 무료 플랜에서는 그 문 하나로 대역폭이
 *   다 탑니다. 큰 것은 '작품 등록'일 때만 받습니다.
 * ★ `maxPayload`도 함께 올립니다. 안 올리면 `ws`가 프레임 단계에서 먼저
 *   끊어 버려, 아래 검사가 돌기도 전에 연결이 죽습니다. */
const MSG_MAX = 2048;
const ART_MSG_MAX = Number(process.env.ART_MSG_MAX) || 600 * 1024;
/** 작품을 올리고 나서 이만큼은 다시 못 올립니다(ms) — 그리는 데 몇 분 걸립니다 */
const ART_COOLDOWN = Number(process.env.ART_COOLDOWN) || 10000;

const wss = new WebSocketServer({ noServer: true, maxPayload: ART_MSG_MAX + 4096 });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '(없음)';
  /* ★ 모든 접속 시도를 남깁니다.
   * 이게 없으면 "브라우저가 아예 안 붙은 것"과 "붙었는데 막힌 것"을 가릴 수
   * 없습니다. 특히 www 있고 없고 차이로 막히는 경우가 흔한데, 로그를 보면
   * 어떤 출처로 들어왔는지 한 줄로 드러납니다. */
  console.log(`업그레이드 시도 — origin: ${origin}`);
  if (!originAllowed(req.headers.origin)) {
    console.log(`  ✘ 거절 — ALLOW_ORIGIN에 없는 출처입니다. 지금 허용: ${ORIGINS.join(', ')}`
      + '  (www 유무·http/https는 이제 가리지 않습니다. 그래도 막혔다면'
      + ' 위에 찍힌 origin을 ALLOW_ORIGIN에 그대로 넣으세요)');
    socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    socket.destroy();
    return;
  }
  wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
});

wss.on('connection', (ws) => {
  ws.id = null;
  ws.alive = true;
  ws.msgs = 0;

  ws.on('pong', () => { ws.alive = true; });

  ws.on('message', (raw) => {
    // 말이 안 되게 큰 메시지는 읽지도 않습니다
    if (raw.length > ART_MSG_MAX) { ws.close(1009, 'too big'); return; }
    /* ★★ 2KB를 넘으면 **작품 등록인지 확인한 뒤에만** 계속합니다.
     *   예전에는 2KB에서 무조건 끊었는데, 작품 그림이 그보다 훨씬 커서
     *   **작품을 세우는 순간 접속이 통째로 끊겼습니다** — 순위표까지
     *   사라져 보인 것이 그 때문입니다. */
    let big = null;
    if (raw.length > MSG_MAX) {
      try { big = JSON.parse(raw); } catch (e) { ws.close(1009, 'too big'); return; }
      if (!(big.t === 'art' && big.a === 'new')) { ws.close(1009, 'too big'); return; }
      const now = Date.now();
      if (now - (ws.artAt || 0) < ART_COOLDOWN) {
        ws.send(JSON.stringify({ t: 'art', a: 'denied', why: 'wait' }));
        return;
      }
      ws.artAt = now;
    }
    /* 초당 메시지 수 제한. 정상 클라이언트는 12Hz + 핑이라 40이면 넉넉합니다.
     * 없으면 한 명이 루프를 돌려 무료 플랜 대역폭을 다 태울 수 있습니다.
     * (틱을 20Hz로 올렸으므로 상한도 함께 올렸습니다) */
    if (++ws.msgs > 60) return;

    /* ★ 큰 메시지는 위에서 이미 읽었습니다. 150KB를 두 번 읽을 이유가 없습니다. */
    let m = big;
    if (!m) {
      try { m = JSON.parse(raw); } catch (e) { return; }
    }

    if (m.t === 'hello') {
      if (ws.id !== null) return;                    // 두 번 들어올 수 없습니다
      const cleaned = sanitizeName(m.n, NAME_MAX);
      /* ★ 클라이언트에서도 거르지만 서버에서 **다시** 봅니다.
       * 브라우저 쪽 검사는 고쳐서 보낼 수 있기 때문입니다
       * (api_works.php가 저장 권한을 서버에서 다시 확인하는 것과 같은 이유). */
      if (isBadName(cleaned)) {
        ws.send(JSON.stringify({ t: 'deny', why: 'badname' }));
        ws.close();
        return;
      }
      /* ── ★★ 같은 탭의 앞 접속을 먼저 치웁니다 ──────────────────────────
       * 앱을 백그라운드로 내렸다 돌아오면 소켓이 죽는데, 서버는 30초
       * (`staleAfter`)가 지나야 그 사람을 지웁니다. 그 사이에 다시 붙으면
       * 서버 눈에는 **같은 이름의 두 사람**이라 새로 온 쪽이 'donsign 2'가
       * 되고, 옛 몸뚱이가 유령처럼 옆에 서 있게 됩니다.
       *
       * ★ 이름이 아니라 **sid(탭마다 한 번 뽑은 임의의 표식)** 로 가립니다.
       *   이름으로 하면 진짜 동명이인을 쫓아내게 됩니다.
       * ★ 점수는 이어받습니다 — 잠깐 앱을 내렸을 뿐인데 0이 되면
       *   '끊겼다'가 아니라 '내 기록이 날아갔다'로 느껴집니다. */
      let carry = 0;
      const prev = room.findBySid(m.sid);
      if (prev) {
        carry = prev.score;
        const old = sockets.get(prev.id);
        const left = room.leave(prev.id);
        sockets.delete(prev.id);
        for (const n of left.freedNpc) broadcast({ t: 'npc', a: 'busy', n, by: 0 });
        broadcast({ t: 'leave', id: prev.id });
        if (old && old !== ws) { old.id = null; old.close(); }
        console.log(`  ↻ ${prev.name} 재접속 — 앞 접속(#${prev.id})을 치웁니다`
          + `${carry ? ` · ${carry}점 이어받음` : ''}`);
      }

      const r = room.join(cleaned, Date.now(), { sid: m.sid, score: carry });
      if (!r.ok) { ws.send(JSON.stringify({ t: 'deny', why: r.reason })); ws.close(); return; }
      ws.id = r.player.id;
      sockets.set(ws.id, ws);
      // 지금 방에 있는 사람들의 명단을 함께 보냅니다 (이름은 여기서 한 번만)
      ws.send(JSON.stringify({
        t: 'welcome', id: r.player.id, n: r.player.name, hz: TICK_HZ,
        /* ★★ 중복을 피해 붙인 번호를 **뗀** 이름입니다('돈 2' → '돈').
         *   작품의 주인은 이 이름으로 가립니다 — 새로고침할 때 앞 접속이
         *   잠깐 남아 있으면 이름 뒤에 번호가 붙는데, 그걸로 가리면
         *   **자기 작품이 남의 것이 되어 사라집니다.** 순위표가 이미
         *   `baseName`으로 기록하는 것과 같은 이유입니다. */
        bn: r.player.baseName || r.player.name,
        p: room.roster(r.player.id),
        // 지금 떠 있는 물감. 좌표가 아니라 **스폰 번호**만 보냅니다
        it: room.itemList(),
        cfg: room.settingsWire(), // 모두에게 같아야 하는 설정 (화면 효과 등)
        sc: r.player.score,       // 내 점수 (같은 탭의 재접속이면 이어받습니다)
        bd: room.topScores(5),    // 상위 5명
        /* 지금 누군가 말을 걸고 있는 NPC. ★ 늦게 들어온 사람도 곧바로
         * '이미 대화중'을 알 수 있어야 합니다 */
        np: room.npcBusyList(),
        /* ★★ 승인된 작품 + **내 작품**. 승인 대기 중인 남의 그림은 보내지
         *   않습니다 — 승인 전에 이미 모두에게 보였다면 승인제가 아무것도
         *   막지 못한 셈입니다. 그림 자체는 `/art/<id>.webp`로 따로 받습니다. */
        ar: gallery.listFor(r.player.baseName || r.player.name),
      }));
      broadcast({ t: 'join', ...Room.meta(r.player) }, r.player.id);
      console.log(`+ ${r.player.name} (#${r.player.id}) — ${room.size}명`);
      return;
    }

    if (ws.id === null) return;                      // hello 전에는 아무것도 못 합니다

    if (m.t === 's') {
      room.setState(ws.id, m, Date.now());
    } else if (m.t === 'ping') {
      // 왕복시간 측정 + 무료 플랜이 잠들지 않게 하는 트래픽
      ws.send(JSON.stringify({ t: 'pong', c: m.c }));
    } else if (m.t === 'take') {
      /* 물감 줍기. 먼저 온 사람이 가져갑니다.
       * 실패해도 조용히 넘어갑니다 — 거의 언제나 "남이 방금 먹었다"이고,
       * 그 사람 화면에서는 이미 `item gone`으로 사라지기 때문입니다. */
      const r = room.takeItem(ws.id, m.i, Date.now());
      if (r.ok) {
        broadcast({ t: 'item', a: 'gone', i: r.item.id, by: ws.id });
        /* ★ 점수는 **여기서** 오릅니다. 클라이언트가 올려 달라고 보내는
         * 구조였다면 그건 그냥 점수 입력창입니다. */
        const total = room.addScore(ws.id, r.item.score);
        saveBoardSoon();
        /* ★ 필드를 손으로 적지 않습니다 — 종류(k)를 빠뜨려 조개를 먹어도
         * '빨강 물감'이 되던 버그가 여기서 났습니다. `Room.tookWire` 주석 참고. */
        ws.send(JSON.stringify(Room.tookWire(r.item, total)));
        broadcast({ t: 'board', b: room.topScores(5) });
      } else {
        ws.send(JSON.stringify({ t: 'item', a: 'deny', i: m.i, why: r.reason }));
      }
    } else if (m.t === 'npc') {
      /* NPC 대화 자리. ★ 서버가 하는 일은 **누가 임자인가** 하나뿐입니다 —
       * 대사 내용도, 몇 번째 줄인지도 서버는 모릅니다. */
      if (m.a === 'claim') {
        const r = room.claimNpc(ws.id, m.n);
        ws.send(JSON.stringify({ t: 'npc', a: 'claim', n: m.n, ok: r.ok, by: r.by || 0 }));
        if (r.ok) broadcast({ t: 'npc', a: 'busy', n: m.n, by: ws.id }, ws.id);
      } else if (m.a === 'free') {
        if (room.releaseNpc(ws.id, m.n)) {
          broadcast({ t: 'npc', a: 'busy', n: m.n, by: 0 }, ws.id);
        }
      }
    } else if (m.t === 'board' && m.a === 'del') {
      /* 필터를 피한 비속어 닉네임을 순위표에서 지웁니다.
       * 열쇠가 설정돼 있지 않으면 **아무도** 못 지웁니다. */
      if (!ADMIN_KEY) {
        ws.send(JSON.stringify({ t: 'board', a: 'denied', why: 'ADMIN_KEY 미설정' }));
      } else if (m.k !== ADMIN_KEY) {
        ws.send(JSON.stringify({ t: 'board', a: 'denied', why: '관리자 키가 다릅니다' }));
      } else if (typeof m.n === 'string' && room.removeScore(m.n)) {
        console.log(`순위표에서 '${m.n}' 기록을 지웠습니다`);
        saveBoardSoon();
        broadcast({ t: 'board', b: room.topScores(5) });
      }
    } else if (m.t === 'cfg') {
      /* 화면 효과 같은 **모두가 같아야 하는 설정**. 순위표 지우기와 같은
       * 열쇠를 씁니다 — 아무나 남의 화면을 바꿀 수는 없어야 합니다. */
      if (!ADMIN_KEY || m.k !== ADMIN_KEY) {
        ws.send(JSON.stringify({ t: 'cfg', a: 'denied', why: ADMIN_KEY ? '관리자 키가 다릅니다' : 'ADMIN_KEY 미설정' }));
      } else if (room.setSetting(m.n, m.v)) {
        console.log(`설정 '${m.n}' → ${m.v}`);
        broadcast({ t: 'cfg', c: room.settingsWire() });
      }
    } else if (m.t === 'art') {
      handleArt(ws, m);
    } else if (m.t === 'color') {
      // 몸 색이 바뀌었다는 알림. 형식만 확인하고 그대로 나눠 줍니다
      const hex = m.c === null || m.c === undefined ? null : m.c;
      if (room.setColor(ws.id, hex)) broadcast({ t: 'color', id: ws.id, c: hex }, ws.id);
    }
  });

  const bye = () => {
    if (ws.id === null) return;
    const p = room.players.get(ws.id);
    const left = room.leave(ws.id);
    sockets.delete(ws.id);
    /* ★ 대화 도중 창을 닫으면 그 NPC가 영영 '대화중'으로 잠깁니다 */
    for (const n of left.freedNpc) broadcast({ t: 'npc', a: 'busy', n, by: 0 });
    broadcast({ t: 'leave', id: ws.id }, ws.id);
    console.log(`- ${p ? p.name : ws.id} — ${room.size}명`);
    ws.id = null;
  };
  ws.on('close', bye);
  ws.on('error', bye);
});

function broadcast(obj, exceptId = null) {
  const msg = JSON.stringify(obj);
  for (const [id, ws] of sockets) {
    if (id === exceptId) continue;
    if (ws.readyState === ws.OPEN) ws.send(msg);
  }
}

/* ── ★★ 작품 (4단계) ──────────────────────────────────────────────────────
 *
 * 한 갈래(`t: 'art'`)로 다섯 가지를 처리합니다. 나누면 `server.js`가
 * 그만큼 길어지는데, 하는 일은 전부 "작품 하나에 무엇을 한다"입니다.
 *
 *   a: 'new'   등록 — 세운 자리와 그림을 함께
 *   a: 'take'  회수 — PIN이 맞아야
 *   a: 'list'  관리자 목록
 *   a: 'ok' | 'no' | 'del'   승인 · 거절 · 삭제 (관리자 열쇠 필요)
 */
function adminOk(ws, m) {
  if (!ADMIN_KEY) {
    ws.send(JSON.stringify({ t: 'art', a: 'denied', why: 'ADMIN_KEY 미설정' }));
    return false;
  }
  if (m.k !== ADMIN_KEY) {
    ws.send(JSON.stringify({ t: 'art', a: 'denied', why: '관리자 키가 다릅니다' }));
    return false;
  }
  return true;
}

async function handleArt(ws, m) {
  const me = room.players.get(ws.id);

  if (m.a === 'new') {
    if (!me) return;
    const r = await gallery.add({
      owner: me.baseName || me.name,
      title: m.t2,
      pin: m.p,
      img: m.img,
      x: m.x, y: m.y, z: m.z, rotY: m.r,
    });
    if (!r.ok) {
      ws.send(JSON.stringify({ t: 'art', a: 'denied', why: r.why }));
      return;
    }
    /* ★ 올린 사람에게만 돌려줍니다. 남들은 **승인된 뒤에** 봅니다. */
    ws.send(JSON.stringify({ t: 'art', a: 'new', art: gallery.wire(r.art) }));
    console.log(`작품 등록 — '${r.art.title}' by ${r.art.owner} (${r.art.id})`);
    return;
  }

  if (m.a === 'take') {
    if (!me) return;
    const art = gallery.items.get(m.id);
    if (!art) { ws.send(JSON.stringify({ t: 'art', a: 'denied', why: 'gone' })); return; }
    /* ★★ **주인 이름부터** 봅니다. 이름이 다르면 PIN을 넣어 볼 기회조차
     *   주지 않습니다 — 그래야 남의 작품 PIN을 만 번 두드리는 길이 막힙니다. */
    if (art.owner !== (me.baseName || me.name)) {
      ws.send(JSON.stringify({ t: 'art', a: 'denied', why: 'owner' }));
      return;
    }
    const c = gallery.checkPin(m.id, m.p);
    if (!c.ok) {
      ws.send(JSON.stringify({ t: 'art', a: 'denied', why: c.why, wait: c.wait }));
      return;
    }
    await gallery.remove(m.id);
    ws.send(JSON.stringify({ t: 'art', a: 'took', id: m.id }));
    /* 남들 화면에서도 걷습니다 (승인돼 보이고 있었을 수 있습니다) */
    broadcast({ t: 'art', a: 'gone', id: m.id }, ws.id);
    return;
  }

  if (m.a === 'list') {
    if (!adminOk(ws, m)) return;
    ws.send(JSON.stringify({ t: 'art', a: 'list', ...gallery.adminList() }));
    return;
  }

  if (m.a === 'ok' || m.a === 'no') {
    if (!adminOk(ws, m)) return;
    const art = gallery.items.get(m.id);
    if (!art) return;
    if (m.a === 'no') {
      /* ★ 거절은 **삭제**입니다. 거절해 두고 남겨 두면 언젠가 실수로
       *   승인될 수 있고, 그림은 그대로 저장소를 차지합니다. */
      await gallery.remove(m.id);
      broadcast({ t: 'art', a: 'gone', id: m.id });
      console.log(`작품 거절 — '${art.title}' by ${art.owner}`);
    } else {
      await gallery.setApproved(m.id, true);
      broadcast({ t: 'art', a: 'add', art: gallery.wire(art) });
      console.log(`작품 승인 — '${art.title}' by ${art.owner}`);
    }
    ws.send(JSON.stringify({ t: 'art', a: 'list', ...gallery.adminList() }));
    return;
  }

  if (m.a === 'del') {
    if (!adminOk(ws, m)) return;
    const art = gallery.items.get(m.id);
    if (!art) return;
    await gallery.remove(m.id);
    broadcast({ t: 'art', a: 'gone', id: m.id });
    console.log(`작품 삭제 — '${art.title}' by ${art.owner}`);
    ws.send(JSON.stringify({ t: 'art', a: 'list', ...gallery.adminList() }));
  }
}

/* ── 서버 주도 루프 ─────────────────────────────────────────────────────────
 * 메시지를 받을 때마다 되쏘지 않고 정해진 박자로 모아 보냅니다.
 * 10명이 12Hz로 보내면 되쏘기 방식은 초당 1200통이지만, 모아 보내면 120통입니다.
 * (나중에 물감 아이템 스폰·NPC 갱신도 이 루프에 들어옵니다) */
setInterval(() => {
  const swept = room.sweep();
  for (const id of swept) {
    const ws = sockets.get(id);
    if (ws) { ws.close(); sockets.delete(id); }
    broadcast({ t: 'leave', id });
  }
  // 소켓이 조용히 죽은 경우에도 NPC를 풀어 줍니다
  for (const n of swept.freedNpc || []) broadcast({ t: 'npc', a: 'busy', n, by: 0 });
  /* 물감 채우기·되살리기. 여기가 **서버가 스스로 세계를 바꾸는 유일한 곳**입니다
   * (나머지는 전부 중계입니다). 새로 생긴 것만 방송하면 되므로 대역폭은
   * 1분에 몇 십 바이트입니다. */
  for (const it of room.tickItems().added) {
    broadcast({ t: 'item', a: 'add', ...Room.itemWire(it) });
  }

  const now = Date.now();
  for (const [id, ws] of sockets) {
    if (ws.readyState !== ws.OPEN) continue;
    ws.msgs = 0;                                    // 초당 제한 창을 여기서 함께 리셋
    const snap = room.snapshot(id, now);
    if (snap.p.length) ws.send(JSON.stringify(snap));
  }
}, Math.round(1000 / TICK_HZ));

/* 죽은 소켓 정리. 브라우저 탭을 강제로 닫으면 close 이벤트가 안 올 때가 있고,
 * 그러면 유령 플레이어가 화면에 남습니다. */
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.alive) { ws.terminate(); continue; }
    ws.alive = false;
    ws.ping();
  }
}, 25000);

server.listen(PORT, () => {
  console.log(`VENIE FIELD 서버 :${PORT}  (틱 ${TICK_HZ}Hz, 최대 ${MAX_PLAYERS}명)`);
  console.log(`물감 ${PAINT.count}개 · ${PAINT.respawn}초 후 리스폰`
    + ` · 개당 ${PAINT.score}점 · 후보 ${SPAWN_COUNT}자리`);
  if (!ADMIN_KEY) console.log('· ADMIN_KEY 미설정 — 순위표 기록을 지울 수 없습니다');
  if (storeOn) {
    console.log(`· 순위표를 바깥 저장소에 보관합니다 (${STORE_URL})`);
    loadBoard();
    gallery.load();
  } else {
    console.log('· ★ 순위표가 메모리에만 있습니다 — 무료 플랜은 15분 놀면 잠들고,'
      + ' 깨어날 때 기록이 사라집니다. SCORE_STORE_URL/TOKEN을 넣으면 보관됩니다');
  }
  console.log(`조개 ${SHELL.count}개 · ${SHELL.respawn}초 후 리스폰`
    + ` · 진주 확률 ${(SHELL.pearlChance * 100).toFixed(0)}% (최대 ${SHELL.pearlMax}개)`
    + ` · 조개 ${SHELL.score}점 / 진주 ${SHELL.pearlScore}점 · 후보 ${SHELL_SPAWN_COUNT}자리`);
  if (LEGACY_ENV.length) {
    console.log(`⚠ 이제 쓰지 않는 환경변수가 남아 있습니다 — ${LEGACY_ENV.join(', ')}`);
    console.log('  이 값들은 items.js로 옮겼습니다. Render 대시보드에서 지우세요'
      + ' (지금은 그냥 무시되므로 동작에는 지장이 없습니다).');
  }
  if (!SPAWN_COUNT) console.log('⚠ spawns.js가 비어 있습니다 — 물감이 하나도 안 뜹니다');
  if (!SHELL_SPAWN_COUNT) console.log('⚠ shells.js가 비어 있습니다 — 조개가 하나도 안 뜹니다');
  console.log(ORIGINS.length ? `허용 출처: ${ORIGINS.join(', ')}` : '⚠ 출처 제한 없음 (ALLOW_ORIGIN 설정 권장)');
});
