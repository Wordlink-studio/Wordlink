'use strict';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithPopup, signInWithRedirect, getRedirectResult,
  GoogleAuthProvider, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, onChildAdded, set, update, push, get, child, onDisconnect, remove
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

const FIREBASE_CONFIG = window.__FIREBASE_CONFIG__ || {};

let app = null, auth = null, db = null;
const listeners = new Map();
let roomUnsubscribe = null;
let currentRoomCode = null;
let lobbyWatching = false;

const ROOM_PATH = 'rooms';
const PROFILES_PATH = 'profiles';
const LOBBY_CHAT_PATH = 'lobby/chat';
const PRESENCE_PATH = 'lobby/presence';

// ---------- 레벨 계산 (progress.js 와 같은 공식, 브라우저용 복사본) ----------
const MAX_LEVEL = 99;
const TITLES = [
  [1, '낱말 새싹'], [5, '글자 수집가'], [10, '단어 탐험가'], [20, '말잇기 달인'],
  [35, '어휘 장인'], [50, '사전 박사'], [70, '언어의 마법사'], [90, '말잇기 전설']
];
function xpNeeded(level) { const n = Math.max(1, Math.floor(level)) - 1; return 100 + 40 * n + 4 * n * n; }
function levelInfo(totalXp) {
  let xp = Math.max(0, Math.floor(Number(totalXp) || 0));
  let level = 1;
  while (level < MAX_LEVEL && xp >= xpNeeded(level)) { xp -= xpNeeded(level); level += 1; }
  if (level >= MAX_LEVEL) return { level: MAX_LEVEL, into: xp, need: 0, pct: 100, max: true };
  const need = xpNeeded(level);
  return { level, into: xp, need, pct: Math.min(100, Math.floor((xp / need) * 100)), max: false };
}
function titleFor(level) { let name = TITLES[0][1]; for (const [from, t] of TITLES) if (level >= from) name = t; return name; }

// ---------- 초기화 · 인증 ----------
function initFirebase() {
  if (app) return app;
  const missing = ['apiKey', 'authDomain', 'databaseURL', 'projectId'].filter(k => !FIREBASE_CONFIG[k]);
  if (missing.length) {
    console.error('[firebase-client] 누락된 설정:', missing);
    window.__FIREBASE_ERROR__ = 'Firebase 설정값이 비어 있어요. index.html 을 확인하세요.';
    return null;
  }
  app = initializeApp(FIREBASE_CONFIG);
  auth = getAuth(app);
  db = getDatabase(app);
  return app;
}

// 저장된 로그인 복원 + 리다이렉트 로그인 결과 처리가 끝날 때까지 기다린다.
let readyPromise = null;
function authReady() {
  if (readyPromise) return readyPromise;
  initFirebase();
  if (!auth) return Promise.resolve(null);
  readyPromise = (async () => {
    try { await getRedirectResult(auth); } catch (error) { console.warn('[firebase-client] redirect result:', error); window.__AUTH_REDIRECT_ERROR__ = error.code || 'error'; }
    if (typeof auth.authStateReady === 'function') await auth.authStateReady();
    else await new Promise(resolve => { const off = onAuthStateChanged(auth, () => { off(); resolve(); }); });
    return auth.currentUser;
  })();
  return readyPromise;
}

// 화면에서 쓰는 형태로 변환. 익명(게스트)은 로그인한 것으로 보지 않는다.
function normalizeUser(user) {
  if (!user || user.isAnonymous) return null;
  const info = user.providerData && user.providerData[0] || {};
  const providerId = info.providerId || 'google.com';
  const label = providerId === 'google.com' ? 'Google' : providerId;
  const cleaned = String(user.displayName || '').replace(/[^\p{L}\p{N}_-]/gu, '').slice(0, 12);
  return {
    uid: user.uid,
    isAnonymous: false,
    displayName: user.displayName || '',
    email: user.email || '',
    photoURL: user.photoURL || '',
    providerData: user.providerData || [],
    providerId,
    providerLabel: label,
    suggestedName: cleaned.length >= 2 ? cleaned : null
  };
}
function currentUser() { return normalizeUser(auth && auth.currentUser); }
function onAuthChange(handler) {
  initFirebase();
  if (!auth) return () => {};
  return onAuthStateChanged(auth, user => handler(normalizeUser(user)));
}

async function signInAnon() {
  await authReady();
  if (auth.currentUser) return auth.currentUser;
  const cred = await signInAnonymously(auth);
  return cred.user;
}

async function signInWithProvider(providerId) {
  initFirebase();
  if (!auth) throw new Error(window.__FIREBASE_ERROR__ || 'Firebase 를 초기화하지 못했어요.');
  if (providerId !== 'google') throw Object.assign(new Error('지원하지 않는 로그인 방식이에요.'), { code: 'wordlink/unsupported' });
  await authReady();
  const provider = new GoogleAuthProvider();
  provider.setCustomParameters({ prompt: 'select_account' });
  try {
    const result = await signInWithPopup(auth, provider);
    return normalizeUser(result.user);
  } catch (error) {
    // 팝업이 막히거나 지원되지 않는 환경(일부 모바일 인앱 브라우저)이면 전체 화면 이동 방식으로 대체
    if (error.code === 'auth/popup-blocked' || error.code === 'auth/operation-not-supported-in-this-environment') {
      await signInWithRedirect(auth, provider);
      return null; // 페이지가 이동하므로 이후 코드는 실행되지 않는다
    }
    throw error;
  }
}

async function doSignOut() {
  initFirebase();
  if (!auth) return;
  await cleanupPresence();
  await signOut(auth);
}

// 방·채팅 등에 쓰는 플레이어 ID는 항상 Firebase 계정 uid (보안 규칙이 uid 로 검사한다)
function myUid() { return auth && auth.currentUser ? auth.currentUser.uid : null; }

// ---------- 이벤트 ----------
function on(event, handler) {
  if (!listeners.has(event)) listeners.set(event, []);
  listeners.get(event).push(handler);
  return () => off(event, handler);
}
function off(event, handler) {
  const hs = listeners.get(event);
  if (!hs) return;
  const i = hs.indexOf(handler);
  if (i >= 0) hs.splice(i, 1);
}
function emitEvent(event, payload) { const hs = listeners.get(event); if (hs) hs.slice().forEach(h => h(payload)); }

// ---------- 프로필 ----------
async function getProfile(uid) {
  const snap = await get(child(ref(db, PROFILES_PATH), uid));
  return snap.val();
}
// 기존 값을 지우지 않고 합쳐서 저장한다. (보안 규칙이 name·xp·games·wins·totalScore 를 요구)
async function saveProfile(uid, patch) {
  const target = child(ref(db, PROFILES_PATH), uid);
  const current = (await get(target)).val() || {};
  const merged = { name: '', avatar: '', xp: 0, games: 0, wins: 0, roundWins: 0, totalScore: 0, ...current, ...patch };
  if (!merged.name || String(merged.name).length < 2) merged.name = String(patch.name || current.name || '플레이어').slice(0, 12);
  await set(target, merged);
  return { ok: true, profile: merged };
}
function decorateProfile(raw, nameFallback) {
  const p = raw || {};
  const info = levelInfo(p.xp);
  return {
    name: p.name || nameFallback || '', avatar: p.avatar || '',
    level: info.level, title: titleFor(info.level), pct: info.pct, max: info.max, xpInto: info.into, xpNeed: info.need,
    xp: p.xp || 0, games: p.games || 0, wins: p.wins || 0, streak: p.streak || 0, bestStreak: p.bestStreak || 0,
    roundWins: p.roundWins || 0, totalScore: p.totalScore || 0, bestMatchScore: p.bestMatchScore || 0,
    words: p.words || 0, longestWord: p.longestWord || '', bestWord: p.bestWord || '', bestWordPoints: p.bestWordPoints || 0,
    missionHits: p.missionHits || 0, recent: Array.isArray(p.recent) ? p.recent : [], rank: null
  };
}
async function getMyProfile() {
  await authReady();
  const user = auth && auth.currentUser;
  if (!user || user.isAnonymous) return { ok: true, guest: true };
  return { ok: true, profile: decorateProfile(await getProfile(user.uid), user.displayName) };
}
async function setMyAvatar(avatar) {
  await authReady();
  const user = auth && auth.currentUser;
  if (!user || user.isAnonymous) return { ok: true, avatar: avatar || '' };
  await saveProfile(user.uid, { avatar: avatar || '' });
  return { ok: true, avatar: avatar || '' };
}
async function recordMatch(uid, result) {
  const current = (await getProfile(uid)) || {};
  const recent = (Array.isArray(current.recent) ? current.recent : []).slice();
  recent.unshift({ at: Date.now(), rank: result.rank || 1, players: result.players || 2, score: result.score || 0, xp: result.xp || 0, won: !!result.won });
  const patch = {
    xp: (current.xp || 0) + (result.xp || 0),
    games: (current.games || 0) + 1,
    wins: (current.wins || 0) + (result.won ? 1 : 0),
    roundWins: (current.roundWins || 0) + (result.roundWins || 0),
    totalScore: (current.totalScore || 0) + (result.score || 0),
    bestMatchScore: Math.max(current.bestMatchScore || 0, result.score || 0),
    recent: recent.slice(0, 10)
  };
  return saveProfile(uid, patch);
}
async function getRanking() {
  const snap = await get(ref(db, PROFILES_PATH));
  const profiles = snap.val() || {};
  const me = myUid();
  const sorted = Object.entries(profiles)
    .filter(([, p]) => p && p.name && (p.games || 0) >= 1)
    .map(([uid, p]) => ({ uid, name: p.name, avatar: p.avatar || '', xp: p.xp || 0, games: p.games || 0, wins: p.wins || 0, level: levelInfo(p.xp).level }))
    .sort((a, b) => b.xp - a.xp || b.wins - a.wins);
  const ranked = sorted.map((row, index) => ({ ...row, rank: index + 1 }));
  const mine = ranked.find(row => row.uid === me);
  return { ok: true, list: ranked.slice(0, 30), myRank: mine ? mine.rank : null };
}

// ---------- 방 목록 · 접속자 ----------
function roomSummary(code, r) {
  const settings = r.settings || {};
  const players = Object.values(r.players || {}).filter(p => p && p.online !== false && !p.eliminatedByKick);
  const max = settings.maxPlayers || 8;
  const host = (r.players || {})[r.hostId] || {};
  return {
    code, number: r.number || 0, title: r.title || '방', state: r.state || 'lobby',
    joinable: (r.state || 'lobby') === 'lobby' && players.length < max,
    locked: !!r.password, rounds: settings.rounds, totalSeconds: settings.totalSeconds, turnSeconds: settings.turnSeconds,
    allowOneShot: settings.allowOneShot !== false, hostName: host.name || '', players: players.length, maxPlayers: max
  };
}
function summarizeRooms(raw) {
  return Object.entries(raw || {})
    .map(([code, data]) => roomSummary(code, data || {}))
    .filter(room => room.state !== 'finished' && room.players > 0)
    .sort((a, b) => a.number - b.number);
}
function summarizeUsers(rooms, presence) {
  const byUid = new Map();
  for (const [uid, p] of Object.entries(presence || {})) {
    if (p && p.name) byUid.set(uid, { id: uid, name: p.name, avatar: p.avatar || '', level: p.level || 0, where: 'lobby' });
  }
  for (const data of Object.values(rooms || {})) {
    for (const [uid, p] of Object.entries((data && data.players) || {})) {
      if (!p || !p.online || !p.name) continue;
      byUid.set(uid, { id: uid, name: p.name, avatar: p.avatar || '', level: (byUid.get(uid) || {}).level || 0, where: data.state === 'playing' ? 'playing' : 'waiting', roomNumber: data.number || 0 });
    }
  }
  const list = Array.from(byUid.values()).slice(0, 200);
  return { list, total: byUid.size };
}
async function getLobbyRooms() {
  const snap = await get(ref(db, ROOM_PATH));
  return summarizeRooms(snap.val());
}
async function getLobbyUsers() {
  const [rooms, presence] = await Promise.all([get(ref(db, ROOM_PATH)), get(ref(db, PRESENCE_PATH))]);
  return summarizeUsers(rooms.val(), presence.val());
}

let presenceRef = null;
async function cleanupPresence() {
  if (presenceRef) { try { await remove(presenceRef); } catch { /* 무시 */ } presenceRef = null; }
}
function startLobbyWatchers() {
  if (lobbyWatching) return;
  lobbyWatching = true;
  let rooms = {}, presence = {};
  const push2 = () => {
    emitEvent('lobby:rooms', summarizeRooms(rooms));
    emitEvent('lobby:users', summarizeUsers(rooms, presence));
  };
  onValue(ref(db, ROOM_PATH), snap => { rooms = snap.val() || {}; push2(); });
  onValue(ref(db, PRESENCE_PATH), snap => { presence = snap.val() || {}; push2(); });
  const startedAt = Date.now() - 60 * 1000;
  onChildAdded(ref(db, LOBBY_CHAT_PATH), snap => {
    const message = snap.val();
    if (message && message.at >= startedAt) emitEvent('lobby:chat', message);
  });
}

async function enterLobby({ name, avatar }) {
  const user = await signInAnon();
  if (!user) return { ok: false, message: '인증에 실패했어요.' };
  const uid = user.uid;
  currentRoomCode = null;

  if (!user.isAnonymous) {
    await saveProfile(uid, { name, avatar: avatar || '', provider: 'google', lastSeenAt: Date.now() });
  }
  const level = user.isAnonymous ? 0 : levelInfo(((await getProfile(uid)) || {}).xp).level;

  presenceRef = ref(db, `${PRESENCE_PATH}/${uid}`);
  await set(presenceRef, { name, avatar: avatar || '', level, at: Date.now() });
  onDisconnect(presenceRef).remove();

  const [rooms, users] = await Promise.all([getLobbyRooms(), getLobbyUsers()]);
  startLobbyWatchers();
  const chatSnap = await get(ref(db, LOBBY_CHAT_PATH));
  const chat = Object.values(chatSnap.val() || {}).sort((a, b) => a.at - b.at).slice(-60);
  return { ok: true, rooms, users, avatar: avatar || '', chat };
}
async function leaveLobby() { await cleanupPresence(); return { ok: true }; }
async function sendLobbyChat({ name, text }) {
  const newRef = push(ref(db, LOBBY_CHAT_PATH));
  await set(newRef, { id: newRef.key, name: name || '', text: String(text || '').slice(0, 120), playerId: myUid(), at: Date.now() });
  return { ok: true };
}

// ---------- 방 ----------
async function createRoom({ title, settings, password, hostName, hostAvatar }) {
  const uid = myUid();
  if (!uid) return { ok: false, message: '로그인 정보를 확인하지 못했어요.' };
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  const roomSettings = { turnSeconds: 15, maxPlayers: 8, totalSeconds: 60, rounds: 5, allowOneShot: true, ...(settings || {}) };
  await set(ref(db, `${ROOM_PATH}/${code}`), {
    code, number: 1 + Math.floor(Math.random() * 999), title: title || '방', settings: roomSettings, state: 'lobby',
    hostId: uid, password: password || '',
    players: { [uid]: { name: hostName || '', avatar: hostAvatar || '', score: 0, ready: false, online: true, eliminated: false, joinedAt: Date.now() } },
    playerOrder: [uid], turnIndex: 0, lastSyllable: '', mission: { letter: '', seq: 0 }, winnerId: null
  });
  return { ok: true, code };
}
async function joinRoom({ code, name, avatar, password }) {
  const uid = myUid();
  if (!uid) return { ok: false, message: '로그인 정보를 확인하지 못했어요.' };
  const roomRef = ref(db, `${ROOM_PATH}/${code}`);
  const room = (await get(roomRef)).val();
  if (!room) return { ok: false, code: 'NOT_FOUND', message: '방을 찾을 수 없어요.' };
  const existing = (room.players || {})[uid];
  if (!existing) {
    if (room.state !== 'lobby') return { ok: false, code: 'STARTED', message: '이미 게임이 시작된 방이에요.' };
    if (Object.keys(room.players || {}).length >= ((room.settings || {}).maxPlayers || 8)) return { ok: false, code: 'FULL', message: '방이 가득 찼어요.' };
    if (room.password && room.password !== (password || '')) return { ok: false, code: password ? 'PASSWORD_WRONG' : 'PASSWORD_REQUIRED', message: password ? '비밀번호가 달라요.' : '비밀번호가 필요해요.' };
  } else if (existing.kickedBy) {
    return { ok: false, code: 'KICKED', message: '추방된 방이에요.' };
  }
  currentRoomCode = code;
  if (roomUnsubscribe) roomUnsubscribe();
  roomUnsubscribe = onValue(roomRef, snap => { emitEvent('room:update', { code, ...(snap.val() || {}) }); });
  await set(child(roomRef, `players/${uid}`), { name: name || '', avatar: avatar || '', score: (existing && existing.score) || 0, ready: false, online: true, eliminated: false, joinedAt: (existing && existing.joinedAt) || Date.now() });
  const order = (await get(child(roomRef, 'playerOrder'))).val() || [];
  if (!order.includes(uid)) await set(child(roomRef, 'playerOrder'), [...order, uid]);
  await cleanupPresence();
  return { ok: true, code };
}
async function leaveRoom({ code }) {
  const uid = myUid();
  if (roomUnsubscribe) { roomUnsubscribe(); roomUnsubscribe = null; }
  if (!code || !uid) return { ok: true };
  await set(ref(db, `${ROOM_PATH}/${code}/players/${uid}/online`), false);
  currentRoomCode = null;
  return { ok: true };
}
async function updateRoomSettings({ code, settings, title, password }) {
  const updates = {};
  if (settings) for (const [k, v] of Object.entries(settings)) updates[`settings/${k}`] = v;
  if (title !== undefined) updates.title = title;
  if (password !== undefined) updates.password = password;
  await update(ref(db, `${ROOM_PATH}/${code}`), updates);
  return { ok: true };
}
async function setPlayerReady({ code, ready }) {
  await set(ref(db, `${ROOM_PATH}/${code}/players/${myUid()}/ready`), !!ready);
  return { ok: true };
}
async function kickPlayer({ code, targetId, targetPlayerId }) {
  const target = targetId || targetPlayerId;
  await update(ref(db, `${ROOM_PATH}/${code}/players/${target}`), { eliminated: true, online: false, kickedBy: myUid(), kickedAt: Date.now() });
  return { ok: true };
}
async function sendReaction({ code, emoji }) {
  await update(ref(db, `${ROOM_PATH}/${code}`), { lastReaction: { playerId: myUid(), emoji, at: Date.now() } });
  return { ok: true };
}
async function sendRoomChat({ code, name, text }) {
  const newRef = push(ref(db, `${ROOM_PATH}/${code}/chat`));
  await set(newRef, { id: newRef.key, name: name || '', text: String(text || '').slice(0, 120), playerId: myUid(), at: Date.now() });
  return { ok: true };
}
async function quickJoinRoom({ name, avatar }) {
  const rooms = (await getLobbyRooms()).filter(r => r.joinable && !r.locked).sort((a, b) => b.players - a.players || a.number - b.number);
  if (!rooms.length) return { ok: false, code: 'NO_ROOM', message: '들어갈 방이 없어요.' };
  return joinRoom({ code: rooms[0].code, name, avatar });
}

// ---------- 요청 라우터 (client.js 의 request() 가 호출) ----------
const NOT_READY = { ok: false, message: '이 기능은 아직 서버 없이 동작하도록 옮겨지지 않았어요.' };
const firebaseClient = {
  init: initFirebase, on, off, authReady, currentUser, onAuthChange,
  request: async (event, payload = {}) => {
    try {
      initFirebase();
      if (!db) return { ok: false, message: window.__FIREBASE_ERROR__ || 'Firebase 를 초기화하지 못했어요.' };
      await authReady();
      switch (event) {
        case 'lobby:enter': return await enterLobby(payload);
        case 'lobby:leave': return await leaveLobby();
        case 'lobby:chat': return await sendLobbyChat(payload);
        case 'lobby:refresh': return { ok: true, rooms: await getLobbyRooms(), users: await getLobbyUsers() };
        case 'room:create': return await createRoom(payload);
        case 'room:join': case 'room:restore': return await joinRoom(payload);
        case 'room:quick': return await quickJoinRoom(payload);
        case 'room:leave': return await leaveRoom(payload);
        case 'room:ready': return await setPlayerReady(payload);
        case 'room:kick': return await kickPlayer(payload);
        case 'room:settings': return await updateRoomSettings(payload);
        case 'room:chat': return await sendRoomChat(payload);
        case 'room:chatlog': {
          const snap = await get(ref(db, `${ROOM_PATH}/${payload.code}/chat`));
          return { ok: true, chat: Object.values(snap.val() || {}).sort((a, b) => a.at - b.at).slice(-60) };
        }
        case 'game:react': return await sendReaction(payload);
        case 'profile:me': return await getMyProfile();
        case 'profile:avatar': return await setMyAvatar(payload.avatar);
        case 'ranking:top': return await getRanking();
        case 'room:start': case 'game:submit': case 'game:rematch': return NOT_READY;
        default: return { ok: false, message: `지원하지 않는 이벤트: ${event}` };
      }
    } catch (error) {
      console.error('[firebase-client]', event, error);
      return { ok: false, message: error.code === 'PERMISSION_DENIED' || /permission/i.test(error.message || '') ? '권한이 없어요. Firebase 보안 규칙을 확인하세요.' : (error.message || '요청 처리 중 오류가 발생했어요.') };
    }
  },
  signInAnon, signInWithProvider, doSignOut,
  getAuth: () => auth, getDb: () => db,
  getCurrentRoom: () => currentRoomCode, getCurrentPlayerId: myUid,
  getLobbyRooms, getLobbyUsers, saveProfile, recordMatch
};

window.firebaseClient = firebaseClient;
window.signInAnon = signInAnon;
window.signInWithProvider = signInWithProvider;
window.doSignOut = doSignOut;
