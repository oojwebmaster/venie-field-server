/**
 * VENIE FIELD — 이름 비속어 필터
 *
 * ★ 이 파일은 **`src/badwords.js`와 `server/badwords.js` 두 곳에 같은 내용**으로
 *   있어야 합니다. 게임은 FTP로 카페24에, 서버는 GitHub로 Render에 올라가서
 *   파일을 공유할 수가 없기 때문입니다.
 *   `test/wire_test.mjs`가 두 파일이 한 글자라도 다르면 실패시킵니다.
 *
 * ## 클라이언트와 서버 양쪽에서 다 거릅니다
 * - 클라이언트: 들어가기 전에 바로 알려 주기 위해 (사용자 경험)
 * - 서버: 클라이언트를 고쳐서 보내는 것을 막기 위해 (실제 차단)
 *   `api_works.php`가 저장 권한을 서버에서 다시 확인하는 것과 같은 이유입니다.
 *
 * ## 우회를 막는 방법
 * 그냥 문자열 포함 검사만 하면 `시1발`, `ㅅ ㅂ`, `f@ck` 같은 것이 전부 통과합니다.
 * 그래서 비교 전에 이름을 **한 줄로 눌러 씁니다**(정규화).
 *   · 공백·기호·숫자 사이 구분 제거
 *   · 흔한 치환 되돌리기 (0→o, 1→i, 3→e, @→a, $→s, 4→a, 5→s, 7→t)
 *   · 같은 글자 반복 줄이기 (ㅅㅂㅂㅂ → ㅅㅂ)
 *
 * ## 완벽할 수 없습니다
 * 비속어 필터는 원래 다 잡지 못합니다. 목표는 **무심코 지나가는 것을 막는 것**이고,
 * 작정하고 우회하는 사람까지 막으려면 필연적으로 멀쩡한 이름을 튕겨내게 됩니다.
 * 그래서 목록은 짧고 확실한 것만 담았습니다.
 */

/** 치환 문자 되돌리기 */
const LEET = {
  0: 'o', 1: 'i', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b',
  '@': 'a', $: 's', '!': 'i', '|': 'i', '+': 't',
};

/**
 * 비교하기 좋게 눌러 씁니다.
 * 원본 이름은 그대로 두고, **검사할 때만** 이 형태를 씁니다.
 */
export function normalize(name, leet = true) {
  let s = String(name || '').toLowerCase();
  /* ★ 치환 되돌리기는 **양날의 칼**입니다.
   * `1`을 `i`로 바꾸면 `sh1t`은 잡히지만 한국어 `시 1 발`은 `시i발`이 되어
   * 오히려 빠져나갑니다. 그래서 두 가지로 눌러 쓴 뒤 **둘 다** 검사합니다.
   *   leet = true  → 숫자·기호를 글자로 (영어 우회 잡기)
   *   leet = false → 숫자·기호를 통째로 제거 (한글 사이에 낀 숫자 잡기) */
  if (leet) s = s.replace(/[0134578@$!|+]/g, (c) => LEET[c] || c);
  s = s.replace(
    leet ? /[^0-9a-z\uac00-\ud7a3\u3131-\u318e]/g : /[^a-z\uac00-\ud7a3\u3131-\u318e]/g,
    ''
  );
  // 세 번 이상 반복은 두 번으로 (ㅅㅂㅂㅂㅂ → ㅅㅂㅂ)
  s = s.replace(/(.)\1{2,}/g, '$1$1');
  return s;
}

/* 한국어. 자모만 쓴 형태(ㅅㅂ 등)도 함께 넣습니다.
 * ★ 짧은 낱말은 멀쩡한 이름에 우연히 들어가기 쉬우므로 신중히 골랐습니다. */
const KO = [
  '시발', '씨발', 'ㅅㅂ', '시바', '씹', '시팔', '시빨', '씨팔', '썅', '병신', 'ㅂㅅ', '지랄', 'ㅈㄹ',
  '개새끼', '새끼', '좆', '좃', 'ㅈ같', '니미', '느금', '엠창', '애미',
  '창녀', '보지', '자지', '섹스', '강간', '따먹',
  '미친놈', '미친년', '개년', '개놈', '등신', '븅신', '멍청이',
  '죽어라', '뒤져', '꺼져', 
];

/* 영어. 단어 경계를 볼 수 없는(정규화하며 공백을 지웠으므로) 방식이라
 * 짧은 낱말은 오탐이 납니다 — 예를 들어 'ass'는 'class', 'grass'에 들어갑니다.
 * 그래서 짧은 것은 아래 EN_WORD에서 **낱말 단위**로만 봅니다. */
const EN = [
  'fuck', 'fuk', 'fck', 'fack', 'fcuk', 'shit', 'bitch', 'bastard', 'asshole',
  'cunt', 'dick', 'pussy', 'penis', 'vagina', 'nigger', 'nigga',
  'whore', 'slut', 'retard', 'faggot', 'rape', 'nazi', 'hitler',
];
/** 정규화 **전**의 원본에서 낱말 단위로만 보는 것들 (오탐 방지) */
const EN_WORD = ['ass', 'sex', 'cum', 'fag', 'jap', 'kkk'];

/**
 * @param {string} name
 * @returns {boolean} 비속어가 들어 있으면 true
 */
export function isBadName(name) {
  const raw = String(name || '').toLowerCase();
  // 두 가지로 눌러 쓴 뒤 둘 다 봅니다 (위 normalize 설명 참조)
  const forms = [normalize(name, true), normalize(name, false)];
  if (!forms[0] && !forms[1]) return false;
  for (const n of forms) {
    for (const w of KO) if (n.includes(w)) return true;
    for (const w of EN) if (n.includes(w)) return true;
  }
  // 낱말 단위 — 'class'가 'ass'로 걸리지 않도록
  const words = raw.split(/[^0-9a-z\uac00-\ud7a3]+/).filter(Boolean);
  for (const w of EN_WORD) if (words.includes(w)) return true;
  return false;
}
