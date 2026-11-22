'use strict';

// 방장 브라우저가 서버 역할을 하는 게임 진행 엔진.
// - 참가자는 단어를 DB(submits/<uid>)에 올리고, 방장이 검증·점수 계산 후 결과를 DB 에 기록한다.
// - 모든 타이머는 방장 브라우저에만 있다. DB 의 turnEndsAt / roundEndsAt / nextRoundAt 만 보면 언제든 이어받을 수 있다.
// - 시간 값은 Firebase 서버 시간 기준(serverNow)으로 저장한다.

const BREAK_MS = 6000;

export function createHostEngine(env) {
  const { db, ref, update, serverNow, myUid, getDictionary, rules } = env;
  let code = null;
  let latest = null;
  let queue = Promise.resolve();
  const timers = { turn: null, round: null, brk: null };
  const armed = { turn: '', round: '', brk: '' };
  const handled = new Set();

  const roomRef = () => ref(db, `rooms/${code}`);
  const clean = value => JSON.parse(JSON.stringify(value));
  const run = fn => { const p = queue.then(fn); queue = p.catch(error => console.error('[game-host]', error)); return p; };
  const fail = (message, extra = {}) => ({ ok: false, message, ...extra });

  const orderIds = d => (Array.isArray(d.playerOrder) ? d.playerOrder : Object.keys(d.players || {})).filter(id => d.players && d.players[id]);
  const playersOf = d => orderIds(d).filter(id => !d.players[id].kickedBy).map(id => ({ id, ...d.players[id] }));
  const liveOf = d => playersOf(d).filter(p => !p.left);
  const activeOf = d => playersOf(d).filter(p => !p.eliminated && !p.left);
  const wordsOf = d => Object.values(d.words || {}).filter(Boolean);
  const matchWordsOf = d => Object.values(d.matchWords || {}).filter(Boolean);

  function nextActiveIndex(d, from) {
    const order = orderIds(d);
    for (let offset = 1; offset <= order.length; offset += 1) {
      const index = (from + offset) % order.length;
      const p = d.players[order[index]];
      if (p && !p.eliminated && !p.left && !p.kickedBy) return index;
    }
    return -1;
  }
  function turnPatch(d, index, roundEndsAt, turnSeconds) {
    const id = orderIds(d)[index];
    const t = serverNow();
    const turnMs = turnSeconds * 1000;
    const endsAt = roundEndsAt - t <= turnMs ? roundEndsAt : t + turnMs;
    return { currentPlayerId: id, turnIndex: index, turnStartedAt: t, turnEndsAt: endsAt, turnDurationMs: endsAt - t };
  }
  function pushSystem(d, patch, text) {
    const n = patch.wordSeq !== undefined ? patch.wordSeq : (d.wordSeq || 0);
    patch[`words/${n}`] = { type: 'system', text, at: Date.now() };
    patch.wordSeq = n + 1;
  }

  // ---------- 패치 만들기 ----------
  async function startRoundPatch(d, roundNo, base = {}) {
    const dict = await getDictionary();
    const s = d.settings;
    const prev = (base['mission/letter'] !== undefined ? base['mission/letter'] : (d.mission && d.mission.letter)) || '';
    const patch = {
      ...base, state: 'playing', round: roundNo, words: null, wordSeq: 0, lastSyllable: '', turnCount: 1,
      roundResult: null, nextRoundAt: null, missionChange: null,
      'mission/letter': rules().pickMissionLetter(dict.pool, prev),
      turnSeconds: rules().turnSecondsForRound(s.turnSeconds, roundNo - 1),
      roundEndsAt: serverNow() + s.totalSeconds * 1000
    };
    const view = { ...d, players: {} };
    for (const id of orderIds(d)) {
      const p = d.players[id];
      const left = base[`players/${id}/left`] !== undefined ? base[`players/${id}/left`] : !!p.left;
      patch[`players/${id}/roundScore`] = 0;
      patch[`players/${id}/eliminated`] = !!left;
      view.players[id] = { ...p, left, eliminated: !!left };
    }
    const first = nextActiveIndex(view, roundNo - 2);
    if (first < 0) { delete patch.words; return finishPatch(d, patch); }
    Object.assign(patch, turnPatch(view, first, patch.roundEndsAt, patch.turnSeconds));
    return patch;
  }
  async function startMatchPatch(d) {
    const patch = { gameId: (d.gameId || 0) + 1, matchWords: null, matchWordCount: 0, summary: null, winnerId: null, startedAt: serverNow(), 'mission/letter': '' };
    for (const id of orderIds(d)) {
      if (d.players[id].kickedBy) continue;
      patch[`players/${id}/score`] = 0; patch[`players/${id}/roundWins`] = 0; patch[`players/${id}/left`] = false;
    }
    return startRoundPatch(d, 1, patch);
  }
  function finishPatch(d, patch) {
    const ranked = liveOf(d).sort((a, b) => (b.roundWins || 0) - (a.roundWins || 0) || (b.score || 0) - (a.score || 0));
    const [first, second] = ranked;
    const decided = first && (!second || (first.roundWins || 0) !== (second.roundWins || 0) || (first.score || 0) !== (second.score || 0));
    const champion = decided ? first : null;
    pushSystem(d, patch, champion ? `🏆 ${champion.name}님이 최종 우승했어요.` : '무승부로 끝났어요.');
    Object.assign(patch, { state: 'finished', winnerId: champion ? champion.id : null, currentPlayerId: null, turnEndsAt: null, turnDurationMs: null, roundEndsAt: null, nextRoundAt: null });
    patch.summary = rules().buildRoundSummary({
      players: playersOf(d).map(p => ({ id: p.id, name: p.name, score: p.score || 0, roundWins: p.roundWins || 0, eliminated: !!p.left })),
      words: matchWordsOf(d), winnerId: champion ? champion.id : null, startedAt: d.startedAt || null, endedAt: serverNow()
    });
    return patch;
  }
  // d 는 이미 최신 점수가 반영된 복사본이어야 한다.
  function endRoundPatch(d, reason, patch = {}) {
    const candidates = activeOf(d);
    let winner = null;
    if (reason === 'last') winner = candidates.length === 1 ? candidates[0] : null;
    else {
      const top = Math.max(0, ...candidates.map(p => p.roundScore || 0));
      const leaders = top > 0 ? candidates.filter(p => (p.roundScore || 0) === top) : [];
      winner = leaders.length === 1 ? leaders[0] : null;
    }
    if (winner) { patch[`players/${winner.id}/roundWins`] = (winner.roundWins || 0) + 1; d.players[winner.id].roundWins = (winner.roundWins || 0) + 1; }
    patch.roundResult = {
      round: d.round, reason, winnerId: winner ? winner.id : null, winnerName: winner ? winner.name : '',
      scores: liveOf(d).map(p => ({ id: p.id, name: p.name, roundScore: p.roundScore || 0, eliminated: !!p.eliminated })).sort((a, b) => b.roundScore - a.roundScore)
    };
    const label = winner ? `${winner.name}님이 승리해 ${d.round}라운드가 끝났어요.` : `무승부로 ${d.round}라운드가 끝났어요.`;
    pushSystem(d, patch, reason === 'time' ? `⏰ 시간이 끝나 ${label}` : `🏁 ${label}`);
    Object.assign(patch, { currentPlayerId: null, turnEndsAt: null, turnDurationMs: null, roundEndsAt: null });
    if (d.round >= d.settings.rounds || liveOf(d).length < 2) return finishPatch(d, patch);
    patch.state = 'intermission';
    patch.nextRoundAt = serverNow() + BREAK_MS;
    return patch;
  }

  async function commit(patch) { await update(roomRef(), clean(patch)); }

  // ---------- 단어 처리 ----------
  async function processSubmit(uid, word) {
    const dict = await getDictionary();
    const d = clone(latest);
    if (!d || d.hostId !== myUid()) return { result: fail('방장이 아니에요.') };
    if (d.state !== 'playing') return { result: fail('지금은 입력할 수 없어요.') };
    if (d.currentPlayerId !== uid) return { result: fail('내 차례가 아니에요.') };
    if (serverNow() >= d.turnEndsAt) return { result: fail('시간이 지났어요.') };
    const used = new Set(wordsOf(d).filter(w => w.type === 'word').map(w => w.word));
    const v = rules().validateWord(word, dict.dict, used, d.lastSyllable || '', { allowOneShot: d.settings.allowOneShot !== false, startIndex: dict.startIndex });
    if (!v.ok) return { result: { ok: false, code: v.code, message: v.message } };
    const text = v.word;
    const now = serverNow();
    const player = d.players[uid];
    const missionLetter = (d.mission && d.mission.letter) || '';
    const usedMission = rules().hasMissionLetter(text, missionLetter) ? missionLetter : '';
    const missions = rules().countMissionLetters(text, missionLetter);
    const chain = wordsOf(d).filter(w => w.type === 'word').length + 1;
    const timeRatio = d.turnDurationMs > 0 ? (d.turnEndsAt - now) / d.turnDurationMs : 0;
    const points = rules().calcScore({ missions, length: text.length, chain, timeRatio });
    const entry = { type: 'word', word: text, playerId: uid, playerName: player.name, points, missions, chain, elapsedMs: now - (d.turnStartedAt || now), at: Date.now() };
    const patch = {};
    const n = d.wordSeq || 0;
    const m = d.matchWordCount || 0;
    player.score = (player.score || 0) + points;
    player.roundScore = (player.roundScore || 0) + points;
    patch[`players/${uid}/score`] = player.score;
    patch[`players/${uid}/roundScore`] = player.roundScore;
    patch.lastSyllable = text[text.length - 1];
    let newMission = '';
    if (usedMission) {
      newMission = rules().pickMissionLetter(dict.pool, usedMission);
      const seq = ((d.mission && d.mission.seq) || 0) + 1;
      entry.missionFrom = usedMission; entry.missionTo = newMission;
      patch['mission/letter'] = newMission; patch['mission/seq'] = seq;
      patch.missionChange = { seq, from: usedMission, to: newMission, playerName: player.name, word: text };
    }
    patch[`words/${n}`] = entry; patch.wordSeq = n + 1;
    patch[`matchWords/${m}`] = entry; patch.matchWordCount = m + 1;
    d.words = { ...(d.words || {}), [n]: entry }; d.wordSeq = n + 1;
    d.matchWords = { ...(d.matchWords || {}), [m]: entry };
    const next = nextActiveIndex(d, d.turnIndex);
    if (next < 0 || activeOf(d).length <= 1) endRoundPatch(d, 'last', patch);
    else { patch.turnCount = (d.turnCount || 1) + 1; Object.assign(patch, turnPatch(d, next, d.roundEndsAt, d.turnSeconds)); }
    return { patch, result: { ok: true, word: text, points, missions, chain, newMission } };
  }
  const clone = value => (value ? JSON.parse(JSON.stringify(value)) : value);

  function submitAsHost(word) {
    return run(async () => {
      const { patch, result } = await processSubmit(myUid(), word);
      if (patch) await commit(patch);
      return result;
    });
  }
  function handleRemoteSubmit(uid, submit) {
    const key = `${uid}:${submit.nonce}`;
    if (handled.has(key)) return;
    handled.add(key);
    run(async () => {
      const { patch = {}, result } = await processSubmit(uid, submit.word);
      patch[`submits/${uid}`] = null;
      patch[`results/${uid}`] = { nonce: submit.nonce, ...result };
      await commit(patch);
    });
  }

  // ---------- 타이머 ----------
  function clearTimer(name) { if (timers[name]) { clearTimeout(timers[name]); timers[name] = null; } armed[name] = ''; }
  function arm(name, token, endsAt, callback) {
    if (armed[name] === token) return;
    clearTimer(name);
    armed[name] = token;
    timers[name] = setTimeout(() => { timers[name] = null; armed[name] = ''; callback(); }, Math.max(0, endsAt - serverNow()) + 30);
  }
  function armTimers(d) {
    if (d.state === 'playing') {
      arm('round', `${d.gameId}:${d.round}:${d.roundEndsAt}`, d.roundEndsAt, () => run(() => onRoundTimeout()));
      if (d.turnEndsAt && d.turnEndsAt < d.roundEndsAt) arm('turn', `${d.gameId}:${d.round}:${d.turnCount}:${d.currentPlayerId}`, d.turnEndsAt, () => run(() => onTurnTimeout()));
      else clearTimer('turn');
    } else { clearTimer('round'); clearTimer('turn'); }
    if (d.state === 'intermission') arm('brk', `${d.gameId}:${d.round}:${d.nextRoundAt}`, d.nextRoundAt, () => run(() => onBreakTimeout()));
    else clearTimer('brk');
  }
  async function onRoundTimeout() {
    const d = clone(latest);
    if (!d || d.hostId !== myUid() || d.state !== 'playing' || serverNow() < d.roundEndsAt - 100) return;
    await commit(endRoundPatch(d, 'time'));
  }
  async function onTurnTimeout() {
    const d = clone(latest);
    if (!d || d.hostId !== myUid() || d.state !== 'playing' || !d.currentPlayerId || serverNow() < d.turnEndsAt - 100) return;
    const patch = {};
    const timedOut = d.players[d.currentPlayerId];
    if (timedOut && !timedOut.eliminated) {
      timedOut.eliminated = true;
      patch[`players/${d.currentPlayerId}/eliminated`] = true;
      pushSystem(d, patch, `${timedOut.name}님이 시간 안에 입력하지 못해 탈락했어요.`);
      d.wordSeq = patch.wordSeq;
    }
    const next = nextActiveIndex(d, d.turnIndex);
    if (next < 0 || activeOf(d).length <= 1) { await commit(endRoundPatch(d, 'last', patch)); return; }
    patch.turnCount = (d.turnCount || 1) + 1;
    Object.assign(patch, turnPatch(d, next, d.roundEndsAt, d.turnSeconds));
    await commit(patch);
  }
  async function onBreakTimeout() {
    const d = clone(latest);
    if (!d || d.hostId !== myUid() || d.state !== 'intermission' || serverNow() < d.nextRoundAt - 100) return;
    await commit(await startRoundPatch(d, d.round + 1));
  }

  // 방 데이터가 바뀔 때마다 호출 (방장일 때만 일한다)
  async function reconcile() {
    const d = clone(latest);
    if (!d || d.hostId !== myUid()) return;
    if (d.state === 'playing') {
      const current = d.currentPlayerId && d.players[d.currentPlayerId];
      if (activeOf(d).length <= 1) { await commit(endRoundPatch(d, 'last')); return; }
      if (!current || current.eliminated || current.left || current.kickedBy) {
        const next = nextActiveIndex(d, d.turnIndex || 0);
        if (next < 0) { await commit(endRoundPatch(d, 'last')); return; }
        const patch = { turnCount: (d.turnCount || 1) + 1 };
        Object.assign(patch, turnPatch(d, next, d.roundEndsAt, d.turnSeconds));
        await commit(patch);
      }
    } else if (d.state === 'intermission' && liveOf(d).length < 2) {
      await commit(finishPatch(d, {}));
    }
  }

  function onData(data) {
    latest = data || null;
    if (!latest || latest.hostId !== myUid()) { clearTimer('turn'); clearTimer('round'); clearTimer('brk'); return; }
    armTimers(latest);
    for (const [uid, submit] of Object.entries(latest.submits || {})) if (submit && submit.nonce) handleRemoteSubmit(uid, submit);
    run(reconcile);
  }

  // ---------- 방장 명령 ----------
  async function start() {
    try { await getDictionary(); } catch { return fail('단어 사전을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    return run(async () => {
      const d = clone(latest);
      if (!d || d.hostId !== myUid()) return fail('방장만 시작할 수 있어요.');
      if (d.state !== 'lobby') return fail('이미 게임이 시작되었어요.');
      const players = playersOf(d).filter(p => !p.left);
      if (players.length < 2) return fail('두 명 이상 모여야 시작할 수 있어요.');
      if (players.some(p => p.online === false || !p.ready)) return fail('모든 참가자가 준비해야 시작할 수 있어요.');
      await commit(await startMatchPatch(d));
      return { ok: true };
    });
  }
  async function rematch() {
    try { await getDictionary(); } catch { return fail('단어 사전을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.'); }
    return run(async () => {
      const d = clone(latest);
      if (!d || d.hostId !== myUid()) return fail('방장만 다시 시작할 수 있어요.');
      if (d.state !== 'finished') return fail('게임이 끝난 뒤에만 다시 시작할 수 있어요.');
      const patch = {};
      const order = orderIds(d).filter(id => !d.players[id].left && !d.players[id].kickedBy);
      for (const id of orderIds(d)) if (!order.includes(id)) patch[`players/${id}`] = null;
      patch.playerOrder = order;
      for (const id of order) d.players[id].left = false;
      d.playerOrder = order;
      if (order.length < 2 || order.some(id => d.players[id].online === false)) return fail('모든 참가자가 접속해 있어야 다시 시작할 수 있어요.');
      for (const id of order) patch[`players/${id}/ready`] = true;
      Object.assign(patch, await startMatchPatch(d));
      await commit(patch);
      return { ok: true };
    });
  }

  function attach(roomCode) { detach(); code = roomCode; }
  function detach() { clearTimer('turn'); clearTimer('round'); clearTimer('brk'); code = null; latest = null; handled.clear(); }

  return { attach, detach, onData, start, rematch, submitAsHost };
}
