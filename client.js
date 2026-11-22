'use strict';

(() => {
  const $ = (selector, root = document) => root.querySelector(selector);
  const app = $('#app');
  const toastNode = $('#toast');
  const connectionDot = $('#connection-dot');
  const connectionLabel = $('#connection-label');
  const SESSION_KEY = 'wordlink.session.v1';
  const PLAYER_KEY = 'wordlink.playerId.v1';
  const SOUND_KEY = 'wordlink.sound.v1';
  const NICKMODE_KEY = 'wordlink.nickmode.v1';
  const REACTIONS = ['👍', '😂', '😮', '🔥', '👏', '😭'];
  const REACTION_COOLDOWN_MS = 350;
  const TOTAL_TIME_OPTIONS = [20, 40, 60, 80, 100, 150, 500];
  const MIN_ROUNDS = 1;
  const MAX_ROUNDS = 25;

  const state = {
    socket: null,
    room: null,
    session: null,
    restoring: false,
    toastTimer: null,
    summaryClosedGame: null,
    summaryShownGame: null,
    lastTick: '',
    lastReactionAt: 0,
    nickname: null,
    avatar: readSavedAvatar(),
    auth: { providers: [{ id: 'google', label: 'Google' }], user: null },
    hub: { rooms: [], users: [], total: 0, chat: [], onlyJoinable: false },
    profile: null,
    rewards: new Map(),
    dialogClose: null,
    idleClosed: false,
    draft: { key: '', value: '' },
    screen: '',
    shown: null
  };
  const CHAT_MAX_LENGTH = 120;

  const MORPHED_SCREENS = new Set(['lobby', 'game']);
  function enterScreen(key) {
    const same = state.screen === key;
    state.screen = key;
    if (!same) window.Bokgu?.screen(key);
    if (!same || !MORPHED_SCREENS.has(key)) document.documentElement.style.setProperty('--ph', `${Math.round(performance.now())}ms`);
    return same;
  }
  function settleScreen(same) {
    if (!same) return;
    const section = app.firstElementChild;
    if (section) section.classList.remove('fade-in');
  }
  const reduceMotion = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  const SCREEN_RANK = { home: 0, hub: 1, lobby: 2, game: 3 };
  const morphState = { pending: null };
  function rowAvatar(rowSelector) {
    const me = state.nickname;
    if (!me) return null;
    const row = [...app.querySelectorAll(rowSelector)].find(node => node.textContent.includes(me));
    return row ? row.querySelector('.avatar') : null;
  }
  const SHARED_FINDERS = {
    'vt-me': () => $('#home-avatar-preview', app) || $('.hub-profile-main .avatar', app) || rowAvatar('.player-row') || rowAvatar('.score-row'),
    'vt-title': () => $('.hero-title', app) || $('.page-title', app),
    'vt-list': () => $('.hub-users', app) || $('.lobby-grid > .panel', app) || $('.score-panel', app),
    'vt-main': () => $('.hub-rooms', app) || $('.settings-panel', app) || $('.chain-strip-panel', app),
    'vt-side': () => $('.home-card', app) || $('.hub-profile', app) || $('.invite-strip', app) || $('.entry-card', app),
    'vt-chat': () => $('.hub-chat', app) || $('#room-chat-slot .panel', app)
  };
  function tagShared() {
    for (const [name, find] of Object.entries(SHARED_FINDERS)) {
      let node = null;
      try { node = find(); } catch { node = null; }
      if (node && !node.dataset.vtTag) { node.style.viewTransitionName = name; node.dataset.vtTag = name; }
    }
  }
  function clearShared() {
    app.querySelectorAll('[data-vt-tag]').forEach(node => { node.style.viewTransitionName = ''; delete node.dataset.vtTag; });
  }
  function canMorph() {
    return typeof document.startViewTransition === 'function' && !reduceMotion.matches && !document.hidden && !state.idleClosed;
  }
  function screenTransition(key, run) {
    const job = morphState.pending;
    if (job) { job.run = run; return; }
    if (state.screen === key || !canMorph()) { run(); return; }
    const from = state.screen;
    const root = document.documentElement;
    const next = { run };
    morphState.pending = next;
    root.dataset.vt = '1';
    tagShared();
    let transition;
    try {
      transition = document.startViewTransition(() => {
        morphState.pending = null;
        next.run();
        const forward = (SCREEN_RANK[state.screen] ?? 0) >= (SCREEN_RANK[from] ?? -1);
        root.style.setProperty('--vt-dir', forward ? '1' : '-1');
        tagShared();
      });
    } catch {
      morphState.pending = null;
      delete root.dataset.vt;
      clearShared();
      run();
      return;
    }
    const finish = () => { delete root.dataset.vt; clearShared(); };
    transition.finished.then(finish, finish);
    transition.ready.catch(() => {});
    transition.updateCallbackDone.catch(error => console.error(error));
  }
  function renderHome() { screenTransition('home', renderHomeImpl); }
  function mountHub() { screenTransition('hub', mountHubImpl); }
  function renderLobby(room) { screenTransition('lobby', () => renderLobbyImpl(room)); }
  function renderGame(room) { screenTransition('game', () => renderGameImpl(room)); }

  const TRANSIENT_CLASSES = ['enter', 'pop', 'swap', 'arrive', 'bump', 'mission-new', 'shake'];
  function morphKey(node) {
    if (node.nodeType !== 1) return '';
    if (node === roomChat.node) return 'id:room-chat-slot';
    if (node.id) return `id:${node.id}`;
    return node.dataset.key ? `key:${node.dataset.key}` : '';
  }
  function sameKind(a, b) { return a.nodeType === b.nodeType && (a.nodeType !== 1 || a.tagName === b.tagName); }
  function hasTransient(node) { return node.nodeType === 1 && TRANSIENT_CLASSES.some(name => node.classList.contains(name)); }
  function patchClass(el, wanted) {
    const want = new Set(wanted.split(/\s+/).filter(Boolean));
    for (const name of SCRIPT_CLASSES) if (el.classList.contains(name)) want.add(name);
    let playing = null;
    for (const name of TRANSIENT_CLASSES) {
      if (!el.classList.contains(name) || want.has(name)) continue;
      if (playing === null) playing = typeof el.getAnimations === 'function' && el.getAnimations({ subtree: true }).some(anim => anim.playState === 'running');
      if (playing) want.add(name);
    }
    for (const name of [...el.classList]) if (!want.has(name)) el.classList.remove(name);
    for (const name of want) if (!el.classList.contains(name)) el.classList.add(name);
    if (!el.classList.length) el.removeAttribute('class');
  }
  function patchAttributes(el, next) {
    const keep = new Set((next.getAttribute('data-morph-keep') || '').split(/\s+/).filter(Boolean));
    if (el.dataset.vtTag) { keep.add('style'); keep.add('data-vt-tag'); }
    for (const { name } of [...el.attributes]) {
      if (name !== 'class' && !keep.has(name) && !next.hasAttribute(name)) el.removeAttribute(name);
    }
    for (const { name, value } of [...next.attributes]) {
      if (keep.has(name)) continue;
      if (name === 'class') patchClass(el, value);
      else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
    }
    if (!next.hasAttribute('class') && !keep.has('class') && el.hasAttribute('class')) patchClass(el, '');
  }
  function morphNode(oldNode, newNode) {
    if (oldNode.nodeType !== 1) {
      if (oldNode.nodeValue !== newNode.nodeValue) oldNode.nodeValue = newNode.nodeValue;
      return oldNode;
    }
    if (newNode.id === 'room-chat-slot') return oldNode;
    if (oldNode.isEqualNode(newNode)) return oldNode;
    if (hasTransient(newNode)) return newNode;
    patchAttributes(oldNode, newNode);
    if (!newNode.hasAttribute('data-morph-skip')) morphChildren(oldNode, newNode);
    return oldNode;
  }
  function morphChildren(parent, source) {
    const incoming = [...source.childNodes];
    const keyed = new Map();
    for (const child of parent.childNodes) { const key = morphKey(child); if (key) keyed.set(key, child); }
    const firstRects = new Map();
    if (!reduceMotion.matches) for (const [key, child] of keyed) if (key.startsWith('key:')) firstRects.set(key, child.getBoundingClientRect());
    const placed = [];
    let prev = null;
    for (const next of incoming) {
      const key = morphKey(next);
      let slot = prev ? prev.nextSibling : parent.firstChild;
      let match = null;
      if (key) {
        match = keyed.get(key) || null;
        if (match && (placed.includes(match) || (!sameKind(match, next) && next.id !== 'room-chat-slot'))) match = null;
      } else {
        let probe = slot;
        if (next.nodeType === 1) { while (probe && (morphKey(probe) || !sameKind(probe, next))) probe = probe.nextSibling; }
        else if (probe && (morphKey(probe) || probe.nodeType !== next.nodeType)) probe = null;
        if (probe) {
          for (let node = slot; node && node !== probe;) { const following = node.nextSibling; if (!morphKey(node)) node.remove(); node = following; }
          match = probe;
          slot = prev ? prev.nextSibling : parent.firstChild;
        }
      }
      const node = match ? morphNode(match, next) : next;
      if (node !== slot) parent.insertBefore(node, slot);
      placed.push(node);
      prev = node;
    }
    for (let node = prev ? prev.nextSibling : parent.firstChild; node;) { const following = node.nextSibling; node.remove(); node = following; }
    if (firstRects.size && typeof Element.prototype.animate === 'function') {
      for (const node of placed) {
        if (node.nodeType !== 1 || hasTransient(node)) continue;
        const first = firstRects.get(morphKey(node));
        if (!first) continue;
        const last = node.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 480, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      }
    }
  }
  function paintScreen(sameScreen, screenClass, html) {
    const current = app.firstElementChild;
    if (sameScreen && current && current.classList.contains(screenClass)) {
      try {
        const template = document.createElement('template');
        template.innerHTML = html.replace('class="fade-in ', 'class="');
        morphChildren(app, template.content);
        return;
      } catch (error) { console.error(error); }
    }
    app.innerHTML = html;
  }

  function patchList(container, items, keyOf, htmlOf, enterClass) {
    const hadItems = Boolean(container.querySelector('[data-key]'));
    const old = new Map();
    const firstRects = new Map();
    for (const el of container.children) if (el.dataset && el.dataset.key) { old.set(el.dataset.key, el); firstRects.set(el.dataset.key, el.getBoundingClientRect()); }
    const nodes = items.map(item => {
      const key = String(keyOf(item));
      const html = htmlOf(item).trim();
      const prev = old.get(key);
      if (prev && prev.dataset.sig === html) return prev;
      const tpl = document.createElement('template');
      tpl.innerHTML = html;
      const fresh = tpl.content.firstElementChild;
      fresh.dataset.key = key;
      fresh.dataset.sig = html;
      if (!prev && hadItems && enterClass) fresh.classList.add(enterClass);
      return fresh;
    });
    const keep = new Set(nodes);
    for (const el of [...container.children]) if (!keep.has(el)) el.remove();
    nodes.forEach((node, index) => {
      if (container.children[index] !== node) container.insertBefore(node, container.children[index] || null);
    });
    if (firstRects.size && !reduceMotion.matches && typeof Element.prototype.animate === 'function') {
      for (const node of nodes) {
        const first = firstRects.get(node.dataset.key);
        if (!first) continue;
        const last = node.getBoundingClientRect();
        const dx = first.left - last.left;
        const dy = first.top - last.top;
        if (Math.abs(dx) < 1 && Math.abs(dy) < 1) continue;
        node.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], { duration: 480, easing: 'cubic-bezier(.22, 1, .36, 1)' });
      }
    }
  }

  function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);
  }
  function playerId() {
    let id = localStorage.getItem(PLAYER_KEY);
    if (!id) {
      id = (crypto.randomUUID ? crypto.randomUUID() : `wl-${Date.now()}-${Math.random().toString(36).slice(2)}`);
      localStorage.setItem(PLAYER_KEY, id);
    }
    return id;
  }
  function saveSession(session) {
    state.session = session;
    localStorage.setItem(SESSION_KEY, JSON.stringify(session));
  }
  function clearSession() {
    state.session = null;
    state.room = null;
    roomChat.code = null;
    localStorage.removeItem(SESSION_KEY);
  }
  function readSession() {
    try {
      const value = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null');
      return value && value.code && value.playerId && value.name ? value : null;
    } catch { return null; }
  }
  function showToast(message, type = 'info') {
    toastNode.textContent = message;
    toastNode.className = `toast show ${type}`;
    clearTimeout(state.toastTimer);
    state.toastTimer = setTimeout(() => { toastNode.className = 'toast'; }, 2600);
  }
  async function request(event, payload = {}) {
    if (!window.firebaseClient) {
      return { ok: false, message: 'Firebase 클라이언트가 초기화되지 않았어요.' };
    }
    try {
      return await window.firebaseClient.request(event, payload);
    } catch (error) {
      return { ok: false, message: error.message || '요청 처리 중 오류가 발생했어요.' };
    }
  }
  function hashName(name) {
    let hash = 2166136261;
    for (const char of String(name ?? '').normalize('NFC')) {
      hash ^= char.codePointAt(0);
      hash = Math.imul(hash, 16777619) >>> 0;
    }
    return hash >>> 0;
  }
  function avatarStyle(name) {
    const hash = hashName(name);
    const hue = (hash % 24) * 15;
    const base = (hash >>> 8) & 1 ? 74 : 62;
    return `--av-a:hsl(${hue},58%,${base + 6}%);--av-b:hsl(${hue},52%,${base - 12}%);--av-fg:hsl(${hue},45%,10%)`;
  }
  const AVATAR_KEY = 'wordlink.avatar';
  const FALLBACK_AVATARS = ['🐶','🐱','🐰','🦊','🐻','🐼','🐨','🐯','🦁','🐮','🐷','🐸','🐵','🐔','🐧','🐦','🦉','🦄','🐙','🐳','🐢','🦋','🌵','🍀'];
  const picByName = new Map();
  let avatarChoices = FALLBACK_AVATARS;
  function readSavedAvatar() { try { return localStorage.getItem(AVATAR_KEY) || ''; } catch { return ''; } }
  function noteAvatars(list) {
    for (const item of list || []) { if (!item || !item.name) continue; if (item.avatar) picByName.set(item.name, item.avatar); else picByName.delete(item.name); }
  }
  function avatar(name, small = false) {
    const pic = picByName.get(name);
    if (pic) return `<span class="avatar tinted has-pic ${small ? 'small' : ''}" style="${avatarStyle(name)}">${escapeHtml(pic)}</span>`;
    return `<span class="avatar tinted ${small ? 'small' : ''}" style="${avatarStyle(name)}">${escapeHtml((name || '?').slice(0, 1))}</span>`;
  }
  const TIER_FROM = [1, 5, 10, 20, 35, 50, 70, 90];
  function tierOf(level) { let tier = 0; TIER_FROM.forEach((from, index) => { if (level >= from) tier = index; }); return tier; }
  function lvBadge(level) { return Number.isFinite(level) && level > 0 ? `<span class="lv-badge tier-${tierOf(level)}" title="레벨 ${level}">Lv.${level}</span>` : ''; }
  function xpBar(pct, extraClass = '', style = '') { return `<div class="xp-track"><i class="xp-fill ${extraClass}" style="width:${Math.max(0, Math.min(100, pct))}%;${style}"></i></div>`; }
  async function loadProfile() {
    const result = await request('profile:me');
    if (!result.ok) return null;
    state.profile = result.guest ? { guest: true } : result.profile;
    updateProfile();
    return state.profile;
  }
  function setConnection(connected) {
    if (state.idleClosed) { connectionDot.className = 'offline'; connectionLabel.textContent = '접속 종료'; return; }
    connectionDot.className = connected ? 'online' : 'offline';
    connectionLabel.textContent = connected ? '연결됨' : '연결 중';
  }
  function setRoom(room) {
    noteAvatars(room.players);
    state.room = room;
    render();
  }

  const sound = (() => {
    let ctx = null;
    let enabled = true;
    try { enabled = localStorage.getItem(SOUND_KEY) !== 'off'; } catch { /* 저장소를 쓸 수 없으면 무시 */ }
    const lastPlayed = {};
    const PATTERNS = {
      submit: [{ freq: 523, dur: .09 }, { freq: 784, at: .08, dur: .14 }],
      word: [{ freq: 440, dur: .08, type: 'triangle', gain: .05 }],
      turn: [{ freq: 659, dur: .1 }, { freq: 988, at: .11, dur: .18 }],
      tick: [{ freq: 1320, dur: .05, type: 'square', gain: .025 }],
      error: [{ freq: 180, dur: .16, type: 'square', gain: .04, to: 140 }],
      eliminate: [{ freq: 392, dur: .35, type: 'sawtooth', gain: .04, to: 130 }],
      out: [{ freq: 300, dur: .2, type: 'triangle', gain: .05, to: 200 }],
      start: [{ freq: 440, dur: .1 }, { freq: 554, at: .1, dur: .1 }, { freq: 659, at: .2, dur: .2 }],
      win: [523, 659, 784, 1047].map((freq, i) => ({ freq, at: i * .12, dur: i === 3 ? .5 : .14 })),
      end: [{ freq: 392, dur: .18, type: 'triangle' }, { freq: 330, at: .18, dur: .18, type: 'triangle' }, { freq: 262, at: .36, dur: .4, type: 'triangle' }],
      bonus: [{ freq: 784, dur: .08 }, { freq: 1047, at: .08, dur: .08 }, { freq: 1319, at: .16, dur: .22 }],
      pop: [{ freq: 700, dur: .07, gain: .035, to: 1000 }],
      toggle: [{ freq: 880, dur: .08, gain: .05 }],
      chat: [{ freq: 620, dur: .06, gain: .03 }, { freq: 830, at: .06, dur: .08, gain: .03 }],
      warn: [{ freq: 990, dur: .13, type: 'square', gain: .05 }, { freq: 740, at: .15, dur: .13, type: 'square', gain: .05 }, { freq: 990, at: .3, dur: .13, type: 'square', gain: .05 }]
    };
    function context() {
      if (!ctx) {
        const Ctor = window.AudioContext || window.webkitAudioContext;
        if (!Ctor) return null;
        try { ctx = new Ctor(); } catch { return null; }
      }
      return ctx;
    }
    function unlock() {
      const audio = context();
      if (audio && audio.state === 'suspended') audio.resume().catch(() => {});
    }
    function tone(audio, { freq, at = 0, dur = .12, type = 'sine', gain = .07, to = null }) {
      const start = audio.currentTime + at;
      const osc = audio.createOscillator();
      const amp = audio.createGain();
      osc.type = type;
      osc.frequency.setValueAtTime(freq, start);
      if (to) osc.frequency.exponentialRampToValueAtTime(to, start + dur);
      amp.gain.setValueAtTime(0.0001, start);
      amp.gain.exponentialRampToValueAtTime(gain, start + .012);
      amp.gain.exponentialRampToValueAtTime(0.0001, start + dur);
      osc.connect(amp);
      amp.connect(audio.destination);
      osc.start(start);
      osc.stop(start + dur + .03);
    }
    function play(name, delayMs = 0) {
      if (!enabled || !PATTERNS[name]) return;
      if (delayMs > 0) { setTimeout(() => play(name), delayMs); return; }
      const audio = context();
      if (!audio) return;
      if (audio.state !== 'running') { unlock(); return; }
      const now = performance.now();
      if (now - (lastPlayed[name] ?? -Infinity) < 70) return;
      lastPlayed[name] = now;
      PATTERNS[name].forEach(note => tone(audio, note));
    }
    function beat(progress, mine) {
      if (!enabled) return;
      const audio = context();
      if (!audio) return;
      if (audio.state !== 'running') { unlock(); return; }
      const p = Math.max(0, Math.min(1, progress));
      tone(audio, { freq: 760 + p * 960, dur: .07, type: 'square', gain: mine ? .045 + p * .05 : .016 + p * .014 });
      if (mine) {
        tone(audio, { freq: 120, to: 55, dur: .2, type: 'sine', gain: .14 + p * .1 });
        tone(audio, { freq: 100, to: 50, at: .15, dur: .17, type: 'sine', gain: .1 + p * .08 });
      }
    }
    async function setEnabled(value) {
      enabled = Boolean(value);
      try { localStorage.setItem(SOUND_KEY, enabled ? 'on' : 'off'); } catch { /* 무시 */ }
      if (enabled) {
        const audio = context();
        if (audio && audio.state === 'suspended') { try { await audio.resume(); } catch { /* 무시 */ } }
        play('toggle');
      }
    }
    ['pointerdown', 'keydown', 'touchend'].forEach(type => window.addEventListener(type, unlock, { passive: true }));
    return { play, beat, setEnabled, get enabled() { return enabled; } };
  })();
  function syncSoundButton() {
    const button = $('#sound-toggle');
    if (!button) return;
    button.setAttribute('aria-pressed', String(sound.enabled));
    button.setAttribute('aria-label', sound.enabled ? '효과음 켜짐 (누르면 끄기)' : '효과음 꺼짐 (누르면 켜기)');
    const label = $('#sound-state');
    if (label) label.textContent = sound.enabled ? 'ON' : 'OFF';
  }

  function announceMissionChange(prev, next) {
    const change = next && next.missionChange;
    if (!change || !next.code) return;
    if (prev && prev.code === next.code && prev.gameId === next.gameId && prev.missionChange && prev.missionChange.seq === change.seq) return;
    if (!prev || prev.code !== next.code) { state.missionFlashSeq = change.seq; return; }
    state.missionFlashSeq = change.seq;
    showToast(`🔄 ${change.playerName}님이 미션 글자 ‘${change.from}’을(를) 썼어요! 새 미션: ‘${change.to}’`, 'success');
  }

  function playRoomSounds(prev, next) {
    if (!prev || !state.session || prev.code !== next.code) return;
    const me = state.session.playerId;
    if (prev.state !== 'playing' && next.state === 'playing') { sound.play('start'); return; }
    if (prev.state === 'playing' && next.state === 'finished') { sound.play(next.winnerId && next.winnerId === me ? 'win' : 'end'); return; }
    if (prev.state === 'playing' && next.state === 'intermission') { sound.play(next.roundResult && next.roundResult.winnerId === me ? 'win' : 'end'); return; }
    if (next.state !== 'playing') return;
    const newWord = next.totalWords > prev.totalWords;
    const lastWord = newWord ? next.words.filter(item => item.type === 'word').slice(-1)[0] : null;
    const prevOut = new Set(prev.players.filter(player => player.eliminated).map(player => player.id));
    const newlyOut = next.players.filter(player => player.eliminated && !prevOut.has(player.id));
    const myTurnNow = next.currentPlayerId === me && prev.currentPlayerId !== me;
    if (newlyOut.length) sound.play(newlyOut.some(player => player.id === me) ? 'eliminate' : 'out');
    else if (lastWord && lastWord.playerId !== me) sound.play('word');
    if (myTurnNow) sound.play('turn', newlyOut.length || (lastWord && lastWord.playerId !== me) ? 220 : 0);
  }

  function showReaction(payload) {
    const layer = $('#reaction-layer');
    if (!layer || !payload || !REACTIONS.includes(payload.emoji)) return;
    sound.play('pop');
    if (document.hidden) return;
    while (layer.children.length >= 30) layer.firstChild.remove();
    const node = document.createElement('div');
    node.className = `reaction-float${state.session && payload.playerId === state.session.playerId ? ' mine' : ''}`;
    node.style.left = `${8 + Math.random() * 84}%`;
    node.style.setProperty('--drift', `${Math.round((Math.random() - .5) * 70)}px`);
    const emoji = document.createElement('span');
    emoji.className = 'reaction-emoji';
    emoji.textContent = payload.emoji;
    const name = document.createElement('span');
    name.className = 'reaction-name';
    name.textContent = String(payload.name ?? '');
    name.style.cssText = avatarStyle(payload.name);
    node.append(emoji, name);
    layer.append(node);
    node.addEventListener('animationend', () => node.remove());
    setTimeout(() => node.remove(), 3200);
  }
  async function sendReaction(emoji) {
    if (!state.room || !state.session || !REACTIONS.includes(emoji)) return;
    const now = Date.now();
    if (now - state.lastReactionAt < REACTION_COOLDOWN_MS) return;
    state.lastReactionAt = now;
    const result = await request('game:react', { code: state.room.code, playerId: state.session.playerId, emoji });
    if (!result.ok && !result.throttled) showToast(result.message, 'error');
  }

  function formatDuration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const minutes = Math.floor(total / 60);
    const seconds = total % 60;
    return minutes ? `${minutes}분 ${String(seconds).padStart(2, '0')}초` : `${seconds}초`;
  }
  function rewardMarkup(reward, animate) {
    if (!reward) return state.auth.user ? '' : '<p class="reward-note">로그인하면 경험치와 전적이 저장돼요.</p>';
    if (reward.skipped === 'short') return '<p class="reward-note">경기가 너무 짧아 경험치는 지급되지 않았어요. (단어 6개 이상 · 2명 이상 참여)</p>';
    if (reward.skipped === 'noword') return '<p class="reward-note">단어를 하나도 내지 않아 경험치는 지급되지 않았어요.</p>';
    const from = reward.leveledUp ? 0 : reward.before.pct;
    const parts = reward.parts.map(part => `<li><span>${escapeHtml(part.label)}</span><b>+${part.xp}</b></li>`).join('');
    return `<div class="reward-box${reward.leveledUp ? ' levelup' : ''}">
      <div class="reward-head">
        <strong>+${reward.xp} XP</strong>
        <span class="reward-level">${lvBadge(reward.after.level)}${reward.leveledUp ? `<em>LEVEL UP!</em>` : ''}</span>
      </div>
      ${xpBar(reward.after.pct, animate ? 'grow' : '', `--from:${from}%`)}
      <div class="reward-sub"><span>${escapeHtml(reward.title)}${reward.newTitle ? ' · 새 칭호!' : ''}</span><span>${reward.after.max ? 'MAX' : `다음 레벨까지 ${(reward.after.need - reward.after.into).toLocaleString('ko-KR')} XP`}</span></div>
      <ul class="reward-parts">${parts}</ul>
    </div>`;
  }


  let loginBusy = false;
  async function socialLogin(providerId) {
    if (loginBusy) return;
    loginBusy = true;
    try {
      const user = await window.signInWithProvider(providerId);
      if (!user) return; // 리다이렉트 방식으로 이동 중
      applyAuthUser(user);
      showToast(`${user.displayName || user.suggestedName || user.email || 'Google 계정'} 님, 환영해요!`, 'success');
      closeDialog();
      if (!state.nickname && !state.room) renderHome(); else render();
    } catch (error) {
      console.error('[login]', error);
      const messages = {
        'auth/popup-closed-by-user': '로그인 창을 닫았어요.',
        'auth/cancelled-popup-request': '로그인 창이 이미 열려 있어요.',
        'auth/unauthorized-domain': '이 주소는 Firebase 에 승인되지 않았어요. 승인된 도메인에 현재 주소를 추가해 주세요.',
        'auth/operation-not-allowed': 'Firebase 콘솔에서 Google 로그인을 켜 주세요.',
        'auth/network-request-failed': '네트워크 오류예요. 연결을 확인해 주세요.'
      };
      showToast(messages[error.code] || '소셜 로그인에 실패했어요. 다시 시도해 주세요.', 'error');
    } finally {
      loginBusy = false;
    }
  }
  function applyAuthUser(user) {
    state.auth.user = user || null;
    state.auth.uid = user ? user.uid : null;
    state.auth.isAnonymous = false;
    if (user) loadProfile();
  }
  // client.js 전체가 함수 안(IIFE)이라 onclick="socialLogin()" 은 전역에서 함수를 못 찾는다 → 이벤트 위임 사용
  document.addEventListener('click', event => {
    const button = event.target.closest && event.target.closest('[data-social]');
    if (button) { event.preventDefault(); socialLogin(button.dataset.social); }
  });

  function loginPrompt(title, note) {
    const links = state.auth.providers.map(provider => `<button class="social-button social-${escapeHtml(provider.id)}" type="button" data-social="${escapeHtml(provider.id)}"><i aria-hidden="true">${escapeHtml(provider.label.slice(0, 1))}</i>${escapeHtml(provider.label)}</button>`).join('');
    openDialog(`
      <h2 class="dialog-title">${title}</h2>
      <p class="dialog-note">${note}</p>
      ${links ? `<div class="social-row" style="margin-top:16px">${links}</div>` : '<p class="dialog-note" style="margin-top:12px">아직 소셜 로그인이 설정되어 있지 않아요.</p>'}
      <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>?リ린</button></div>`);
  }
  function formatAgo(at) {
    const diff = Math.max(0, Date.now() - at);
    const minutes = Math.floor(diff / 60000);
    if (minutes < 1) return '방금';
    if (minutes < 60) return `${minutes}분 전`;
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return `${hours}시간 전`;
    return `${Math.floor(hours / 24)}일 전`;
  }
  async function openMyPage() {
    if (!state.auth.user) {
      return loginPrompt('👤 마이페이지', '게스트는 기록이 저장되지 않아요.<br>소셜 계정으로 로그인하면 점수 · 레벨 · 전적이 쌓이고 랭킹에도 올라요!');
    }
    const node = openDialog('<h2 class="dialog-title">👤 마이페이지</h2><p class="dialog-note">불러오는 중…</p>');
    const p = await loadProfile();
    if (!$('#dialog') || $('#dialog') !== node) return;
    if (!p || p.guest) { node.firstElementChild.innerHTML = '<h2 class="dialog-title">👤 마이페이지</h2><p class="dialog-note">기록을 불러오지 못했어요. 잠시 후 다시 시도해 주세요.</p><div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>닫기</button></div>'; node.querySelector('[data-cancel]').addEventListener('click', closeDialog); return; }
    const winRate = p.games ? `${Math.round((p.wins / p.games) * 100)}%` : '—';
    const tile = (label, value, note = '') => `<div class="mp-tile"><small>${label}</small><strong>${value}</strong>${note ? `<span>${note}</span>` : ''}</div>`;
    const tiles = [
      tile('플레이', `${p.games}판`, `${p.wins}승`),
      tile('승률', winRate),
      tile('연승', `${p.streak}`, `최고 ${p.bestStreak}`),
      tile('라운드 승리', `${p.roundWins}`),
      tile('누적 점수', p.totalScore.toLocaleString('ko-KR')),
      tile('한 경기 최고', p.bestMatchScore.toLocaleString('ko-KR')),
      tile('낸 단어', `${p.words.toLocaleString('ko-KR')}개`),
      tile('가장 긴 단어', p.longestWord ? escapeHtml(p.longestWord) : '—', p.longestWord ? `${p.longestWord.length}글자` : ''),
      tile('최고 득점 단어', p.bestWord ? escapeHtml(p.bestWord) : '—', p.bestWord ? `+${p.bestWordPoints}점` : ''),
      tile('미션 글자', `${p.missionHits}회`)
    ].join('');
    const recent = p.recent.length ? p.recent.map(item => `<li class="mp-match${item.won ? ' won' : ''}"><span class="mp-rank">${item.won ? '🏆' : `${item.rank}위`}</span><span class="mp-match-info">${item.players}명 · ${item.score}점</span><b class="mp-xp">+${item.xp} XP</b><time>${formatAgo(item.at)}</time></li>`).join('') : '<li class="mp-empty">아직 기록이 없어요. 친구와 한 판 해 보세요!</li>';
    node.firstElementChild.classList.add('wide');
    node.firstElementChild.innerHTML = `
      <h2 class="dialog-title">👤 마이페이지</h2>
      <div class="mp-head">${avatar(p.name || state.nickname)}<div><strong>${escapeHtml(p.name || state.nickname)}</strong><span>${lvBadge(p.level)} ${escapeHtml(p.title)}${p.rank ? ` · 전체 ${p.rank}위` : ''}</span></div></div>
      <div class="xp-box mp-xp">
        <div class="xp-top"><b>경험치</b><span>${p.max ? 'MAX' : `${p.xpInto.toLocaleString('ko-KR')} / ${p.xpNeed.toLocaleString('ko-KR')} XP`}</span></div>
        ${xpBar(p.pct)}
        <div class="xp-total">누적 ${p.xp.toLocaleString('ko-KR')} XP</div>
      </div>
      <div class="mp-grid">${tiles}</div>
      <h3 class="mp-subtitle">최근 경기</h3>
      <ul class="mp-matches">${recent}</ul>
      <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>?リ린</button></div>`;
    node.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', closeDialog));
  }
  async function openRanking() {
    const node = openDialog('<h2 class="dialog-title">🏆 랭킹</h2><p class="dialog-note">불러오는 중…</p>');
    const result = await request('ranking:top');
    if ($('#dialog') !== node) return;
    const card = node.firstElementChild;
    card.classList.add('wide');
    if (result.ok) noteAvatars(result.list);
    if (!result.ok) {
      card.innerHTML = `<h2 class="dialog-title">🏆 랭킹</h2><p class="dialog-note">${escapeHtml(result.message || '랭킹을 불러오지 못했어요.')}</p><div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>닫기</button></div>`;
    } else {
      const mine = state.auth.user ? state.nickname : null;
      const rows = result.list.length ? result.list.map(row => `<li class="rk-row${row.name === mine ? ' me' : ''}"><span class="rk-rank${row.rank <= 3 ? ` top${row.rank}` : ''}">${row.rank}</span>${avatar(row.name, true)}<span class="rk-name">${lvBadge(row.level)}${escapeHtml(row.name)}</span><span class="rk-stat">${row.wins}승 / ${row.games}판</span><b class="rk-xp">${row.xp.toLocaleString('ko-KR')} XP</b></li>`).join('') : '<li class="mp-empty">아직 랭킹에 오른 사람이 없어요</li>';
      card.innerHTML = `
        <h2 class="dialog-title">🏆 랭킹</h2>
        <p class="dialog-note">경험치 상위 30명이에요.${state.auth.user ? (result.myRank ? ` 내 순위는 <b>${result.myRank}위</b>.` : ' 한 판 이상 하면 랭킹에 올라요.') : ' 로그인하면 랭킹에 도전할 수 있어요.'}</p>
        <ol class="rk-list">${rows}</ol>
        <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>?リ린</button></div>`;
    }
    card.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', closeDialog));
  }

  function summaryMarkup(room, isHost, animate) {
    const summary = room.summary;
    if (!summary) return '';
    const me = state.session.playerId;
    const winner = summary.ranking.find(row => row.isWinner);
    const tiles = [
      ['단어 수', `${summary.totalWords}개`, ''],
      ['가장 긴 단어', summary.longestWord ? escapeHtml(summary.longestWord.word) : '—', summary.longestWord ? escapeHtml(summary.longestWord.playerName) : ''],
      ['가장 빠른 입력', summary.fastestWord ? `${(summary.fastestWord.elapsedMs / 1000).toFixed(1)}초` : '—', summary.fastestWord ? `${escapeHtml(summary.fastestWord.word)} · ${escapeHtml(summary.fastestWord.playerName)}` : ''],
      ['플레이 시간', summary.durationMs == null ? '—' : formatDuration(summary.durationMs), '']
    ].map(([label, value, note]) => `<div class="summary-stat"><small>${label}</small><strong>${value}</strong>${note ? `<span>${note}</span>` : ''}</div>`).join('');
    const levels = new Map(room.players.map(player => [player.id, player.level]));
    const rows = summary.ranking.map(row => {
      const status = row.isWinner ? '우승' : row.eliminated ? '탈락' : '생존';
      const detail = `${status} · ${row.roundWins}승 · 단어 ${row.wordCount}개${row.longestWord ? ` · 가장 긴 단어 ${escapeHtml(row.longestWord)}` : ''}`;
      return `<li class="summary-row ${row.isWinner ? 'winner' : ''}">
        <span class="summary-rank">${row.rank}</span>
        ${avatar(row.name, true)}
        <div class="summary-name">${lvBadge(levels.get(row.id))}${escapeHtml(row.name)}${row.id === me ? '<em class="summary-me">나</em>' : ''}${row.isWinner ? ' 👑' : ''}<small>${detail}</small></div>
        <span class="summary-score">${row.score}<small>점</small></span>
      </li>`;
    }).join('');
    return `
      <div id="summary-backdrop" class="summary-backdrop ${animate ? 'enter' : ''}" role="dialog" aria-modal="true" aria-labelledby="summary-title">
        <div class="summary-card" tabindex="-1">
          <button id="summary-close" class="summary-close" type="button" aria-label="결과 창 닫기">✕</button>
          <div class="summary-kicker">경기 종료</div>
          <h2 id="summary-title" class="summary-title">${winner ? `${escapeHtml(winner.name)} 우승!` : '우승자 없음'}</h2>
          <p class="summary-sub">${winner ? '가장 많은 라운드를 이겼어요.' : '모두 수고했어요.'}</p>
          <div class="summary-stats">${tiles}</div>
          ${rewardMarkup(state.rewards.get(room.gameId), animate)}
          <ol class="summary-ranking">${rows}</ol>
          <div class="summary-actions">
            <button id="summary-dismiss" class="ghost-button" type="button">?リ린</button>
            ${isHost ? '<button id="summary-rematch" class="primary-button" type="button">다시 하기</button>' : '<span class="summary-wait">방장을 기다리는 중</span>'}
          </div>
        </div>
      </div>`;
  }
  function closeSummary() {
    if (!state.room) return;
    const gameId = state.room.gameId;
    const node = $('#summary-backdrop');
    const finish = () => { state.summaryClosedGame = gameId; render(); };
    if (!node) { finish(); return; }
    if (node.classList.contains('leaving')) return;
    node.classList.add('leaving');
    setTimeout(finish, 230);
  }


  async function initFirebaseConnection() {
    if (!window.firebaseClient) {
      showToast('Firebase 클라이언트를 불러오지 못했어요.', 'error');
      return;
    }
    const firebaseApp = window.firebaseClient.init();
    if (!firebaseApp) {
      showToast(window.__FIREBASE_ERROR__ || 'Firebase 초기화에 실패했어요.', 'error');
      return;
    }

    // 저장된 로그인 복원(새로고침해도 유지) + 리다이렉트 로그인 결과 처리
    await window.firebaseClient.authReady();
    applyAuthUser(window.firebaseClient.currentUser());
    if (window.__AUTH_REDIRECT_ERROR__) showToast('로그인 중 문제가 생겼어요. 다시 시도해 주세요.', 'error');
    window.firebaseClient.onAuthChange(user => {
      const changed = (user && user.uid) !== state.auth.uid;
      applyAuthUser(user);
      if (changed && !state.nickname && !state.room) renderHome();
    });

    window.firebaseClient.on('room:update', room => {
      if (state.session && room.code === state.session.code) {
        announceMissionChange(state.room, room);
        playRoomSounds(state.room, room);
        window.Bokgu?.room(state.room, room, state.session.playerId);
        setRoom(room);
      }
    });

    window.firebaseClient.on('lobby:rooms', rooms => {
      state.hub.rooms = rooms;
      updateRooms();
      updateProfile();
    });

    window.firebaseClient.on('lobby:users', payload => {
      noteAvatars(payload.list);
      state.hub.users = payload.list;
      state.hub.total = payload.total;
      updateUsers();
      updateProfile();
    });

    window.firebaseClient.on('lobby:chat', message => {
      state.hub.chat.push(message);
      if (state.hub.chat.length > 80) state.hub.chat.shift();
      appendChatLine(message);
    });

    window.firebaseClient.on('room:chat', appendRoomChat);

    window.firebaseClient.on('room:kicked', async payload => {
      if (!state.session || payload.code !== state.session.code) return;
      clearSession();
      history.replaceState({}, '', location.pathname);
      showToast(payload.message || '방장에게 추방되었어요.', 'error');
      if (state.nickname) { if (!(await enterLobby(state.nickname))) renderHome(); } else renderHome();
    });

    window.firebaseClient.on('profile:reward', payload => {
      state.rewards.set(payload.gameId, payload);
      if (payload.leveledUp) { sound.play('win', 500); showToast(`🎉 레벨 업! Lv.${payload.after.level}`, 'success'); }
      loadProfile();
      if (state.room && state.room.state === 'finished') render();
    });

    window.firebaseClient.on('game:reaction', showReaction);

    window.firebaseClient.on('notice', payload => showToast(payload.message || '알 수 없는 오류가 발생했어요.', payload.type || 'info'));

    window.firebaseClient.on('server:hello', payload => {
      document.documentElement.dataset.dictionarySize = String(payload.dictionarySize || 0);
      if (Array.isArray(payload.avatars) && payload.avatars.length) avatarChoices = payload.avatars;
    });

    setConnection(true);

    const saved = state.session || readSession();
    if (saved) {
      state.restoring = true;
      state.session = saved;
      const result = await request('room:restore', { code: saved.code, playerId: saved.playerId });
      state.restoring = false;
      if (result.ok) {
        state.nickname = saved.name;
        noteAvatars(result.room.players);
        state.room = result.room;
        roomChat.code = null;
        saveSession(saved);
        render();
      } else if (readSession()) {
        clearSession();
        if (state.nickname) await enterLobby(state.nickname, { silent: true }); else render();
        showToast(`이전 방에 돌아가지 못했어요. ${state.nickname ? '로비' : '홈'}으로 이동해요.`, 'error');
      }
      return;
    }

    if (state.nickname) await enterLobby(state.nickname, { silent: true });
  }

  initFirebaseConnection();

  function openDialog(html) {
    closeDialog();
    const node = document.createElement('div');
    node.id = 'dialog';
    node.className = 'dialog-backdrop';
    node.innerHTML = `<div class="dialog-card" role="dialog" aria-modal="true" tabindex="-1">${html}</div>`;
    document.body.append(node);
    document.body.classList.add('dialog-open');
    node.addEventListener('mousedown', event => { if (event.target === node) closeDialog(); });
    node.querySelectorAll('[data-cancel]').forEach(button => button.addEventListener('click', closeDialog));
    return node;
  }
  function closeDialog() {
    const node = $('#dialog');
    if (node) {
      node.removeAttribute('id');
      node.classList.add('closing');
      node.addEventListener('animationend', event => { if (event.target === node) node.remove(); });
      setTimeout(() => node.remove(), 450);
    }
    document.body.classList.remove('dialog-open');
    const callback = state.dialogClose;
    state.dialogClose = null;
    if (callback) callback();
  }
  function askPassword(note = '') {
    return new Promise(resolve => {
      const node = openDialog(`
        <h2 class="dialog-title">🔒 비밀번호 입력</h2>
        <p class="dialog-note">${escapeHtml(note || '이 방은 비밀번호가 필요해요.')}</p>
        <form id="password-form" autocomplete="off">
          <input id="password-input" class="text-input" type="password" maxlength="8" autocomplete="off" placeholder="비밀번호">
          <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>취소</button><button type="submit" class="primary-button">입장</button></div>
        </form>`);
      state.dialogClose = () => resolve(null);
      const input = $('#password-input', node);
      input.focus();
      $('#password-form', node).addEventListener('submit', event => {
        event.preventDefault();
        const value = input.value.trim();
        if (!value) return;
        state.dialogClose = null;
        closeDialog();
        resolve(value);
      });
    });
  }

  function renderHomeImpl() {
    const sameScreen = enterScreen('home');
    document.body.classList.remove('modal-open');
    closeDialog();
    const rawCode = new URLSearchParams(location.search).get('room') || '';
    const inviteCode = rawCode.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5);
    const { user, providers } = state.auth;
    const socialOk = !!(user && user.suggestedName);
    const mode = user && socialOk ? nickMode() : 'custom';
    app.innerHTML = `
      <section class="home-layout fade-in">
        <div class="hero-copy">
          <span class="eyebrow">WORD GAME 쨌 REALTIME</span>
          <h1 class="hero-title">친구와 함께,<br><span class="accent">끝없이 이어 가는 말</span></h1>
          <p class="hero-description">방 코드를 공유하면 친구들과 바로 실시간 끝말잇기를 즐길 수 있어요. 미션 글자와 라운드 규칙으로 더 짜릿하게!</p>
          <div class="feature-row">
            <span class="feature-chip"><b>⚡</b> 실시간 대전</span>
            <span class="feature-chip"><b>🎯</b> 미션 글자</span>
            <span class="feature-chip"><b>🏆</b> 레벨 · 랭킹</span>
          </div>
        </div>
        <section class="home-card">
          <div class="card-kicker">LET'S PLAY TOGETHER</div>
          <h2 class="card-heading">지금 시작해요</h2>
          <p class="card-subtitle">${user ? '로그인되었어요. 닉네임을 정해 주세요.' : '닉네임을 입력하거나 소셜 로그인으로 시작해요.'}</p>
          ${user ? `
          <div class="auth-chip"><span>✓ <b>${escapeHtml(user.providerLabel)}</b> 로 로그인됨</span><button id="auth-logout" class="link-button" type="button">로그아웃</button></div>
          <div class="nick-mode" role="radiogroup" aria-label="닉네임 방식">
            <label class="nick-option${socialOk ? '' : ' disabled'}">
              <input type="radio" name="nick-mode" value="social" ${mode === 'social' ? 'checked' : ''} ${socialOk ? '' : 'disabled'}>
              <span><b>소셜 이름 그대로</b><small>${socialOk ? escapeHtml(user.suggestedName) : '소셜 이름을 가져오지 못했어요 (직접 입력은 2~12자)'}</small></span>
            </label>
            <label class="nick-option">
              <input type="radio" name="nick-mode" value="custom" ${mode === 'custom' ? 'checked' : ''}>
              <span><b>직접 정하기</b><small>원하는 이름을 입력해요</small></span>
            </label>
          </div>` : ''}
          <div class="home-avatar-row"><span id="home-avatar-preview" class="avatar tinted has-pic">${escapeHtml(state.avatar || '🙂')}</span><button id="pick-avatar" class="ghost-button" type="button">프로필 사진 고르기</button></div>
          <div id="nick-field"${mode === 'social' ? ' hidden' : ''}>
            <label class="field-label" for="display-name">닉네임</label>
            <input id="display-name" class="text-input" type="text" maxlength="12" autocomplete="nickname" placeholder="2~12자 닉네임" value="${escapeHtml(localStorage.getItem('wordlink.nickname') || '')}">
          </div>
          <button id="enter-lobby" class="primary-button button-full" style="margin-top:18px">로비 입장 <span aria-hidden="true">→</span></button>
          ${inviteCode ? `<div class="divider-label">초대 링크로 왔어요</div><button id="join-invite" class="secondary-button button-full">방 ${escapeHtml(inviteCode)} 에 바로 입장</button>` : ''}
          ${!user && providers.length ? `
          <div class="divider-label">소셜 계정으로 로그인</div>
          <div class="social-row">${providers.map(p => `<button class="social-button social-${escapeHtml(p.id)}" type="button" data-social="${escapeHtml(p.id)}"><i aria-hidden="true">${escapeHtml(p.label.slice(0, 1))}</i>${escapeHtml(p.label)}</button>`).join('')}</div>` : ''}
          <p class="home-footnote">${user ? '로그인하면 경험치와 전적이 계정에 저장돼요.' : '게스트로도 플레이할 수 있지만 기록은 저장되지 않아요.'}</p>
        </section>
      </section>`;
    const enter = async invite => {
      const name = readNickname();
      if (!name) return;
      const button = $('#enter-lobby');
      button.disabled = true;
      button.textContent = '입장 중…';
      const ok = await enterLobby(name);
      if (!ok) { renderHome(); return; }
      if (invite) { history.replaceState({}, '', location.pathname); await joinByCode(invite); }
    };
    $('#pick-avatar').addEventListener('click', () => openAvatarPicker(value => {
      setMyAvatar(value);
      const preview = $('#home-avatar-preview');
      if (preview) preview.textContent = state.avatar || '🙂';
    }));
    $('#enter-lobby').addEventListener('click', () => enter(''));
    $('#display-name').addEventListener('keydown', event => { if (event.key === 'Enter') enter(''); });
    app.querySelectorAll('input[name="nick-mode"]').forEach(radio => radio.addEventListener('change', () => {
      try { localStorage.setItem(NICKMODE_KEY, radio.value); } catch { /* 저장소를 쓸 수 없으면 무시 */ }
      $('#nick-field').hidden = radio.value === 'social';
      if (radio.value === 'custom') $('#display-name').focus();
    }));
    if ($('#auth-logout')) $('#auth-logout').addEventListener('click', logout);
    if ($('#join-invite')) $('#join-invite').addEventListener('click', () => enter(inviteCode));
    settleScreen(sameScreen);
  }

  function nickMode() {
    try { return localStorage.getItem(NICKMODE_KEY) === 'custom' ? 'custom' : 'social'; } catch { return 'social'; }
  }
  async function logout() {
    try { await window.doSignOut(); } catch { }
    location.reload();
  }
  async function loadAuth() {
    const params = new URLSearchParams(location.search);
    const error = params.get('auth_error');
    if (error) {
      params.delete('auth_error');
      history.replaceState({}, '', location.pathname + (params.toString() ? `?${params}` : ''));
      showToast(error === 'denied' ? '로그인을 취소했어요.' : '로그인 중 문제가 생겼어요. 다시 시도해 주세요.', 'error');
    }
  }

  function readNickname() {
    const user = state.auth.user;
    if (user && user.suggestedName && nickMode() === 'social') return user.suggestedName;
    const input = $('#display-name');
    const name = (input?.value || '').trim();
    if (!/^[\p{L}\p{N}_-]{2,12}$/u.test(name)) {
      showToast('닉네임은 글자·숫자·_·- 로 2~12자여야 해요.', 'error');
      input?.focus();
      return '';
    }
    localStorage.setItem('wordlink.nickname', name);
    return name;
  }
  function setMyAvatar(value) {
    state.avatar = value || '';
    try { if (state.avatar) localStorage.setItem(AVATAR_KEY, state.avatar); else localStorage.removeItem(AVATAR_KEY); } catch { /* 저장소를 쓸 수 없으면 무시 */ }
    if (state.nickname) noteAvatars([{ name: state.nickname, avatar: state.avatar }]);
  }
  function openAvatarPicker(onPick) {
    const cell = (value, label) => `<button type="button" class="avatar-choice${state.avatar === value ? ' selected' : ''}" data-avatar="${escapeHtml(value)}" aria-pressed="${state.avatar === value}" aria-label="${escapeHtml(label)}">${value ? escapeHtml(value) : '<span class="avatar-choice-none">없음</span>'}</button>`;
    const node = openDialog(`
      <h2 class="dialog-title">프로필 사진</h2>
      <p class="dialog-note">마음에 드는 이모지를 골라 주세요</p>
      <div class="avatar-grid" role="group" aria-label="프로필 사진 목록">${cell('', '사진 없음 (닉네임 첫 글자)')}${avatarChoices.map(value => cell(value, `이모지 ${value}`)).join('')}</div>
      <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>?リ린</button></div>`);
    node.querySelectorAll('.avatar-choice').forEach(button => button.addEventListener('click', async () => {
      closeDialog();
      await onPick(button.dataset.avatar);
    }));
  }
  async function enterLobby(name, options = {}) {
    const result = await request('lobby:enter', { name, playerId: playerId(), avatar: state.avatar });
    if (!result.ok) {
      if (!options.silent || result.code === 'NAME_TAKEN') showToast(result.message, 'error');
      if (result.code !== 'IN_ROOM') state.nickname = null;
      if (options.silent) render();
      return false;
    }
    state.nickname = name;
    setMyAvatar(result.avatar || '');
    state.hub.rooms = result.rooms;
    noteAvatars(result.users.list);
    state.hub.users = result.users.list;
    state.hub.total = result.users.total;
    state.hub.chat = result.chat;
    if (!state.room) mountHub();
    loadProfile();
    return true;
  }
  async function leaveLobby() {
    await request('lobby:leave');
    state.nickname = null;
    state.hub.chat = [];
    renderHome();
  }

  function nameColor(name) { return `hsl(${(hashName(name) % 24) * 15},55%,30%)`; }
  function whereLabel(user) {
    if (user.where === 'waiting') return `대기실 ${user.roomNumber}번`;
    if (user.where === 'playing') return `게임중 ${user.roomNumber}번`;
    return '로비';
  }
  function mountHubImpl() {
    enterScreen('hub');
    document.body.classList.remove('modal-open');
    closeDialog();
    if (!$('#hub')) {
      app.innerHTML = `
        <section id="hub" class="hub fade-in">
          <div class="hub-tabs">
            <button id="hub-create" class="hub-tab primary" type="button">방 만들기</button>
            <button id="hub-quick" class="hub-tab" type="button">빠른 입장</button>
            <button id="hub-code" class="hub-tab" type="button">코드로 입장</button>
            <button id="hub-refresh" class="hub-tab" type="button">새로고침</button>
            <button id="hub-mypage" class="hub-tab" type="button">👤 마이페이지</button>
            <button id="hub-ranking" class="hub-tab" type="button">🏆 랭킹</button>
            <span class="hub-tabs-spacer"></span>
            <span id="hub-summary" class="hub-summary"></span>
          </div>
          <div class="hub-grid">
            <section class="panel hub-users">
              <div class="panel-header"><span class="panel-title">접속자</span><span id="hub-user-count" class="panel-caption"></span></div>
              <ul id="hub-user-list" class="hub-user-list"></ul>
            </section>
            <section class="panel hub-rooms">
              <div class="panel-header">
                <span class="panel-title">방 목록 <span id="hub-room-count" class="panel-caption"></span></span>
                <label class="hub-filter"><input id="hub-filter" type="checkbox"> 입장 가능한 방만</label>
              </div>
              <div id="hub-room-grid" class="hub-room-grid"></div>
            </section>
            <section class="panel hub-profile">
              <div class="panel-header"><span class="panel-title">내 정보</span></div>
              <div id="hub-profile-body" class="hub-profile-body"></div>
            </section>
            <section class="panel hub-chat">
              <div class="panel-header"><span class="panel-title">로비 채팅</span><span class="panel-caption">최근 60개</span></div>
              <div id="hub-chat-log" class="hub-chat-log" role="log" aria-live="polite"></div>
              <form id="hub-chat-form" class="hub-chat-form" autocomplete="off">
                <input id="hub-chat-input" class="text-input" type="text" maxlength="${CHAT_MAX_LENGTH}" placeholder="메시지를 입력하고 Enter">
                <button class="primary-button" type="submit">전송</button>
              </form>
            </section>
          </div>
        </section>`;
      $('#hub-create').addEventListener('click', openCreateDialog);
      $('#hub-quick').addEventListener('click', quickJoin);
      $('#hub-code').addEventListener('click', openCodeDialog);
      $('#hub-refresh').addEventListener('click', refreshHub);
      $('#hub-mypage').addEventListener('click', openMyPage);
      $('#hub-ranking').addEventListener('click', openRanking);
      $('#hub-filter').addEventListener('change', event => { state.hub.onlyJoinable = event.target.checked; updateRooms(); });
      $('#hub-room-grid').addEventListener('click', event => {
        const card = event.target.closest('.room-card');
        if (!card) return;
        if (card.dataset.status === 'playing') return showToast('게임이 진행 중인 방이에요.', 'error');
        if (card.dataset.status === 'full') return showToast('가득 찬 방이에요.', 'error');
        joinByCode(card.dataset.code);
      });
      $('#hub-chat-form').addEventListener('submit', sendChat);
    }
    $('#hub-filter').checked = state.hub.onlyJoinable;
    updateUsers();
    updateRooms();
    updateProfile();
    renderChatLog();
  }
  function updateUsers() {
    const list = $('#hub-user-list');
    if (!list) return;
    $('#hub-user-count').textContent = `${state.hub.total}명`;
    if (!state.hub.users.length) { list.innerHTML = '<li class="hub-empty">접속자가 없어요</li>'; return; }
    patchList(list, state.hub.users, user => user.name, user => `
      <li class="hub-user${user.name === state.nickname ? ' me' : ''}" title="${escapeHtml(user.name)}">
        ${avatar(user.name, true)}
        <span class="hub-user-name">${lvBadge(user.level)}${escapeHtml(user.name)}${user.name === state.nickname ? ' <em>(나)</em>' : ''}</span>
        <span class="hub-user-where ${user.where}">${whereLabel(user)}</span>
      </li>`, 'enter');
  }
  function roomCardHtml(room) {
    const status = room.state === 'playing' ? 'playing' : room.joinable ? 'waiting' : 'full';
    const label = { playing: '게임중', waiting: '대기중', full: '가득 참' }[status];
    return `
      <button type="button" class="room-card ${status}" data-code="${escapeHtml(room.code)}" data-status="${status}">
        <span class="room-num"><i class="room-dot ${status}"></i>${room.number}</span>
        <span class="room-title">${escapeHtml(room.title)}</span>
        <span class="room-lock${room.locked ? ' on' : ''}" title="${room.locked ? '비밀번호 방' : '누구나 입장 가능'}">${room.locked ? '🔒' : '🔓'}</span>
        <span class="room-rule">${room.rounds}라운드 · ${room.totalSeconds}초 · 턴 ${room.turnSeconds}초${room.allowOneShot === false ? ' · 한방 금지' : ''}</span>
        <span class="room-meta"><span class="room-host">방장 ${escapeHtml(room.hostName || '-')}</span><span class="room-people">인원 ${room.players}/${room.maxPlayers}</span><span class="room-state ${status}">${label}</span></span>
      </button>`;
  }
  function updateRooms() {
    const grid = $('#hub-room-grid');
    if (!grid) return;
    const rooms = state.hub.onlyJoinable ? state.hub.rooms.filter(room => room.joinable) : state.hub.rooms;
    $('#hub-room-count').textContent = `${state.hub.rooms.length}개`;
    if (!rooms.length) {
      grid.innerHTML = `<div class="hub-empty">${state.hub.rooms.length ? '조건에 맞는 방이 없어요' : '열린 방이 없어요<br>새 방을 만들어 보세요'}</div>`;
      return;
    }
    patchList(grid, rooms, room => room.code, roomCardHtml, 'enter');
  }
  function updateProfile() {
    const body = $('#hub-profile-body');
    if (!body) return;
    const summary = $('#hub-summary');
    if (summary) summary.textContent = `방 ${state.hub.rooms.length}개 · 접속 ${state.hub.total}명`;
    const p = state.profile;
    const known = p && !p.guest;
    const level = known ? `
      <div class="xp-box">
        <div class="xp-top">${lvBadge(p.level)}<b>${escapeHtml(p.title)}</b><span>${p.max ? 'MAX' : `${p.xpInto.toLocaleString('ko-KR')} / ${p.xpNeed.toLocaleString('ko-KR')} XP`}</span></div>
        ${xpBar(p.pct)}
      </div>` : p && p.guest ? '<p class="hub-guest-note">게스트는 기록이 저장되지 않아요. 로그인하면 기록이 쌓여요.</p>' : '';
    const html = `
      <div class="hub-profile-main">${avatar(state.nickname)}<div><strong>${escapeHtml(state.nickname)}</strong><small>${known ? `${p.games}판 ${p.wins}승` : '로그인하면 기록이 저장돼요'}</small></div></div>
      ${level}
      <button id="hub-profile-open" class="secondary-button button-full" type="button">${known ? '마이페이지' : '기록 보기'}</button>
      <button id="hub-avatar" class="ghost-button button-full" type="button">프로필 사진</button>
      <button id="hub-rename" class="ghost-button button-full" type="button">닉네임 변경</button>`;
    if (body.dataset.sig === html) return;
    body.dataset.sig = html;
    body.innerHTML = html;
    $('#hub-profile-open').addEventListener('click', openMyPage);
    $('#hub-avatar').addEventListener('click', () => openAvatarPicker(async value => {
      const result = await request('profile:avatar', { avatar: value });
      if (!result.ok) { showToast(result.message || '변경하지 못했어요.', 'error'); return; }
      setMyAvatar(result.avatar);
      updateProfile(); updateUsers();
      showToast('변경했어요.', 'success');
    }));
    $('#hub-rename').addEventListener('click', leaveLobby);
  }
  function chatLineHtml(message) {
    const time = new Date(message.at).toLocaleTimeString('ko-KR', { hour: '2-digit', minute: '2-digit', hour12: false });
    return `<div class="chat-line${message.name === state.nickname ? ' mine' : ''}"><span class="chat-name" style="color:${nameColor(message.name)}">${escapeHtml(message.name)}</span><span class="chat-text">${escapeHtml(message.text)}</span><time class="chat-time">${time}</time></div>`;
  }
  function renderChatLog() {
    const log = $('#hub-chat-log');
    if (!log) return;
    log.innerHTML = state.hub.chat.length ? state.hub.chat.map(chatLineHtml).join('') : '<div class="chat-empty">아직 채팅이 없어요. 첫 인사를 남겨 보세요</div>';
    log.scrollTo({ top: log.scrollHeight, behavior: 'instant' });
  }
  function appendChatLine(message) {
    const log = $('#hub-chat-log');
    if (!log) return;
    const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
    $('.chat-empty', log)?.remove();
    log.insertAdjacentHTML('beforeend', chatLineHtml(message));
    log.lastElementChild.classList.add('enter');
    while (log.children.length > 80) log.firstChild.remove();
    if (nearBottom || message.name === state.nickname) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
  }
  async function sendChat(event) {
    event.preventDefault();
    const input = $('#hub-chat-input');
    const text = input.value.trim();
    if (!text) return;
    input.value = '';
    const result = await request('lobby:chat', { text });
    if (!result.ok) {
      input.value = text;
      if (!result.throttled) showToast(result.message, 'error');
    }
  }
  const roomChat = { code: null, messages: [], node: null, log: null, input: null, refocus: null, scroll: null };
  function ensureRoomChat() {
    if (roomChat.node) return roomChat.node;
    const node = document.createElement('section');
    node.className = 'panel room-chat';
    node.innerHTML = `<div class="panel-header"><span class="panel-title">채팅</span><span class="panel-caption">게임 중에도 가능</span></div>
      <div class="room-chat-log" role="log" aria-live="polite"></div>
      <div class="reaction-bar room-reactions" aria-label="이모지 반응"><span class="reaction-label">반응</span><div class="reaction-buttons">${REACTIONS.map(emoji => `<button type="button" class="reaction-button" data-emoji="${emoji}" aria-label="${emoji} 반응 보내기">${emoji}</button>`).join('')}</div></div>
      <form class="room-chat-form" autocomplete="off">
        <input class="text-input" type="text" maxlength="${CHAT_MAX_LENGTH}" enterkeyhint="send" aria-label="채팅 입력" placeholder="메시지 입력">
        <button class="primary-button" type="submit">전송</button>
      </form>`;
    roomChat.node = node;
    roomChat.log = $('.room-chat-log', node);
    roomChat.input = $('input', node);
    $('form', node).addEventListener('submit', sendRoomChat);
    node.querySelectorAll('.reaction-button').forEach(button => button.addEventListener('click', () => sendReaction(button.dataset.emoji)));
    roomChat.input.addEventListener('keydown', event => { if (event.key === 'Escape') roomChat.input.blur(); });
    return node;
  }
  function captureRoomChat() {
    const { input, log } = roomChat;
    roomChat.refocus = input && document.activeElement === input ? { start: input.selectionStart, end: input.selectionEnd, typing: input.value.length > 0 } : null;
    roomChat.scroll = log && log.isConnected ? { top: log.scrollTop, bottom: log.scrollHeight - log.scrollTop - log.clientHeight < 40 } : null;
  }
  function roomChatLineHtml(message) { return chatLineHtml(message); }
  function renderRoomChatLog() {
    const { log } = roomChat;
    if (!log) return;
    log.innerHTML = roomChat.messages.length ? roomChat.messages.map(roomChatLineHtml).join('') : '<div class="chat-empty">아직 채팅이 없어요<br>인사를 남겨 보세요</div>';
    log.scrollTop = log.scrollHeight;
  }
  function mountRoomChat() {
    const slot = $('#room-chat-slot');
    const mounted = !slot && Boolean(roomChat.node) && app.contains(roomChat.node);
    if (!slot && !mounted) return;
    const node = ensureRoomChat();
    const code = state.session && state.session.code;
    const switched = Boolean(code) && roomChat.code !== code;
    if (code && roomChat.code !== code) {
      roomChat.code = code;
      roomChat.messages = [];
      roomChat.input.value = '';
      roomChat.scroll = null;
      renderRoomChatLog();
      request('room:chatlog', { code, playerId: state.session.playerId }).then(result => {
        if (!result.ok || roomChat.code !== code) return;
        const seen = new Set(result.chat.map(message => message.id));
        roomChat.messages = result.chat.concat(roomChat.messages.filter(message => !seen.has(message.id)));
        renderRoomChatLog();
      });
    }
    if (mounted) {
      node.classList.toggle('in-game', Boolean(state.room && state.room.state !== 'lobby'));
      roomChat.refocus = null;
      if (switched) roomChat.log.scrollTop = roomChat.log.scrollHeight;
      return;
    }
    slot.replaceWith(node);
    node.classList.toggle('in-game', state.room && state.room.state !== 'lobby');
    const saved = roomChat.scroll;
    if (saved && !saved.bottom) roomChat.log.scrollTop = saved.top; else roomChat.log.scrollTop = roomChat.log.scrollHeight;
    const refocus = roomChat.refocus;
    roomChat.refocus = null;
    if (refocus) { roomChat.input.focus({ preventScroll: true }); try { roomChat.input.setSelectionRange(refocus.start, refocus.end); } catch { /* 무시 */ } }
  }
  function appendRoomChat(message) {
    if (!state.session || message.code !== state.session.code || roomChat.code !== message.code) return;
    if (roomChat.messages.some(item => item.id === message.id)) return;
    roomChat.messages.push(message);
    if (roomChat.messages.length > 80) roomChat.messages.shift();
    const { log } = roomChat;
    if (log) {
      const nearBottom = log.scrollHeight - log.scrollTop - log.clientHeight < 60;
      $('.chat-empty', log)?.remove();
      log.insertAdjacentHTML('beforeend', roomChatLineHtml(message));
      log.lastElementChild.classList.add('enter');
      while (log.children.length > 80) log.firstChild.remove();
      if (nearBottom || message.name === state.nickname) log.scrollTo({ top: log.scrollHeight, behavior: 'smooth' });
    }
    if (message.name !== state.nickname) sound.play('chat');
  }
  async function sendRoomChat(event) {
    event.preventDefault();
    const input = roomChat.input;
    const text = input.value.trim();
    if (!text || !state.session) return;
    input.value = '';
    const result = await request('room:chat', { code: state.session.code, playerId: state.session.playerId, text });
    if (!result.ok) {
      if (!input.value) input.value = text;
      if (!result.throttled) showToast(result.message, 'error');
    }
  }

  async function refreshHub() {
    const result = await request('lobby:refresh');
    if (!result.ok) return showToast(result.message, 'error');
    state.hub.rooms = result.rooms;
    noteAvatars(result.users.list);
    state.hub.users = result.users.list;
    state.hub.total = result.users.total;
    updateRooms(); updateUsers(); updateProfile();
  }

  function enterRoom(result) {
    saveSession({ code: result.room.code, playerId: result.playerId, name: state.nickname });
    noteAvatars(result.room.players);
    state.room = result.room;
    history.replaceState({}, '', location.pathname);
    render();
    showToast(`${result.room.number}번 방을 만들었어요`, 'success');
  }
  async function joinByCode(code, password = '') {
    const result = await request('room:join', { code, name: state.nickname, playerId: playerId(), password, avatar: state.avatar });
    if (result.ok) return enterRoom(result);
    if (result.code === 'PASSWORD_REQUIRED' || result.code === 'PASSWORD_WRONG') {
      const typed = await askPassword(result.code === 'PASSWORD_WRONG' ? result.message : '');
      if (typed) return joinByCode(code, typed);
      return;
    }
    showToast(result.message, 'error');
  }
  async function quickJoin() {
    const result = await request('room:quick', { name: state.nickname, playerId: playerId(), avatar: state.avatar });
    if (result.ok) enterRoom(result); else showToast(result.message, 'error');
  }
  function openCodeDialog() {
    const node = openDialog(`
      <h2 class="dialog-title">코드로 입장</h2>
      <p class="dialog-note">친구에게 받은 방 코드 5자리를 입력하세요</p>
      <form id="code-form" autocomplete="off">
        <input id="code-input" class="text-input code-input" type="text" maxlength="5" placeholder="방 코드 5자리">
        <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>취소</button><button type="submit" class="primary-button">입장</button></div>
      </form>`);
    const input = $('#code-input', node);
    input.focus();
    input.addEventListener('input', () => { input.value = input.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 5); });
    $('#code-form', node).addEventListener('submit', event => {
      event.preventDefault();
      if (!/^[A-Z0-9]{5}$/.test(input.value)) return showToast('방 코드는 5자리예요', 'error');
      const code = input.value;
      closeDialog();
      joinByCode(code);
    });
  }
  function openCreateDialog() {
    const options = (values, selected, unit) => values.map(value => `<option value="${value}" ${value === selected ? 'selected' : ''}>${value}${unit}</option>`).join('');
    const node = openDialog(`
      <h2 class="dialog-title">방 만들기</h2>
      <p class="dialog-note">원하는 규칙을 정하고 친구를 초대해 보세요</p>
      <form id="create-form" autocomplete="off">
        <label class="field-label" for="create-title">방 제목</label>
        <input id="create-title" class="text-input" type="text" maxlength="24" value="${escapeHtml(state.nickname)}님의 방">
        <label class="field-label" for="create-password">비밀번호 <small class="field-hint">(선택 · 영문·숫자 1~8자)</small></label>
        <input id="create-password" class="text-input" type="text" maxlength="8" autocomplete="off" placeholder="비워 두면 공개 방">
        <div class="dialog-grid">
          <div><label class="field-label" for="create-max">최대 인원</label><select id="create-max" class="select-input">${options([2, 3, 4, 5, 6, 7, 8], 8, '명')}</select></div>
          <div><label class="field-label" for="create-rounds">라운드 수<small class="field-hint">(${MIN_ROUNDS}~${MAX_ROUNDS})</small></label><input id="create-rounds" class="text-input" type="number" inputmode="numeric" min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" step="1" value="3"></div>
          <div><label class="field-label" for="create-total">라운드 시간</label><select id="create-total" class="select-input">${options(TOTAL_TIME_OPTIONS, 60, '초')}</select></div>
          <div><label class="field-label" for="create-turn">턴 시간</label><select id="create-turn" class="select-input">${options([10, 15, 20, 30], 15, '초')}</select></div>
          <div><label class="check-row" for="create-oneshot"><input id="create-oneshot" type="checkbox" checked><span>한방 단어 허용 <small class="field-hint">(이어 갈 단어가 없는 단어)</small></span></label></div>
        </div>
        <div class="dialog-actions"><button type="button" class="ghost-button" data-cancel>취소</button><button id="create-submit" type="submit" class="primary-button">방 만들기 <span aria-hidden="true">→</span></button></div>
      </form>`);
    $('#create-title', node).select();
    $('#create-form', node).addEventListener('submit', async event => {
      event.preventDefault();
      const submit = $('#create-submit', node);
      const rounds = parseRounds($('#create-rounds', node).value);
      if (rounds === null) { showToast(`라운드는 ${MIN_ROUNDS}~${MAX_ROUNDS} 사이로 입력해 주세요`, 'error'); $('#create-rounds', node).focus(); return; }
      submit.disabled = true;
      const result = await request('room:create', {
        name: state.nickname, playerId: playerId(), avatar: state.avatar,
        title: $('#create-title', node).value,
        password: $('#create-password', node).value,
        maxPlayers: Number($('#create-max', node).value),
        rounds,
        totalSeconds: Number($('#create-total', node).value),
        turnSeconds: Number($('#create-turn', node).value),
        allowOneShot: $('#create-oneshot', node).checked
      });
      if (!result.ok) { showToast(result.message, 'error'); submit.disabled = false; return; }
      closeDialog();
      enterRoom(result);
    });
  }

  function renderLobbyImpl(room) {
    const sameScreen = enterScreen('lobby');
    const roundsHadFocus = document.activeElement?.id === 'setting-rounds';
    captureRoomChat();
    document.body.classList.remove('modal-open');
    const mine = room.players.find(player => player.id === state.session.playerId);
    const isHost = room.hostId === state.session.playerId;
    const allReady = room.players.length >= 2 && room.players.every(player => player.online && player.ready);
    const playerRows = room.players.map(player => `
      <div class="player-row" data-key="${escapeHtml(player.id)}">
        ${avatar(player.name)}
        <div class="player-info">
          <div class="player-name">${lvBadge(player.level)}${escapeHtml(player.name)} ${player.isHost ? '<span class="host-label">방장</span>' : ''}</div>
          <div class="player-meta">${player.online ? '접속 중' : '연결 끊김'}</div>
        </div>
        <span class="player-status ${player.ready ? 'ready' : player.online ? '' : 'offline'}">${player.ready ? '준비 완료' : player.online ? '준비 중' : '오프라인'}</span>
        ${isHost && player.id !== state.session.playerId ? `<button type="button" class="kick-button" data-kick="${escapeHtml(player.id)}" data-name="${escapeHtml(player.name)}" title="${escapeHtml(player.name)}님 추방" aria-label="${escapeHtml(player.name)}님 추방">추방</button>` : ''}
      </div>`).join('');
    const emptySlots = Math.max(0, Math.min(room.settings.maxPlayers - room.players.length, 3));
    const settingsContent = isHost ? `
      <div class="setting-block">
        <label class="field-label" for="setting-title">방 제목</label>
        <input id="setting-title" class="text-input" type="text" maxlength="24" value="${escapeHtml(room.title)}">
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-password">비밀번호 <small class="field-hint">${room.locked ? '(비우면 유지)' : '(선택)'}</small></label>
        <input id="setting-password" class="text-input" type="text" maxlength="8" autocomplete="off" placeholder="${room.locked ? '새 비밀번호' : '영문·숫자 1~8자'}">
        ${room.locked ? '<label class="check-line"><input id="setting-clear-pw" type="checkbox"> 비밀번호 해제</label>' : ''}
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-time">턴 시간 <small class="field-hint">(라운드마다 줄어들어요)</small></label>
        <select id="setting-time" class="select-input"><option value="10" ${room.settings.turnSeconds === 10 ? 'selected' : ''}>10초</option><option value="15" ${room.settings.turnSeconds === 15 ? 'selected' : ''}>15초</option><option value="20" ${room.settings.turnSeconds === 20 ? 'selected' : ''}>20초</option><option value="30" ${room.settings.turnSeconds === 30 ? 'selected' : ''}>30초</option></select>
        <p class="setting-note turn-plan-line">턴 계획: 라운드별 ${formatTurnPlan(room.turnPlan)}</p>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-total">라운드 시간</label>
        <select id="setting-total" class="select-input">${TOTAL_TIME_OPTIONS.map(sec => `<option value="${sec}" ${room.settings.totalSeconds === sec ? 'selected' : ''}>${sec}초</option>`).join('')}</select>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-rounds">라운드 수<small class="field-hint">(${MIN_ROUNDS}~${MAX_ROUNDS})</small></label>
        <input id="setting-rounds" class="text-input" type="number" inputmode="numeric" min="${MIN_ROUNDS}" max="${MAX_ROUNDS}" step="1" value="${room.settings.rounds}">
        <p class="setting-note">${MIN_ROUNDS}~${MAX_ROUNDS}라운드까지 설정할 수 있어요</p>
      </div>
      <div class="setting-block">
        <label class="check-row" for="setting-oneshot"><input id="setting-oneshot" type="checkbox" ${room.settings.allowOneShot !== false ? 'checked' : ''}><span>한방 단어 허용 <small class="field-hint">(이어 갈 단어가 없는 단어)</small></span></label>
      </div>
      <div class="setting-block">
        <label class="field-label" for="setting-players">최대 인원</label>
        <select id="setting-players" class="select-input">${[2,3,4,5,6,7,8].map(num => `<option value="${num}" ${room.settings.maxPlayers === num ? 'selected' : ''} ${num < room.players.length ? 'disabled' : ''}>${num}紐?/option>`).join('')}</select>
        <p class="setting-note">인원은 2~8명까지 가능해요</p>
      </div>
      <button id="apply-settings" class="ghost-button button-full">설정 적용</button>` : `
      <div class="setting-block"><label class="field-label">방 제목</label><div class="read-only-setting">${escapeHtml(room.title)}${room.locked ? ' 🔒' : ''}</div></div>
      <div class="setting-block"><label class="field-label">턴 시간</label><div class="read-only-setting">${room.settings.turnSeconds}초</div></div>
      <div class="setting-block"><label class="field-label">라운드 시간</label><div class="read-only-setting">${room.settings.totalSeconds}초</div></div>
      <div class="setting-block"><label class="field-label">라운드 수</label><div class="read-only-setting">${room.settings.rounds}라운드</div></div>
      <div class="setting-block"><label class="field-label">라운드별 턴 시간</label><div class="read-only-setting turn-plan-line">${formatTurnPlan(room.turnPlan)}</div></div>
      <div class="setting-block"><label class="field-label">한방 단어</label><div class="read-only-setting">${room.settings.allowOneShot === false ? '금지' : '허용'}</div></div>
      <div class="setting-block"><label class="field-label">최대 인원</label><div class="read-only-setting">${room.settings.maxPlayers}명</div></div>
      <p class="setting-note">설정은 방장만 바꿀 수 있어요</p>`;

    paintScreen(sameScreen, 'lobby-screen', `
      <section class="fade-in lobby-screen">
        <div class="page-heading-row">
          <div><span class="eyebrow">WAITING ROOM</span><h1 class="page-title">${escapeHtml(room.title)}</h1><p class="page-description">${room.number}번 방${room.locked ? ' · 비밀번호 방' : ''} · 모두 준비하면 게임을 시작할 수 있어요</p></div>
          <div class="room-code-pill"><small>방 코드</small><strong>${escapeHtml(room.code)}</strong></div>
        </div>
        <div class="lobby-grid">
          <section class="panel">
            <div class="panel-header"><span class="panel-title">참가자</span><span class="panel-caption">${room.players.length} / ${room.settings.maxPlayers}명</span></div>
            <div class="player-list">${playerRows}${Array.from({ length: emptySlots }, () => `<div class="empty-slot"><span class="avatar">+</span><span>빈 자리</span></div>`).join('')}</div>
          </section>
          <section class="panel settings-panel">
            <div class="panel-header"><span class="panel-title">게임 설정</span><span class="panel-caption">${isHost ? '방장 설정' : '방장만 변경 가능'}</span></div>
            <div class="settings-content">${settingsContent}</div>
          </section>
          <div id="room-chat-slot"></div>
        </div>
        <div class="invite-strip"><p><b>초대</b> 방 코드 ${escapeHtml(room.code)} 를 친구에게 알려 주세요</p><button id="copy-invite" class="secondary-button">초대 링크 복사</button></div>
        <div class="lobby-actions">
          <button id="leave-room" class="ghost-button danger-button">방 나가기</button>
          <button id="ready-toggle" class="secondary-button">${mine?.ready ? '준비 취소' : '준비'}</button>
          ${isHost ? `<button id="start-game" class="primary-button" ${allReady ? '' : 'disabled'}>게임 시작</button>` : '<button class="primary-button" disabled>방장이 시작하길 기다리는 중</button>'}
        </div>
      </section>`);

    $('#ready-toggle').addEventListener('click', toggleReady);
    $('#leave-room').addEventListener('click', leaveRoom);
    $('#copy-invite').addEventListener('click', copyInvite);
    if ($('#apply-settings')) $('#apply-settings').addEventListener('click', applySettings);
    app.querySelectorAll('[data-kick]').forEach(button => button.addEventListener('click', onKickClick));
    if ($('#start-game')) $('#start-game').addEventListener('click', startGame);
    const roundsInput = $('#setting-rounds');
    if (roundsInput) {
      if (state.roundsDraft && state.roundsDraft.code === room.code && roundsInput.value !== state.roundsDraft.value) roundsInput.value = state.roundsDraft.value;
      roundsInput.addEventListener('input', onRoundsInput);
      if (roundsHadFocus && document.activeElement !== roundsInput) roundsInput.focus();
    }
    mountRoomChat();
    settleScreen(sameScreen);
  }
  async function toggleReady() {
    const room = state.room;
    if (!room || !state.session) return;
    const me = room.players.find(player => player.id === state.session.playerId);
    const result = await request('room:ready', { code: room.code, playerId: state.session.playerId, ready: !me?.ready });
    if (!result.ok) showToast(result.message, 'error');
  }
  function onKickClick(event) { const { kick, name } = event.currentTarget.dataset; kickPlayer(kick, name); }
  function onRoundsInput(event) { if (state.room) state.roundsDraft = { code: state.room.code, value: event.currentTarget.value }; }
  async function applySettings() {
    const rounds = parseRounds($('#setting-rounds').value);
    if (rounds === null) { showToast(`라운드는 ${MIN_ROUNDS}~${MAX_ROUNDS} 사이로 입력해 주세요`, 'error'); $('#setting-rounds').focus(); return; }
    const result = await request('room:settings', {
      code: state.room.code, playerId: state.session.playerId,
      turnSeconds: Number($('#setting-time').value), maxPlayers: Number($('#setting-players').value),
      totalSeconds: Number($('#setting-total').value), rounds,
      allowOneShot: $('#setting-oneshot').checked,
      title: $('#setting-title').value, password: $('#setting-password').value, clearPassword: Boolean($('#setting-clear-pw')?.checked)
    });
    if (result.ok) state.roundsDraft = null;
    showToast(result.ok ? '설정을 바꿨어요' : result.message, result.ok ? 'success' : 'error');
  }
  async function kickPlayer(targetId, targetName) {
    if (!state.room || !window.confirm(`${targetName}님을 추방할까요?\n추방되면 이 방에 다시 들어올 수 없어요`)) return;
    const result = await request('room:kick', { code: state.room.code, playerId: state.session.playerId, targetId });
    showToast(result.ok ? `${targetName}님을 추방했어요` : result.message, result.ok ? 'success' : 'error');
  }
  async function startGame() {
    const result = await request('room:start', { code: state.room.code, playerId: state.session.playerId });
    if (!result.ok) showToast(result.message, 'error');
  }
  async function copyInvite() {
    const url = `${location.origin}${location.pathname}?room=${state.room.code}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('초대 링크를 복사했어요', 'success');
    } catch {
      try { await navigator.clipboard.writeText(state.room.code); showToast(`방 코드 ${state.room.code} 를 복사했어요`, 'success'); }
      catch { showToast(`방 코드: ${state.room.code}`); }
    }
  }
  async function leaveRoom() {
    const session = state.session;
    if (session) await request('room:leave', { code: session.code, playerId: session.playerId });
    clearSession();
    history.replaceState({}, '', location.pathname);
    if (state.nickname) { if (!(await enterLobby(state.nickname))) renderHome(); } else renderHome();
  }

  function renderGameImpl(room) {
    const sameScreen = enterScreen('game');
    captureRoomChat();
    const prev = sameScreen && state.shown && state.shown.gameId === room.gameId ? state.shown : null;
    const keepScroll = {
      chainLeft: $('#chain-strip') ? $('#chain-strip').scrollLeft : 0,
      chainAtEnd: !$('#chain-strip') || (() => { const strip = $('#chain-strip'); return strip.scrollWidth - strip.scrollLeft - strip.clientWidth < 48; })(),
      scores: $('.score-list') ? $('.score-list').scrollLeft : 0
    };
    const mine = room.players.find(player => player.id === state.session.playerId);
    const isHost = room.hostId === state.session.playerId;
    const isPlaying = room.state === 'playing';
    const onBreak = room.state === 'intermission';
    const myTurn = isPlaying && room.currentPlayerId === state.session.playerId && !mine?.eliminated;
    const alive = room.players.filter(player => !player.eliminated).length;
    const wordCount = room.words.filter(item => item.type === 'word').length;
    const sortedPlayers = [...room.players].sort((a, b) => Number(a.eliminated) - Number(b.eliminated) || b.score - a.score);
    const scoreRows = sortedPlayers.map(player => {
      const current = player.id === room.currentPlayerId;
      const status = player.eliminated ? '탈락' : !player.online ? '접속 끊김' : '';
      const arrive = current && prev && prev.currentPlayerId !== room.currentPlayerId;
      const bump = prev && prev.scores[player.id] != null && player.score > prev.scores[player.id];
      return `<div class="score-row ${current ? 'current' : ''}${arrive ? ' arrive' : ''} ${player.eliminated ? 'eliminated' : ''}" data-key="${escapeHtml(player.id)}">
        ${avatar(player.name, true)}
        <div class="score-name"><span class="score-nick">${escapeHtml(player.name)}</span><span class="score-state">${lvBadge(player.level)}${status}${room.totalRounds > 1 && player.roundWins ? `${status ? ' · ' : ''}${player.roundWins}승` : ''}</span></div>
        <span class="score-points${bump ? ' bump' : ''}">${player.score}</span>
      </div>`;
    }).join('');
    const addedEntries = prev ? Math.max(0, room.words.length - prev.entryCount) : 0;
    const chainParts = [];
    let prevWasWord = false;
    room.words.forEach((item, index) => {
      const enter = index >= room.words.length - addedEntries ? ' enter' : '';
      if (item.type === 'system') { chainParts.push(`<span class="chain-sep${enter}">${escapeHtml(item.text)}</span>`); prevWasWord = false; return; }
      if (prevWasWord) chainParts.push('<span class="chain-arrow" aria-hidden="true">→</span>');
      chainParts.push(`<span class="chain-chip${enter}" title="${escapeHtml(item.playerName)} +${item.points}점">${avatar(item.playerName, true)}<b class="chain-chip-word">${escapeHtml(item.word)}</b><em class="chain-chip-pts">${item.missions ? '🎯' : ''}+${item.points}</em></span>`);
      prevWasWord = true;
    });
    const history = chainParts.join('');
    const finished = room.state === 'finished';
    const winnerContent = finished ? `<div class="finished-banner"><div class="trophy">🏆</div><h2>${room.winnerName ? `${escapeHtml(room.winnerName)} 우승!` : '무승부'}</h2></div>` : '';
    const breakContent = onBreak && room.roundResult ? (() => {
      const result = room.roundResult;
      const board = result.scores.map(row => `${escapeHtml(row.name)} ${row.roundScore}점`).join(' · ');
      return `<div class="finished-banner round-banner"><div class="trophy">${result.winnerId ? '🏆' : '🤝'}</div><h2>ROUND ${result.round} ${result.winnerId ? `· ${escapeHtml(result.winnerName)} 승리!` : '· 무승부'}</h2><p>${board}</p><p class="break-count-line"><span id="break-count">6</span>초 후 ROUND ${room.round + 1}/${room.totalRounds} 시작</p><p class="break-turn-line">턴 시간 ${room.turnPlan[room.round - 1] ?? room.turnSeconds}초 → <b>${room.turnPlan[room.round] ?? room.turnSeconds}초</b></p></div>`;
    })() : '';
    const turnName = onBreak ? '다음 라운드 준비 중' : isPlaying ? (myTurn ? '내 차례!' : `${escapeHtml(room.currentPlayerName)}님의 차례`) : '게임 종료';
    const allowed = (room.allowedSyllables && room.allowedSyllables.length) ? room.allowedSyllables : (room.lastSyllable ? [room.lastSyllable] : []);
    const allowedLabel = allowed.map(item => `‘${escapeHtml(item)}’`).join(' 또는 ');
    const allowedChip = allowed.map(item => escapeHtml(item)).join(' / ');
    const allowedPlaceholder = allowed.join(' 쨌 ');
    const turnHint = onBreak ? '' : myTurn ? (room.lastSyllable ? `${allowedLabel}(으)로 시작` : '아무 단어나 시작해요') : '';
    const chain = room.words.filter(item => item.type === 'word').slice(-1)[0];
    const newWord = Boolean(prev) && wordCount > prev.wordCount;
    const turnChanged = Boolean(prev) && prev.currentPlayerId !== room.currentPlayerId;
    const allowedKey = allowed.join('|');
    const letterChanged = Boolean(prev) && prev.allowedKey !== allowedKey;
    const showSummary = finished && Boolean(room.summary) && state.summaryClosedGame !== room.gameId;
    const firstShow = showSummary && state.summaryShownGame !== room.gameId;
    if (showSummary) state.summaryShownGame = room.gameId;
    const summaryHtml = showSummary ? summaryMarkup(room, isHost, firstShow) : '';
    const turnKey = `${room.gameId}:${room.round}:${room.currentPlayerId}:${room.turnEndsAt}`;
    const entryMode = finished ? 'done' : onBreak ? 'break' : myTurn ? 'mine' : mine?.eliminated ? 'out' : 'wait';
    const startChips = allowed.length
      ? allowed.map(item => `<button type="button" class="entry-chip" data-letter="${escapeHtml(item)}" ${myTurn ? '' : 'disabled'} aria-label="${escapeHtml(item)} 입력">${escapeHtml(item)}</button>`).join('<span class="entry-or">또는</span>')
      : '<span class="entry-chip free">자유 시작</span>';
    const entryTitle = {
      mine: allowed.length ? '단어를 입력해 이어 가요' : '아무 단어나 시작해요',
      wait: `${escapeHtml(room.currentPlayerName || '상대')}님이 입력하는 중`,
      out: '탈락했어요. 채팅으로 응원해 보세요',
      break: '잠시 쉬는 중이에요',
      done: '게임이 끝났어요'
    }[entryMode];
    const entryPlaceholder = entryMode === 'mine' ? (allowed.length ? `${allowed[0]}(으)로 시작 (2~12자)` : '단어 입력 (2~12자)') : entryMode === 'wait' ? '상대 차례예요' : '입력할 수 없어요';
    const entryMarkup = `<section class="entry-card is-${entryMode}" id="entry-card" aria-label="단어 입력">
          <div class="entry-top">
            <div class="entry-start" aria-hidden="${entryMode === 'mine' ? 'false' : 'true'}">${entryMode === 'mine' || entryMode === 'wait' ? startChips : ''}</div>
            <div class="entry-title">${entryTitle}</div>
          </div>
          <form id="word-form" class="entry-form" autocomplete="off" novalidate>
            <div class="entry-field">
              <input id="word-input" class="text-input" type="text" inputmode="text" lang="ko" maxlength="12" autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="send" aria-label="단어 입력" aria-describedby="entry-hint" placeholder="${escapeHtml(entryPlaceholder)}" ${myTurn ? '' : 'disabled'}>
              <span id="entry-count" class="entry-count" aria-hidden="true">0/12</span>
            </div>
            <button class="primary-button entry-send" type="submit" ${myTurn ? '' : 'disabled'}><span>입력</span><kbd aria-hidden="true">↵</kbd></button>
          </form>
          <div id="entry-hint" class="entry-hint" role="status" aria-live="polite">${myTurn ? `<span class="hint-neutral">${room.mission ? `미션 글자 ‘${escapeHtml(room.mission)}’를 넣으면 보너스!` : '한글 2~12자 · Enter로 제출'}</span>` : ''}</div>
        </section>`;
    paintScreen(sameScreen, 'game-screen', `
      <section class="fade-in game-screen">
        <div class="game-topline">
          <div class="game-top-actions">
            <button id="leave-room" class="ghost-button danger-button">방 나가기</button>
            <button id="copy-invite" class="ghost-button">초대 링크 복사</button>
            ${finished && room.summary ? '<button id="open-summary" class="secondary-button">결과 보기</button>' : ''}
            ${finished && isHost ? '<button id="rematch" class="primary-button">다시 하기</button>' : finished ? '<button class="secondary-button" disabled>방장을 기다리는 중</button>' : ''}
          </div>
          <div class="game-top-info"><span class="game-round">${room.round}/${room.totalRounds} 라운드${isPlaying ? ` · <span id="round-clock" data-morph-keep="class">--</span><span class="round-total" title="라운드 총 시간"> / ${formatClock(room.settings.totalSeconds * 1000)}</span>` : ''}</span>${isPlaying ? `<span class="game-turnplan" title="라운드마다 줄어드는 턴 시간">턴 ${room.turnSeconds}초${room.round < room.totalRounds ? ` <i>→</i> 다음 ${room.turnPlan[room.round] ?? room.turnSeconds}초` : ' · 마지막 라운드'}</span>` : ''}<span class="game-code">방 ${escapeHtml(room.code)} <span class="footer-dot">·</span> 생존 ${alive}명</span></div>
        </div>
        <div class="game-body">
        <div class="game-left">
        ${winnerContent}${breakContent}
        <section class="turn-card stage">
          <div class="stage-side stage-next">
            <span class="stage-side-label">다음 글자</span>
            <strong class="stage-letter${letterChanged ? ' swap' : ''}">${allowedChip || '?'}</strong>
          </div>
          <div class="stage-side stage-mission${state.missionFlashSeq && room.missionChange && room.missionChange.seq === state.missionFlashSeq ? ' mission-new' : ''}">
            <span class="stage-side-label">미션</span>
            <strong class="stage-letter">${room.mission ? escapeHtml(room.mission) : '?'}</strong>
          </div>
          <div class="stage-center">
            <div class="turn-label">${finished ? '최종 단어' : onBreak ? '휴식' : '현재 단어'}</div>
            <div class="turn-name${turnChanged ? ' swap' : ''}">${turnName}</div>
            ${finished || !turnHint ? '' : `<div class="turn-hint">${turnHint}</div>`}
            <div class="chain-current">${chain ? `<span class="chain-word${newWord ? ' pop' : ''}" data-key="w-${escapeHtml(chain.word)}">${escapeHtml(chain.word)}</span>` : '<span class="chain-word empty">첫 단어를 시작해요</span>'}</div>
            <div class="timer-track"><div id="timer-fill" class="timer-fill" data-morph-keep="style class"></div></div>
          </div>
          <div class="stage-side stage-chain">
            <span class="stage-side-label">泥댁씤</span>
            <strong class="stage-letter">${wordCount}</strong>
            <div class="turn-clock"><span class="clock-icon">⏱</span><span id="clock-number" class="clock-number">${isPlaying ? room.turnSeconds : '—'}</span></div>
          </div>
        </section>
        <section class="chain-strip-panel" aria-label="단어 기록">
          <div class="chain-strip-head"><span class="chain-strip-title">단어 기록</span><span class="chain-strip-count">${wordCount}개</span></div>
          <div id="chain-strip" class="chain-strip" tabindex="0" role="list">${history || '<span class="chain-empty">아직 단어가 없어요. 첫 단어를 입력해 보세요</span>'}</div>
        </section>
        ${entryMarkup}
        <div class="players-row">
          <section class="panel score-panel"><div class="panel-header"><span class="panel-title">플레이어 점수</span><span class="panel-caption">실시간</span></div><div class="score-list">${scoreRows}</div></section>
        </div>
        </div>
        <div id="room-chat-slot"></div>
        </div>
      </section>${summaryHtml}`);
    document.body.classList.toggle('modal-open', showSummary);
    $('#word-form').addEventListener('submit', submitWord);
    $('#leave-room').addEventListener('click', leaveRoom);
    $('#copy-invite').addEventListener('click', copyInvite);
    if ($('#rematch')) $('#rematch').addEventListener('click', rematch);
    if ($('#open-summary')) $('#open-summary').addEventListener('click', reopenSummary);
    if (showSummary) {
      $('#summary-close').addEventListener('click', closeSummary);
      $('#summary-dismiss').addEventListener('click', closeSummary);
      $('#summary-backdrop').addEventListener('click', onSummaryBackdrop);
      if ($('#summary-rematch')) $('#summary-rematch').addEventListener('click', rematch);
      if (firstShow) $('.summary-card')?.focus({ preventScroll: true });
    }
    setupEntry(room, { myTurn, allowed, turnKey });
    updateClock();
    settleScreen(sameScreen);
    const chainNode = $('#chain-strip');
    if (chainNode) {
      chainNode.addEventListener('wheel', chainWheel, { passive: false });
      if (keepScroll.chainAtEnd || newWord || addedEntries) {
        chainNode.scrollTo({ left: Math.min(keepScroll.chainLeft, chainNode.scrollWidth), behavior: 'instant' });
        chainNode.scrollTo({ left: chainNode.scrollWidth, behavior: keepScroll.chainLeft ? 'smooth' : 'instant' });
      } else chainNode.scrollTo({ left: keepScroll.chainLeft, behavior: 'instant' });
    }
    mountRoomChat();
    const scoreNode = $('.score-list');
    if (scoreNode && keepScroll.scores) scoreNode.scrollLeft = keepScroll.scores;
    state.shown = {
      gameId: room.gameId, wordCount, entryCount: room.words.length, allowedKey,
      currentPlayerId: room.currentPlayerId,
      scores: Object.fromEntries(room.players.map(player => [player.id, player.score]))
    };
  }
  function reopenSummary() { state.summaryClosedGame = null; state.summaryShownGame = null; render(); }
  function onSummaryBackdrop(event) { if (event.target.id === 'summary-backdrop') closeSummary(); }
  function chainWheel(event) {
    const node = event.currentTarget;
    if (Math.abs(event.deltaY) > Math.abs(event.deltaX) && node.scrollWidth > node.clientWidth) { node.scrollLeft += event.deltaY; event.preventDefault(); }
  }
  function checkDraft(word, room) {
    const text = word.normalize('NFC').replace(/\s+/gu, '');
    if (!text) return { level: 'neutral', text: '' };
    if (/[^가-힣]/u.test(text)) return { level: 'warn', code: 'FORMAT', text: '한글만 입력할 수 있어요 (자음·모음만 있는 글자는 안 돼요)' };
    const allowed = (room.allowedSyllables && room.allowedSyllables.length) ? room.allowedSyllables : (room.lastSyllable ? [room.lastSyllable] : []);
    if (allowed.length && !allowed.includes(text[0])) {
      return { level: 'warn', code: 'START', text: `첫 글자는 ${allowed.map(item => `‘${item}’`).join(' 또는 ')} 이어야 해요` };
    }
    if (text.length < 2) return { level: 'neutral', text: '2글자 이상 입력해 주세요' };
    if (room.words.some(item => item.type === 'word' && item.word === text)) return { level: 'warn', code: 'DUPLICATE', text: '이미 사용한 단어예요' };
    const hits = room.mission ? [...text].filter(ch => ch === room.mission).length : 0;
    return { level: 'ok', text: hits ? `미션 글자 ${hits}개 포함! Enter로 제출` : 'Enter로 제출' };
  }
  function setEntryHint(level, text) {
    const hint = $('#entry-hint');
    const card = $('#entry-card');
    if (hint) hint.innerHTML = text ? `<span class="hint-${level}">${level === 'ok' ? '✓ ' : level === 'warn' || level === 'error' ? '⚠ ' : ''}${escapeHtml(text)}</span>` : '';
    if (card) { card.classList.toggle('has-warn', level === 'warn' || level === 'error'); card.classList.toggle('has-ok', level === 'ok'); }
  }
  const entryCtx = { room: null, myTurn: false, allowed: [], turnKey: '', composing: false };
  const entryBound = new WeakSet();
  const entryTurn = new WeakMap();
  function refreshEntry() {
    const input = $('#word-input');
    if (!input) return;
    const { room, myTurn } = entryCtx;
    const count = $('#entry-count');
    if (count) count.textContent = `${[...input.value].length}/12`;
    $('#word-form')?.classList.toggle('has-text', Boolean(input.value));
    if (!myTurn) return;
    if (entryCtx.composing) { setEntryHint('neutral', ''); return; }
    const result = checkDraft(input.value, state.room || room);
    if (result.text) setEntryHint(result.level, result.text);
    else setEntryHint('neutral', '');
    if (!result.text && !input.value) {
      const hint = $('#entry-hint');
      if (hint) hint.innerHTML = `<span class="hint-neutral">${room.mission ? `미션 글자 ‘${escapeHtml(room.mission)}’를 넣으면 보너스!` : '한글 2~12자 · Enter로 제출'}</span>`;
    }
  }
  function setupEntry(room, { myTurn, allowed, turnKey }) {
    const input = $('#word-input');
    const form = $('#word-form');
    if (!input || !form) return;
    form.addEventListener('submit', submitWord);
    Object.assign(entryCtx, { room, myTurn, allowed, turnKey });
    if (!entryBound.has(input)) {
      entryBound.add(input);
      entryCtx.composing = false;
      input.addEventListener('compositionstart', () => { entryCtx.composing = true; });
      input.addEventListener('compositionend', () => { entryCtx.composing = false; state.draft = { key: entryCtx.turnKey, value: input.value }; refreshEntry(); });
      input.addEventListener('input', () => {
        state.draft = { key: entryCtx.turnKey, value: input.value };
        input.classList.remove('shake');
        refreshEntry();
      });
    }
    const card = $('#entry-card');
    if (card && !entryBound.has(card)) {
      entryBound.add(card);
      card.addEventListener('click', event => {
        const chip = event.target.closest?.('.entry-chip[data-letter]');
        const field = $('#word-input');
        if (!chip || !field || !entryCtx.myTurn) return;
        const letter = chip.dataset.letter;
        if (!field.value || !entryCtx.allowed.includes(field.value[0])) field.value = letter + (field.value ? field.value.slice(1) : '');
        state.draft = { key: entryCtx.turnKey, value: field.value };
        field.focus({ preventScroll: true });
        field.setSelectionRange(field.value.length, field.value.length);
        refreshEntry();
      });
    }
    if (entryTurn.get(input) !== turnKey) { entryTurn.set(input, turnKey); if (input.value) input.value = ''; }
    if (myTurn && state.draft.key === turnKey && state.draft.value) { if (input.value !== state.draft.value) input.value = state.draft.value; }
    else if (state.draft.key !== turnKey) state.draft = { key: turnKey, value: '' };
    if (myTurn) {
      refreshEntry();
      const keepFocus = !state.hadFocusBeforeRender && document.activeElement && document.activeElement !== document.body && document.activeElement.closest?.('.reaction-bar');
      const chatBusy = Boolean(roomChat.refocus && roomChat.refocus.typing);
      if (!keepFocus && !chatBusy) {
        roomChat.refocus = null;
        if (document.activeElement !== input) input.focus({ preventScroll: true });
        input.setSelectionRange(input.value.length, input.value.length);
      }
    } else {
      setEntryHint('neutral', '');
      refreshEntry();
    }
  }
  function flashEntryError(message) {
    const input = $('#word-input');
    setEntryHint('error', message);
    if (input) {
      input.classList.remove('shake');
      void input.offsetWidth;
      input.classList.add('shake');
      input.focus();
      input.select();
    }
  }
  async function submitWord(event) {
    event.preventDefault();
    const input = $('#word-input');
    const word = input?.value.trim();
    if (!word) return flashEntryError('단어를 입력해 주세요');
    const local = checkDraft(word, state.room);
    if (local.level === 'warn') { sound.play('error'); window.Bokgu?.rejected({ code: local.code }); return flashEntryError(local.text); }
    const button = $('#word-form button[type="submit"]');
    if (button) { if (button.disabled) return; button.disabled = true; button.classList.add('busy'); }
    const result = await request('game:submit', { code: state.room.code, playerId: state.session.playerId, word });
    if (!result.ok) {
      sound.play('error');
      window.Bokgu?.rejected({ code: result.code });
      flashEntryError(result.message || '입력하지 못했어요.');
      const live = $('#word-form button[type="submit"]');
      if (live) { live.disabled = false; live.classList.remove('busy'); }
    } else {
      state.draft = { key: '', value: '' };
      if (input) input.value = '';
      sound.play('submit');
      window.Bokgu?.accepted({ word, points: result.points, chain: result.chain, missions: result.missions });
      if (result.missions) sound.play('bonus', 160);
      showToast(`+${result.points}점${result.chain > 1 ? ` · 체인 ${result.chain}` : ''}${result.newMission ? ` · 새 미션 ‘${result.newMission}’` : ''}`, 'success');
    }
  }
  async function rematch() {
    const result = await request('game:rematch', { code: state.room.code, playerId: state.session.playerId });
    if (!result.ok) showToast(result.message, 'error');
    else showToast('제출했어요', 'success');
  }
  function formatClock(ms) {
    const total = Math.max(0, Math.ceil(ms / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
  }
  function formatTurnPlan(plan) {
    if (!Array.isArray(plan) || !plan.length) return '';
    const last = plan[plan.length - 1];
    const firstLast = plan.indexOf(last);
    const shown = plan.slice(0, firstLast + 1);
    return `${shown.join('초 → ')}초${plan.length - 1 > firstLast ? ' (이후 유지)' : ''}`;
  }
  function parseRounds(value) {
    const number = Number(String(value).trim());
    return Number.isInteger(number) && number >= MIN_ROUNDS && number <= MAX_ROUNDS ? number : null;
  }
  const clockView = { fill: null, number: null, round: null, count: null, frac: 1, turnKey: '', from: 1, t0: 0, applied: '' };
  const REFILL_MS = 340;
  function cached(name, selector) {
    const node = clockView[name];
    if (node && node.isConnected) return node;
    clockView[name] = $(selector);
    if (name === 'fill') clockView.applied = '';
    return clockView[name];
  }
  function setText(node, text) { if (node.textContent !== text) node.textContent = text; }
  function updateClock() {
    const room = state.room;
    if (!room) return;
    if (room.state === 'intermission') {
      const count = cached('count', '#break-count');
      if (count) setText(count, String(Math.max(0, Math.ceil(((room.nextRoundAt || Date.now()) - Date.now()) / 1000))));
      return;
    }
    if (room.state !== 'playing') { clockView.frac = 1; clockView.turnKey = ''; return; }
    const now = Date.now();
    const roundClock = cached('round', '#round-clock');
    if (roundClock) {
      const left = Math.max(0, (room.roundEndsAt || now) - now);
      setText(roundClock, formatClock(left));
      const low = left <= 10000;
      if (roundClock.classList.contains('low') !== low) roundClock.classList.toggle('low', low);
    }
    const number = cached('number', '#clock-number');
    const fill = cached('fill', '#timer-fill');
    if (!number || !fill) return;
    const duration = room.turnDurationMs || room.turnSeconds * 1000;
    const remaining = Math.max(0, (room.turnEndsAt || now) - now);
    const seconds = Math.ceil(remaining / 1000);
    setText(number, String(seconds));
    const key = `${room.gameId}:${room.round}:${room.turnEndsAt}`;
    const perf = performance.now();
    if (clockView.turnKey !== key) { clockView.turnKey = key; clockView.from = clockView.frac; clockView.t0 = perf; }
    const target = Math.max(0, Math.min(1, remaining / duration));
    let frac = target;
    if (target > clockView.from) {
      const progress = Math.min(1, (perf - clockView.t0) / REFILL_MS);
      frac = clockView.from + (target - clockView.from) * (1 - Math.pow(1 - progress, 3));
    }
    clockView.frac = frac;
    const transform = `translate3d(${((frac - 1) * 100).toFixed(3)}%,0,0)`;
    if (clockView.applied !== transform) { fill.style.transform = transform; clockView.applied = transform; }
    const low = seconds <= 5;
    if (fill.classList.contains('low') !== low) fill.classList.toggle('low', low);
    if (state.session && room.currentPlayerId === state.session.playerId && seconds > 0 && seconds <= 5) window.Bokgu?.lowTime(key, seconds);
    urgencyAudio(room, remaining, duration, key);
  }
  const beatState = { key: '', last: Infinity, warned: false };
  function urgencyAudio(room, remainingMs, durationMs, key) {
    if (!state.session) return;
    const mine = room.currentPlayerId === state.session.playerId;
    if (beatState.key !== key) { beatState.key = key; beatState.last = Infinity; beatState.warned = false; }
    if (remainingMs <= 0) return;
    const limit = mine ? Math.min(10000, durationMs * .6) : Math.min(5000, durationMs * .4);
    if (remainingMs > limit) return;
    if (mine && !beatState.warned) {
      beatState.last = remainingMs;
      sound.play('warn');
      return;
    }
    const interval = remainingMs > 5000 ? 1000 : remainingMs > 3000 ? 650 : remainingMs > 1500 ? 420 : 260;
    if (beatState.last - remainingMs < interval) return;
    beatState.last = remainingMs;
    sound.beat(1 - remainingMs / limit, mine);
    if (mine && remainingMs <= 3000 && sound.enabled && navigator.vibrate) { try { navigator.vibrate(35); } catch { /* 진동을 쓸 수 없으면 무시 */ } }
  }
  function frameLoop() {
    updateClock();
    requestAnimationFrame(frameLoop);
  }

  function render() {
    window.Bokgu?.sync(state.room, state.session ? state.session.playerId : null);
    if (!state.room || !state.session) { if (state.nickname) mountHub(); else renderHome(); return; }
    if (state.room.state === 'lobby') renderLobby(state.room);
    else renderGame(state.room);
  }

  const soundButton = $('#sound-toggle');
  if (soundButton) soundButton.addEventListener('click', async () => { await sound.setEnabled(!sound.enabled); syncSoundButton(); });
  syncSoundButton();
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && document.body.classList.contains('dialog-open')) closeDialog();
    else if (event.key === 'Escape' && document.body.classList.contains('modal-open')) closeSummary();
  });

  const IDLE_LIMIT_MS = (6 * 60 + 30) * 1000;
  const IDLE_MESSAGE = '6분 30초 동안 활동이 없어 접속을 종료했어요. 다시 접속하려면 새로고침해 주세요.';
  const ACTIVITY_PING_MS = 20000;
  let lastActivityAt = Date.now();
  let lastActivityPing = 0;
  function markActivity() {
    if (state.idleClosed) return;
    const stamp = Date.now();
    lastActivityAt = stamp;
    if (stamp - lastActivityPing >= ACTIVITY_PING_MS) { lastActivityPing = stamp; }
  }
  function closeForIdle() {
    if (state.idleClosed) return;
    state.idleClosed = true;
    morphState.pending = null;
    closeDialog();
    document.body.classList.remove('modal-open');
    setConnection(false);
    for (const node of [app, $('.topbar'), $('.site-footer')]) if (node) node.inert = true;
    const overlay = document.createElement('div');
    overlay.className = 'idle-overlay';
    overlay.innerHTML = `
      <div class="dialog-card idle-card" role="alertdialog" aria-modal="true" aria-labelledby="idle-title" aria-describedby="idle-message" tabindex="-1">
        <div class="idle-icon" aria-hidden="true">💤</div>
        <h2 id="idle-title" class="dialog-title">접속 종료</h2>
        <p id="idle-message" class="dialog-note"></p>
        <div class="dialog-actions idle-actions"><button id="idle-reconnect" type="button" class="primary-button">다시 접속하기</button></div>
      </div>`;
    $('#idle-message', overlay).textContent = IDLE_MESSAGE;
    document.body.append(overlay);
    $('#idle-reconnect', overlay).addEventListener('click', () => location.reload());
    $('#idle-reconnect', overlay).focus({ preventScroll: true });
  }
  function checkIdle() {
    if (!state.idleClosed && Date.now() - lastActivityAt >= IDLE_LIMIT_MS) closeForIdle();
  }
  for (const type of ['pointerdown', 'pointermove', 'mousedown', 'keydown', 'wheel', 'touchstart', 'touchmove', 'scroll', 'click', 'input', 'focusin']) {
    window.addEventListener(type, markActivity, { capture: true, passive: true });
  }
  document.addEventListener('visibilitychange', checkIdle);
  setInterval(checkIdle, 1000);

  requestAnimationFrame(frameLoop);
  setConnection(false);
  loadAuth().then(() => { if (!state.nickname && !state.room) renderHome(); });
})();


