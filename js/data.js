const channels = new Map();
const globalEmotes = new Map();
const globalBadges = new Map();
const userEmotes = new Map();
let irc = null;
let eventsub = null;
let localId = 0;

function makeChannel(name, special = false) {
  return {
    name, special, id: null,
    emotes: new Map(), badges: new Map(), cheermotes: null, rewards: new Map(),
    history: [], chatters: new Map(), colors: new Map(),
    me: {}, room: {}, isMod: false, live: undefined, kick: null,
    splits: new Set(),
  };
}

const specials = {
  '/mentions': makeChannel('/mentions', true),
  '/whispers': makeChannel('/whispers', true),
};

/* ---------- emotes, badges, cheermotes ---------- */

function addSevenTV(map, list) {
  for (const e of list || []) {
    const host = e.data?.host;
    if (!host) continue;
    const base = 'https:' + host.url;
    map.set(e.name, { name: e.name, url: `${base}/1x.webp`, url2: `${base}/2x.webp`, url4: `${base}/4x.webp`, provider: '7TV', zeroWidth: (e.flags & 1) === 1 });
  }
}

function addBttv(map, list) {
  for (const e of list || []) {
    const base = `https://cdn.betterttv.net/emote/${e.id}`;
    map.set(e.code, { name: e.code, url: `${base}/1x`, url2: `${base}/2x`, url4: `${base}/3x`, provider: 'BTTV' });
  }
}

function addFfz(map, sets) {
  const fix = u => (u && u.startsWith('//') ? 'https:' + u : u);
  for (const set of Object.values(sets || {})) {
    for (const e of set.emoticons || []) {
      const u = e.urls;
      map.set(e.name, { name: e.name, url: fix(u['1']), url2: fix(u['2'] || u['1']), url4: fix(u['4'] || u['2'] || u['1']), provider: 'FFZ' });
    }
  }
}

function addBadges(map, list) {
  for (const set of list || []) {
    for (const v of set.versions || []) {
      map.set(`${set.set_id}/${v.id}`, { url: v.image_url_1x, url2: v.image_url_2x, url4: v.image_url_4x, title: v.title });
    }
  }
}

async function loadBadges(map, ch) {
  try {
    if (auth) {
      const r = await helix('GET', ch ? `/chat/badges?broadcaster_id=${ch.id}` : '/chat/badges/global');
      addBadges(map, r.data);
    } else {
      const url = ch ? `https://api.ivr.fi/v2/twitch/badges/channel?login=${ch.name}` : 'https://api.ivr.fi/v2/twitch/badges/global';
      addBadges(map, await getJSON(url));
    }
  } catch {}
}

async function loadGlobals() {
  const [ffz, bttv, stv] = await Promise.allSettled([
    getJSON('https://api.frankerfacez.com/v1/set/global'),
    getJSON('https://api.betterttv.net/3/cached/emotes/global'),
    getJSON('https://7tv.io/v3/emote-sets/global'),
  ]);
  if (ffz.status === 'fulfilled') {
    const sets = {};
    for (const id of ffz.value.default_sets || []) sets[id] = ffz.value.sets[id];
    addFfz(globalEmotes, sets);
  }
  if (bttv.status === 'fulfilled') addBttv(globalEmotes, bttv.value);
  if (stv.status === 'fulfilled') addSevenTV(globalEmotes, stv.value.emotes);
  await loadBadges(globalBadges, null);
}

async function loadChannelData(ch) {
  const [ffz, bttv, stv] = await Promise.allSettled([
    getJSON(`https://api.frankerfacez.com/v1/room/id/${ch.id}`),
    getJSON(`https://api.betterttv.net/3/cached/users/twitch/${ch.id}`),
    getJSON(`https://7tv.io/v3/users/twitch/${ch.id}`),
  ]);
  ch.emotes.clear();
  if (ffz.status === 'fulfilled') addFfz(ch.emotes, ffz.value.sets);
  if (bttv.status === 'fulfilled') {
    addBttv(ch.emotes, bttv.value.channelEmotes);
    addBttv(ch.emotes, bttv.value.sharedEmotes);
  }
  if (stv.status === 'fulfilled') addSevenTV(ch.emotes, stv.value.emote_set?.emotes);
  ch.badges.clear();
  await loadBadges(ch.badges, ch);
  await loadCheermotes(ch);
  ch.splits.forEach(s => s.rerender());
}

async function loadCheermotes(ch) {
  if (!auth || !ch.id) return;
  try {
    const r = await helix('GET', `/bits/cheermotes?broadcaster_id=${ch.id}`);
    ch.cheermotes = new Map();
    for (const c of r.data) {
      ch.cheermotes.set(c.prefix.toLowerCase(), c.tiers.slice().sort((a, b) => b.min_bits - a.min_bits));
    }
  } catch {}
}

async function loadUserEmotes() {
  if (!hasScope('user:read:emotes')) return;
  userEmotes.clear();
  let after = '';
  try {
    for (let page = 0; page < 30; page++) {
      const r = await helix('GET', `/chat/emotes/user?user_id=${auth.id}${after ? '&after=' + after : ''}`);
      for (const e of r.data) {
        const fmt = e.format.includes('animated') ? 'animated' : 'static';
        const base = `https://static-cdn.jtvnw.net/emoticons/v2/${e.id}/${fmt}/dark/`;
        userEmotes.set(e.name, { name: e.name, url: base + '1.0', url2: base + '2.0', url4: base + '3.0', provider: 'Twitch' });
      }
      after = r.pagination?.cursor;
      if (!after) break;
    }
  } catch {}
}

/* ---------- irc ---------- */

function unescapeTag(v) {
  return v.replace(/\\(.)/g, (_, c) => ({ s: ' ', ':': ';', '\\': '\\', r: '\r', n: '\n' }[c] ?? c));
}

function parse(line) {
  const m = { tags: {}, prefix: '', command: '', params: [] };
  let i = 0;
  if (line[0] === '@') {
    const sp = line.indexOf(' ');
    for (const kv of line.slice(1, sp).split(';')) {
      const eq = kv.indexOf('=');
      if (eq === -1) m.tags[kv] = '';
      else m.tags[kv.slice(0, eq)] = unescapeTag(kv.slice(eq + 1));
    }
    i = sp + 1;
  }
  if (line[i] === ':') {
    const sp = line.indexOf(' ', i);
    m.prefix = line.slice(i + 1, sp);
    i = sp + 1;
  }
  const trail = line.indexOf(' :', i);
  const head = trail === -1 ? line.slice(i) : line.slice(i, trail);
  const parts = head.split(' ').filter(Boolean);
  m.command = parts.shift() || '';
  m.params = parts;
  if (trail !== -1) m.params.push(line.slice(trail + 2));
  return m;
}

class Irc {
  constructor() {
    this.retry = 1000;
    this.dropped = false;
    this.connect();
  }

  connect() {
    const ws = this.ws = new WebSocket('wss://irc-ws.chat.twitch.tv:443');
    ws.onopen = () => {
      ws.send('CAP REQ :twitch.tv/tags twitch.tv/commands');
      if (auth) {
        ws.send('PASS oauth:' + auth.token);
        ws.send('NICK ' + auth.login);
      } else {
        ws.send('NICK justinfan' + (10000 + Math.floor(Math.random() * 80000)));
      }
    };
    ws.onmessage = e => {
      for (const line of e.data.split('\r\n')) if (line) onLine(parse(line));
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      if (!this.dropped) broadcast('Disconnected from chat. Reconnecting…');
      this.dropped = true;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30000);
    };
  }

  ready() {
    if (this.dropped) broadcast('Reconnected.');
    this.dropped = false;
    this.retry = 1000;
    for (const name of channels.keys()) this.send('JOIN #' + name);
  }

  reconnect() {
    const old = this.ws;
    this.ws = null;
    old?.close();
    this.connect();
  }

  send(line) {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(line);
    return true;
  }
}

function onLine(m) {
  switch (m.command) {
    case 'PING': irc.send('PONG :' + (m.params[0] || 'tmi.twitch.tv')); return;
    case 'RECONNECT': irc.ws?.close(); return;
    case '001': irc.ready(); return;
    case 'NOTICE':
      if (m.params[0] === '*') {
        if (/authentication failed|improperly formatted/i.test(m.params[1])) expireLogin('Twitch rejected the saved login. Log in again to chat.');
        return;
      }
  }

  const ch = channels.get((m.params[0] || '').replace(/^#/, ''));
  if (!ch) return;

  if (m.command === 'ROOMSTATE') {
    Object.assign(ch.room, m.tags);
    if (!ch.id && m.tags['room-id']) {
      ch.id = m.tags['room-id'];
      loadChannelData(ch);
      ensureEventSub();
    }
    ch.splits.forEach(s => s.updateHead());
    return;
  }
  if (m.command === 'USERSTATE') {
    ch.me = m.tags;
    const wasMod = ch.isMod;
    ch.isMod = /(^|,)(moderator|broadcaster)\//.test(m.tags.badges || '');
    if (wasMod !== ch.isMod) {
      ch.splits.forEach(s => s.rerender());
      ensureEventSub();
    }
    return;
  }

  const ev = ingest(ch, m);
  if (!ev) return;
  if (ev.kind === 'add') {
    const msg = ev.msg;
    if (isHidden(msg)) return;
    remember(ch, msg);
    if (msg.rewardId && ch.rewards.has(msg.rewardId)) msg.rewardTitle = ch.rewards.get(msg.rewardId);
    if (isMention(msg)) notifyMention(msg);
  }
  publish(ch, ev);
}

function publish(ch, ev) {
  const res = apply(ch.history, ev);
  ch.splits.forEach(s => s.onEvent(res));
}

function channelNotice(ch, text) {
  publish(ch, { kind: 'add', msg: noticeMsg(text) });
}

function notifyMention(msg) {
  publish(specials['/mentions'], { kind: 'add', msg });
  if (settings.mentionSound) ping();
  bumpTitle();
}

/* ---------- eventsub (whispers, automod, redemptions) ---------- */

function wantedSubs() {
  if (!auth) return [];
  const out = [];
  if (hasScope('user:read:whispers')) out.push(['user.whisper.message', '1', { user_id: auth.id }]);
  for (const ch of channels.values()) {
    if (!ch.id) continue;
    if (ch.isMod && hasScope('moderator:manage:automod')) {
      out.push(['automod.message.hold', '2', { broadcaster_user_id: ch.id, moderator_user_id: auth.id }]);
    }
    if (ch.id === auth.id && hasScope('channel:read:redemptions')) {
      out.push(['channel.channel_points_custom_reward_redemption.add', '1', { broadcaster_user_id: ch.id }]);
    }
  }
  return out;
}

function ensureEventSub() {
  if (!wantedSubs().length) return;
  if (!eventsub) eventsub = new EventSub();
  else eventsub.sync();
}

class EventSub {
  constructor() {
    this.subs = new Set();
    this.connect();
  }

  connect(url = 'wss://eventsub.wss.twitch.tv/ws', migrating = false) {
    const ws = new WebSocket(url);
    if (!migrating) this.ws = ws;
    ws.onmessage = e => {
      let data;
      try { data = JSON.parse(e.data); } catch { return; }
      const type = data.metadata?.message_type;
      const payload = data.payload;
      if (type === 'session_welcome') {
        this.session = payload.session.id;
        if (migrating) {
          const old = this.ws;
          this.ws = ws;
          old?.close();
        } else {
          this.subs.clear();
          this.sync();
        }
      } else if (type === 'session_reconnect') {
        this.connect(payload.session.reconnect_url, true);
      } else if (type === 'notification') {
        onEventSub(payload.subscription.type, payload.event);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.session = null;
      if (wantedSubs().length) setTimeout(() => { if (!this.ws) this.connect(); }, 5000);
      else eventsub = null;
    };
  }

  sync() {
    if (!this.session || this.ws?.readyState !== WebSocket.OPEN) return;
    for (const [type, version, condition] of wantedSubs()) {
      const key = type + JSON.stringify(condition);
      if (this.subs.has(key)) continue;
      this.subs.add(key);
      helix('POST', '/eventsub/subscriptions', {
        type, version, condition,
        transport: { method: 'websocket', session_id: this.session },
      }).catch(() => this.subs.delete(key));
    }
  }
}

function onEventSub(type, e) {
  if (type === 'user.whisper.message') {
    addWhisper({ login: e.from_user_login, name: e.from_user_name, userId: e.from_user_id, text: e.whisper?.text || '' });
    return;
  }

  const ch = channels.get(e.broadcaster_user_login);
  if (!ch) return;

  if (type === 'automod.message.hold') {
    const msg = {
      id: 'automod-' + e.message_id, kind: 'automod', amId: e.message_id, origin: ch,
      login: e.user_login, name: e.user_name, userId: e.user_id,
      text: e.message?.text ?? '', emotes: '', badges: '',
      reason: e.reason || e.category || 'held for review', time: Date.now(),
    };
    publish(ch, { kind: 'add', msg });
  }

  if (type === 'channel.channel_points_custom_reward_redemption.add') {
    const title = e.reward?.title || 'a reward';
    if (e.user_input) {
      // the chat message for this redemption arrives over IRC, so just label it
      ch.rewards.set(e.reward.id, title);
      const msg = ch.history.findLast(m => m.rewardId === e.reward.id && m.login === e.user_login && !m.rewardTitle);
      if (msg) {
        msg.rewardTitle = title;
        ch.splits.forEach(s => s.update(msg));
      }
      return;
    }
    const msg = {
      id: 'redeem-' + e.id, kind: 'redeem', origin: ch, login: e.user_login, name: e.user_name,
      text: '', emotes: '', badges: '', time: Date.now(),
      system: `${e.user_name} redeemed ${title} (${e.reward?.cost ?? '?'})`,
    };
    publish(ch, { kind: 'add', msg });
  }
}

function addWhisper(w) {
  const msg = {
    id: `whisper-${++localId}`, kind: 'whisper', login: w.login, name: w.name, userId: w.userId,
    to: w.to, outgoing: !!w.outgoing, local: !!w.outgoing,
    text: w.text, emotes: '', badges: '', time: Date.now(),
  };
  const wch = specials['/whispers'];
  remember(wch, msg);
  publish(wch, { kind: 'add', msg });
  if (msg.outgoing) return;
  if (!wch.splits.size) {
    const target = focusedSplit?.ch ? focusedSplit : activePage?.splits.find(s => s.ch);
    target?.notice(`Whisper from ${w.name}: ${w.text}  (open a /whispers split to reply)`);
  }
  if (settings.mentionSound) ping(990);
  bumpTitle();
}

/* ---------- channels and messages ---------- */

function getChannel(name) {
  if (specials[name]) return specials[name];
  let ch = channels.get(name);
  if (!ch) {
    ch = makeChannel(name);
    channels.set(name, ch);
    irc.send('JOIN #' + name);
    loadRecent(ch);
    schedulePoll();
    const kick = kickSpecFor(name);
    if (kick) kickAttach(ch, kick);
  }
  return ch;
}

function releaseChannel(ch, split) {
  ch.splits.delete(split);
  if (ch.special || ch.splits.size) return;
  irc.send('PART #' + ch.name);
  kickDetach(ch);
  channels.delete(ch.name);
}

async function loadRecent(ch) {
  let data;
  try {
    data = await getJSON(`https://recent-messages.robotty.de/api/v2/recent-messages/${ch.name}?limit=${Math.min(settings.limit, 800)}`);
  } catch { return; }
  if (channels.get(ch.name) !== ch) return;

  const old = [];
  for (const line of data.messages || []) {
    const ev = ingest(ch, parse(line));
    if (!ev) continue;
    if (ev.kind === 'add') {
      if (isHidden(ev.msg)) continue;
      remember(ch, ev.msg);
    }
    for (const msg of apply(old, ev).added) msg.historical = true;
  }
  const seen = new Set(ch.history.map(x => x.id));
  ch.history = [...old.filter(x => !seen.has(x.id)), ...ch.history];
  ch.splits.forEach(s => s.rerender());
}

function remember(ch, msg) {
  if (!msg.login) return;
  ch.chatters.set(msg.login, msg.name);
  if (msg.color) ch.colors.set(msg.login, msg.color);
}

function isHidden(msg) {
  if (msg.login && settings.ignored.includes(msg.login)) return true;
  return !!msg.text && settings.blockedPhrases.some(p => p && matches(p, msg.text));
}

function makeMsg(ch, t, login, text, extra = {}) {
  const sourceId = t['source-room-id'];
  const shared = !!sourceId && !!t['room-id'] && sourceId !== t['room-id'];
  return {
    id: t.id || `local-${++localId}`,
    kind: 'chat',
    origin: ch,
    login,
    userId: t['user-id'],
    name: t['display-name'] || login,
    color: t.color,
    badges: (shared ? t['source-badges'] : t.badges) || '',
    emotes: t.emotes || '',
    source: shared ? sourceChannel(sourceId) : null,
    text,
    time: Number(t['tmi-sent-ts']) || Date.now(),
    first: t['first-msg'] === '1',
    bits: Number(t.bits) || 0,
    rewardId: t['custom-reward-id'] || null,
    highlightedMsg: t['msg-id'] === 'highlighted-message',
    replyParentId: t['reply-parent-msg-id'] || null,
    replyParentLogin: t['reply-parent-user-login'] || null,
    threadId: t['reply-thread-parent-msg-id'] || null,
    reply: t['reply-parent-display-name'] ? { name: t['reply-parent-display-name'], body: t['reply-parent-msg-body'] } : null,
    ...extra,
  };
}

// Channels whose messages show up in ours through Shared Chat, keyed by room id
const sourceChannels = new Map();

function sourceChannel(id) {
  let src = sourceChannels.get(id);
  if (!src) {
    src = makeChannel('');
    src.id = id;
    src.logo = null;
    sourceChannels.set(id, src);
    loadSource(src);
  }
  return src;
}

async function loadSource(src) {
  try {
    const u = (await getJSON(`https://api.ivr.fi/v2/twitch/user?id=${src.id}`))?.[0];
    if (u) Object.assign(src, { name: u.login, displayName: u.displayName, logo: u.logo });
  } catch {}
  if (!src.name && auth) {
    try {
      const u = (await helix('GET', `/users?id=${src.id}`)).data[0];
      if (u) Object.assign(src, { name: u.login, displayName: u.display_name, logo: u.profile_image_url });
    } catch {}
  }
  if (src.name) await loadChannelData(src);
  for (const ch of channels.values()) {
    if (ch.history.some(m => m.source === src)) ch.splits.forEach(s => s.rerender());
  }
}

function noticeMsg(text, time) {
  return { id: `notice-${++localId}`, kind: 'notice', text, time: time || Date.now() };
}

function ingest(ch, m) {
  const t = m.tags;
  switch (m.command) {
    case 'PRIVMSG': {
      let text = m.params[1] || '';
      const action = text.startsWith('\x01ACTION ') && text.endsWith('\x01');
      if (action) text = text.slice(8, -1);
      return { kind: 'add', msg: makeMsg(ch, t, m.prefix.split('!')[0], text, { action }) };
    }
    case 'USERNOTICE': {
      const system = t['msg-id'] === 'announcement' ? 'Announcement' : t['system-msg'] || '';
      return { kind: 'add', msg: makeMsg(ch, t, t.login, m.params[1] || '', { kind: 'sub', system }) };
    }
    case 'CLEARCHAT':
      if (m.params[1]) return { kind: 'clearUser', user: m.params[1], duration: Number(t['ban-duration']) || 0, time: Number(t['tmi-sent-ts']) };
      return { kind: 'clearAll', time: Number(t['tmi-sent-ts']) };
    case 'CLEARMSG':
      return { kind: 'clearMsg', id: t['target-msg-id'] };
    case 'NOTICE':
      return { kind: 'add', msg: noticeMsg(m.params[1] || '') };
  }
  return null;
}

function apply(list, ev) {
  const res = { added: [], changed: [] };
  const push = msg => { list.push(msg); res.added.push(msg); };

  if (ev.kind === 'add') {
    push(ev.msg);
  } else if (ev.kind === 'clearMsg') {
    const msg = list.find(x => x.id === ev.id);
    if (msg) { msg.deleted = true; res.changed.push(msg); }
  } else if (ev.kind === 'clearUser') {
    const platform = ev.platform || null;
    for (const msg of list) {
      if (msg.login === ev.user && (msg.platform || null) === platform && !msg.deleted) { msg.deleted = true; res.changed.push(msg); }
    }
    push(noticeMsg(ev.note || (ev.duration ? `${ev.user} was timed out for ${fmtDuration(ev.duration)}.` : `${ev.user} was banned.`), ev.time));
  } else if (ev.kind === 'clearAll') {
    push(noticeMsg(ev.note || 'Chat was cleared by a moderator.', ev.time));
  }

  if (list.length > settings.limit + 200) list.splice(0, list.length - settings.limit);
  return res;
}

/* ---------- live status ---------- */

let pollTimer = null;
function schedulePoll() {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(pollLive, 1500);
}

async function pollLive() {
  if (!auth) return;
  const names = [...channels.keys()];
  for (let i = 0; i < names.length; i += 100) {
    const batch = names.slice(i, i + 100);
    let r;
    try {
      r = await helix('GET', '/streams?first=100&' + batch.map(n => 'user_login=' + n).join('&'));
    } catch { return; }
    const live = new Map(r.data.map(s => [s.user_login, s]));
    for (const name of batch) {
      const ch = channels.get(name);
      if (!ch) continue;
      const s = live.get(name);
      const was = ch.live;
      ch.live = s ? { title: s.title, game: s.game_name, viewers: s.viewer_count, started: s.started_at } : null;
      if (s && was === null) {
        channelNotice(ch, `${name} is live: ${s.title}`);
        if (settings.liveSound) ping(660);
      } else if (!s && was) {
        channelNotice(ch, `${name} went offline.`);
      }
      ch.splits.forEach(sp => sp.updateHead());
    }
  }
  renderTabs();
}
