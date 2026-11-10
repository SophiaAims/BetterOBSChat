class Split {
  constructor(page, channel) {
    this.page = page;
    this.ch = null;
    this.paused = false;
    this.hovering = false;
    this.markPending = false;
    this.searchActive = false;
    this.filter = { from: [], text: '' };
    this.sent = [];
    this.sentIdx = 0;
    this.replyTo = null;
    this.comp = null;

    this.root = el('section', 'split');

    this.head = el('div', 'split-head');
    this.liveDot = el('span', 'live-dot');
    this.liveDot.hidden = true;
    this.title = el('button', 'name');
    this.title.title = 'Change channel';
    this.title.onclick = () => this.showJoin();
    this.modes = el('span', 'modes');
    const more = el('button', 'icon-btn', '⋯');
    more.title = 'Split options';
    more.onclick = e => this.openMenu(e);
    const add = el('button', 'icon-btn', '+');
    add.title = 'Add split (Alt+N)';
    add.onclick = () => addSplit(this.page, '', this);
    const close = el('button', 'icon-btn', '×');
    close.title = 'Close split (Alt+W)';
    close.onclick = () => closeSplit(this);
    this.kickChip = el('span', 'kick-chip', 'Kick');
    this.kickChip.hidden = true;
    this.head.append(this.liveDot, this.title, this.kickChip, this.modes, more, add, close);

    const wrap = el('div', 'log-wrap');
    this.searchBar = el('div', 'search');
    this.searchBar.hidden = true;
    this.searchInput = el('input');
    this.searchInput.placeholder = 'Search messages, or from:name';
    const searchClose = el('button', null, '×');
    searchClose.title = 'Close search';
    searchClose.onclick = () => this.closeSearch();
    this.searchBar.append(this.searchInput, searchClose);
    this.list = el('div', 'messages');
    this.list.setAttribute('role', 'log');
    this.jump = el('button', 'jump');
    this.jump.onclick = () => this.stick();
    wrap.append(this.searchBar, this.list, this.jump);

    this.composer = el('div', 'composer');
    this.replyBar = el('div', 'reply-bar');
    const row = el('div', 'composer-row');
    this.input = el('textarea');
    this.input.rows = 1;
    this.input.maxLength = 500;
    this.count = el('span', 'count');
    this.pickerBtn = el('button', 'picker-btn');
    this.pickerBtn.innerHTML = ICONS.smile;
    this.pickerBtn.title = 'Emotes';
    this.pickerBtn.onclick = () => (picker.hidden || pickerSplit !== this ? openPicker(this) : closePicker());
    row.append(this.input, this.count, this.pickerBtn);
    this.composer.append(this.replyBar, row);

    this.root.append(this.head, wrap, this.composer);
    this.bind();
    if (channel) this.setChannel(channel, false);
    else this.showJoin();
    this.updateComposer();
  }

  bind() {
    this.root.addEventListener('focusin', () => setFocused(this));
    this.root.addEventListener('mousedown', () => setFocused(this));

    this.list.addEventListener('scroll', () => {
      const paused = !this.atEdge();
      if (paused === this.paused) return;
      this.paused = paused;
      this.root.classList.toggle('paused', paused);
      if (!paused) this.trim();
    });
    this.list.addEventListener('load', () => {
      if (!this.holding() && !newestOnTop()) this.list.scrollTop = this.list.scrollHeight;
    }, true);
    this.list.addEventListener('mouseenter', () => { this.hovering = true; });
    this.list.addEventListener('mouseleave', () => {
      this.hovering = false;
      if (settings.pauseOnHover) this.stick();
    });

    this.list.addEventListener('click', e => {
      const row = e.target.closest('.msg');
      const msg = row && this.find(row.dataset.id);
      const user = e.target.closest('.user, .mention-tag');
      if (user?.dataset.login) return openCard(this, user.dataset.login, e, msg?.origin, user.dataset.platform);
      if (!msg) return;
      const act = e.target.closest('[data-act]');
      if (act) return this.act(act.dataset.act, msg);
      if (e.target.closest('.reply-ctx')) return openThread(this, msg, e);
      if (row.classList.contains('long') && !e.target.closest('a')) row.classList.remove('long');
    });

    this.list.addEventListener('contextmenu', e => {
      const row = e.target.closest('.msg');
      const msg = row && this.find(row.dataset.id);
      if (!msg || msg.kind === 'notice') return;
      e.preventDefault();
      const src = msg.origin || this.ch;
      const canMod = auth && !msg.platform && src.isMod && msg.kind === 'chat' && msg.login !== src.name && msg.login !== auth.login;
      const canReply = !this.input.disabled && !msg.platform && (msg.kind === 'chat' || msg.kind === 'whisper');
      showMenu([
        canReply && { label: 'Reply', fn: () => this.setReply(msg) },
        { label: 'Copy message', fn: () => copyText(msg.text || msg.system || '') },
        msg.login && { label: 'Copy username', fn: () => copyText(msg.login) },
        msg.login && { label: 'Open user card', fn: () => openCard(this, msg.login, e, msg.origin, msg.platform) },
        msg.replyParentId && { label: 'View thread', fn: () => openThread(this, msg, e) },
        canMod && '-',
        canMod && { label: 'Delete message', fn: () => this.act('delete', msg) },
        canMod && { label: 'Timeout 10 minutes', fn: () => this.act('timeout', msg) },
        canMod && { label: 'Ban', fn: () => this.act('ban', msg), danger: true },
      ], e.clientX, e.clientY);
    });

    this.searchInput.addEventListener('input', () => this.runSearch());
    this.searchInput.addEventListener('keydown', e => { if (e.key === 'Escape') this.closeSearch(); });

    this.input.addEventListener('input', () => this.updateCount());
    this.input.addEventListener('keydown', e => {
      if (e.key === 'Tab' && this.complete(e.shiftKey ? -1 : 1)) {
        e.preventDefault();
        return;
      }
      if (e.key !== 'Shift') this.comp = null;
      if (e.key === 'Enter') {
        e.preventDefault();
        const text = this.input.value;
        this.input.value = '';
        this.updateCount();
        this.send(text);
      } else if (e.key === 'ArrowUp' && this.sentIdx > 0) {
        e.preventDefault();
        this.input.value = this.sent[--this.sentIdx];
        this.updateCount();
      } else if (e.key === 'ArrowDown' && this.sentIdx < this.sent.length) {
        e.preventDefault();
        this.input.value = this.sent[++this.sentIdx] ?? '';
        this.updateCount();
      } else if (e.key === 'Escape' && this.replyTo) {
        this.setReply(null);
      }
    });
  }

  find(id) {
    return this.ch?.history.find(m => m.id === id);
  }

  /* ---------- channel ---------- */

  setChannel(name, save = true) {
    name = name.trim().toLowerCase();
    name = specials[name] ? name : name.replace(/^#/, '').replace(/[^a-z0-9_]/g, '');
    const input = $('.channel-input', this.head);
    if (input) input.replaceWith(this.title);
    if (this.ch?.name === name) return;

    if (this.ch) releaseChannel(this.ch, this);
    this.ch = null;
    this.setReply(null);
    this.list.replaceChildren();
    this.kickChip.hidden = true;
    if (!name) { this.showJoin(); return; }

    this.ch = getChannel(name);
    this.ch.splits.add(this);
    this.title.textContent = name;
    this.updateHead();
    this.updateComposer();
    this.rerender();
    if (save) { renderTabs(); syncLayout(); }
  }

  showJoin() {
    if ($('.channel-input', this.head)) return;
    const input = el('input', 'channel-input');
    input.placeholder = 'Channel name';
    input.value = this.ch?.name || '';
    input.spellcheck = false;
    input.onkeydown = e => {
      if (e.key === 'Enter') this.setChannel(input.value);
      if (e.key === 'Escape' && this.ch) input.replaceWith(this.title);
    };
    input.onblur = () => { if (this.ch && input.isConnected) input.replaceWith(this.title); };
    this.title.replaceWith(input);
    if (!this.ch) {
      this.modes.textContent = '';
      this.liveDot.hidden = true;
      this.list.replaceChildren(el('p', 'empty', 'Type a channel name above and press Enter. You can also use /mentions or /whispers.'));
    }
    if (this.root.isConnected) { input.focus(); input.select(); }
  }

  updateHead() {
    const ch = this.ch;
    const r = ch?.room || {};
    const bits = [];
    if (ch?.live) bits.push(`${ch.live.viewers.toLocaleString()} viewers, ${fmtUptime(ch.live.started)}`);
    if (Number(r.slow) > 0) bits.push(`slow ${r.slow}s`);
    if (r['emote-only'] === '1') bits.push('emote only');
    if (r['subs-only'] === '1') bits.push('subs only');
    if (r['followers-only'] && r['followers-only'] !== '-1') bits.push(r['followers-only'] === '0' ? 'followers only' : `followers ${r['followers-only']}m`);
    if (r.r9k === '1') bits.push('unique chat');
    this.modes.textContent = bits.join(', ');
    this.liveDot.hidden = !ch?.live;
    this.head.title = ch?.live ? `${ch.live.title}\n${ch.live.game}` : '';

    const k = ch?.kick;
    this.kickChip.hidden = !k;
    if (k) {
      this.kickChip.className = 'kick-chip ' + k.state;
      this.kickChip.title = {
        connected: `Showing kick.com/${k.slug} chat here too`,
        connecting: `Connecting to kick.com/${k.slug} chat…`,
        failed: `Couldn't connect to kick.com/${k.slug} chat`,
      }[k.state];
    }
  }

  updateComposer() {
    const special = this.ch?.special;
    this.input.disabled = !auth || !this.ch || this.ch.name === '/mentions';
    if (!auth) this.input.placeholder = 'Log in to send messages';
    else if (!this.ch) this.input.placeholder = '';
    else if (this.ch.name === '/mentions') this.input.placeholder = 'Mentions from every channel you have open';
    else if (special) this.input.placeholder = 'Reply to a whisper, or /w name message';
    else this.input.placeholder = `Send a message to ${this.ch.name}${this.ch.kick ? ' on Twitch' : ''}`;
    this.pickerBtn.disabled = this.input.disabled;
  }

  updateCount() {
    const n = this.input.value.length;
    this.count.textContent = settings.showCharCount && n ? String(n) : '';
    this.count.classList.toggle('near', n > 450);
  }

  focus() {
    ($('.channel-input', this.head) || this.input).focus();
  }

  /* ---------- message list ---------- */

  holding() {
    return this.paused || (settings.pauseOnHover && this.hovering);
  }

  atEdge() {
    const l = this.list;
    return newestOnTop() ? l.scrollTop < 40 : l.scrollHeight - l.scrollTop - l.clientHeight < 40;
  }

  rerender() {
    if (!this.ch) return;
    const rows = this.ch.history.slice(-settings.limit).map(m => renderMessage(m, this.ch, true));
    if (newestOnTop()) rows.reverse();
    this.list.replaceChildren(...rows);
    this.jump.textContent = newestOnTop() ? 'New messages above' : 'More messages below';
    if (this.searchActive) this.runSearch();
    this.stick();
  }

  stick() {
    this.paused = false;
    this.root.classList.remove('paused');
    this.trim();
    this.list.scrollTop = newestOnTop() ? 0 : this.list.scrollHeight;
  }

  trim() {
    const top = newestOnTop();
    while (this.list.children.length > settings.limit) {
      (top ? this.list.lastElementChild : this.list.firstElementChild).remove();
    }
  }

  onEvent(res) {
    res.added.forEach(m => this.add(m));
    res.changed.forEach(m => this.update(m));
  }

  add(msg) {
    const top = newestOnTop();
    const hold = this.holding();
    const row = renderMessage(msg, this.ch, true);
    if (this.searchActive) this.applyFilter(row, msg);
    if (top) this.list.prepend(row);
    else this.list.append(row);

    let shift = row.offsetHeight;
    if (this.markPending && settings.lastRead && !msg.historical && msg.kind !== 'notice') {
      this.list.querySelector('.last-read')?.remove();
      const mark = el('div', 'last-read');
      if (top) row.after(mark);
      else row.before(mark);
      shift += mark.offsetHeight;
      this.markPending = false;
    }

    if (hold) {
      // keep what the reader is looking at in place while new rows land above it
      if (top) this.list.scrollTop += shift;
    } else {
      this.trim();
      this.list.scrollTop = top ? 0 : this.list.scrollHeight;
    }

    if (this.page !== activePage && !msg.historical && msg.kind !== 'notice') {
      this.page.unread = true;
      if (row.classList.contains('mention') || msg.kind === 'whisper') this.page.mentioned = true;
      markTab(this.page);
    }
  }

  update(msg) {
    const old = this.list.querySelector(`[data-id="${CSS.escape(msg.id)}"]`);
    if (!old) return;
    const row = renderMessage(msg, this.ch, true);
    if (this.searchActive) this.applyFilter(row, msg);
    old.replaceWith(row);
  }

  notice(text) {
    if (this.ch) channelNotice(this.ch, text);
  }

  /* ---------- search ---------- */

  openSearch() {
    if (!this.ch) return;
    this.searchBar.hidden = false;
    this.searchInput.focus();
    this.searchInput.select();
  }

  closeSearch() {
    this.searchBar.hidden = true;
    this.searchInput.value = '';
    this.searchActive = false;
    for (const row of this.list.querySelectorAll('.filtered-out')) row.classList.remove('filtered-out');
    this.stick();
  }

  runSearch() {
    const q = this.searchInput.value.trim().toLowerCase();
    this.searchActive = !!q;
    const from = [];
    const words = [];
    for (const tok of q.split(/\s+/).filter(Boolean)) {
      if (tok.startsWith('from:')) from.push(tok.slice(5).replace(/^@/, ''));
      else words.push(tok);
    }
    this.filter = { from, text: words.join(' ') };
    const byId = new Map((this.ch?.history || []).map(m => [m.id, m]));
    for (const row of this.list.children) {
      const msg = byId.get(row.dataset.id);
      if (msg) this.applyFilter(row, msg);
      else row.classList.toggle('filtered-out', this.searchActive);
    }
  }

  applyFilter(row, msg) {
    const f = this.filter;
    let show = true;
    if (this.searchActive) {
      if (f.from.length && !f.from.includes(msg.login)) show = false;
      if (f.text && !(msg.text || msg.system || '').toLowerCase().includes(f.text)) show = false;
    }
    row.classList.toggle('filtered-out', !show);
  }

  /* ---------- menu ---------- */

  openMenu(e) {
    const ch = this.ch;
    if (!ch) return;
    const r = e.currentTarget.getBoundingClientRect();
    const mod = !ch.special && auth && ch.isMod;
    const room = ch.room;
    const run = cmd => () => this.send('/' + cmd, false);
    const on = (flag, offWord, onWord) => (flag ? offWord : onWord);
    const followers = room['followers-only'] && room['followers-only'] !== '-1';
    showMenu([
      !ch.special && { label: 'Open channel on Twitch', fn: () => window.open(`https://www.twitch.tv/${ch.name}`, '_blank', 'noopener') },
      ch.kick && { label: 'Open channel on Kick', fn: () => window.open(`https://kick.com/${ch.kick.slug}`, '_blank', 'noopener') },
      !ch.special && (ch.kick
        ? { label: `Unlink Kick chat (${ch.kick.slug})`, fn: () => unlinkKick(ch) }
        : { label: 'Link a Kick chat…', fn: () => promptKick(this, { clientX: r.left, clientY: r.bottom }) }),
      { label: 'Search messages (Ctrl+F)', fn: () => this.openSearch() },
      mod && hasScope('moderator:read:chatters') && { label: 'Viewer list', fn: () => openViewers(this, { clientX: r.left, clientY: r.bottom }) },
      !ch.special && ch.id && { label: 'Reload emotes and badges', fn: () => loadChannelData(ch) },
      { label: 'Clear messages (only for you)', fn: () => { ch.history = []; ch.splits.forEach(s => s.rerender()); } },
      mod && '-',
      mod && { label: on(Number(room.slow) > 0, 'Turn off slow mode', 'Turn on slow mode'), fn: run(Number(room.slow) > 0 ? 'slowoff' : 'slow') },
      mod && { label: on(room['emote-only'] === '1', 'Turn off emote-only', 'Turn on emote-only'), fn: run(room['emote-only'] === '1' ? 'emoteonlyoff' : 'emoteonly') },
      mod && { label: on(room['subs-only'] === '1', 'Turn off subscribers-only', 'Turn on subscribers-only'), fn: run(room['subs-only'] === '1' ? 'subscribersoff' : 'subscribers') },
      mod && { label: on(followers, 'Turn off followers-only', 'Turn on followers-only'), fn: run(followers ? 'followersoff' : 'followers') },
      mod && { label: on(room.r9k === '1', 'Turn off unique chat', 'Turn on unique chat'), fn: run(room.r9k === '1' ? 'uniquechatoff' : 'uniquechat') },
    ], r.left, r.bottom);
  }

  /* ---------- composing ---------- */

  setReply(msg) {
    this.replyTo = msg;
    this.replyBar.replaceChildren();
    this.replyBar.classList.toggle('on', !!msg);
    if (!msg) return;
    const cancel = el('button', null, 'Cancel');
    cancel.onclick = () => this.setReply(null);
    const who = msg.kind === 'whisper' && msg.outgoing ? msg.to : msg.name;
    this.replyBar.append(el('span', null, `Replying to @${who}: ${msg.text}`), cancel);
    this.input.focus();
  }

  insert(text) {
    const ta = this.input;
    const before = ta.value.slice(0, ta.selectionStart);
    const after = ta.value.slice(ta.selectionEnd);
    const pad = before && !before.endsWith(' ') ? ' ' : '';
    ta.value = before + pad + text + ' ' + after;
    ta.selectionStart = ta.selectionEnd = (before + pad + text + ' ').length;
    this.updateCount();
    ta.focus();
  }

  complete(dir) {
    if (!this.ch) return false;
    const ta = this.input;
    if (!this.comp) {
      const pos = ta.selectionStart;
      const start = ta.value.lastIndexOf(' ', pos - 1) + 1;
      const word = ta.value.slice(start, pos);
      if (!word) return false;
      const at = word.startsWith('@');
      const q = (at ? word.slice(1) : word).toLowerCase();
      const names = [...this.ch.chatters.values()].map(n => (at ? '@' : '') + n);
      const emotes = at ? [] : [...userEmotes.keys(), ...this.ch.emotes.keys(), ...globalEmotes.keys()];
      const pool = [...new Set([...emotes, ...names])]
        .filter(x => x.replace(/^@/, '').toLowerCase().startsWith(q))
        .sort((a, b) => a.length - b.length || a.localeCompare(b));
      if (!pool.length) return false;
      this.comp = { start, end: pos, pool, i: dir > 0 ? -1 : 0 };
    }
    const c = this.comp;
    c.i = (c.i + dir + c.pool.length) % c.pool.length;
    const pick = c.pool[c.i] + ' ';
    ta.value = ta.value.slice(0, c.start) + pick + ta.value.slice(c.end);
    c.end = c.start + pick.length;
    ta.selectionStart = ta.selectionEnd = c.end;
    return true;
  }

  async send(raw, remember = true) {
    const text = raw.replace(/\s+/g, ' ').trim();
    if (!text || !this.ch || !auth) return;
    if (remember) {
      this.sent.push(text);
      if (this.sent.length > 50) this.sent.shift();
      this.sentIdx = this.sent.length;
    }

    try {
      if (text.startsWith('/')) {
        const [cmd, ...args] = text.slice(1).split(' ');
        const fn = commands[cmd.toLowerCase()];
        if (!fn) throw new Error(`Unknown command /${cmd}. Type /help for the list.`);
        await fn(this, args);
        return;
      }
      if (this.ch.name === '/whispers') {
        if (!this.replyTo) throw new Error('Reply to a whisper, or use /w name message.');
        const to = this.replyTo.outgoing ? this.replyTo.to : this.replyTo.login;
        this.setReply(null);
        await this.whisper(to, text);
        return;
      }
      this.post(text);
    } catch (err) {
      this.notice(err.message);
    }
  }

  post(text, action = false) {
    if (!text) return;
    let out = text;
    // Twitch drops a message identical to your last one, so nudge repeats with an invisible tag character
    if (text === this.lastText && Date.now() - this.lastAt < 30000) out += ' \u{E0000}';
    this.lastText = text;
    this.lastAt = Date.now();

    const replyTag = this.replyTo && !this.replyTo.id.startsWith('local-') ? `@reply-parent-msg-id=${this.replyTo.id} ` : '';
    const payload = action ? `\x01ACTION ${out}\x01` : out;
    if (!irc.send(`${replyTag}PRIVMSG #${this.ch.name} :${payload}`)) {
      throw new Error('Not connected to chat right now. Try again in a moment.');
    }

    const me = this.ch.me;
    const msg = makeMsg(this.ch, { ...me, id: '', emotes: '', 'user-id': auth.id, 'display-name': me['display-name'] || auth.login }, auth.login, text, { action, local: true });
    if (this.replyTo) {
      msg.reply = { name: this.replyTo.name, body: this.replyTo.text };
      msg.replyParentId = this.replyTo.id;
      msg.threadId = this.replyTo.threadId || this.replyTo.id;
    }
    this.setReply(null);
    remember(this.ch, msg);
    publish(this.ch, { kind: 'add', msg });
  }

  async whisper(login, text) {
    if (!text) throw new Error('Usage: /w <user> <message>');
    const id = await this.userId(login);
    await helix('POST', `/whispers?from_user_id=${auth.id}&to_user_id=${id}`, { message: text });
    addWhisper({ login: auth.login, name: auth.login, userId: auth.id, to: login, text, outgoing: true });
  }

  async act(name, msg) {
    if (name === 'reply') return this.setReply(msg);
    const src = msg.origin || this.ch;
    try {
      if (name === 'delete') await helix('DELETE', `/moderation/chat?broadcaster_id=${src.id}&moderator_id=${auth.id}&message_id=${msg.id}`);
      if (name === 'timeout') await modBan(src, msg.userId, 600);
      if (name === 'ban') await modBan(src, msg.userId);
      if (name === 'am-allow' || name === 'am-deny') {
        const allow = name === 'am-allow';
        await helix('POST', '/moderation/automod/message', { user_id: auth.id, msg_id: msg.amId, action: allow ? 'ALLOW' : 'DENY' });
        msg.resolved = allow ? 'Allowed' : 'Denied';
        src.splits.forEach(s => s.update(msg));
      }
    } catch (err) {
      this.notice(err.message);
    }
  }

  async userId(login) {
    const known = this.ch?.history.findLast(m => m.login === login && m.userId);
    if (known) return known.userId;
    const r = await helix('GET', `/users?login=${encodeURIComponent(login)}`);
    if (!r.data[0]) throw new Error(`There's no Twitch user named ${login}.`);
    return r.data[0].id;
  }

  async timeout(login, seconds, reason, ch = this.ch) {
    try { await modBan(ch, await this.userId(login), seconds, reason); } catch (err) { this.notice(err.message); }
  }

  async unban(login, ch = this.ch) {
    try {
      const id = await this.userId(login);
      await helix('DELETE', `/moderation/bans?broadcaster_id=${ch.id}&moderator_id=${auth.id}&user_id=${id}`);
      this.notice(`${login} was unbanned.`);
    } catch (err) {
      this.notice(err.message);
    }
  }

  destroy() {
    if (this.ch) releaseChannel(this.ch, this);
    this.root.remove();
    if (focusedSplit === this) focusedSplit = null;
    if (pickerSplit === this) closePicker();
  }
}

async function modBan(ch, userId, duration, reason) {
  if (!ch?.id) throw new Error('Still connecting to this channel.');
  const data = { user_id: userId };
  if (duration) data.duration = duration;
  if (reason) data.reason = reason;
  await helix('POST', `/moderation/bans?broadcaster_id=${ch.id}&moderator_id=${auth.id}`, { data });
}

/* ---------- commands ---------- */

function need(args, usage) {
  if (!args[0]) throw new Error('Usage: ' + usage);
  return args[0].replace(/^@/, '').toLowerCase();
}

function inChannel(s) {
  if (s.ch.special) throw new Error('Use that command in a channel split.');
  if (!s.ch.id) throw new Error('Still connecting to this channel.');
  return s.ch;
}

function chatSetting(body, done) {
  return async s => {
    const ch = inChannel(s);
    await helix('PATCH', `/chat/settings?broadcaster_id=${ch.id}&moderator_id=${auth.id}`, body);
    s.notice(done);
  };
}

function announce(color) {
  return async (s, args) => {
    const ch = inChannel(s);
    if (!args.length) throw new Error('Usage: /announce <message>');
    await helix('POST', `/chat/announcements?broadcaster_id=${ch.id}&moderator_id=${auth.id}`, { message: args.join(' '), color });
  };
}

function userAction(method, path, usage, done) {
  return async (s, args) => {
    const ch = inChannel(s);
    const user = need(args, usage);
    const id = await s.userId(user);
    await helix(method, path(ch, id), null);
    s.notice(done(user));
  };
}

const commands = {
  me: (s, a) => { inChannel(s); s.post(a.join(' '), true); },
  w: (s, a) => s.whisper(need(a, '/w <user> <message>'), a.slice(1).join(' ')),
  timeout: (s, a) => {
    const user = need(a, '/timeout <user> [10m] [reason]');
    const secs = parseDuration(a[1]);
    return s.timeout(user, secs ?? 600, a.slice(secs == null ? 1 : 2).join(' '), inChannel(s));
  },
  ban: (s, a) => s.timeout(need(a, '/ban <user> [reason]'), 0, a.slice(1).join(' '), inChannel(s)),
  unban: (s, a) => s.unban(need(a, '/unban <user>'), inChannel(s)),
  warn: async (s, a) => {
    const ch = inChannel(s);
    const user = need(a, '/warn <user> <reason>');
    const reason = a.slice(1).join(' ');
    if (!reason) throw new Error('Usage: /warn <user> <reason>');
    await helix('POST', `/moderation/warnings?broadcaster_id=${ch.id}&moderator_id=${auth.id}`, { data: { user_id: await s.userId(user), reason } });
    s.notice(`Warned ${user}.`);
  },
  clear: async s => {
    const ch = inChannel(s);
    await helix('DELETE', `/moderation/chat?broadcaster_id=${ch.id}&moderator_id=${auth.id}`);
  },
  slow: (s, a) => {
    const secs = Math.min(120, Math.max(3, parseDuration(a[0]) ?? 30));
    return chatSetting({ slow_mode: true, slow_mode_wait_time: secs }, `Slow mode on (${secs}s).`)(s);
  },
  slowoff: chatSetting({ slow_mode: false }, 'Slow mode off.'),
  emoteonly: chatSetting({ emote_mode: true }, 'Emote-only mode on.'),
  emoteonlyoff: chatSetting({ emote_mode: false }, 'Emote-only mode off.'),
  subscribers: chatSetting({ subscriber_mode: true }, 'Subscriber-only mode on.'),
  subscribersoff: chatSetting({ subscriber_mode: false }, 'Subscriber-only mode off.'),
  uniquechat: chatSetting({ unique_chat_mode: true }, 'Unique chat on.'),
  uniquechatoff: chatSetting({ unique_chat_mode: false }, 'Unique chat off.'),
  followers: (s, a) => {
    const mins = Math.round((parseDuration(a[0]) ?? 0) / 60);
    return chatSetting({ follower_mode: true, follower_mode_duration: mins }, `Followers-only mode on${mins ? ` (${mins}m)` : ''}.`)(s);
  },
  followersoff: chatSetting({ follower_mode: false }, 'Followers-only mode off.'),
  announce: announce('primary'),
  announceblue: announce('blue'),
  announcegreen: announce('green'),
  announceorange: announce('orange'),
  announcepurple: announce('purple'),
  shoutout: userAction('POST', (ch, id) => `/chat/shoutouts?from_broadcaster_id=${ch.id}&to_broadcaster_id=${id}&moderator_id=${auth.id}`, '/shoutout <user>', u => `Shouted out ${u}.`),
  mod: userAction('POST', (ch, id) => `/moderation/moderators?broadcaster_id=${ch.id}&user_id=${id}`, '/mod <user>', u => `${u} is now a moderator.`),
  unmod: userAction('DELETE', (ch, id) => `/moderation/moderators?broadcaster_id=${ch.id}&user_id=${id}`, '/unmod <user>', u => `${u} is no longer a moderator.`),
  vip: userAction('POST', (ch, id) => `/channels/vips?broadcaster_id=${ch.id}&user_id=${id}`, '/vip <user>', u => `${u} is now a VIP.`),
  unvip: userAction('DELETE', (ch, id) => `/channels/vips?broadcaster_id=${ch.id}&user_id=${id}`, '/unvip <user>', u => `${u} is no longer a VIP.`),
  raid: userAction('POST', (ch, id) => `/raids?from_broadcaster_id=${ch.id}&to_broadcaster_id=${id}`, '/raid <channel>', u => `Raid to ${u} started.`),
  unraid: async s => {
    const ch = inChannel(s);
    await helix('DELETE', `/raids?broadcaster_id=${ch.id}`);
    s.notice('Raid cancelled.');
  },
  block: async (s, a) => {
    const user = need(a, '/block <user>');
    await helix('PUT', `/users/blocks?target_user_id=${await s.userId(user)}`);
    s.notice(`Blocked ${user}.`);
  },
  unblock: async (s, a) => {
    const user = need(a, '/unblock <user>');
    await helix('DELETE', `/users/blocks?target_user_id=${await s.userId(user)}`);
    s.notice(`Unblocked ${user}.`);
  },
  color: async (s, a) => {
    if (!a[0]) throw new Error('Usage: /color <name or #hex>');
    await helix('PUT', `/chat/color?user_id=${auth.id}&color=${encodeURIComponent(a[0])}`);
    s.notice(`Your color is now ${a[0]}.`);
  },
  marker: async (s, a) => {
    const ch = inChannel(s);
    await helix('POST', '/streams/markers', { user_id: ch.id, description: a.join(' ').slice(0, 140) });
    s.notice('Stream marker added.');
  },
  settitle: async (s, a) => {
    const ch = inChannel(s);
    if (!a.length) throw new Error('Usage: /settitle <title>');
    await helix('PATCH', `/channels?broadcaster_id=${ch.id}`, { title: a.join(' ') });
    s.notice('Title updated.');
  },
  setgame: async (s, a) => {
    const ch = inChannel(s);
    if (!a.length) throw new Error('Usage: /setgame <category>');
    const r = await helix('GET', `/search/categories?first=1&query=${encodeURIComponent(a.join(' '))}`);
    const game = r.data[0];
    if (!game) throw new Error(`No category matches "${a.join(' ')}".`);
    await helix('PATCH', `/channels?broadcaster_id=${ch.id}`, { game_id: game.id });
    s.notice(`Category set to ${game.name}.`);
  },
  clip: async s => {
    const ch = inChannel(s);
    const r = await helix('POST', `/clips?broadcaster_id=${ch.id}`);
    s.notice(`Clip created: ${r.data[0].edit_url}`);
  },
  chatters: async s => {
    const ch = inChannel(s);
    const r = await helix('GET', `/chat/chatters?broadcaster_id=${ch.id}&moderator_id=${auth.id}&first=1`);
    s.notice(`${r.total.toLocaleString()} people in chat.`);
  },
  user: (s, a) => openCard(s, need(a, '/user <name>'), { clientX: innerWidth / 2 - 160, clientY: 60 }),
  help: s => s.notice('Commands: /me /w /timeout /ban /unban /warn /clear /slow /slowoff /emoteonly /emoteonlyoff /subscribers /subscribersoff /followers /followersoff /uniquechat /uniquechatoff /announce (blue, green, orange, purple) /shoutout /mod /unmod /vip /unvip /raid /unraid /block /unblock /color /marker /settitle /setgame /clip /chatters /user'),
};
commands.whisper = commands.w;
commands.untimeout = commands.unban;
commands.so = commands.shoutout;
commands.usercard = commands.user;
commands.r9kbeta = commands.uniquechat;
commands.r9kbetaoff = commands.uniquechatoff;
