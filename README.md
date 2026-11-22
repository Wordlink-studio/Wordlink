# WORDLINK

친구와 실시간으로 즐기는 한국어 끝말잇기 웹게임입니다.
정적 파일은 **GitHub Pages**, 로그인·데이터는 **Firebase(Auth + Realtime Database)** 가 맡습니다.

## Google 로그인이 동작하려면 (Firebase 콘솔)

1. Authentication → Sign-in method → **Google 사용 설정**
2. Authentication → Settings → **승인된 도메인**에 `<아이디>.github.io` 추가
3. Realtime Database → 규칙에 `database.rules.json` 내용 게시
4. 팝업이 `…firebaseapp.com/__/auth/handler` 에서 404 이면: 콘솔 **Hosting → 시작하기**로 기본 사이트를 한 번 만들기

## 현재 상태

- 동작: 로그인, 로비, 방 만들기·입장, 채팅, 프로필, 랭킹
- 미구현: 게임 진행(단어 검증, 턴 타이머, 점수, 라운드, 미션). `room:start`, `game:submit` 은 안내 메시지만 돌려줍니다.

## 로컬 실행 · 테스트

```
npm start      # http://localhost:3000 (정적 서버)
npm test       # 끝말잇기 규칙 테스트
npm run check  # 문법 검사
```

## 파일

| 파일 | 설명 |
| --- | --- |
| `index.html` | 진입 페이지, Firebase 웹 앱 설정 |
| `client.js` | 화면과 게임 UI |
| `firebase-client.js` | Firebase 인증·DB 연동 (ES 모듈) |
| `game-rules.js` | 끝말잇기 규칙 (두음법칙 등) |
| `database.rules.json` | Realtime Database 보안 규칙 |
| `words.json` | 단어 사전 |
| `mascot.js`, `mascot.css`, `styles.css` | 마스코트와 스타일 |
