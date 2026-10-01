const ICONS = {
  delete: '<svg viewBox="0 0 16 16"><path d="M3 4h10M6 4V2.5h4V4M4.5 4l.7 9.5h5.6l.7-9.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  timeout: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M8 4.5V8l2.5 1.5" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  ban: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M3.8 3.8l8.4 8.4" stroke="currentColor" stroke-width="1.4"/></svg>',
  reply: '<svg viewBox="0 0 16 16"><path d="M6 4L2 8l4 4M2 8h8a4 4 0 0 1 4 4" fill="none" stroke="currentColor" stroke-width="1.4"/></svg>',
  smile: '<svg viewBox="0 0 16 16"><circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" stroke-width="1.4"/><path d="M5.3 9.4a3.2 3.2 0 0 0 5.4 0" fill="none" stroke="currentColor" stroke-width="1.4"/><circle cx="6" cy="6.5" r=".9" fill="currentColor"/><circle cx="10" cy="6.5" r=".9" fill="currentColor"/></svg>',
};

const colorCache = new Map();
function readable(hex) {
  if (!/^#[0-9a-f]{6}$/i.test(hex || '')) return null;
  if (colorCache.has(hex)) return colorCache.get(hex);
  const n = parseInt(hex.slice(1), 16);
  let rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => v / 255);
  const lum = 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2];
  if (lum < 0.4) {
    const t = (0.4 - lum) / (1 - lum);
    rgb = rgb.map(v => v + (1 - v) * t);
  }
  const out = '#' + rgb.map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('');
  colorCache.set(hex, out);
  return out;
}

function defaultColor(login = '') {
  let sum = 0;
  for (const c of login) sum += c.charCodeAt(0);
  return DEFAULT_COLORS[sum % DEFAULT_COLORS.length];
}

function userColor(login, color) {
  return readable(color) || readable(defaultColor(login));
}

function displayName(msg) {
  const nick = settings.nicknames[msg.login];
  if (nick) return nick;
  if (settings.usernames === 'login') return msg.login;
  if (settings.usernames === 'display' || msg.name.toLowerCase() === msg.login) return msg.name;
  return `${msg.name} (${msg.login})`;
}

function isMention(msg) {
  if (!msg.text || msg.kind === 'notice' || msg.kind === 'whisper' || msg.login === auth?.login) return false;
  if (auth && msg.replyParentLogin === auth.login) return true;
  if (auth && matches(auth.login, msg.text)) return true;
  return settings.highlights.some(p => p && matches(p, msg.text));
}

function twitchEmote(id, size) {
  return `https://static-cdn.jtvnw.net/emoticons/v2/${id}/default/dark/${size}`;
}

function emoteImg(e) {
  const img = el('img', 'emote');
  img.src = e.url;
  if (e.url2) img.srcset = `${e.url} 1x, ${e.url2} 2x`;
  img.alt = e.name;
  img.dataset.tip = `${e.name}\n${e.provider} emote`;
  img.dataset.big = e.url4 || e.url2 || e.url;
  return img;
}

const URL_RE = /^(https?:\/\/\S+|www\.\S+\.\S+)$/i;

function linkEl(word) {
  const a = el('a', null, word);
  a.href = /^https?:/i.test(word) ? word : 'https://' + word;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  return a;
}

function linkify(text) {
  const frag = document.createDocumentFragment();
  for (const word of text.split(/(\s+)/)) frag.append(URL_RE.test(word) ? linkEl(word) : word);
  return frag;
}

function cheerFor(word, src) {
  const m = /^([a-z]+)(\d+)$/i.exec(word);
  const tiers = m && src.cheermotes?.get(m[1].toLowerCase());
  if (!tiers) return null;
  const amount = Number(m[2]);
  const tier = tiers.find(t => amount >= t.min_bits) || tiers[tiers.length - 1];
  const imgs = tier.images?.dark?.animated || tier.images?.dark?.static;
  if (!imgs) return null;
  const frag = document.createDocumentFragment();
  const img = emoteImg({ name: word, url: imgs['1'], url2: imgs['2'], url4: imgs['4'], provider: 'Cheer' });
  const n = el('span', 'cheer-amount', String(amount));
  n.style.color = tier.color;
  frag.append(img, n);
  return frag;
}

function renderText(msg, src) {
  const frag = document.createDocumentFragment();
  const chars = Array.from(msg.text);

  const ranges = [];
  for (const part of (msg.emotes || '').split('/').filter(Boolean)) {
    const [id, spans = ''] = part.split(':');
    for (const span of spans.split(',')) {
      const [s, e] = span.split('-').map(Number);
      if (Number.isInteger(s) && Number.isInteger(e)) ranges.push({ s, e, id });
    }
  }
  ranges.sort((a, b) => a.s - b.s);

  const pieces = [];
  let at = 0;
  for (const r of ranges) {
    if (r.s < at) continue;
    if (r.s > at) pieces.push(chars.slice(at, r.s).join(''));
    pieces.push({ name: chars.slice(r.s, r.e + 1).join(''), url: twitchEmote(r.id, '1.0'), url2: twitchEmote(r.id, '2.0'), url4: twitchEmote(r.id, '3.0'), provider: 'Twitch' });
    at = r.e + 1;
  }
  if (at < chars.length) pieces.push(chars.slice(at).join(''));

  let stack = null;
  let space = '';
  const flush = () => { if (space) frag.append(space); space = ''; };
  const putEmote = e => {
    if (e.zeroWidth && stack) {
      const img = emoteImg(e);
      img.classList.add('zw');
      stack.append(img);
      space = '';
      return;
    }
    flush();
    stack = el('span', 'emote-stack');
    stack.append(emoteImg(e));
    frag.append(stack);
  };

  for (const piece of pieces) {
    if (typeof piece !== 'string') { putEmote(piece); continue; }
    for (const word of piece.split(/(\s+)/)) {
      if (!word) continue;
      if (/^\s+$/.test(word)) { space += word; continue; }

      const emote = (msg.local && userEmotes.get(word)) || src.emotes.get(word) || globalEmotes.get(word);
      if (emote) { putEmote(emote); continue; }

      flush();
      stack = null;
      const cheer = msg.bits ? cheerFor(word, src) : null;
      if (cheer) {
        frag.append(cheer);
      } else if (URL_RE.test(word)) {
        frag.append(linkEl(word));
      } else if (/^@\w/.test(word)) {
        const [, name, rest] = word.match(/^@(\w+)(.*)$/);
        const login = name.toLowerCase();
        const tag = el('span', 'mention-tag', '@' + name);
        tag.dataset.login = login;
        if (src.colors.has(login)) tag.style.color = userColor(login, src.colors.get(login));
        frag.append(tag, rest);
      } else {
        frag.append(word);
      }
    }
  }
  flush();
  return frag;
}

function iconButton(name, title) {
  const b = el('button');
  b.innerHTML = ICONS[name];
  b.title = title;
  b.dataset.act = name;
  return b;
}

function renderMessage(msg, ch, withTools = false) {
  const src = msg.origin || ch;
  const row = el('div', 'msg');
  row.dataset.id = msg.id;
  if (msg.historical) row.classList.add('historical');

  if (settings.timestamps) row.append(el('span', 'ts', fmtTime(msg.time)));
  if (ch.special && msg.origin) row.append(el('span', 'origin', '#' + msg.origin.name + ' '));

  if (msg.kind === 'notice') {
    row.classList.add('notice');
    row.append(linkify(msg.text));
    return row;
  }

  if (msg.kind === 'redeem') {
    row.classList.add('redemption');
    row.append(el('span', 'sys', msg.system));
    return row;
  }

  if (msg.kind === 'automod') {
    row.classList.add('automod');
    row.append(el('span', 'sys', `AutoMod held a message from ${msg.name} (${msg.reason})`), el('br'));
    const body = el('span', 'body');
    body.append(renderText(msg, src));
    row.append(body);
    if (msg.resolved) {
      row.append(el('span', 'am-state', msg.resolved));
    } else if (withTools) {
      const actions = el('span', 'am-actions');
      const allow = el('button', 'allow', 'Allow');
      allow.dataset.act = 'am-allow';
      const deny = el('button', 'deny', 'Deny');
      deny.dataset.act = 'am-deny';
      actions.append(allow, deny);
      row.append(actions);
    }
    return row;
  }

  if (msg.kind === 'sub') row.classList.add('sub');
  else if (msg.kind === 'whisper') row.classList.add('whisper');
  else if (msg.highlightedMsg) row.classList.add('highlighted-msg');
  else if (settings.highlightUsers.includes(msg.login)) row.classList.add('hl-user');
  else if (isMention(msg)) row.classList.add('mention');
  else if (msg.rewardId) row.classList.add('redemption');
  else if (msg.first && !msg.historical) row.classList.add('first');

  if (msg.deleted) {
    row.classList.add('deleted');
    if (settings.hideDeleted) row.hidden = true;
  }
  if (settings.collapseLong && msg.text.length > 350) row.classList.add('long');

  if (withTools && auth && (msg.kind === 'chat' || msg.kind === 'whisper')) {
    const reply = iconButton('reply', 'Reply');
    reply.className = 'reply-btn';
    row.prepend(reply);
  }

  if (msg.system) {
    row.append(el('span', 'sys', msg.system));
    if (!msg.text) return row;
    row.append(el('br'));
  }
  if (msg.rewardId) {
    row.append(el('span', 'sys', msg.rewardTitle ? `Redeemed ${msg.rewardTitle}` : 'Redeemed a channel point reward'), el('br'));
  }
  if (msg.reply) {
    const ctx = el('span', 'reply-ctx', `Replying to @${msg.reply.name}: ${msg.reply.body}`);
    ctx.title = 'View thread';
    row.prepend(ctx);
  }

  if (withTools && settings.modButtons && src.isMod && auth && msg.kind === 'chat' && msg.login !== src.name && msg.login !== auth.login) {
    const tools = el('span', 'tools');
    tools.append(iconButton('delete', 'Delete message'), iconButton('timeout', 'Timeout 10 minutes'), iconButton('ban', 'Ban'));
    row.append(tools);
  }

  if (settings.badges) {
    for (const b of msg.badges.split(',').filter(Boolean)) {
      const info = src.badges.get(b) || globalBadges.get(b);
      if (!info) continue;
      const img = el('img', 'badge');
      img.src = info.url;
      if (info.url2) img.srcset = `${info.url} 1x, ${info.url2} 2x`;
      img.alt = info.title;
      img.dataset.tip = info.title;
      img.dataset.big = info.url4 || info.url2 || info.url;
      row.append(img);
    }
  }

  const color = userColor(msg.login, msg.color);
  const name = el('span', 'user', displayName(msg));
  name.style.color = color;
  name.dataset.login = msg.login;
  row.append(name);

  if (msg.kind === 'whisper') {
    row.append(' → ');
    const to = el('span', 'user', msg.outgoing ? msg.to : 'you');
    if (msg.outgoing) to.dataset.login = msg.to;
    row.append(to, ': ');
  } else {
    row.append(msg.action ? ' ' : ': ');
  }

  const body = el('span', 'body');
  if (msg.action) body.style.color = color;
  body.append(renderText(msg, src));
  row.append(body);
  return row;
}

/* ---------- tooltips for emotes and badges ---------- */

const tip = $('#tooltip');

document.addEventListener('mouseover', e => {
  const img = e.target.closest?.('img.emote, img.badge');
  if (!img?.dataset.tip) return;
  tip.replaceChildren();
  if (img.dataset.big) {
    const big = el('img');
    big.src = img.dataset.big;
    big.alt = '';
    tip.append(big);
  }
  tip.append(el('div', null, img.dataset.tip));
  tip.hidden = false;
  const r = img.getBoundingClientRect();
  const below = r.top < 140;
  tip.style.left = Math.min(Math.max(r.left + r.width / 2, 90), innerWidth - 90) + 'px';
  tip.style.top = (below ? r.bottom + 8 : r.top - 8) + 'px';
  tip.classList.toggle('below', below);
});

document.addEventListener('mouseout', e => {
  if (e.target.closest?.('img.emote, img.badge')) tip.hidden = true;
});
