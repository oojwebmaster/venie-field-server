/**
 * 방 로직 검증 — 소켓 없이 순수 로직만 돌립니다.
 *   node test.js
 */
import { Room, sanitizeName } from './room.js';

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
ok(!('c' in wire), '색은 아직 아무도 안 씀 (물감 기능 자리)');

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
