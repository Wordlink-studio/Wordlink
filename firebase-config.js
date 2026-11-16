'use strict';

// Firebase 설정 (환경변수에서 읽거나, index.html의 데이터 속성에서 읽음)
// 이 파일은 브라우저에서 직접 사용됩니다.
// Firebase 콘솔 > 프로젝트 설정 > 일반 > 앱 추가 > 웹 에서 설정 값을 복사해 오세요.

const firebaseConfig = {
  apiKey: "AIzaSyDUhbQL0KQCh140aTpIOOmFsesDLM9Og_I",
  authDomain: "wordlink-games.firebaseapp.com",
  databaseURL: "https://wordlink-games-default-rtdb.asia-southeast1.firebasedatabase.app",
  projectId: "wordlink-games",
  storageBucket: "wordlink-games.firebasestorage.app",
  messagingSenderId: "1084270490992",
  appId: "1:1084270490992:web:9733af315b1dd7abcc8bb5",
  measurementId: "G-M6JTW43JZS"
};

// index.html에 data- 속성으로 설정값을 주입하면 전역 변수로 덮어씁니다.
(function() {
  if (typeof window === 'undefined') return;
  const script = document.currentScript;
  if (!script) return;
  const keys = ['apiKey','authDomain','databaseURL','projectId','storageBucket','messagingSenderId','appId'];
  for (const key of keys) {
    const val = script.dataset[key];
    if (val) FIREBASE_CONFIG[key] = val;
  }
})();

module.exports = FIREBASE_CONFIG;