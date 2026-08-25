/**
 * 방 로직 검증 — 소켓 없이 순수 로직만 돌립니다.
 *   node test.js
 */
import { Room, sanitizeName } from './room.js';
import { SPAWN_COUNT, spawnAt } from './spawns.js';
import { PAINTS } from './palette.js';

let fail = 0;
const ok = (cond, name, extra = '') => {
  if (!cond) fail++;
  console.log(`  ${cond ? '✔' : '✘'} ${name}${extra ? '  ' + extra : ''}`);
};

console.log('이름 정리');
ok(sanitizeName('  베니  ') === '베니', '앞뒤 공백 제거');
ok(sanitizeName('a\u202eb') === 'ab', '방향 재정의 문자 제거 (이름을 거꾸로 뒤집는 공격)');
ok(sanitizeName('줄\n바꿈') === '줄 바꿈', '줄바꿈은 공백으로');
ok(sanitizeName('가나다라마바사아자차카타파하', 12).length === 12, '길이 제한');
ok(sanitizeName('') === '' && sanitizeName(null) === '', '빈 이름은 빈 문자열');

console.log('\n접속');
const room = new Room({ maxPlayers: 3, nameMax: 12 });
const a = room.join('베니');
const b = room.join('베니');
ok(a.ok && b.ok, '두 명 접속');
ok(a.player.name === '베니' && b.player.name === '베니 2', '같은 이름은 서버가 갈라 줌', `→ "${b.player.name}"`);
ok(!room.join('').ok, '빈 이름 거절');
const c = room.join('세번째');
ok(c.ok && !room.join('네번째').ok, '정원(3)을 넘으면 거절');

console.log('\n상태');
room.setState(a.player.id, { x: 10, y: 2, z: -3, yaw: 1.2, mv: 0.7, sw: 0, air: 1 });
const pa = room.players.get(a.player.id);
ok(pa.x === 10 && pa.air === 1, '정상 값 반영');
room.setState(a.player.id, { x: NaN, y: Infinity, z: 'zz', yaw: undefined });
ok(pa.x === 10 && pa.y === 2 && pa.z === -3 && pa.yaw === 1.2,
  'NaN/Infinity/문자열은 무시하고 직전 값 유지');
room.setState(a.player.id, { mv: 5, sw: -2 });
ok(pa.mv === 1 && pa.sw === 0, '블렌드 값은 0~1로 잘림');
ok(!room.setState(9999, { x: 1 }), '없는 id는 무시');

console.log('\n스냅샷');
const snapForA = room.snapshot(a.player.id);
ok(!snapForA.p.some((p) => p.id === a.player.id), '자기 자신은 빠짐 (받아서 덮으면 조작이 끊깁니다)');
ok(snapForA.p.length === room.size - 1, `나머지 ${room.size - 1}명 포함`);
const wire = snapForA.p[0];
ok(!('n' in wire), '이름은 스냅샷에 없음 (접속할 때 한 번만 받습니다)');
ok(room.roster(a.player.id).every((m) => m.n), '명단(roster)에는 이름이 들어 있음');
ok(!('c' in wire), '색은 스냅샷에 없음 (드물게 바뀌는 값을 초당 20번 보낼 이유가 없습니다)');

console.log('\n몸 색');
ok(room.setColor(a.player.id, '#f58a8a'), '정상 색 문자열은 받아들임');
ok(room.players.get(a.player.id).color === '#f58a8a', '저장됨');
ok(!room.setColor(a.player.id, 'red'), '이름은 거절 (그대로 남의 재질에 들어갑니다)');
ok(!room.setColor(a.player.id, '#12345'), '자릿수가 다르면 거절');
ok(!room.setColor(a.player.id, '<img onerror=1>'), '엉뚱한 문자열 거절');
ok(room.players.get(a.player.id).color === '#f58a8a', '거절돼도 직전 값은 그대로');
ok(room.setColor(a.player.id, null), '기본색으로 되돌리기(null)는 허용');
ok(room.players.get(a.player.id).color === null, '되돌아감');
ok(!room.setColor(99999, '#ffffff'), '없는 id는 무시');
ok(room.roster(b.player.id).length === room.size - 1, '명단에 색이 함께 실림 (늦게 온 사람도 남의 색을 봅니다)');

console.log('\n★ 물감 아이템 — 서버가 진실을 가집니다');
{
  const R = new Room({
    maxPlayers: 8,
    itemCount: 5,
    itemRespawn: 60000,
    itemColors: PAINTS.length,
    spawnCount: SPAWN_COUNT,
    claimRange: 12,
    spawnAt,
  });
  ok(SPAWN_COUNT > 0, '스폰표를 읽었다', `${SPAWN_COUNT}자리`);

  const t0 = 1000000;
  const first = R.tickItems(t0);
  ok(first.added.length === 5 && R.items.length === 5, '설정한 개수만큼 채운다', `${R.items.length}개`);
  ok(R.tickItems(t0 + 50).added.length === 0, '이미 다 찼으면 더 만들지 않는다');
  ok(new Set(R.items.map((i) => i.spawn)).size === 5,
    '두 개가 같은 자리에 겹치지 않는다 (겹치면 하나만 보입니다)');
  ok(R.items.every((i) => i.color >= 0 && i.color < PAINTS.length), '색 번호가 범위 안');

  // 아이템 옆으로 걸어간 플레이어
  const target = R.items[0];
  const at = spawnAt(target.spawn);
  const p1 = R.join('먹는사람', t0);
  const p2 = R.join('늦은사람', t0);
  R.setState(p1.player.id, { x: at.x + 0.5, z: at.z - 0.4 }, t0);
  R.setState(p2.player.id, { x: at.x + 0.9, z: at.z + 0.2 }, t0);

  const win = R.takeItem(p1.player.id, target.id, t0);
  ok(win.ok && win.item.id === target.id, '가까이 있으면 가져간다');
  const lose = R.takeItem(p2.player.id, target.id, t0);
  ok(!lose.ok && lose.reason === 'gone',
    '★ 같은 물감을 두 사람이 먹을 수 없다 (먼저 온 사람이 가져갑니다)');
  ok(R.items.length === 4, '목록에서 빠졌다');

  // 멀리서 먹었다고 우기기
  const far = R.items[0];
  const fa = spawnAt(far.spawn);
  R.setState(p2.player.id, { x: fa.x + 300, z: fa.z + 300 }, t0);
  const cheat = R.takeItem(p2.player.id, far.id, t0);
  ok(!cheat.ok && cheat.reason === 'far', '지도 반대편에서 주웠다고 하면 거절');
  ok(R.items.length === 4, '거절됐으니 그대로 남아 있다');
  ok(!R.takeItem(p1.player.id, 999999, t0).ok, '없는 아이템은 거절');

  // 1분 뒤 되살아나기
  ok(R.tickItems(t0 + 30000).added.length === 0, '30초에는 아직 안 돌아온다');
  const back = R.tickItems(t0 + 60001);
  ok(back.added.length === 1 && R.items.length === 5, '★ 1분 뒤에 다시 나타난다');
  ok(back.added[0].color === target.color,
    '같은 색으로 돌아온다 (일곱 색이 골고루 남습니다)', `색 ${back.added[0].color}`);
  ok(back.added[0].spawn !== target.spawn || SPAWN_COUNT < 2,
    '다른 자리에서 나타난다');
  ok(back.added[0].id !== target.id, '아이디는 새로 받는다 (먹은 것과 헷갈리면 안 됩니다)');

  // 아이디가 겹치지 않는가 — 오래 돌려 보기
  const ids = new Set(R.items.map((i) => i.id));
  let now = t0 + 60001;
  for (let k = 0; k < 200; k++) {
    const it = R.items[0];
    const pos = spawnAt(it.spawn);
    R.setState(p1.player.id, { x: pos.x, z: pos.z }, now);
    R.takeItem(p1.player.id, it.id, now);
    now += 61000;
    for (const nu of R.tickItems(now).added) ids.add(nu.id);
  }
  ok(ids.size >= 200, '200번 먹고 되살려도 아이디가 겹치지 않는다', `${ids.size}개`);
  ok(R.items.length === 5, '개수가 계속 유지된다', `${R.items.length}개`);

  console.log('\n  일곱 색이 고루 남는가');
  {
    const R2 = new Room({
      itemCount: 14, itemRespawn: 1, itemColors: PAINTS.length,
      spawnCount: SPAWN_COUNT, spawnAt, claimRange: 12,
    });
    R2.tickItems(0);
    const tally = new Array(PAINTS.length).fill(0);
    for (const i of R2.items) tally[i.color]++;
    ok(tally.every((t) => t >= 1),
      '★ 처음부터 일곱 색이 모두 떠 있다',
      tally.map((t, i) => `${PAINTS[i].name}${t}`).join(' '));
    ok(Math.max(...tally) - Math.min(...tally) <= 1, '치우치지 않는다');
  }

  console.log('\n  모두에게 나눠 주는 설정');
  {
    ok(JSON.stringify(R.settingsWire()) === '{}',
      '처음에는 서버가 관여하지 않는다 (각자의 config 기본값을 씁니다)');
    ok(R.setSetting('blur', false), '아는 이름은 바꾼다');
    ok(R.settingsWire().blur === false, '나눠 줄 값에 들어간다');
    ok(!R.setSetting('없는설정', true), '★ 모르는 이름은 거절 (오타로 이상한 값이 퍼지면 안 됩니다)');
    R.setSetting('blur', null);
    ok(!('blur' in R.settingsWire()), 'null이면 다시 관여하지 않는다');
  }

  console.log('\n  점수 (자세한 검사는 test/score_test.mjs)');
  {
    const it = R.items[0];
    ok(it.score === 1, '아이템이 자기 점수를 들고 있다', `${it.score}점`);
    ok(Room.itemWire(it).v === 1, '전선에 점수 값(v)이 실린다');
    const before = R.players.get(p1.player.id).score;
    ok(R.addScore(p1.player.id, 3) === before + 3, '★ 점수는 서버가 올린다');
    ok(R.topScores(5).some((e) => e.n === '먹는사람'), '순위표에 올라간다');
    R.removeScore('먹는사람');
    ok(!R.topScores(5).some((e) => e.n === '먹는사람'), '기록을 지울 수 있다');
    ok(R.join('먹는사람', 0).player.baseName === '먹는사람',
      '★ 순위표용 이름은 표시 이름과 별개 (같은 이름으로 다시 와도 줄이 안 늘어납니다)');
  }

  const wireItem = Room.itemWire(R.items[0]);
  ok('i' in wireItem && 's' in wireItem && 'c' in wireItem && !('born' in wireItem),
    '전선에는 아이디·스폰번호·색만 (좌표는 표에서 각자 읽습니다)',
    JSON.stringify(wireItem));
  console.log(`  · 물감 5개 명단 ${JSON.stringify(R.itemList()).length} B — 접속할 때 한 번뿐입니다`);
}

console.log('\n정리');
const r2 = new Room({ staleAfter: 1000 });
const p = r2.join('테스트', 0);
r2.setState(p.player.id, { x: 1 }, 0);
ok(r2.sweep(500).length === 0, '0.5초는 살아 있음');
ok(r2.sweep(2000).length === 1 && r2.size === 0, '조용한 지 오래면 정리 (유령 플레이어 방지)');

console.log('\n대역폭 어림');
const big = new Room({ maxPlayers: 20 });
for (let i = 0; i < 15; i++) {
  const j = big.join('플레이어' + i);
  big.setState(j.player.id, { x: 123.456, y: 7.89, z: -45.6, yaw: 2.345, mv: 0.5, sw: 0 });
}
const bytes = JSON.stringify(big.snapshot(1)).length;
const hz = 12;
console.log(`  15명 스냅샷 ${bytes} B → 한 명당 ${(bytes * hz / 1024).toFixed(1)} KB/s`
  + `, 서버 송신 합계 ${(bytes * hz * 15 / 1024).toFixed(0)} KB/s`);

console.log(fail === 0 ? '\n전부 통과' : `\n${fail}건 실패`);
process.exit(fail === 0 ? 0 : 1);
