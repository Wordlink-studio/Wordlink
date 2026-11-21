'use strict';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import { getAuth, signInAnonymously, signInWithPopup, GoogleAuthProvider, GithubAuthProvider, signOut, OAuthProvider } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import { getDatabase, ref, onValue, onChildAdded, set, update, push, get, child } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const FIREBASE_CONFIG = window.__FIREBASE_CONFIG__ || { apiKey:'', authDomain:'', databaseURL:'', projectId:'', storageBucket:'', messagingSenderId:'', appId:'' };

let app = null, auth = null, db = null;
let listeners = new Map();
let roomRef = null, roomUnsubscribe = null;
let currentRoomCode = null, currentPlayerId = null;

const ROOM_PATH = 'rooms';
const PROFILES_PATH = 'profiles';
const LOBBY_CHAT_PATH = 'lobby/chat';

function initFirebase() {
  if (app) return app;
  const missing = ['apiKey','authDomain','databaseURL','projectId'].filter(k => !FIREBASE_CONFIG[k]);
  if (missing.length) {
    console.error('[firebase-client] 누락:', missing);
    window.__FIREBASE_ERROR__ = 'Firebase 설정값이 비어있어요. index.html 을 확인하세요.';
    return null;
  }
  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  db = getDatabase(app);
  return app;
}

function getPlayerId() {
  let id = localStorage.getItem('wordlink.playerId.v1');
  if (!id) { id = crypto.randomUUID ? crypto.randomUUID() : `wl-${Date.now()}-${Math.random().toString(36).slice(2)}`; localStorage.setItem('wordlink.playerId.v1', id); }
  return id;
}

async function signInAnon() { initFirebase(); const cred = await signInAnonymously(auth); return cred.user; }
async function signInWithProvider(providerId) {
  initFirebase();
  let provider;
  if (providerId === 'google') provider = new GoogleAuthProvider();
  else if (providerId === 'github') provider = new GithubAuthProvider();
  else if (providerId === 'discord') {
    // Discord는 Firebase 기본 제공자가 아님. 콘솔에서 커스텀 OAuth 설정 필요.
    // 클라이언트 ID는 Firebase 콘솔 > 인증 > 로그인 방법 > Discord 에서 확인.
    throw new Error('Discord 로그인은 Firebase 콘솔에서 Discord 제공자를 먼저 설정해 주세요.');
  } else throw new Error('지원하지 않는 제공자입니다.');
  const result = await signInWithPopup(auth, provider);
  return result.user;
}
async function doSignOut() { initFirebase(); await signOut(auth); }

function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(handler);
  return () => { const hs = listeners.get(event); if (hs) { const i = hs.indexOf(handler); if (i >= 0) hs.splice(i, 1); } };
}
function emitEvent(event, payload) { const hs = listeners.get(event); if (hs) hs.forEach(h => h(payload)); }

async function joinRoom({ code, playerId, name, avatar, isHost }) {
  currentRoomCode = code; currentPlayerId = playerId;
  roomRef = ref(db, `${ROOM_PATH}/${code}`);
  roomUnsubscribe = onValue(roomRef, snap => { emitEvent('room:update', snap.val() || {}); });
  await set(child(roomRef, `players/${playerId}`), { name: name||'', avatar: avatar||'', score:0, ready:false, online:true, eliminated:false, joinedAt:Date.now() });
  const orderSnap = await get(child(roomRef, 'playerOrder'));
  const order = orderSnap.val() || [];
  if (!order.includes(playerId)) { order.push(playerId); await update(child(roomRef, ''), { playerOrder: order }); }
  if (isHost) await update(child(roomRef, ''), { hostId: playerId });
  return { ok: true };
}
async function leaveRoom({ code, playerId }) {
  if (roomUnsubscribe) { roomUnsubscribe(); roomUnsubscribe = null; }
  if (!code) return;
  const rRef = ref(db, `${ROOM_PATH}/${code}`);
  await set(child(rRef, `players/${playerId}/online`), false);
  await set(child(rRef, `players/${playerId}/socketId`), null);
  currentRoomCode = null; currentPlayerId = null;
}
async function updateRoomSettings({ code, settings, title, password }) {
  const updates = {};
  if (settings) updates.settings = settings;
  if (title !== undefined) updates.title = title;
  if (password !== undefined) updates.password = password;
  await update(ref(db, `${ROOM_PATH}/${code}`), updates);
}
async function setPlayerReady({ code, playerId, ready }) {
  await set(child(ref(db, `${ROOM_PATH}/${code}`), `players/${playerId}/ready`), ready);
}
async function kickPlayer({ code, targetPlayerId, hostPlayerId }) {
  await update(child(ref(db, `${ROOM_PATH}/${code}`), `players/${targetPlayerId}`), { eliminated:true, online:false, kickedBy:hostPlayerId, kickedAt:Date.now() });
}
async function startGame({ code }) {
  await update(ref(db, `${ROOM_PATH}/${code}`), { state:'playing', turnIndex:0, turnStartedAt:Date.now(), turnEndsAt:Date.now()+15000, lastSyllable:'', usedWords:{}, words:[], winnerId:null, roundWins:{} });
}

async function submitWord({ code, playerId, word, points, missions, chain, timeRatio }) {
  const now = Date.now();
  const newWordRef = push(child(ref(db, `${ROOM_PATH}/${code}`), 'words'));
  await set(newWordRef, { type:'word', word, playerId, points:points||0, missions:missions||0, chain:chain||1, timeRatio:timeRatio||0, at:now, elapsedMs:0 });
  await set(child(ref(db, `${ROOM_PATH}/${code}`), `usedWords/${word}`), true);
  const lastChar = word[word.length-1];
  await update(ref(db, `${ROOM_PATH}/${code}`), { lastSyllable: lastChar, turnIndex: (await get(child(ref(db, `${ROOM_PATH}/${code}`), 'turnIndex'))).val()+1 });
  return { ok: true, word, at: now };
}
async function sendReaction({ code, playerId, emoji }) {
  await update(ref(db, `${ROOM_PATH}/${code}`), { lastReaction: { playerId, emoji, at: Date.now() } });
}
async function sendRoomChat({ code, playerId, name, text }) {
  const newChatRef = push(child(ref(db, `${ROOM_PATH}/${code}`), 'chat'));
  await set(newChatRef, { id: newChatRef.key, name: name||'', text: text||'', playerId, at: Date.now() });
}
async function getLobbyRooms() {
  const snap = await get(ref(db, ROOM_PATH));
  const rooms = snap.val() || {};
  return Object.entries(rooms).map(([code,data]) => ({ code, ...data })).filter(r => r.state === 'lobby');
}
async function getLobbyUsers() {
  const snap = await get(ref(db, ROOM_PATH));
  const rooms = snap.val() || {};
  const users = [];
  for (const data of Object.values(rooms)) { for (const [pid,p] of Object.entries(data.players||{})) { if (p.online && p.name) users.push(p); } }
  return { list: users, total: users.length };
}
async function sendLobbyChat({ playerId, name, text }) {
  const newRef = push(ref(db, LOBBY_CHAT_PATH));
  await set(newRef, { id: newRef.key, name: name||'', text: text||'', playerId, at: Date.now() });
}
async function getProfile(uid) { const snap = await get(child(ref(db, PROFILES_PATH), uid)); return snap.val(); }
async function saveProfile(uid, profile) { await set(child(ref(db, PROFILES_PATH), uid), profile); }
async function recordMatch(uid, result) {
  const profileSnap = await get(child(ref(db, PROFILES_PATH), uid));
  const profile = profileSnap.val() || { xp:0, games:0, wins:0, roundWins:0, totalScore:0, recent:[] };
  profile.xp = (profile.xp||0)+(result.xp||0);
  profile.games = (profile.games||0)+1;
  if (result.won) profile.wins = (profile.wins||0)+1;
  profile.roundWins = (profile.roundWins||0)+(result.roundWins||0);
  profile.totalScore = (profile.totalScore||0)+(result.score||0);
  profile.recent = (profile.recent||[]).slice();
  profile.recent.unshift({ at:Date.now(), rank:result.rank||1, players:result.players||2, score:result.score||0, xp:result.xp||0, won:!!result.won });
  profile.recent = profile.recent.slice(0,10);
  await set(child(ref(db, PROFILES_PATH), uid), profile);
  return { ok: true, profile };
}

let lobbyChatListenerRegistered = false;

async function enterLobby({ name, playerId, avatar }) {
  // 인증 확인 및 대기
  if (!auth || !auth.currentUser) {
    await signInAnon();
  }

  // 인증 상태가 될 때까지 대기 (최대 5초)
  let waitCount = 0;
  while (!auth.currentUser && waitCount < 50) {
    await new Promise(r => setTimeout(r, 100));
    waitCount += 1;
  }

  if (!auth.currentUser) {
    return { ok: false, message: '인증에 실패했어요.' };
  }

  if (!playerId) playerId = getPlayerId();
  currentPlayerId = playerId;

  // 프로필 저장/업데이트
  const uid = auth.currentUser.uid;
  await saveProfile(uid, { name, avatar: avatar||'', provider: 'anonymous', uid, lastSeenAt: Date.now() });

  // 로비 방 목록
  const rooms = await getLobbyRooms();
  const users = await getLobbyUsers();

  // 로비 채팅 실시간 리스너 (한 번만 등록)
  if (!lobbyChatListenerRegistered) {
    const chatRef = ref(db, LOBBY_CHAT_PATH);
    onChildAdded(chatRef, snap => {
      emitEvent('lobby:chat', snap.val());
    });
    lobbyChatListenerRegistered = true;
  }

  return { ok: true, rooms, users: { list: users.list, total: users.total }, avatar: avatar||'', chat: [] };
}

async function leaveLobby() {
  currentRoomCode = null;
  currentPlayerId = null;
  return { ok: true };
}

const firebaseClient = {
  init: initFirebase, on,
  off: (event, handler) => { const hs = listeners.get(event); if (hs) { const i = hs.indexOf(handler); if (i>=0) hs.splice(i,1); } },
  request: async (event, payload = {}) => {
    try {
      switch (event) {
        case 'room:create': return await createRoom(payload);
        case 'room:join': return await joinRoom(payload);
        case 'room:leave': return await leaveRoom(payload);
        case 'room:ready': return await setPlayerReady(payload);
        case 'room:kick': return await kickPlayer(payload);
        case 'room:settings': return await updateRoomSettings(payload);
        case 'room:start': return await startGame(payload);
        case 'game:submit': return await submitWord(payload);
        case 'game:react': return await sendReaction(payload);
        case 'room:chat': return await sendRoomChat(payload);
        case 'lobby:chat': return await sendLobbyChat(payload);
        case 'lobby:enter': return await enterLobby(payload);
        case 'lobby:leave': return await leaveLobby(payload);
        case 'lobby:refresh': return await { ok: true, rooms: await getLobbyRooms(), users: await getLobbyUsers() };
        case 'profile:me': return await getProfile(payload.uid || currentPlayerId);
        case 'profile:avatar': return await saveProfile(auth?.currentUser?.uid || currentPlayerId, { avatar: payload.avatar });
        case 'room:chatlog': return await { ok: true, chat: (await get(child(ref(db, `${ROOM_PATH}/${payload.code}`), 'chat'))).val() || [] };
        case 'room:quick': return await quickJoinRoom(payload);
        case 'room:restore': return await joinRoom(payload);
        case 'game:rematch': return await rematchRoom(payload);
        case 'ranking:top': return await getRanking();
        default: return { ok: false, message: `지원하지 않는 이벤트: ${event}` };
      }
    } catch (error) { return { ok: false, message: error.message || '요청 처리 중 오류가 발생했어요.' }; }
  },
  signInAnon, signInWithProvider, doSignOut,
  getAuth: () => auth, getDb: () => db,
  getCurrentRoom: () => currentRoomCode, getCurrentPlayerId: () => currentPlayerId,
  getLobbyRooms, getLobbyUsers, saveProfile, recordMatch
};

async function createRoom({ code, title, settings, hostId, hostName, hostAvatar, password }) {
  if (!code) {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let c = '';
    for (let i = 0; i < 5; i += 1) c += alphabet[Math.floor(Math.random() * alphabet.length)];
    code = c;
  }
  await set(ref(db, `${ROOM_PATH}/${code}`), {
    code, title: title||'방', settings: settings||{ turnSeconds:15, maxPlayers:8, totalSeconds:60, rounds:5, allowOneShot:true }, state:'lobby', hostId, password: password||'',
    players: { [hostId]: { name: hostName||'', avatar: hostAvatar||'', score:0, ready:false, online:true, eliminated:false, joinedAt:Date.now() } },
    playerOrder: [hostId], currentPlayerId:null, turnIndex:0, turnStartedAt:null, turnEndsAt:null, lastSyllable:'',
    mission: { letter:'', seq:0 }, usedWords:{}, words:[], chat:[], winnerId:null, roundWins:{}
  });
  return { ok: true, code };
}
async function getRanking() {
  const snap = await get(ref(db, PROFILES_PATH));
  const profiles = snap.val() || {};
  const list = Object.entries(profiles)
    .filter(([uid,p]) => p && p.name && (p.games||0)>=1)
    .map(([uid,p], index) => ({ rank:index+1, name:p.name, avatar:p.avatar||'', xp:p.xp||0, games:p.games||0, wins:p.wins||0 }))
    .sort((a,b) => b.xp-a.xp || b.wins-a.wins).slice(0,30);
  return { ok: true, list };
}

async function quickJoinRoom({ name, avatar }) {
  const rooms = await getLobbyRooms();
  const candidates = rooms.filter(r => !r.password && r.state === 'lobby' && r.players && Object.keys(r.players).length < (r.settings?.maxPlayers || 8));
  if (candidates.length === 0) return { ok: false, code: 'NO_ROOM', message: '들어갈 방이 없어요.' };
  candidates.sort((a, b) => (Object.keys(b.players||{}).length - Object.keys(a.players||{}).length) || (a.number||0) - (b.number||0));
  const target = candidates[0];
  return await joinRoom({ code: target.code, playerId: getPlayerId(), name, avatar, isHost: false });
}

async function rematchRoom({ code, playerId }) {
  const roomRefPath = `${ROOM_PATH}/${code}`;
  await update(ref(db, roomRefPath), {
    state: 'playing',
    turnIndex: 0,
    turnStartedAt: Date.now(),
    turnEndsAt: Date.now() + 15000,
    lastSyllable: '',
    usedWords: {},
    words: [],
    winnerId: null,
    roundWins: {}
  });
  return { ok: true, code };
}

window.firebaseClient = firebaseClient;
window.signInAnon = signInAnon;
window.signInWithProvider = signInWithProvider;
window.doSignOut = doSignOut;