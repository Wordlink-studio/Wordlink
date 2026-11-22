'use strict';

import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getAuth, signInAnonymously, signInWithPopup, signInWithRedirect, getRedirectResult,
  GoogleAuthProvider, signOut, onAuthStateChanged
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-auth.js';
import {
  getDatabase, ref, onValue, onChildAdded, set, update, push, get, child, onDisconnect, remove, query, limitToLast
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js';

import { createHostEngine } from './game-host.js';

const FIREBASE_CONFIG = window.__FIREBASE_CONFIG__ || {};

let app = null, auth = null, db = null;
const listeners = new Map();
let roomUnsubscribe = null;
let currentRoomCode = null;
let lobbyWatching = false;
let myName = '';
let serverOffset = 0;
const serverNow = () => Date.now() + serverOffset;
const toLocal = t => (t == null ? null : t - serverOffset);
const rulesApi = () => window.gameRules;

// 단어 사전은 방장만 필요하다. (약 5MB) 처음 필요할 때 한 번만 받는다.
let dictionaryPromise = null;
function getDictionary() {
  if (!dictionaryPromise) {
    dictionaryPromise = fetch('./words.json')
      .then(response => { if (!response.ok) throw new Error('words.json 을 불러오지 못했어요.'); return response.json(); })
      .then(raw => {
        const R = rulesApi();
        const dict = new Set(raw.map(R.normalizeWord));
        return { dict, startIndex: R.buildStartIndex(dict), pool: R.buildMissionPool(dict) };
      })
      .catch(error => { dictionaryPromise = null; throw error; });
  }
  return dictionaryPromise;
}
let engine = null;
function getEngine() {
  if (!engine) engine = createHostEngine({ db, ref, update, serverNow, myUid: () => myUid(), getDictionary, rules: rulesApi });
  return engine;
}
const awarded = new Set();

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


const MIN_SCORE_XP_RATE = 0.2;
function calcMatchXp({ score = 0, roundWins = 0, rank = 1, players = 2, won = false }) {
  const parts = [{ label: '경기 참가', xp: 20 }];
  const scoreXp = Math.min(300, Math.floor(Math.max(0, score) * MIN_SCORE_XP_RATE));
  if (scoreXp > 0) parts.push({ label: `획득 점수 ${score}점`, xp: scoreXp });
  if (roundWins > 0) parts.push({ label: `라운드 승리 ${roundWins}회`, xp: roundWins * 10 });
  if (won) parts.push({ label: '최종 우승', xp: 40 });
  else if (rank === 2 && players >= 3) parts.push({ label: '준우승', xp: 15 });
  if (players > 2) parts.push({ label: `${players}인 대전`, xp: (players - 2) * 5 });
  return { total: parts.reduce((sum, part) => sum + part.xp, 0), parts };
}

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
  onValue(ref(db, '.info/serverTimeOffset'), snap => { serverOffset = Number(snap.val()) || 0; });
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
  const words = result.words || [];
  const recent = (Array.isArray(current.recent) ? current.recent : []).slice();
  recent.unshift({ at: Date.now(), rank: result.rank || 1, players: result.players || 2, score: result.score || 0, xp: result.xp || 0, won: !!result.won });
  let longest = current.longestWord || '';
  let best = current.bestWord || '';
  let bestPoints = current.bestWordPoints || 0;
  for (const item of words) {
    if (item.word && item.word.length > longest.length) longest = item.word;
    if ((item.points || 0) > bestPoints) { best = item.word; bestPoints = item.points; }
  }
  const streak = result.won ? (current.streak || 0) + 1 : 0;
  return saveProfile(uid, {
    xp: (current.xp || 0) + (result.xp || 0),
    games: (current.games || 0) + 1,
    wins: (current.wins || 0) + (result.won ? 1 : 0),
    streak, bestStreak: Math.max(current.bestStreak || 0, streak),
    roundWins: (current.roundWins || 0) + (result.roundWins || 0),
    totalScore: (current.totalScore || 0) + (result.score || 0),
    bestMatchScore: Math.max(current.bestMatchScore || 0, result.score || 0),
    words: (current.words || 0) + words.length,
    longestWord: longest, bestWord: best, bestWordPoints: bestPoints,
    missionHits: (current.missionHits || 0) + words.reduce((sum, item) => sum + (item.missions || 0), 0),
    recent: recent.slice(0, 10)
  });
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
  myName = name;
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
async function sendLobbyChat({ text }) {
  const newRef = push(ref(db, LOBBY_CHAT_PATH));
  await set(newRef, { id: newRef.key, name: myName, text: String(text || '').slice(0, 120), playerId: myUid(), at: Date.now() });
  return { ok: true };
}

// ---------- 방 ----------
// DB 의 방 데이터를 client.js 가 기대하는 모양으로 변환한다. (시간 값은 이 기기의 시계 기준으로 바꿔 준다)
function toClientRoom(code, r) {
  const R = rulesApi();
  const s = r.settings || {};
  const all = r.players || {};
  const order = (Array.isArray(r.playerOrder) ? r.playerOrder : Object.keys(all)).filter(id => all[id] && !all[id].kickedBy);
  const players = order.map(id => {
    const p = all[id];
    return { id, name: p.name || '', avatar: p.avatar || '', level: p.level || 0, isHost: id === r.hostId, ready: !!p.ready, online: p.online !== false && !p.left, eliminated: !!p.eliminated || !!p.left, roundWins: p.roundWins || 0, score: p.score || 0, roundScore: p.roundScore || 0 };
  });
  const maxPlayers = s.maxPlayers || 8;
  const rounds = s.rounds || 5;
  const baseTurn = s.turnSeconds || 15;
  const host = players.find(p => p.id === r.hostId);
  const current = players.find(p => p.id === r.currentPlayerId);
  const state = r.state || 'lobby';
  const allWords = Object.values(r.words || {}).filter(Boolean);
  const lastSyllable = r.lastSyllable || '';
  return {
    code, number: r.number || 0, title: r.title || '방', locked: !!r.password,
    hostId: r.hostId, hostName: host ? host.name : '', state,
    players, maxPlayers, rounds, totalSeconds: s.totalSeconds || 60, turnSeconds: r.turnSeconds || baseTurn, allowOneShot: s.allowOneShot !== false,
    settings: { maxPlayers, rounds, totalSeconds: s.totalSeconds || 60, turnSeconds: baseTurn, allowOneShot: s.allowOneShot !== false },
    joinable: state === 'lobby' && players.filter(p => p.online).length < maxPlayers,
    turnPlan: R ? R.turnPlanFor(baseTurn, rounds) : Array.from({ length: rounds }, () => baseTurn),
    round: r.round || 1, totalRounds: rounds, gameId: r.gameId || 0, totalWords: r.matchWordCount || 0,
    words: allWords.slice(-80), mission: (r.mission && r.mission.letter) || '', missionChange: r.missionChange || null,
    lastSyllable, allowedSyllables: R && lastSyllable ? R.allowedFirstSyllables(lastSyllable) : [],
    currentPlayerId: r.currentPlayerId || null, currentPlayerName: current ? current.name : '',
    turnEndsAt: toLocal(r.turnEndsAt || null), turnDurationMs: r.turnDurationMs || null,
    roundEndsAt: toLocal(r.roundEndsAt || null), nextRoundAt: toLocal(r.nextRoundAt || null),
    roundResult: r.roundResult || null, winnerId: r.winnerId || null,
    summary: state === 'finished' ? (r.summary || null) : null,
    winnerName: r.winnerId && all[r.winnerId] ? all[r.winnerId].name : ''
  };
}

// 경기가 끝나면 각자 자기 기록(경험치·전적)을 자기 프로필에 저장한다.
async function awardMatch(code, d) {
  const key = `${code}:${d.gameId}`;
  if (awarded.has(key) || !d.summary) return;
  awarded.add(key);
  const user = auth && auth.currentUser;
  if (!user || user.isAnonymous) return;
  const row = (d.summary.ranking || []).find(item => item.id === user.uid);
  if (!row) return;
  const words = Object.values(d.matchWords || {}).filter(w => w && w.type === 'word');
  const mine = words.filter(w => w.playerId === user.uid);
  const eligible = words.length >= 6 && new Set(words.map(w => w.playerId)).size >= 2;
  const gameId = d.gameId;
  if (!eligible) { emitEvent('profile:reward', { gameId, skipped: 'short' }); return; }
  if (!mine.length) { emitEvent('profile:reward', { gameId, skipped: 'noword' }); return; }
  const players = Object.values(d.players || {}).filter(p => p && !p.left && !p.kickedBy).length;
  const xp = calcMatchXp({ score: row.score, roundWins: row.roundWins, rank: row.rank, players, won: !!row.isWinner });
  const before = levelInfo(((await getProfile(user.uid)) || {}).xp);
  await recordMatch(user.uid, { xp: xp.total, score: row.score, roundWins: row.roundWins, rank: row.rank, players, won: !!row.isWinner, words: mine });
  const after = levelInfo(((await getProfile(user.uid)) || {}).xp);
  emitEvent('profile:reward', {
    gameId, xp: xp.total, parts: xp.parts,
    before: { level: before.level, pct: before.pct },
    after: { level: after.level, pct: after.pct, into: after.into, need: after.need, max: after.max },
    title: titleFor(after.level), leveledUp: after.level > before.level, newTitle: titleFor(after.level) !== titleFor(before.level)
  });
}

function watchRoom(code) {
  unwatchRoom();
  currentRoomCode = code;
  const me = myUid();
  const eng = getEngine();
  eng.attach(code);
  let lastReaction = null;
  let first = true;
  const offRoom = onValue(ref(db, `${ROOM_PATH}/${code}`), snap => {
    const data = snap.val();
    if (!data) return;
    const mine = data.players && data.players[me];
    if (mine && mine.kickedBy) {
      unwatchRoom();
      emitEvent('room:kicked', { code, message: '방장에게 추방되었어요.' });
      return;
    }
    // 방장이 오프라인이면 접속 중인 첫 번째 참가자가 방장을 이어받는다.
    const hostEntry = data.players && data.players[data.hostId];
    if (!hostEntry || hostEntry.online === false) {
      const candidates = (Array.isArray(data.playerOrder) ? data.playerOrder : []).filter(id => data.players[id] && data.players[id].online !== false && !data.players[id].left && !data.players[id].kickedBy);
      if (candidates[0] === me && data.hostId !== me) set(ref(db, `${ROOM_PATH}/${code}/hostId`), me).catch(() => {});
    }
    eng.onData(data);
    if (data.lastReaction) {
      if (!first && lastReaction !== null && data.lastReaction.at !== lastReaction) {
        const sender = data.players && data.players[data.lastReaction.playerId];
        emitEvent('game:reaction', { ...data.lastReaction, name: sender ? sender.name : '' });
      }
      lastReaction = data.lastReaction.at;
    } else if (first) lastReaction = 0;
    first = false;
    if (data.state === 'finished') awardMatch(code, data).catch(error => console.warn('[firebase-client] award', error));
    emitEvent('room:update', toClientRoom(code, data));
  });
  const offChat = onChildAdded(query(ref(db, `${ROOM_PATH}/${code}/chat`), limitToLast(60)), snap => {
    const message = snap.val();
    if (message) emitEvent('room:chat', { ...message, code });
  });
  roomUnsubscribe = () => { offRoom(); offChat(); };
}
function unwatchRoom() {
  if (roomUnsubscribe) { roomUnsubscribe(); roomUnsubscribe = null; }
  if (engine) engine.detach();
  currentRoomCode = null;
}

async function myPlayerEntry(name, avatar, existing) {
  const user = auth.currentUser;
  const level = user && !user.isAnonymous ? levelInfo(((await getProfile(user.uid)) || {}).xp).level : 0;
  return { name: name || myName || '플레이어', avatar: avatar || '', level, score: (existing && existing.score) || 0, roundScore: (existing && existing.roundScore) || 0, roundWins: (existing && existing.roundWins) || 0, ready: false, online: true, left: false, eliminated: !!(existing && existing.eliminated), joinedAt: (existing && existing.joinedAt) || Date.now() };
}
function markOnlineWithDisconnect(code, uid) {
  onDisconnect(ref(db, `${ROOM_PATH}/${code}/players/${uid}/online`)).set(false);
}
function clampInt(value, min, max, fallback) { const n = Math.floor(Number(value)); return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback; }

async function createRoom(payload) {
  const uid = myUid();
  if (!uid) return { ok: false, message: '로그인 정보를 확인하지 못했어요.' };
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 5; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
  const name = payload.name || myName;
  if (payload.name) myName = payload.name;
  const settings = {
    maxPlayers: clampInt(payload.maxPlayers, 2, 8, 8), rounds: clampInt(payload.rounds, 1, 25, 3),
    totalSeconds: clampInt(payload.totalSeconds, 10, 600, 60), turnSeconds: clampInt(payload.turnSeconds, 5, 60, 15),
    allowOneShot: payload.allowOneShot !== false
  };
  const entry = await myPlayerEntry(name, payload.avatar);
  await set(ref(db, `${ROOM_PATH}/${code}`), {
    code, number: 1 + Math.floor(Math.random() * 999), title: String(payload.title || `${name}님의 방`).slice(0, 24), settings, state: 'lobby',
    hostId: uid, password: String(payload.password || '').slice(0, 8),
    players: { [uid]: entry }, playerOrder: [uid], round: 1, gameId: 0, lastSyllable: '', mission: { letter: '', seq: 0 }
  });
  markOnlineWithDisconnect(code, uid);
  await cleanupPresence();
  watchRoom(code);
  getDictionary().catch(() => {}); // 방장이 될 사람이므로 미리 받아 둔다
  const data = (await get(ref(db, `${ROOM_PATH}/${code}`))).val();
  return { ok: true, code, playerId: uid, room: toClientRoom(code, data) };
}
// restore=true: 새로고침 후 복원. 이미 이 계정이 들어가 있던 방에만 다시 들어간다.
async function joinRoom({ code, name, avatar, password }, restore = false) {
  const uid = myUid();
  if (!uid) return { ok: false, message: '로그인 정보를 확인하지 못했어요.' };
  if (name) myName = name;
  const roomRef = ref(db, `${ROOM_PATH}/${code}`);
  const room = (await get(roomRef)).val();
  if (!room) return { ok: false, code: 'NOT_FOUND', message: '방을 찾을 수 없어요.' };
  const existing = (room.players || {})[uid];
  if (existing && existing.kickedBy) return { ok: false, code: 'KICKED', message: '추방된 방이에요.' };
  if (existing && existing.left) {
    if (restore) return { ok: false, code: 'NOT_IN_ROOM', message: '이전 방 정보를 찾을 수 없어요.' };
    return { ok: false, code: 'STARTED', message: '이미 나간 경기예요. 게임이 끝나면 다시 들어올 수 있어요.' };
  }
  if (restore && !existing) return { ok: false, code: 'NOT_IN_ROOM', message: '이전 방 정보를 찾을 수 없어요.' };
  if (!existing) {
    if ((room.state || 'lobby') !== 'lobby') return { ok: false, code: 'STARTED', message: '이미 게임이 시작된 방이에요.' };
    const online = Object.values(room.players || {}).filter(p => p && p.online !== false && !p.left && !p.kickedBy).length;
    if (online >= ((room.settings || {}).maxPlayers || 8)) return { ok: false, code: 'FULL', message: '방이 가득 찼어요.' };
    if (room.password && room.password !== (password || '')) {
      return { ok: false, code: password ? 'PASSWORD_WRONG' : 'PASSWORD_REQUIRED', message: password ? '비밀번호가 달라요.' : '이 방은 비밀번호가 필요해요.' };
    }
  }
  const entry = await myPlayerEntry(name, avatar, existing);
  if (existing) { entry.ready = !!existing.ready; entry.avatar = avatar || existing.avatar || ''; }
  await set(child(roomRef, `players/${uid}`), entry);
  const order = Array.isArray(room.playerOrder) ? room.playerOrder : [];
  if (!order.includes(uid)) await set(child(roomRef, 'playerOrder'), [...order, uid]);
  markOnlineWithDisconnect(code, uid);
  await cleanupPresence();
  watchRoom(code);
  const data = (await get(roomRef)).val();
  return { ok: true, code, playerId: uid, room: toClientRoom(code, data) };
}
async function leaveRoom({ code }) {
  const uid = myUid();
  unwatchRoom();
  if (!code || !uid) return { ok: true };
  const roomRef = ref(db, `${ROOM_PATH}/${code}`);
  try { await onDisconnect(child(roomRef, `players/${uid}/online`)).cancel(); } catch { /* 무시 */ }
  try {
    const before = (await get(roomRef)).val();
    if (!before) return { ok: true };
    const state = before.state || 'lobby';
    if (state === 'lobby') {
      // 대기실에서는 기록 없이 완전히 나간다.
      await set(child(roomRef, `players/${uid}`), null);
      await set(child(roomRef, 'playerOrder'), (Array.isArray(before.playerOrder) ? before.playerOrder : []).filter(id => id !== uid));
    } else {
      // 경기 중·종료 후에는 '나감' 표시만 남긴다. (진행 중이면 탈락 처리)
      await update(roomRef, { [`players/${uid}/online`]: false, [`players/${uid}/ready`]: false, [`players/${uid}/left`]: true, [`players/${uid}/eliminated`]: true });
    }
    const room = (await get(roomRef)).val();
    if (room) {
      const alive = Object.entries(room.players || {}).filter(([, p]) => p && p.online !== false && !p.left && !p.kickedBy).map(([id]) => id);
      if (!alive.length) await remove(roomRef);
      else if (room.hostId === uid) await set(child(roomRef, 'hostId'), alive[0]);
    }
  } catch (error) { console.warn('[firebase-client] leaveRoom', error); }
  return { ok: true };
}
async function updateRoomSettings(payload) {
  const { code } = payload;
  const updates = {};
  if (payload.maxPlayers !== undefined) updates['settings/maxPlayers'] = clampInt(payload.maxPlayers, 2, 8, 8);
  if (payload.rounds !== undefined) updates['settings/rounds'] = clampInt(payload.rounds, 1, 25, 3);
  if (payload.totalSeconds !== undefined) updates['settings/totalSeconds'] = clampInt(payload.totalSeconds, 10, 600, 60);
  if (payload.turnSeconds !== undefined) updates['settings/turnSeconds'] = clampInt(payload.turnSeconds, 5, 60, 15);
  if (payload.allowOneShot !== undefined) updates['settings/allowOneShot'] = !!payload.allowOneShot;
  if (payload.title !== undefined) updates.title = String(payload.title).slice(0, 24) || '방';
  if (payload.clearPassword) updates.password = '';
  else if (payload.password) updates.password = String(payload.password).slice(0, 8);
  await update(ref(db, `${ROOM_PATH}/${code}`), updates);
  return { ok: true };
}
async function setPlayerReady({ code, ready }) {
  await set(ref(db, `${ROOM_PATH}/${code}/players/${myUid()}/ready`), !!ready);
  return { ok: true };
}
async function kickPlayer({ code, targetId }) {
  await update(ref(db, `${ROOM_PATH}/${code}/players/${targetId}`), { online: false, ready: false, left: true, eliminated: true, kickedBy: myUid(), kickedAt: Date.now() });
  return { ok: true };
}
async function sendReaction({ code, emoji }) {
  await update(ref(db, `${ROOM_PATH}/${code}`), { lastReaction: { playerId: myUid(), emoji, at: Date.now() } });
  return { ok: true };
}
async function sendRoomChat({ code, text }) {
  const newRef = push(ref(db, `${ROOM_PATH}/${code}/chat`));
  await set(newRef, { id: newRef.key, name: myName, text: String(text || '').slice(0, 120), playerId: myUid(), at: Date.now() });
  return { ok: true };
}
async function quickJoinRoom({ name, avatar }) {
  const rooms = (await getLobbyRooms()).filter(r => r.joinable && !r.locked).sort((a, b) => b.players - a.players || a.number - b.number);
  if (!rooms.length) return { ok: false, code: 'NO_ROOM', message: '들어갈 방이 없어요.' };
  return joinRoom({ code: rooms[0].code, name, avatar });
}

// ---------- 게임 진행 ----------
async function startGame({ code }) {
  const data = (await get(ref(db, `${ROOM_PATH}/${code}`))).val();
  if (!data) return { ok: false, message: '방을 찾을 수 없어요.' };
  if (data.hostId !== myUid()) return { ok: false, message: '방장만 시작할 수 있어요.' };
  return getEngine().start();
}
async function rematchGame({ code }) {
  const data = (await get(ref(db, `${ROOM_PATH}/${code}`))).val();
  if (!data || data.hostId !== myUid()) return { ok: false, message: '방장만 다시 시작할 수 있어요.' };
  return getEngine().rematch();
}
// 방장이면 직접 처리하고, 아니면 DB 에 올려 방장의 답을 기다린다.
async function submitWord({ code, word }) {
  const uid = myUid();
  const roomRef = ref(db, `${ROOM_PATH}/${code}`);
  const hostId = (await get(child(roomRef, 'hostId'))).val();
  if (hostId === uid) return getEngine().submitAsHost(word);
  const nonce = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  return new Promise(resolve => {
    let done = false;
    const resultRef = child(roomRef, `results/${uid}`);
    const finish = value => { if (done) return; done = true; off(); clearTimeout(timer); resolve(value); };
    const off = onValue(resultRef, snap => {
      const value = snap.val();
      if (value && value.nonce === nonce) { const { nonce: _n, ...rest } = value; finish(rest); }
    });
    const timer = setTimeout(() => finish({ ok: false, message: '방장의 응답이 없어요. 잠시 후 다시 시도해 주세요.' }), 7000);
    set(child(roomRef, `submits/${uid}`), { nonce, word: String(word || '').slice(0, 24), at: Date.now() }).catch(() => finish({ ok: false, message: '단어를 보내지 못했어요.' }));
  });
}

// ---------- 요청 라우터 (client.js 의 request() 가 호출) ----------
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
        case 'room:join': return await joinRoom(payload);
        case 'room:restore': return await joinRoom(payload, true);
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
        case 'room:start': return await startGame(payload);
        case 'game:submit': return await submitWord(payload);
        case 'game:rematch': return await rematchGame(payload);
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
