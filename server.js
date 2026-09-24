import http from 'node:http';
import { WebSocketServer } from 'ws';
import { Room, sanitizeName } from './room.js';
import { BallState } from './ball.js';
import { isBadName } from './badwords.js';
import { SPAWN_COUNT, spawnAt } from './spawns.js';
import { SHELL_SPAWN_COUNT, shellSpawnAt } from './shells.js';
import { ITEMS, TICK_HZ } from './items.js';
import { PAINTS } from './palette.js';
import { Gallery, ART, ownerKey } from './gallery.js';

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

/* ── 작품 갤러리 ──────────────────────────────────────────────────────────
 * ★ 저장소는 **순위표가 쓰는 그 DB**를 키 이름만 나눠 씁니다. 따로 열고
 *   싶으면 ART_STORE_URL/TOKEN을 넣으세요(없으면 SCORE_STORE_*를 씁니다).
 * ★ ART_PIN_SALT가 없으면 PIN 해시가 소금 없이 만들어집니다 — 그래도
 *   작품마다 다른 소금이 하나 더 붙으므로 무지개표는 안 통하지만,
 *   **넣어 두는 편이 맞습니다.** 없으면 시작할 때 한 줄 알려 줍니다. */
/* ── png → webp 변환기 ────────────────────────────────────────────────────
 * ★★ **iOS는 webp를 만들지 못합니다.** 16.4 아래의 WebKit은
 *   `toDataURL('image/webp')`에 말없이 png를 돌려주고, 아이폰의 크롬·
 *   파이어폭스도 속은 WebKit이라 똑같습니다. 그 사람들의 작품을 버릴 수는
 *   없으니 **여기서 바꿔서** 저장합니다 — 저장소에 남는 것은 언제나 webp입니다.
 * ★ 없어도 서버는 그대로 뜹니다. webp를 보내는 기기(안드로이드·PC 크롬)는
 *   아무 영향이 없고, png를 보내는 기기만 거절당합니다(까닭도 그렇게 옵니다). */
let sharp = null;
/**
 * ★ 최상위 `await`를 쓰지 않습니다 — 그러면 이 파일을 **통째로 컴파일해
 *   보는 검사**(`wire_test`의 `new Function`)가 통과하지 못합니다.
 *   서버가 뜨기 전에 한 번 부르는 것으로 충분합니다.
 */
async function loadConverter() {
  try {
    sharp = (await import('sharp')).default;
  } catch (e) {
    sharp = null;
  }
  gallery.convert = sharp
    /* 화질 82 — 512칸 그림이 50~90KB가 됩니다. 눈으로는 원본과 구별되지
     * 않고, 무료 플랜의 저장·대역폭으로는 png(300KB+)와 하늘과 땅 차이입니다. */
    ? (buf) => sharp(buf).webp({ quality: Number(process.env.ART_WEBP_Q) || 82 }).toBuffer()
    : null;
  return sharp;
}

const gallery = new Gallery({
  storeUrl: process.env.ART_STORE_URL || process.env.SCORE_STORE_URL || '',
  storeToken: process.env.ART_STORE_TOKEN || process.env.SCORE_STORE_TOKEN || '',
  pinSalt: process.env.ART_PIN_SALT || '',
  max: Number(process.env.ART_MAX) || 300,
  ttlDays: Number(process.env.ART_TTL_DAYS) || 7,
  log: (s) => console.log(`[작품] ${s}`),
});
/**
 * 올라오는 그림 한 장의 최대 크기(바이트).
 *
 * ★ webp는 40~150KB지만 **png는 300KB를 훌쩍 넘습니다.** 그래도 받습니다 —
 *   png는 **올라오는 동안만** 존재하고, 저장되는 것은 바꾼 webp이기
 *   때문입니다. 여기를 300KB로 두면 아이폰 작품이 통째로 막힙니다.
 */
const ART_BYTES = Number(process.env.ART_MAX_BYTES) || 1500 * 1024;
/** 같은 주소에서 한 시간에 올릴 수 있는 장수 */
const ART_PER_HOUR = Number(process.env.ART_PER_HOUR) || 20;
const artRate = new Map();   // ip → { n, at }

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
/* 해변 비치볼 — 임자와 마지막 상태만 (ball.js 머리말) */
const ball = new BallState();
/* ★ (세션 8-3) 아무도 없이 이만큼(분) 지나면 공을 해변 가운데로. 비용 0 — 타이머 없이
 *   다음 사람이 들어올 때 봅니다. 저장소가 있으면 방이 빌 때 한 번 적습니다(잠들어도 잼) */
const BALL_RESET_MS = Math.max(1, Number(process.env.BALL_RESET_MIN || 30)) * 60 * 1000;
const BALL_KEY = 'vf:ball';
async function loadBall() {
  if (!storeOn) return;
  try {
    const res = await fetch(`${STORE_URL}/get/${encodeURIComponent(BALL_KEY)}`, {
      headers: { Authorization: `Bearer ${STORE_TOKEN}` },
    });
    const j = await res.json();
    const v = j?.result ? JSON.parse(j.result) : null;
    if (ball.restore(v, Date.now(), BALL_RESET_MS)) console.log('비치볼 자리를 불러왔습니다');
  } catch (e) {
    console.log('비치볼 자리를 불러오지 못했습니다:', e.message);
  }
}
/** 방이 비었을 때 — 공의 빈 시각을 적고 저장소에 한 번 남깁니다 */
function ballRoomEmpty() {
  ball.markEmpty(Date.now());
  if (!storeOn || !ball.s) return;
  fetch(`${STORE_URL}/set/${encodeURIComponent(BALL_KEY)}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${STORE_TOKEN}` },
    body: JSON.stringify(ball.saved()),
  }).catch((e) => console.log('비치볼 자리를 저장하지 못했습니다:', e.message));
}
const sockets = new Map();   // id -> ws

/* ── HTTP: 헬스체크 ──────────────────────────────────────────────────────────
 * Render는 포트가 열려 있는지로 배포 성공을 판단합니다. 그리고 이 주소를
 * 외부 핑 서비스(cron-job.org 등)로 두드리면 무료 플랜이 잠드는 것을 막습니다. */
/* ── 관리자 화면 ──────────────────────────────────────────────────────────
 * ★ 한 장짜리입니다. 열쇠는 주소에 싣지 않고 **본문으로** 보냅니다 —
 *   주소에 실으면 브라우저 방문기록·중계 서버 로그에 그대로 남습니다.
 * ★ 그림은 `<img>` 한 줄로 뜹니다. 승인은 "무엇을 승인하는지 보고" 누르는
 *   일이라, 제목만 늘어놓은 목록은 승인 화면이 아닙니다. */
const ADMIN_HTML = `<!doctype html><html lang="ko"><head>
<meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>VENIE FIELD — 작품 승인</title><style>
 body{margin:0;padding:18px;background:#f6f2ea;color:#4a4038;
   font:15px/1.5 -apple-system,BlinkMacSystemFont,'Apple SD Gothic Neo','Noto Sans KR',sans-serif}
 h1{font-size:17px;margin:0 0 14px}
 .key{display:flex;gap:8px;margin-bottom:16px}
 input{flex:1;min-width:0;padding:10px 12px;border:1px solid #d8ccb8;border-radius:10px;background:#fff;font-size:15px}
 button{padding:10px 14px;border:1px solid #d8ccb8;border-radius:10px;background:#fff;cursor:pointer;font-size:14px}
 button.go{background:#7d9a6b;color:#fff;border-color:transparent}
 button.no{background:#c4785f;color:#fff;border-color:transparent}
 .card{display:flex;gap:12px;padding:12px;margin-bottom:10px;background:#fffdfa;
   border:1px solid #e5dccb;border-radius:14px}
 .card img{width:96px;height:96px;object-fit:cover;border-radius:9px;background:#efe7d8;flex:0 0 auto}
 .meta{flex:1;min-width:0}
 .t{font-weight:600}
 .d{font-size:12.5px;color:#8d7f70;margin:3px 0 9px}
 .acts{display:flex;gap:6px;flex-wrap:wrap}
 .tag{display:inline-block;padding:1px 7px;border-radius:99px;font-size:11.5px;margin-left:6px}
 .p{background:#f0e2c4;color:#8a6b2f}.a{background:#dceccf;color:#4d6d3a}.h{background:#e6e0d6;color:#7a6f61}
 .msg{padding:10px 0;color:#8d7f70;font-size:13px}
</style></head><body>
<h1>작품 승인</h1>
<div class="key"><input id="k" type="password" placeholder="관리자 키" autocomplete="off">
<button class="go" onclick="load()">불러오기</button></div>
<div id="msg" class="msg"></div><div id="list"></div>
<script>
const $=(s)=>document.querySelector(s);
try{ $('#k').value = sessionStorage.getItem('vfAdminKey')||''; }catch(e){}
async function api(a,id){
  const key=$('#k').value.trim();
  try{ sessionStorage.setItem('vfAdminKey',key); }catch(e){}
  const r=await fetch('/art/admin/api',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({key:key,a:a,id:id})});
  return r.json();
}
function esc(s){return String(s==null?'':s).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]));}
async function load(){ draw(await api('list')); }
async function act(a,id){ if(a==='del'&&!confirm('정말 지울까요? 되돌릴 수 없습니다.'))return; draw(await api(a,id)); }
function draw(j){
  if(!j.ok){ $('#msg').textContent='✘ '+(j.why||'실패'); return; }
  const v=j.v||[]; $('#msg').textContent=v.length?(v.length+'점 · 승인 대기 '+v.filter(x=>x.state!==2).length+'점'):'아직 작품이 없습니다.';
  $('#list').innerHTML=v.map(function(m){
    const tag=m.state===2?'<span class="tag a">승인됨</span>'
      :(m.placed?'<span class="tag p">승인 대기</span>':'<span class="tag h">들고 있음</span>');
    const left=m.days==null?'':(' · '+m.days+'일 뒤 사라짐');
    const spot=m.placed?(' · ('+m.x+', '+m.z+')'):'';
    return '<div class="card"><img loading="lazy" src="/art/'+m.id+'.webp" alt="">'
      +'<div class="meta"><div class="t">'+esc(m.title)+tag+'</div>'
      +'<div class="d">'+esc(m.owner)+spot+left+'</div><div class="acts">'
      +(m.state===2?'<button class="no" onclick="act(\\'reject\\',\\''+m.id+'\\')">승인 취소</button>'
        :'<button class="go" onclick="act(\\'approve\\',\\''+m.id+'\\')">승인</button>')
      +'<button onclick="act(\\'del\\',\\''+m.id+'\\')">삭제</button>'
      +'</div></div></div>';
  }).join('');
}
if($('#k').value) load();
</script></body></html>`;

/**
 * ★★ 브라우저가 **답을 읽을 수 있게** 합니다.
 *
 * WebSocket에는 CORS가 없지만 HTTP에는 있습니다. 게임은 ooj.co.kr에 있고
 * 이 서버는 onrender.com이라, 이 머리글이 없으면 그림을 올려도 **답을 못
 * 읽고**, 내려받은 그림은 캔버스를 오염시켜 WebGL 텍스처로 못 씁니다
 * (`crossOrigin='anonymous'`와 짝입니다).
 *
 * ★ 출처 검사는 업그레이드(WS)와 **같은 함수**를 씁니다. 두 벌로 두면
 *   www 유무 같은 것이 한쪽에서만 고쳐집니다.
 */
function cors(req, res) {
  const o = req.headers.origin;
  if (o && originAllowed(o)) {
    res.setHeader('Access-Control-Allow-Origin', o);
    res.setHeader('Vary', 'Origin');
  }
}

/** 본문 읽기 — 상한을 넘으면 그 자리에서 끊습니다 */
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const parts = [];
    let n = 0;
    req.on('data', (c) => {
      n += c.length;
      if (n > limit) { reject(new Error('too big')); req.destroy(); return; }
      parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

const json = (res, code, obj) => {
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
};

function rateOk(ip, now = Date.now()) {
  /* 표가 끝없이 자라지 않게 — 숫자는 한 시간이면 뜻을 잃습니다 */
  if (artRate.size > 500) artRate.clear();
  const r = artRate.get(ip);
  if (!r || now - r.at > 3600000) { artRate.set(ip, { n: 1, at: now }); return true; }
  r.n++;
  return r.n <= ART_PER_HOUR;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const path = url.pathname;

  if (req.method === 'OPTIONS') {
    cors(req, res);
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Max-Age', '86400');
    res.writeHead(204).end();
    return;
  }

  if (path === '/health' || path === '/') {
    cors(req, res);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({
      ok: true,
      players: room.size,
      uptime: Math.round(process.uptime()),
      /* ★★ 이 칸이 없으면 **4단계 이전 서버**입니다. 게임에서 작품이 저장되지
       *   않을 때 가장 먼저 볼 곳이라 일부러 자세히 적습니다. */
      gallery: {
        on: true,
        ready: gallery.ready,
        count: gallery.size,
        pending: gallery.pendingCount,
        store: !!gallery.store,
        salt: !!gallery.pinSalt,
        admin: !!ADMIN_KEY,
        /* ★ 이게 false면 **아이폰에서 올린 작품이 거절됩니다** */
        convert: !!sharp,
        ttlDays: Math.round(gallery.ttl / 86400000),
        max: gallery.max,
      },
    }));
    return;
  }

  /* ── 그림 내려받기 ────────────────────────────────────────────────────
   * ★ 번호가 임의의 11글자라 **주소를 아는 사람만** 봅니다. 승인 전 작품의
   *   번호는 주인에게만 보내므로, 목록에 없는 그림을 우연히 열 수는 없습니다. */
  if (req.method === 'GET' && /^\/art\/[\w-]{6,32}\.webp$/.test(path)) {
    const id = path.slice(5, -5);
    const buf = await gallery.image(id);
    cors(req, res);
    if (!buf) { res.writeHead(404).end(); return; }
    res.writeHead(200, {
      'Content-Type': 'image/webp',
      'Content-Length': buf.length,
      /* ★★ 같은 번호의 그림은 **영원히 같은 그림**입니다(고칠 수 없습니다).
       *   그래서 immutable — 어제 본 갤러리를 오늘 다시 받지 않습니다.
       *   무료 플랜의 대역폭을 지키는 가장 큰 한 줄입니다. */
      'Cache-Control': 'public, max-age=31536000, immutable',
    });
    res.end(buf);
    return;
  }

  /* ── 그림 맡기기 — ★★ **한 번의 요청**으로 끝납니다 ──────────────────
   *
   * 처음에는 WS로 자리표를 먼저 주고 그 다음 HTTP로 받았습니다. 그 설계는
   * **실패가 조용했습니다** — 서버가 옛 판이라 자리표 요청에 답하지 않으면
   * 게임은 8초를 기다렸다가 아무 말 없이 포기하고, 화면에는 "맡기지
   * 못했습니다" 한 줄만 떴습니다. 무엇이 틀렸는지 알 방법이 없었습니다.
   *
   * 한 번의 HTTP는 **언제나 번호로 답합니다.** 404면 서버가 옛 판,
   * 401이면 접속이 안 맞는 것, 413이면 그림이 큰 것 — 게임이 그대로
   * 화면에 적을 수 있습니다.
   *
   * ★ 주인 이름은 **보내온 것을 안 씁니다.** `sid`로 지금 접속해 있는
   *   사람을 찾아 그 사람의 이름을 적습니다 — 이름을 믿으면 아무나 남의
   *   이름으로 작품을 올릴 수 있습니다. */
  if (req.method === 'POST' && path === '/art') {
    cors(req, res);
    if (!originAllowed(req.headers.origin)) { json(res, 403, { ok: false, why: 'origin' }); return; }
    const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress || '?';
    if (!rateOk(String(ip).split(',')[0].trim())) { json(res, 429, { ok: false, why: 'rate' }); return; }

    let raw;
    try {
      /* base64라 원본의 4/3, 거기에 제목·PIN을 감싼 JSON 몫을 더합니다 */
      raw = await readBody(req, Math.ceil(ART_BYTES * 4 / 3) + 2048);
    } catch (e) {
      json(res, 413, { ok: false, why: 'size' });
      return;
    }
    let j = null;
    try { j = JSON.parse(raw.toString('utf8')); } catch (e) { j = null; }
    if (!j) { json(res, 400, { ok: false, why: 'body' }); return; }

    const ws = sockets.get(Number(url.searchParams.get('sid')));
    const p = ws ? room.players.get(ws.id) : null;
    if (!p) { json(res, 401, { ok: false, why: 'session' }); return; }
    /* ★ 이름 필터를 여기서도 봅니다 — 게임 쪽 검사는 고쳐서 보낼 수 있고,
     *   작품명은 남의 화면에 오래 남습니다. */
    if (isBadName(String(j.t || ''))) { json(res, 400, { ok: false, why: 'title' }); return; }

    const slot = gallery.reserve(p.baseName || p.name, j.t, j.p);
    if (!slot.ok) { json(res, 400, { ok: false, why: slot.why }); return; }
    const buf = Buffer.from(String(j.b || ''), 'base64');
    if (buf.length > ART_BYTES) { json(res, 413, { ok: false, why: 'size' }); return; }
    const r = await gallery.putImage(slot.id, slot.ticket, buf);
    if (!r.ok) { json(res, 400, { ok: false, why: r.why }); return; }
    /* ★ 알려 주는 크기는 **저장된 webp**입니다 — 올라온 png가 아니라.
     *   그래야 게임 콘솔에서 "400KB 보냈는데 100KB로 남았다"가 보입니다. */
    console.log(`[작품] 맡음 '${slot.id}' — ${p.name} · 저장 ${(r.bytes / 1024).toFixed(0)}KB`);
    json(res, 200, { ok: true, id: slot.id, bytes: r.bytes });
    return;
  }

  /* ── 관리자 ────────────────────────────────────────────────────────────
   * ★★ 게임 안(개발자모드)이 아니라 **따로 한 장의 웹페이지**로 둡니다.
   *   승인은 게임을 켜지 않고 휴대폰에서 잠깐 보는 일이고, 그때마다 3D를
   *   띄우고 걸어가야 한다면 결국 안 하게 됩니다. */
  if (path === '/art/admin' && req.method === 'GET') {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(ADMIN_HTML);
    return;
  }
  if (path === '/art/admin/api' && req.method === 'POST') {
    let body = {};
    try { body = JSON.parse((await readBody(req, 4096)).toString('utf8')); } catch (e) { body = {}; }
    if (!ADMIN_KEY) { json(res, 403, { ok: false, why: 'ADMIN_KEY 미설정' }); return; }
    if (body.key !== ADMIN_KEY) { json(res, 403, { ok: false, why: '관리자 키가 다릅니다' }); return; }
    if (body.a === 'list') { json(res, 200, { ok: true, v: gallery.adminList() }); return; }
    const before = gallery.items.get(body.id);
    if (!before) { json(res, 404, { ok: false, why: '없는 작품입니다' }); return; }
    if (body.a === 'approve') {
      const m = await gallery.approve(body.id);
      console.log(`[작품] 승인 — '${m.title}' (${m.owner})`);
      /* ★ 승인하는 순간 **접속해 있는 모두에게** 나타납니다. 다음에 들어올
       *   때까지 기다리게 하면 승인했는지 확인할 방법이 없습니다. */
      if (m.state === ART.APPROVED) broadcastArt(m);
      json(res, 200, { ok: true, v: gallery.adminList() });
      return;
    }
    if (body.a === 'reject') {
      const m = await gallery.reject(body.id);
      console.log(`[작품] 승인 취소 — '${m.title}'`);
      broadcast({ t: 'art', a: 'gone', i: body.id });
      sendArtTo(m.key);
      json(res, 200, { ok: true, v: gallery.adminList() });
      return;
    }
    if (body.a === 'del') {
      console.log(`[작품] 삭제 — '${before.title}' (${before.owner})`);
      await gallery.remove(body.id);
      broadcast({ t: 'art', a: 'gone', i: body.id });
      json(res, 200, { ok: true, v: gallery.adminList() });
      return;
    }
    json(res, 400, { ok: false, why: '알 수 없는 요청' });
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
        if (ball.leave(prev.id, [...sockets.keys()])) {
          broadcast({ t: 'ball', ...ball.wire(), own: 1 });
        }
        for (const n of left.freedNpc) broadcast({ t: 'npc', a: 'busy', n, by: 0 });
        broadcast({ t: 'leave', id: prev.id });
        if (old && old !== ws) { old.id = null; old.close(); }
        console.log(`  ↻ ${prev.name} 재접속 — 앞 접속(#${prev.id})을 치웁니다`
          + `${carry ? ` · ${carry}점 이어받음` : ''}`);
      }

      /* 오래 비어 있던 방이면 공을 해변 가운데로 (세션 8-3) */
      if (room.size === 0 && ball.maybeReset(Date.now(), BALL_RESET_MS)) {
        console.log(`  ⚽ ${BALL_RESET_MS / 60000}분 넘게 아무도 없었습니다 — 비치볼을 해변 가운데로`);
      }
      const r = room.join(cleaned, Date.now(), { sid: m.sid, score: carry });
      if (!r.ok) { ws.send(JSON.stringify({ t: 'deny', why: r.reason })); ws.close(); return; }
      ws.id = r.player.id;
      sockets.set(ws.id, ws);
      ball.join(ws.id);                              // 임자가 없으면 이 사람이 임자
      // 지금 방에 있는 사람들의 명단을 함께 보냅니다 (이름은 여기서 한 번만)
      ws.send(JSON.stringify({
        t: 'welcome', id: r.player.id, n: r.player.name, hz: TICK_HZ,
        p: room.roster(r.player.id),
        // 지금 떠 있는 물감. 좌표가 아니라 **스폰 번호**만 보냅니다
        it: room.itemList(),
        cfg: room.settingsWire(), // 모두에게 같아야 하는 설정 (화면 효과 등)
        sc: r.player.score,       // 내 점수 (같은 탭의 재접속이면 이어받습니다)
        bd: room.topScores(5),    // 상위 5명
        /* 지금 누군가 말을 걸고 있는 NPC. ★ 늦게 들어온 사람도 곧바로
         * '이미 대화중'을 알 수 있어야 합니다 */
        np: room.npcBusyList(),
        /* 해변 비치볼 — 마지막 상태와 임자(없으면 s:null — 임자가 해변 가운데에 놓습니다) */
        bl: ball.wire(),
      }));
      broadcast({ t: 'join', ...Room.meta(r.player) }, r.player.id);
      console.log(`+ ${r.player.name} (#${r.player.id}) — ${room.size}명`);
      /* ★ 작품은 **welcome에 싣지 않습니다.** 300점이면 그 한 통이 20KB가
       *   되는데, 접속의 첫 응답은 가벼워야 화면이 빨리 움직입니다. */
      sendArtList(ws, r.player);
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
    } else if (m.t === 'color') {
      // 몸 색이 바뀌었다는 알림. 형식만 확인하고 그대로 나눠 줍니다
      const hex = m.c === null || m.c === undefined ? null : m.c;
      if (room.setColor(ws.id, hex)) broadcast({ t: 'color', id: ws.id, c: hex }, ws.id);
    } else if (m.t === 'ball') {
      /* 해변 비치볼. ★ 친 것(hit)은 언제나 받고 임자가 바뀝니다. 갱신(up)은
       *   임자의 것만 받습니다 — 방금 남에게 빼앗긴 옛 임자의 늦은 갱신은 버립니다. */
      if (m.a === 'hit') {
        if (ball.hit(ws.id, m.s)) {
          broadcast({ t: 'ball', ...ball.wire(), h: 1 }, ws.id);
          /* ★ (세션 8-4) 친 사람에게 **자기 임자 번호**를 알립니다 — 동시에 쳤을 때 가리려고 */
          ws.send(JSON.stringify({ t: 'ball', a: 'ok', e: ball.epoch, o: ws.id }));
        }
      } else if (m.a === 'up') {
        if (ball.update(ws.id, m.s)) broadcast({ t: 'ball', ...ball.wire() }, ws.id);
      }
    } else if (m.t === 'art') {
      /* 작품. ★ 그림 자체는 여기로 오지 않습니다(HTTP). 여기는 **번호와
       * 좌표와 PIN**만 오갑니다 — 전부 합쳐 200바이트 남짓입니다. */
      handleArt(ws, m).catch((e) => console.log(`[작품] 처리 실패: ${e.message}`));
    }
  });

  const bye = () => {
    if (ws.id === null) return;
    const p = room.players.get(ws.id);
    const left = room.leave(ws.id);
    sockets.delete(ws.id);
    /* 공의 임자가 나가면 남은 사람에게 넘깁니다 — 공중에서 멈춰 버리지 않게 */
    if (ball.leave(ws.id, [...sockets.keys()])) broadcast({ t: 'ball', ...ball.wire(), own: 1 });
    if (sockets.size === 0) ballRoomEmpty();
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

/* ── 작품 ─────────────────────────────────────────────────────────────────── */

const send = (ws, obj) => {
  if (ws && ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
};

/**
 * 이 사람이 볼 수 있는 것만 보냅니다.
 *
 * ★★ **승인 전 작품은 아예 안 보냅니다.** "보내 놓고 게임이 가린다"면
 *   개발자도구를 열어 볼 줄 아는 누구에게나 보입니다 — 남의 포트폴리오에
 *   걸릴 그림입니다. 안 보내야 안 보이는 것입니다.
 */
function sendArtList(ws, player, tries = 0) {
  /* ★★ 저장소에서 다 불러오기 **전에** 보내면 빈 목록이 갑니다. 게임 쪽은
   *   그 목록에 없는 작품을 걷어 내므로(`reconcile`), 깨어나는 순간 접속한
   *   사람의 화면에서 **들판이 통째로 비워집니다.** 잠깐 기다립니다. */
  if (!gallery.ready && tries < 12) {
    setTimeout(() => sendArtList(ws, player, tries + 1), 700);
    return;
  }
  const who = player.baseName || player.name;
  send(ws, { t: 'art', a: 'list', v: gallery.visibleTo(who) });
  /* 창을 닫을 때 머리에 이고 있던 작품 — 다시 얹어 줍니다 */
  const held = gallery.heldBy(who);
  if (held) send(ws, { t: 'art', a: 'hold', v: held });
}

/**
 * 작품 하나를 **보는 사람마다 다르게** 보냅니다.
 *
 * ★★ 한 벌을 그대로 방송하면 '내 작품인가'(`m`)가 **모두에게 같은 값**으로
 *   갑니다. 승인된 작품이 나타나는 순간 주인에게도 '남의 것'으로 보여
 *   회수 버튼이 사라집니다. 사람 수가 몇 안 되니 한 사람씩 만듭니다.
 */
function broadcastArt(meta, exceptId = null) {
  for (const [id, ws] of sockets) {
    if (id === exceptId) continue;
    const p = room.players.get(id);
    if (!p) continue;
    send(ws, { t: 'art', a: 'set', v: Gallery.wire(meta, ownerKey(p.baseName || p.name)) });
  }
}

/** 그 이름으로 접속해 있는 사람들에게 목록을 다시 보냅니다 (승인 취소 등) */
function sendArtTo(key) {
  for (const [id, ws] of sockets) {
    const p = room.players.get(id);
    if (!p) continue;
    if (ownerKey(p.baseName || p.name) !== key) continue;
    send(ws, { t: 'art', a: 'list', v: gallery.visibleTo(p.baseName || p.name) });
  }
}

async function handleArt(ws, m) {
  const p = room.players.get(ws.id);
  if (!p) return;
  const who = p.baseName || p.name;

  if (m.a === 'place') {
    const r = await gallery.place(m.i, who, m.x, m.z, m.r);
    if (!r.ok) { send(ws, { t: 'art', a: 'err', i: m.i, why: r.why }); return; }
    send(ws, { t: 'art', a: 'set', v: Gallery.wire(r.meta, ownerKey(who)) });
    console.log(`[작품] 세움 '${r.meta.title}' (${r.meta.owner})`
      + ` — ${r.meta.state === ART.APPROVED ? '승인됨' : '승인 대기'}`);
    /* 승인된 작품을 옮겼다면 남들의 화면에서도 옮겨져야 합니다 */
    if (r.meta.state === ART.APPROVED) broadcastArt(r.meta, ws.id);
    return;
  }

  if (m.a === 'recall') {
    const r = await gallery.recall(m.i, who, m.pin);
    if (!r.ok) { send(ws, { t: 'art', a: 'err', i: m.i, why: r.why }); return; }
    send(ws, { t: 'art', a: 'back', i: m.i });
    /* 남들 화면에서는 그 자리에서 사라집니다(승인된 것이었다면) */
    if (r.wasPlaced) broadcast({ t: 'art', a: 'gone', i: m.i }, ws.id);
    return;
  }

  send(ws, { t: 'art', a: 'err', why: 'what' });
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

/* ── 승인되지 않은 작품 걷기 ─────────────────────────────────────────────
 * ★★ 저장소의 만료(EX)가 이미 지워 주지만, 그건 **다음에 깨어날 때**에나
 *   드러납니다. 며칠 내리 떠 있으면 메모리의 목록에 유령이 남아 "사라졌어야
 *   할 작품이 아직 서 있는" 상태가 됩니다. 한 시간에 한 번 훑습니다 —
 *   7일짜리 시한에 한 시간의 오차는 아무 뜻이 없고, Upstash 요청은 아낍니다. */
setInterval(() => {
  gallery.sweep().then((gone) => {
    for (const id of gone) broadcast({ t: 'art', a: 'gone', i: id });
  }).catch(() => {});
}, 3600000);

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
    loadBall();
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

  /* ── 작품 ── */
  console.log(`작품 갤러리 — 최대 ${gallery.max}점 · 승인 전 ${Math.round(gallery.ttl / 86400000)}일 뒤 사라짐`
    + ` · 한 장 ${Math.round(ART_BYTES / 1024)}KB까지`);
  if (!gallery.store) {
    console.log('· ★ 작품이 메모리에만 있습니다 — 서버가 자면 전부 사라집니다.'
      + ' SCORE_STORE_URL/TOKEN(또는 ART_STORE_URL/TOKEN)을 넣으세요');
  }
  if (!gallery.pinSalt) console.log('· ⚠ ART_PIN_SALT 미설정 — 넣어 두세요(PIN 해시의 소금입니다)');
  loadConverter().then((ok) => {
    console.log(ok
      ? '· png → webp 변환 준비됨 (sharp) — 아이폰에서 올린 작품도 webp로 저장됩니다'
      : '· ⚠ sharp 없음 — webp를 못 만드는 기기(아이폰 등)의 작품을 받을 수 없습니다.'
        + ' server/package.json에 sharp가 있는지, 빌드가 성공했는지 보세요');
  });
  if (!ADMIN_KEY) console.log('· ⚠ ADMIN_KEY 미설정 — 작품을 승인할 수 없습니다 (/art/admin)');
  /* ★ 약속을 놓치면 Node 22는 **프로세스를 내립니다.** 저장소가 잠깐
   *   말을 안 듣는다고 서버가 내려가서는 안 됩니다. */
  gallery.load().catch((e) => console.log(`[작품] 불러오기 실패: ${e.message}`));
});
