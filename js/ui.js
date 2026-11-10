const pages = [];
let activePage = null;
let focusedSplit = null;

function forEachSplit(fn) {
  for (const p of pages) p.splits.forEach(fn);
}

function broadcast(text) {
  const seen = new Set();
  forEachSplit(s => {
    if (!s.ch || seen.has(s.ch)) return;
    seen.add(s.ch);
    channelNotice(s.ch, text);
  });
}

function rerenderAll() {
  forEachSplit(s => s.rerender());
}

function setFocused(split) {
  if (focusedSplit === split) return;
  focusedSplit?.root.classList.remove('focused');
  focusedSplit = split;
  split.root.classList.add('focused');
}

/* ---------- tabs and pages ---------- */

function createPage(tab) {
  const page = { name: tab.name || '', el: el('div', 'page'), splits: [], unread: false, mentioned: false };
  page.el.hidden = true;
  $('#splits').append(page.el);
  pages.push(page);
  for (const name of tab.splits.length ? tab.splits : ['']) {
    const s = new Split(page, name);
    page.splits.push(s);
    page.el.append(s.root);
  }
  return page;
}

function addSplit(page, channel = '', after = null) {
  const s = new Split(page, channel);
  const idx = after ? page.splits.indexOf(after) + 1 : page.splits.length;
  page.splits.splice(idx, 0, s);
  if (after) after.root.after(s.root);
  else page.el.append(s.root);
  s.focus();
  renderTabs();
  syncLayout();
  return s;
}

function closeSplit(s) {
  const page = s.page;
  s.destroy();
  page.splits.splice(page.splits.indexOf(s), 1);
  if (!page.splits.length) addSplit(page);
  renderTabs();
  syncLayout();
}

function selectTab(page) {
  if (activePage && activePage !== page) activePage.splits.forEach(s => { s.markPending = true; });
  activePage = page;
  page.unread = page.mentioned = false;
  for (const p of pages) p.el.hidden = p !== page;
  renderTabs();
  syncLayout();
  page.splits.forEach(s => { if (!s.paused) s.stick(); });
}

function newTab() {
  const page = createPage({ name: '', splits: [''] });
  selectTab(page);
  page.splits[0].focus();
}

function closeTab(page) {
  const i = pages.indexOf(page);
  page.splits.forEach(s => s.destroy());
  page.el.remove();
  pages.splice(i, 1);
  if (!pages.length) return newTab();
  if (activePage === page) selectTab(pages[Math.max(0, i - 1)]);
  else { renderTabs(); syncLayout(); }
}

function tabLabel(page) {
  return page.name || page.splits.map(s => s.ch?.name).filter(Boolean).join(', ') || 'New tab';
}

function markTab(page) {
  page.tabEl?.classList.toggle('unread', page.unread);
  page.tabEl?.classList.toggle('mentioned', page.mentioned);
}

function renderTabs() {
  const bar = $('#tabs');
  bar.replaceChildren();
  for (const page of pages) {
    const tab = el('div', 'tab');
    tab.setAttribute('role', 'tab');
    tab.tabIndex = 0;
    tab.classList.toggle('active', page === activePage);
    if (page.splits.some(s => s.ch?.live)) tab.append(el('span', 'live-dot'));
    const label = el('span', null, tabLabel(page));
    const x = el('button', 'x', '×');
    x.title = 'Close tab';
    x.onclick = e => { e.stopPropagation(); closeTab(page); };
    tab.append(label, x);
    tab.onclick = () => { if (page !== activePage) selectTab(page); };
    tab.onkeydown = e => { if (e.key === 'Enter') selectTab(page); };
    tab.onauxclick = e => { if (e.button === 1) closeTab(page); };
    tab.ondblclick = () => renameTab(page, label);
    page.tabEl = tab;
    markTab(page);
    bar.append(tab);
  }
}

function renameTab(page, label) {
  const input = el('input');
  input.value = page.name;
  input.placeholder = tabLabel(page);
  input.onkeydown = e => {
    if (e.key === 'Enter') input.blur();
    if (e.key === 'Escape') { input.value = page.name; input.blur(); }
  };
  input.onblur = () => {
    page.name = input.value.trim();
    renderTabs();
    syncLayout();
  };
  input.onclick = e => e.stopPropagation();
  label.replaceWith(input);
  input.focus();
  input.select();
}

function syncLayout() {
  if (dockMode) return;
  store.set('layout', {
    tabs: pages.map(p => ({ name: p.name, splits: p.splits.map(s => s.ch?.name || '') })),
    active: Math.max(0, pages.indexOf(activePage)),
  });
}

/* ---------- popups ---------- */

const menu = $('#menu');
const panel = $('#panel');
const picker = $('#picker');
let pickerSplit = null;
let panelLogin = null;

function place(node, x, y) {
  const r = node.getBoundingClientRect();
  node.style.left = Math.max(8, Math.min(x, innerWidth - r.width - 8)) + 'px';
  node.style.top = Math.max(8, Math.min(y, innerHeight - r.height - 8)) + 'px';
}

function showMenu(items, x, y) {
  menu.replaceChildren();
  for (const item of items) {
    if (!item) continue;
    if (item === '-') {
      if (menu.lastChild && menu.lastChild.tagName !== 'HR') menu.append(el('hr'));
      continue;
    }
    const b = el('button', item.danger ? 'danger' : null, item.label);
    b.onclick = () => { closeMenu(); item.fn(); };
    menu.append(b);
  }
  if (menu.lastChild?.tagName === 'HR') menu.lastChild.remove();
  menu.hidden = false;
  place(menu, x, y);
}

function closeMenu() {
  menu.hidden = true;
}

function panelHeader(title, extra = []) {
  const head = el('div', 'panel-head');
  const h = el('strong', null, title);
  const close = el('button', 'icon-btn', '×');
  close.title = 'Close';
  close.onclick = closePanel;
  head.append(h, ...extra, close);
  return head;
}

function showPanel(nodes, ev) {
  panel.replaceChildren(...nodes);
  panel.hidden = false;
  place(panel, ev.clientX + 8, ev.clientY + 8);
}

function closePanel() {
  panel.hidden = true;
  panelLogin = null;
}

function openCard(split, login, ev, origin, platform) {
  const ch = origin || split.ch;
  if (!ch || !login) return;
  panelLogin = login;
  const kick = platform === 'kick';

  const msgs = ch.history.filter(m => m.login === login && m.kind !== 'notice' && (m.platform === 'kick') === kick);
  const last = msgs.at(-1);
  const name = last?.name || ch.chatters.get(login) || login;

  const head = el('div', 'card-head');
  const avatar = el('img', 'avatar');
  avatar.alt = '';
  const info = el('div', 'card-info');
  const link = el('a', 'card-name', settings.nicknames[login] ? `${settings.nicknames[login]} (${name})` : name);
  const kickSlug = msgs.findLast(m => m.slug)?.slug || login;
  link.href = kick ? `https://kick.com/${kickSlug}` : `https://www.twitch.tv/${login}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';
  link.style.color = userColor(login, last?.color || ch.colors.get(login));
  const where = kick ? ' on Kick' : '';
  const seen = el('div', 'card-meta', msgs.length ? `${msgs.length} message${msgs.length === 1 ? '' : 's'}${where} this session` : `No messages${where} this session`);
  const created = el('div', 'card-meta');
  const relation = el('div', 'card-meta');
  info.append(link, seen, created, relation);
  const close = el('button', 'icon-btn', '×');
  close.title = 'Close';
  close.onclick = closePanel;
  head.append(avatar, info, close);

  const actions = el('div', 'card-actions');
  const button = (row, label, fn, cls) => {
    const b = el('button', cls, label);
    b.onclick = fn;
    row.append(b);
    return b;
  };
  const toggleList = key => () => {
    const list = settings[key];
    settings[key] = list.includes(login) ? list.filter(x => x !== login) : [...list, login];
    saveSettings();
    rerenderAll();
    closePanel();
  };

  const usable = !split.input.disabled;
  if (usable && !split.ch.special) button(actions, 'Mention', () => { split.insert(`@${name}`); closePanel(); });
  if (auth && !kick && login !== auth.login) button(actions, 'Whisper', () => { split.input.value = `/w ${login} `; split.input.focus(); closePanel(); });
  button(actions, settings.highlightUsers.includes(login) ? 'Unhighlight' : 'Highlight', toggleList('highlightUsers'));
  button(actions, settings.ignored.includes(login) ? 'Unignore' : 'Ignore', toggleList('ignored'));
  const nickBtn = button(actions, 'Nickname', () => {
    const input = el('input', 'nick-input');
    input.placeholder = 'Nickname (empty to clear)';
    input.value = settings.nicknames[login] || '';
    input.onkeydown = e => {
      if (e.key !== 'Enter') return;
      const v = input.value.trim();
      if (v) settings.nicknames[login] = v;
      else delete settings.nicknames[login];
      saveSettings();
      rerenderAll();
      closePanel();
    };
    nickBtn.replaceWith(input);
    input.focus();
  });
  button(actions, 'Copy name', () => copyText(login));

  const nodes = [head, actions];
  if (auth && !kick && ch.isMod && !ch.special && login !== ch.name && login !== auth.login) {
    const mod = el('div', 'card-actions');
    for (const [label, secs] of [['1m', 60], ['10m', 600], ['1h', 3600], ['1d', 86400], ['1w', 604800]]) {
      button(mod, label, () => split.timeout(login, secs, '', ch));
    }
    button(mod, 'Ban', () => split.timeout(login, 0, '', ch), 'danger');
    button(mod, 'Unban', () => split.unban(login, ch));
    nodes.push(mod);
  }

  const log = el('div', 'card-log');
  if (msgs.length) msgs.slice(-50).forEach(m => log.append(renderMessage(m, ch)));
  else log.append(el('p', 'empty', 'Nothing from them yet.'));
  nodes.push(log);

  showPanel(nodes, ev);
  log.scrollTop = log.scrollHeight;

  if (kick) {
    kickChannelInfo(kickSlug).then(info => {
      if (panelLogin !== login) return;
      if (info?.user?.profile_pic) avatar.src = info.user.profile_pic;
      if (info?.followers_count != null) created.textContent = `${info.followers_count.toLocaleString()} followers on Kick`;
    });
    return;
  }

  getJSON(`https://api.ivr.fi/v2/twitch/user?login=${encodeURIComponent(login)}`).then(res => {
    const u = res?.[0];
    if (!u || panelLogin !== login) return;
    if (u.logo) avatar.src = u.logo;
    if (u.createdAt) created.textContent = `Account created ${new Date(u.createdAt).toLocaleDateString()}`;
  }).catch(() => {});

  if (!ch.special) {
    getJSON(`https://api.ivr.fi/v2/twitch/subage/${encodeURIComponent(login)}/${ch.name}`).then(r => {
      if (panelLogin !== login) return;
      const parts = [];
      if (r.followedAt) parts.push(`Following since ${new Date(r.followedAt).toLocaleDateString()}`);
      const months = r.cumulative?.months;
      if (months) parts.push(`subscribed ${months} month${months === 1 ? '' : 's'}`);
      relation.textContent = parts.join(', ');
    }).catch(() => {});
  }
}

function openThread(split, msg, ev) {
  const src = msg.origin || split.ch;
  const root = msg.threadId || msg.replyParentId;
  if (!root) return;
  const msgs = src.history.filter(m => m.id === root || m.threadId === root || m.replyParentId === root);
  const log = el('div', 'card-log');
  if (!msgs.some(m => m.id === root) && msg.reply) {
    log.append(el('p', 'empty', `Started by @${msg.reply.name}: ${msg.reply.body}`));
  }
  msgs.forEach(m => log.append(renderMessage(m, src)));
  showPanel([panelHeader('Reply thread'), log], ev);
  log.scrollTop = log.scrollHeight;
}

async function openViewers(split, ev) {
  const ch = split.ch;
  const filter = el('input', 'panel-filter');
  filter.placeholder = 'Filter viewers';
  const list = el('div', 'viewer-list');
  list.append(el('p', 'empty', 'Loading…'));
  showPanel([panelHeader(`Viewers in ${ch.name}`), filter, list], ev);
  try {
    const names = [];
    let after = '';
    do {
      const r = await helix('GET', `/chat/chatters?broadcaster_id=${ch.id}&moderator_id=${auth.id}&first=1000${after ? '&after=' + after : ''}`);
      names.push(...r.data.map(c => c.user_login));
      after = r.pagination?.cursor;
    } while (after && names.length < 5000);
    names.sort();
    const draw = () => {
      const q = filter.value.toLowerCase();
      const shown = names.filter(n => n.includes(q)).slice(0, 1000);
      list.replaceChildren(...shown.map(n => {
        const b = el('button', 'viewer', n);
        b.onclick = e => openCard(split, n, e);
        return b;
      }));
      if (!shown.length) list.append(el('p', 'empty', 'No one matches that.'));
    };
    filter.oninput = draw;
    draw();
    filter.focus();
  } catch (err) {
    list.replaceChildren(el('p', 'empty', err.message));
  }
}

function openPicker(split) {
  if (!split.ch) return;
  pickerSplit = split;
  const search = el('input', 'picker-search');
  search.placeholder = 'Search emotes';
  const body = el('div', 'picker-body');
  const groups = [
    ['Your Twitch emotes', userEmotes],
    [`${split.ch.name} emotes`, split.ch.special ? new Map() : split.ch.emotes],
    ['Global emotes', globalEmotes],
  ];
  const draw = () => {
    const q = search.value.toLowerCase();
    body.replaceChildren();
    for (const [title, map] of groups) {
      const list = [...map.values()].filter(e => !q || e.name.toLowerCase().includes(q));
      if (!list.length) continue;
      const grid = el('div', 'picker-grid');
      for (const e of list.slice(0, 600)) {
        const b = el('button');
        const img = emoteImg(e);
        img.loading = 'lazy';
        b.append(img);
        b.onclick = () => split.insert(e.name);
        grid.append(b);
      }
      body.append(el('div', 'picker-title', title), grid);
    }
    if (!body.children.length) body.append(el('p', 'empty', q ? 'No emotes match that.' : 'No emotes loaded yet.'));
  };
  search.oninput = draw;
  search.onkeydown = e => { if (e.key === 'Escape') { closePicker(); split.input.focus(); } };
  draw();
  picker.replaceChildren(search, body);
  picker.hidden = false;
  const r = split.pickerBtn.getBoundingClientRect();
  const pr = picker.getBoundingClientRect();
  place(picker, r.right - pr.width, r.top - pr.height - 6);
  search.focus();
}

function closePicker() {
  picker.hidden = true;
  pickerSplit = null;
}

document.addEventListener('mousedown', e => {
  if (!menu.hidden && !menu.contains(e.target)) closeMenu();
  if (!panel.hidden && !panel.contains(e.target) && !e.target.closest('.user, .mention-tag, .reply-ctx, #menu')) closePanel();
  if (!picker.hidden && !picker.contains(e.target) && !e.target.closest('.picker-btn')) closePicker();
});

/* ---------- settings ---------- */

const dialog = $('#settings');
const form = $('.settings-form');

function splitList(value, lower) {
  return value.split(',').map(x => x.trim()).filter(Boolean).map(x => (lower ? x.toLowerCase().replace(/^@/, '') : x));
}

function openSettings(note) {
  $('#settings-note').hidden = !note;
  $('#settings-note').textContent = note || '';
  $('#account-status').textContent = auth ? `Logged in as ${auth.login}` : 'Not logged in. You can read chat but not send messages.';
  $('#account-btn').textContent = auth ? 'Log out' : 'Log in with Twitch';

  for (const field of form.elements) {
    if (!(field.name in defaults)) continue;
    const v = settings[field.name];
    if (field.type === 'checkbox') field.checked = v;
    else if (Array.isArray(v)) field.value = v.join(', ');
    else field.value = v;
  }
  form.querySelectorAll('output[data-for]').forEach(o => { o.textContent = form.elements[o.dataset.for].value; });

  const first = activePage?.splits.find(s => s.ch && !s.ch.special)?.ch.name || 'yourchannel';
  const kick = kickSpecFor(first);
  $('#dock-url').value = `${location.origin}${location.pathname}?channel=${first}${kick ? '&kick=' + encodeURIComponent(kick) : ''}`;
  dialog.showModal();
}

form.addEventListener('input', e => {
  const out = form.querySelector(`output[data-for="${e.target.name}"]`);
  if (out) out.textContent = e.target.value;
});
$('#dock-url').onclick = e => e.target.select();
$('#account-btn').onclick = () => (auth ? logout() : login());

dialog.addEventListener('close', () => {
  if (dialog.returnValue !== 'save') return;
  for (const field of form.elements) {
    const key = field.name;
    if (!(key in defaults)) continue;
    if (field.type === 'checkbox') settings[key] = field.checked;
    else if (Array.isArray(defaults[key])) settings[key] = splitList(field.value, field.dataset.case !== 'keep');
    else if (typeof defaults[key] === 'number') settings[key] = Number(field.value) || defaults[key];
    else settings[key] = field.value;
  }
  settings.limit = Math.min(2000, Math.max(100, settings.limit));
  settings.seToken = settings.seToken.trim();
  saveSettings();
  applyAppearance();
  rerenderAll();
  seSync();
});

function applyAppearance() {
  const root = document.documentElement.style;
  root.setProperty('--fs', settings.fontSize + 'px');
  root.setProperty('--emote', Math.round(28 * settings.emoteScale) + 'px');
  const body = document.body.classList;
  body.toggle('dock', dockMode);
  body.toggle('alt-rows', settings.alternateRows);
  body.toggle('readonly', readOnly);
  body.toggle('transparent', transparent);
  body.toggle('newest-top', newestOnTop());
}

function updateAccount() {
  $('#account').textContent = auth ? auth.login : 'Log in';
  $('#account').title = auth ? 'Settings and account' : 'Log in with Twitch';
}

/* ---------- shortcuts and startup ---------- */

$('#new-tab').onclick = newTab;
$('#open-settings').onclick = () => openSettings();
$('#account').onclick = () => (auth ? openSettings() : login());

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (!menu.hidden) return closeMenu();
    if (!panel.hidden) return closePanel();
    if (!picker.hidden) return closePicker();
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyF' && focusedSplit?.ch) {
    e.preventDefault();
    focusedSplit.openSearch();
    return;
  }
  if ((e.ctrlKey || e.metaKey) && e.code === 'KeyE' && focusedSplit && !focusedSplit.input.disabled) {
    e.preventDefault();
    openPicker(focusedSplit);
    return;
  }
  if (!e.altKey || e.ctrlKey || e.metaKey) return;
  if (e.code === 'KeyN') {
    e.preventDefault();
    addSplit(activePage, '', focusedSplit?.page === activePage ? focusedSplit : null);
  } else if (e.code === 'KeyW' && focusedSplit) {
    e.preventDefault();
    closeSplit(focusedSplit);
  } else if (e.code === 'KeyT' && !dockMode) {
    e.preventDefault();
    newTab();
  } else if (/^Digit[1-9]$/.test(e.code)) {
    const page = pages[Number(e.code.slice(5)) - 1];
    if (page) { e.preventDefault(); selectTab(page); }
  }
});

async function init() {
  applyAppearance();

  if (pendingToken) await setToken(pendingToken).catch(() => {});
  else await validate();
  updateAccount();

  irc = new Irc();
  const layout = dockMode
    ? { tabs: [{ name: '', splits: dockChannels }], active: 0 }
    : store.get('layout', { tabs: [{ name: '', splits: [''] }], active: 0 });
  for (const tab of layout.tabs) createPage(tab);
  if (!pages.length) createPage({ name: '', splits: [''] });
  selectTab(pages[Math.min(layout.active || 0, pages.length - 1)]);

  loadGlobals().then(rerenderAll);
  if (auth) {
    loadUserEmotes();
    ensureEventSub();
    if (SCOPES.some(s => !hasScope(s))) {
      broadcast('Some features (whispers, AutoMod, emote picker and more) need newer permissions. Log out and back in from settings to turn them on.');
    }
  }
  seSync();
  setInterval(pollLive, 60 * 1000);
  setInterval(validate, 60 * 60 * 1000);
}

init();
