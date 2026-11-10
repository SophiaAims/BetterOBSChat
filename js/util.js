const CLIENT_ID = 'ik78pxg6egx6csamogpbx2to4tmr93';
const REDIRECT_URI = location.origin + location.pathname;
const SCOPES = [
  'chat:read', 'chat:edit',
  'user:read:emotes', 'user:read:whispers', 'user:manage:whispers',
  'user:manage:blocked_users', 'user:manage:chat_color',
  'moderator:manage:banned_users', 'moderator:manage:chat_messages', 'moderator:manage:chat_settings',
  'moderator:manage:announcements', 'moderator:manage:automod', 'moderator:manage:shoutouts',
  'moderator:manage:warnings', 'moderator:read:chatters',
  'channel:manage:moderators', 'channel:manage:vips', 'channel:manage:raids',
  'channel:manage:broadcast', 'channel:read:redemptions', 'clips:edit',
];
const DEFAULT_COLORS = ['#FF0000', '#0000FF', '#008000', '#B22222', '#FF7F50', '#9ACD32', '#FF4500', '#2E8B57', '#DAA520', '#D2691E', '#5F9EA0', '#1E90FF', '#FF69B4', '#8A2BE2', '#00FF7F'];

const store = {
  get(key, fallback) {
    try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : fallback; } catch { return fallback; }
  },
  set(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); } catch {}
  },
};

// Twitch sends us back here with the token in the hash, so grab it before anything reads the URL
let pendingToken = null;
if (/access_token|error/.test(location.hash)) {
  const h = new URLSearchParams(location.hash.slice(1));
  const expected = sessionStorage.getItem('oauth-state');
  if (h.get('access_token') && expected && h.get('state') === expected) pendingToken = h.get('access_token');
  history.replaceState(null, '', location.pathname + (sessionStorage.getItem('oauth-return') || ''));
  sessionStorage.removeItem('oauth-state');
  sessionStorage.removeItem('oauth-return');
}

const defaults = {
  direction: 'up',
  usernames: 'both',
  fontSize: 14,
  emoteScale: 1,
  timestamps: true,
  badges: true,
  alternateRows: false,
  collapseLong: true,
  hideDeleted: false,
  lastRead: true,
  showCharCount: true,
  limit: 600,
  pauseOnHover: false,
  modButtons: true,
  sharedChat: true,
  platformMarks: true,
  seToken: '',
  seChannel: '',
  seTwitchDupes: false,
  alertSound: true,
  highlights: [],
  highlightUsers: [],
  ignored: [],
  blockedPhrases: [],
  mentionSound: true,
  liveSound: false,
  flashTitle: true,
  nicknames: {},
};
let settings = { ...defaults, ...store.get('settings', {}) };
const saveSettings = () => store.set('settings', settings);
let auth = store.get('auth', null);

const params = new URLSearchParams(location.search);
const dockChannels = (params.get('channel') || params.get('channels') || '')
  .toLowerCase().split(',').map(s => s.trim().replace(/^#/, '')).filter(Boolean);
const dockMode = dockChannels.length > 0;
const orderOverride = { top: 'down', bottom: 'up' }[params.get('order')] || null;
const readOnly = params.has('readonly');
const transparent = params.has('transparent');

function newestOnTop() {
  return (orderOverride || settings.direction) === 'down';
}

const $ = (sel, root = document) => root.querySelector(sel);

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text != null) e.textContent = text;
  return e;
}

async function getJSON(url, opts) {
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${res.status} from ${new URL(url).host}`);
  return res.json();
}

function hasClientId() {
  return CLIENT_ID && !CLIENT_ID.startsWith('PUT_');
}

function hasScope(scope) {
  return !!auth?.scopes?.includes(scope);
}

async function helix(method, path, body) {
  if (!auth) throw new Error('Log in to do that.');
  const headers = { 'Client-Id': CLIENT_ID, Authorization: 'Bearer ' + auth.token };
  if (body) headers['Content-Type'] = 'application/json';
  const res = await fetch('https://api.twitch.tv/helix' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  if (!res.ok) {
    let msg = '';
    try { msg = (await res.json()).message || ''; } catch {}
    const scopeProblem = /scope/i.test(msg);
    if (res.status === 401 && !scopeProblem) {
      expireLogin();
      throw new Error('Your Twitch login expired. Log in again.');
    }
    if (scopeProblem) msg += ' Log out and back in to grant the newer permissions.';
    throw new Error(msg || `Twitch said no (${res.status}).`);
  }
  if (res.status === 204) return null;
  return res.json().catch(() => null);
}

/* ---------- login ---------- */

function login() {
  if (!hasClientId()) {
    openSettings('Login needs a Twitch client ID. Add yours at the top of js/util.js.');
    return;
  }
  const state = crypto.randomUUID();
  sessionStorage.setItem('oauth-state', state);
  sessionStorage.setItem('oauth-return', location.search);
  const q = new URLSearchParams({ response_type: 'token', client_id: CLIENT_ID, redirect_uri: REDIRECT_URI, scope: SCOPES.join(' '), state });
  location.href = 'https://id.twitch.tv/oauth2/authorize?' + q;
}

function logout() {
  if (auth && hasClientId()) {
    fetch('https://id.twitch.tv/oauth2/revoke', { method: 'POST', body: new URLSearchParams({ client_id: CLIENT_ID, token: auth.token }) }).catch(() => {});
  }
  auth = null;
  store.set('auth', null);
  location.reload();
}

function expireLogin(text = 'Your Twitch login expired. Log in again to chat.') {
  if (!auth) return;
  auth = null;
  store.set('auth', null);
  updateAccount();
  forEachSplit(s => s.updateComposer());
  broadcast(text);
  eventsub?.ws?.close();
  irc?.reconnect();
}

async function setToken(token) {
  const v = await getJSON('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + token } });
  auth = { token, login: v.login, id: v.user_id, scopes: v.scopes || [] };
  store.set('auth', auth);
}

async function validate() {
  if (!auth) return;
  try {
    const res = await fetch('https://id.twitch.tv/oauth2/validate', { headers: { Authorization: 'OAuth ' + auth.token } });
    if (res.status === 401) return expireLogin();
    const v = await res.json();
    auth.scopes = v.scopes || [];
    store.set('auth', auth);
  } catch {}
}

/* ---------- small helpers ---------- */

function fmtTime(ms) {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

function fmtDuration(s) {
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.round(s / 60)}m`;
  if (s < 86400) return `${Math.round(s / 3600)}h`;
  return `${Math.round(s / 86400)}d`;
}

function fmtUptime(iso) {
  const mins = Math.floor((Date.now() - new Date(iso)) / 60000);
  return mins < 60 ? `${mins}m` : `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m`;
}

function parseDuration(str) {
  const m = /^(\d+)([smhdw]?)$/i.exec(str || '');
  if (!m) return null;
  return Number(m[1]) * { '': 1, s: 1, m: 60, h: 3600, d: 86400, w: 604800 }[m[2].toLowerCase()];
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// "/pattern/" is treated as a regex, anything else as a whole word or phrase
const patternCache = new Map();
function matches(pattern, text) {
  let re = patternCache.get(pattern);
  if (!re) {
    try {
      re = /^\/.+\/$/.test(pattern)
        ? new RegExp(pattern.slice(1, -1), 'i')
        : new RegExp(`(^|[^\\w])${escapeRe(pattern)}($|[^\\w])`, 'i');
    } catch {
      re = /(?!)/;
    }
    patternCache.set(pattern, re);
  }
  return re.test(text);
}

function copyText(text) {
  const fallback = () => {
    const ta = el('textarea');
    ta.value = text;
    document.body.append(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  };
  if (navigator.clipboard) navigator.clipboard.writeText(text).catch(fallback);
  else fallback();
}

let audioCtx = null;
function ping(freq = 880) {
  try {
    audioCtx ||= new AudioContext();
    const now = audioCtx.currentTime;
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.2, now + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.35);
    osc.connect(gain).connect(audioCtx.destination);
    osc.start();
    osc.stop(now + 0.4);
  } catch {}
}

let unseenMentions = 0;
const baseTitle = document.title;
function bumpTitle() {
  if (!settings.flashTitle || !document.hidden) return;
  unseenMentions++;
  document.title = `(${unseenMentions}) ${baseTitle}`;
}
document.addEventListener('visibilitychange', () => {
  if (document.hidden) return;
  unseenMentions = 0;
  document.title = baseTitle;
});
