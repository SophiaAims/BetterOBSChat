// Kick chat comes in over Kick's public Pusher socket, so reading needs no login
const KICK_WS = 'wss://ws-us2.pusher.com/app/32cbd69e4b950bf97679?protocol=7&client=js&version=8.4.0&flash=false';

const kickSaved = store.get('kickLinks', {});
const kickRooms = store.get('kickRooms', {});
const kickByRoom = new Map();
const dockKick = params.get('kick');
let kickWs = null;

function kickSpecFor(name) {
  if (dockMode && dockKick && name === dockChannels[0]) return dockKick;
  return kickSaved[name] || null;
}

// accepts "name", "name:chatroomId" or a kick.com link
function parseKickSpec(spec) {
  const m = /^\s*(?:https?:\/\/)?(?:www\.)?(?:kick\.com\/)?([\w-]+)\/?(?::(\d+))?\s*$/i.exec(spec || '');
  return m ? { slug: m[1].toLowerCase(), room: m[2] ? Number(m[2]) : null } : null;
}

async function kickChannelInfo(slug) {
  try {
    return await getJSON(`https://kick.com/api/v2/channels/${encodeURIComponent(slug)}`);
  } catch {
    return null;
  }
}

async function kickAttach(ch, spec) {
  const p = parseKickSpec(spec);
  if (!p) return;
  const k = ch.kick = { slug: p.slug, room: p.room, userId: null, emotes: new Map(), subBadges: [], state: 'connecting' };
  const cached = kickRooms[p.slug];
  if (!k.room && cached) k.room = cached.room;
  if (cached) k.userId = cached.userId;
  refreshKickHead(ch);

  const info = await kickChannelInfo(p.slug);
  if (ch.kick !== k) return;
  if (info) {
    k.room ||= info.chatroom?.id || null;
    k.userId = info.user_id || k.userId;
    k.subBadges = (info.subscriber_badges || [])
      .filter(b => b.badge_image?.src)
      .map(b => ({ months: b.months, url: b.badge_image.src }))
      .sort((a, b) => b.months - a.months);
  }

  if (!k.room) {
    k.state = 'failed';
    refreshKickHead(ch);
    channelNotice(ch, `Couldn't find the chat room for kick.com/${p.slug}. Open https://kick.com/api/v2/channels/${p.slug} in your browser, look for "chatroom":{"id": and link it again as ${p.slug}:THATNUMBER.`);
    return;
  }

  kickRooms[p.slug] = { room: k.room, userId: k.userId };
  store.set('kickRooms', kickRooms);
  kickByRoom.set(k.room, ch);
  kickSocket().subscribe(k.room);
  loadKickEmotes(ch, k);
}

function kickDetach(ch) {
  const k = ch.kick;
  if (!k) return;
  ch.kick = null;
  if (k.room && kickByRoom.get(k.room) === ch) {
    kickByRoom.delete(k.room);
    kickWs?.unsubscribe(k.room);
  }
  refreshKickHead(ch);
}

function linkKick(ch, spec) {
  const p = parseKickSpec(spec);
  if (!p) {
    channelNotice(ch, `"${spec}" doesn't look like a Kick channel name.`);
    return;
  }
  kickSaved[ch.name] = spec.trim();
  store.set('kickLinks', kickSaved);
  kickDetach(ch);
  kickAttach(ch, spec);
}

function unlinkKick(ch) {
  delete kickSaved[ch.name];
  store.set('kickLinks', kickSaved);
  const slug = ch.kick?.slug;
  kickDetach(ch);
  channelNotice(ch, `Stopped showing kick.com/${slug} chat here.`);
}

function refreshKickHead(ch) {
  ch.splits.forEach(s => { s.updateHead(); s.updateComposer(); });
}

async function loadKickEmotes(ch, k) {
  if (!k.userId) return;
  try {
    const r = await getJSON(`https://7tv.io/v3/users/kick/${k.userId}`);
    addSevenTV(k.emotes, r.emote_set?.emotes);
    if (ch.kick === k) ch.splits.forEach(s => s.rerender());
  } catch {}
}

/* ---------- socket ---------- */

function kickSocket() {
  kickWs ||= new KickSocket();
  return kickWs;
}

class KickSocket {
  constructor() {
    this.rooms = new Set();
    this.retry = 1000;
    this.dropped = false;
    this.ready = false;
    this.connect();
  }

  connect() {
    const ws = this.ws = new WebSocket(KICK_WS);
    this.ready = false;
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.event === 'pusher:connection_established') {
        this.ready = true;
        this.retry = 1000;
        if (this.dropped) kickNotice('Reconnected to Kick chat.');
        this.dropped = false;
        for (const room of this.rooms) this.sendSub(room);
      } else if (m.event === 'pusher:ping') {
        this.send({ event: 'pusher:pong', data: {} });
      } else if (m.event === 'pusher_internal:subscription_succeeded') {
        const ch = kickByRoom.get(roomOf(m.channel));
        if (ch?.kick && ch.kick.state !== 'connected') {
          ch.kick.state = 'connected';
          refreshKickHead(ch);
        }
      } else {
        onKickEvent(m);
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ready = false;
      for (const ch of kickByRoom.values()) {
        if (ch.kick) ch.kick.state = 'connecting';
        refreshKickHead(ch);
      }
      if (!this.dropped && this.rooms.size) kickNotice('Disconnected from Kick chat. Reconnecting…');
      this.dropped = true;
      setTimeout(() => this.connect(), this.retry);
      this.retry = Math.min(this.retry * 2, 30000);
    };
  }

  send(obj) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(obj));
  }

  sendSub(room) {
    this.send({ event: 'pusher:subscribe', data: { auth: '', channel: `chatrooms.${room}.v2` } });
  }

  subscribe(room) {
    this.rooms.add(room);
    if (this.ready) this.sendSub(room);
  }

  unsubscribe(room) {
    this.rooms.delete(room);
    if (this.ready) this.send({ event: 'pusher:unsubscribe', data: { channel: `chatrooms.${room}.v2` } });
  }
}

function roomOf(channel) {
  return Number(/^chatrooms\.(\d+)/.exec(channel || '')?.[1]);
}

function kickNotice(text) {
  for (const ch of kickByRoom.values()) channelNotice(ch, text);
}

/* ---------- events ---------- */

function onKickEvent(m) {
  const ch = kickByRoom.get(roomOf(m.channel));
  if (!ch) return;
  let d = m.data;
  if (typeof d === 'string') {
    try { d = JSON.parse(d); } catch { return; }
  }
  if (!d) return;

  switch (m.event) {
    case 'App\\Events\\ChatMessageEvent': {
      const msg = kickMsg(ch, d);
      if (isHidden(msg)) return;
      remember(ch, msg);
      if (isMention(msg)) notifyMention(msg);
      publish(ch, { kind: 'add', msg });
      return;
    }
    case 'App\\Events\\MessageDeletedEvent':
      publish(ch, { kind: 'clearMsg', id: 'kick-' + (d.message?.id ?? d.id) });
      return;
    case 'App\\Events\\UserBannedEvent': {
      const user = d.user?.username;
      if (!user) return;
      const mins = Number(d.duration);
      const note = d.permanent || !mins
        ? `${user} was banned on Kick.`
        : `${user} was timed out on Kick for ${fmtDuration(mins * 60)}.`;
      publish(ch, { kind: 'clearUser', user: user.toLowerCase(), platform: 'kick', note });
      return;
    }
    case 'App\\Events\\ChatroomClearEvent':
      publish(ch, { kind: 'clearAll', note: 'Kick chat was cleared by a moderator.' });
      return;
    case 'App\\Events\\SubscriptionEvent':
      if (d.username) kickSystem(ch, `${d.username} subscribed on Kick${d.months > 1 ? ` (${d.months} months)` : ''}`);
      return;
    case 'App\\Events\\GiftedSubscriptionsEvent': {
      const n = d.gifted_usernames?.length || 1;
      kickSystem(ch, `${d.gifter_username || 'Someone'} gifted ${n} sub${n === 1 ? '' : 's'} on Kick`);
      return;
    }
  }
}

function kickSystem(ch, system) {
  const msg = { id: `kick-sys-${++localId}`, kind: 'sub', platform: 'kick', origin: ch, login: '', name: '', text: '', emotes: '', badges: '', system, time: Date.now() };
  publish(ch, { kind: 'add', msg });
}

const KICK_EMOTE_RE = /\[emote:(\d+):([^\]]*)\]/g;

// Kick sends emotes inline as [emote:id:name]; swap them for their names and keep the positions
function kickContent(raw) {
  let text = '';
  let len = 0;
  let last = 0;
  const ranges = [];
  for (const m of raw.matchAll(KICK_EMOTE_RE)) {
    const before = raw.slice(last, m.index);
    text += before;
    len += Array.from(before).length;
    const name = m[2] || 'emote';
    const n = Array.from(name).length;
    const url = `https://files.kick.com/emotes/${m[1]}/fullsize`;
    ranges.push({ s: len, e: len + n - 1, emote: { name, url, url4: url, provider: 'Kick' } });
    text += name;
    len += n;
    last = m.index + m[0].length;
  }
  text += raw.slice(last);
  return { text, ranges };
}

function kickMsg(ch, d) {
  const s = d.sender || {};
  const { text, ranges } = kickContent(d.content || '');
  const meta = d.metadata || {};
  const parent = meta.original_sender?.username;
  return {
    id: 'kick-' + d.id,
    kind: 'chat',
    platform: 'kick',
    origin: ch,
    login: (s.username || '').toLowerCase(),
    slug: s.slug || null,
    userId: s.id,
    name: s.username || '?',
    color: s.identity?.color,
    badges: '',
    kickBadges: s.identity?.badges || [],
    emotes: '',
    emoteRanges: ranges,
    source: null,
    text,
    time: Date.parse(d.created_at) || Date.now(),
    reply: parent ? { name: parent, body: kickContent(meta.original_message?.content || '').text } : null,
    replyParentLogin: parent ? parent.toLowerCase() : null,
  };
}

/* ---------- badges and platform marks ---------- */

const KICK_BADGES = {
  broadcaster: ['#e9113c', '<path d="M2 5h8v6H2zM10.5 7.2 14 5v6l-3.5-2.2z"/>'],
  moderator: ['#00c7ff', '<path d="M13.5 1.5v2.8L7.6 10.2l1.2 1.2-1.4 1.4-1.2-1.2-2.6 2.6-1.4-1.4 2.6-2.6-1.2-1.2 1.4-1.4 1.2 1.2 5.9-5.9z"/>'],
  vip: ['#ffc800', '<path d="M4 3h8l3 3.5L8 14 1 6.5z"/>'],
  og: ['#00c2a2', '<path d="M8 1.5l2 4.3 4.6.5-3.4 3.2.9 4.6L8 11.8l-4.1 2.3.9-4.6-3.4-3.2 4.6-.5z"/>'],
  founder: ['#ffb800', '<path d="M2 12.5h12l1-7.5-4 3-3-5.5L5 8 1 5z"/>'],
  verified: ['#1475e1', '<path d="M6.5 11.8 2.8 8.1l1.4-1.4 2.3 2.3 5.3-5.3 1.4 1.4z"/>'],
  sub_gifter: ['#2ebde1', '<path d="M2 5h5v3H2zM9 5h5v3H9zM3 9h4v5H3zM9 9h4v5H9zM5 2.5h2V5H5zM9 2.5h2V5H9z"/>'],
  subscriber: ['#53fc18', '<path d="M8 1.5l2 4.3 4.6.5-3.4 3.2.9 4.6L8 11.8l-4.1 2.3.9-4.6-3.4-3.2 4.6-.5z"/>'],
  staff: ['#7e45ff', '<path d="M8 1.5 14 4v4c0 3.4-2.5 5.6-6 6.5C4.5 13.6 2 11.4 2 8V4z"/>'],
};

function kickBadgeEl(b, ch) {
  const title = b.text || b.type;
  if (b.type === 'subscriber' && ch.kick?.subBadges.length) {
    const tiers = ch.kick.subBadges;
    const tier = tiers.find(t => (b.count || 1) >= t.months) || tiers[tiers.length - 1];
    const img = el('img', 'badge');
    img.src = tier.url;
    img.alt = title;
    img.dataset.tip = b.count ? `${title} (${b.count} months)` : title;
    img.dataset.big = tier.url;
    return img;
  }
  const def = KICK_BADGES[b.type];
  if (!def) return null;
  const span = el('span', 'kick-badge');
  span.style.background = def[0];
  span.innerHTML = `<svg viewBox="0 0 16 16">${def[1]}</svg>`;
  span.title = b.count ? `${title} (${b.count})` : title;
  return span;
}

const PLATFORM_MARKS = {
  kick: '<svg viewBox="0 0 16 16"><path d="M3 2h3.5v3.5H8V4h1.5V2H13v4h-1.5v1.5H10v1h1.5V10H13v4H9.5v-2H8v-1.5H6.5V14H3z"/></svg>',
  twitch: '<svg viewBox="0 0 16 16"><path d="M3 1.5 1.8 4.5v9h3.3v1.8h1.8l1.8-1.8h2.7l3.6-3.6V1.5zm9.6 7.8-2 2H7.8L6 13.1v-1.8H3.6V3.3h9z"/><path d="M10.5 5.1h1.3v3.6h-1.3zM7.3 5.1h1.3v3.6H7.3z"/></svg>',
};

function platformMark(platform) {
  const span = el('span', 'plat ' + platform);
  span.innerHTML = PLATFORM_MARKS[platform];
  span.title = platform === 'kick' ? 'From Kick chat' : 'From Twitch chat';
  return span;
}

/* ---------- link prompt ---------- */

function promptKick(split, at) {
  const ch = split.ch;
  const input = el('input', 'panel-filter');
  input.placeholder = 'Kick channel name';
  input.value = kickSaved[ch.name] || ch.name;
  input.spellcheck = false;
  const go = el('button', 'kick-go', 'Link');
  const row = el('div', 'kick-row');
  row.append(input, go);
  const hint = el('p', 'empty', `Kick messages will show up in this split alongside ${ch.name}'s Twitch chat. If it can't find the channel, add its chat room ID after a colon, like name:123456.`);
  const submit = () => {
    if (!input.value.trim()) return;
    linkKick(ch, input.value);
    closePanel();
  };
  input.onkeydown = e => { if (e.key === 'Enter') submit(); };
  go.onclick = submit;
  showPanel([panelHeader('Link a Kick chat'), row, hint], at);
  input.focus();
  input.select();
}
