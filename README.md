# VENIE FIELD 멀티플레이 서버

위치·이름만 중계하는 아주 가벼운 Node + WebSocket 서버입니다.
Render 무료 플랜에 그대로 올라갑니다.

```
server/
├─ server.js   WebSocket + 헬스체크 (환경변수로만 설정)
├─ room.js     방 로직 — 네트워크와 분리되어 있어 Node에서 그대로 검증됩니다
├─ test.js     그 검증
└─ package.json
```

## 왜 이렇게 가벼운가

지형이 **시드 기반 결정적 생성**이라 모든 브라우저가 같은 월드를 만듭니다.
서버가 월드를 들고 있을 필요가 없어서, 하는 일이 "누가 어디에 있는지 나눠 주기"
뿐입니다. 15명이 붙어도 초당 180KB 정도이고 메모리는 몇 MB입니다.

## 로컬에서 돌려보기

```bash
cd server
npm install
npm start          # http://localhost:8080/health 로 확인
npm test           # 방 로직 검증 (서버를 띄우지 않아도 됩니다)
```

게임 쪽 `src/config.js`에서:

```js
net: { url: 'ws://localhost:8080' }
```

로컬은 http라 `ws://`, 실제 사이트는 https라 반드시 **`wss://`** 입니다.

## Render에 올리기

1. **GitHub 저장소에 `server/` 폴더를 올립니다.** (게임 파일과 같은 저장소여도 됩니다)
2. Render → **New → Web Service** → 그 저장소 선택
3. 설정
   | 항목 | 값 |
   |---|---|
   | Root Directory | `server` |
   | Runtime | Node |
   | Build Command | `npm install` |
   | Start Command | `npm start` |
   | Instance Type | **Free** |
4. **Environment** 탭에서 환경변수를 추가합니다.

   | 이름 | 값 | 설명 |
   |---|---|---|
   | `ALLOW_ORIGIN` | `https://내사이트주소` | ★ 아래 설명 참고 |
   | `MAX_PLAYERS` | `24` | 선택 |
   | `TICK_HZ` | `12` | 선택. `config.net.sendRate`와 같게 |

   `PORT`는 **넣지 마세요.** Render가 알아서 넣어 주고, 서버가 그 값을 씁니다.

5. 배포가 끝나면 `https://이름.onrender.com` 주소를 받습니다.
   `src/config.js`의 `net.url`에 **`wss://이름.onrender.com`** 으로 넣으세요
   (https가 아니라 **wss**).

### ★ ALLOW_ORIGIN을 꼭 넣으세요

**브라우저는 WebSocket에 CORS를 적용하지 않습니다.** 즉 서버가 직접 막지 않으면
아무나 자기 사이트에서 이 서버에 붙을 수 있습니다. 무료 플랜의 대역폭을 지키기
위해서라도 사이트 주소를 넣어 두세요. 여러 개면 쉼표로 구분합니다.

```
ALLOW_ORIGIN=https://내사이트.com,http://localhost:5500
```

## 무료 플랜에서 알아야 할 것

- **15분간 들어오는 트래픽이 없으면 잠듭니다.** 다시 깨는 데 1분쯤 걸립니다.
  다만 연결된 WebSocket에서 오는 메시지도 트래픽으로 쳐 주므로,
  **한 명이라도 접속해 있으면 잠들지 않습니다**(클라이언트가 20초마다 핑을 보냅니다).
- 그래도 첫 방문자는 최대 1분을 기다릴 수 있습니다. 그래서 게임은 **서버 없이도
  그냥 돕니다** — 혼자 걷다가 연결되면 그때부터 다른 사람이 나타납니다.
  이건 버그가 아니라 의도된 동작입니다.
- 계속 깨워 두려면 [cron-job.org](https://cron-job.org) 같은 곳에서
  `https://이름.onrender.com/health`를 **10분마다** 두드리게 하세요.
  무료 한도가 월 750시간이라 24시간 내내 켜 두어도(약 730시간) 서비스 하나는 들어갑니다.
- 무료 플랜은 배포할 때마다 주소가 유지되지만, 서비스를 지웠다 만들면 바뀝니다.
  주소가 바뀌면 `config.net.url`도 함께 고쳐야 합니다.

## 나중에 물감·NPC를 붙일 때

`room.js`에 자리를 비워 두었습니다.

- `Room.items` — 서버가 소유할 것들이 들어갈 배열
- `player.color` — 물감을 먹었을 때의 색. 지금은 아무도 안 쓰지만 프로토콜에는
  이미 자리가 있어서(`c` 필드) 프로토콜을 새로 짜지 않아도 됩니다
- `server.js`의 틱 루프가 이미 **서버 주도**입니다. 아이템 스폰·수명·획득 판정을
  그 안에 넣으면 됩니다

★ 아이템 획득 판정은 **반드시 서버에서** 해야 합니다. 클라이언트가 "내가 먹었다"고
보내는 것을 믿으면 두 사람이 같은 물감을 동시에 먹습니다.
