import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, sanitizeName } from './room.js';

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
const TICK_HZ = Number(process.env.TICK_HZ) || 12;
const MAX_PLAYERS = Number(process.env.MAX_PLAYERS) || 24;
const NAME_MAX = Number(process.env.NAME_MAX) || 12;
/* 허용할 출처. 쉼표로 여러 개.
 * ★ 브라우저는 WebSocket에 CORS를 적용하지 않습니다 — 즉 **서버가 직접 막지 않으면
 *   누구나 남의 사이트에서 이 서버에 붙일 수 있습니다.** 무료 플랜의 대역폭을
 *   지키기 위해서라도 여기서 걸러야 합니다. 비워 두면 전부 허용합니다. */
const ORIGINS = (process.env.ALLOW_ORIGIN || '')
  .split(',').map((s) => s.trim()).filter(Boolean);

const room = new Room({ maxPlayers: MAX_PLAYERS, nameMax: NAME_MAX });
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
     * 없으면 한 명이 루프를 돌려 무료 플랜 대역폭을 다 태울 수 있습니다. */
    if (++ws.msgs > 40) return;

    let m;
    try { m = JSON.parse(raw); } catch (e) { return; }

    if (m.t === 'hello') {
      if (ws.id !== null) return;                    // 두 번 들어올 수 없습니다
      const r = room.join(sanitizeName(m.n, NAME_MAX));
      if (!r.ok) { ws.send(JSON.stringify({ t: 'deny', why: r.reason })); ws.close(); return; }
      ws.id = r.player.id;
      sockets.set(ws.id, ws);
      // 지금 방에 있는 사람들의 명단을 함께 보냅니다 (이름은 여기서 한 번만)
      ws.send(JSON.stringify({
        t: 'welcome', id: r.player.id, n: r.player.name, hz: TICK_HZ,
        p: room.roster(r.player.id),
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
  console.log(ORIGINS.length ? `허용 출처: ${ORIGINS.join(', ')}` : '⚠ 출처 제한 없음 (ALLOW_ORIGIN 설정 권장)');
});
