import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, sanitizeName } from './room.js';
import { isBadName } from './badwords.js';
import { SPAWN_COUNT, spawnAt } from './spawns.js';
import { SHELL_SPAWN_COUNT, shellSpawnAt } from './shells.js';
import { ITEMS, TICK_HZ } from './items.js';
import { PAINTS } from './palette.js';

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
  res.writeHead(404).end();
});

const wss = new WebSocketServer({ noServer: true });

server.on('upgrade', (req, socket, head) => {
  const origin = req.headers.origin || '(없음)';
  /* ★ 모든 접속 시도를 남깁니다.
   * 이게 없으면 "브라우저가 아예 안 붙은 것"과 "붙었는데 막힌 것"을 가릴 수
   * 없습니다. 특히 www 있고 없고 차이로 막히는 경우가 흔한데, 로그를 보면
   * 어떤 출처로 들어왔는지 한 줄로 드러납니다. */
  console.log(`업그레이드 시도 — origin: ${origin}`);
  if (ORIGINS.length && !ORIGINS.includes(origin)) {
    console.log(`  ✘ 거절 — ALLOW_ORIGIN에 없는 출처입니다. 지금 허용: ${ORIGINS.join(', ')}`);
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
    if (raw.length > 2048) { ws.close(1009, 'too big'); return; }
    /* 초당 메시지 수 제한. 정상 클라이언트는 12Hz + 핑이라 40이면 넉넉합니다.
     * 없으면 한 명이 루프를 돌려 무료 플랜 대역폭을 다 태울 수 있습니다.
     * (틱을 20Hz로 올렸으므로 상한도 함께 올렸습니다) */
    if (++ws.msgs > 60) return;

    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

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
      const r = room.join(cleaned);
      if (!r.ok) { ws.send(JSON.stringify({ t: 'deny', why: r.reason })); ws.close(); return; }
      ws.id = r.player.id;
      sockets.set(ws.id, ws);
      // 지금 방에 있는 사람들의 명단을 함께 보냅니다 (이름은 여기서 한 번만)
      ws.send(JSON.stringify({
        t: 'welcome', id: r.player.id, n: r.player.name, hz: TICK_HZ,
        p: room.roster(r.player.id),
        // 지금 떠 있는 물감. 좌표가 아니라 **스폰 번호**만 보냅니다
        it: room.itemList(),
        cfg: room.settingsWire(), // 모두에게 같아야 하는 설정 (화면 효과 등)
        sc: 0,                    // 내 점수 (저장하지 않으므로 늘 0에서 시작)
        bd: room.topScores(5),    // 상위 5명
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
        ws.send(JSON.stringify({
          t: 'item', a: 'took', i: r.item.id, c: r.item.color, v: r.item.score, sc: total,
        }));
        broadcast({ t: 'board', b: room.topScores(5) });
      } else {
        ws.send(JSON.stringify({ t: 'item', a: 'deny', i: m.i, why: r.reason }));
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
    } else if (m.t === 'color') {
      // 몸 색이 바뀌었다는 알림. 형식만 확인하고 그대로 나눠 줍니다
      const hex = m.c === null || m.c === undefined ? null : m.c;
      if (room.setColor(ws.id, hex)) broadcast({ t: 'color', id: ws.id, c: hex }, ws.id);
    }
  });

  const bye = () => {
    if (ws.id === null) return;
    const p = room.players.get(ws.id);
    room.leave(ws.id);
    sockets.delete(ws.id);
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

/* ── 서버 주도 루프 ─────────────────────────────────────────────────────────
 * 메시지를 받을 때마다 되쏘지 않고 정해진 박자로 모아 보냅니다.
 * 10명이 12Hz로 보내면 되쏘기 방식은 초당 1200통이지만, 모아 보내면 120통입니다.
 * (나중에 물감 아이템 스폰·NPC 갱신도 이 루프에 들어옵니다) */
setInterval(() => {
  for (const id of room.sweep()) {
    const ws = sockets.get(id);
    if (ws) { ws.close(); sockets.delete(id); }
    broadcast({ t: 'leave', id });
  }
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
