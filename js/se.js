// StreamElements alerts (follows, subs, tips and the rest) through their Astro socket
const SE_WS = 'wss://astro.streamelements.com';
let se = null;

function seSync() {
  const token = (settings.seToken || '').trim();
  if (se && se.token === token) return;
  se?.stop();
  se = token ? new SeSocket(token) : null;
}

function seTarget() {
  const want = (settings.seChannel || '').trim().toLowerCase().replace(/^#/, '') || auth?.login || dockChannels[0];
  return channels.get(want) || channels.values().next().value || null;
}

function seNotice(text) {
  const ch = seTarget();
  if (ch) channelNotice(ch, text);
}

class SeSocket {
  constructor(token) {
    this.token = token;
    this.retry = 1000;
    this.stopped = false;
    this.dropped = false;
    this.connect(SE_WS);
  }

  connect(url) {
    const ws = this.ws = new WebSocket(url);
    ws.onmessage = e => {
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.type === 'welcome') {
        if (url !== SE_WS) {
          this.retry = 1000;
          return;
        }
        ws.send(JSON.stringify({
          type: 'subscribe',
          nonce: 'activities',
          data: { topic: 'channel.activities', token: this.token, token_type: this.token.split('.').length === 3 ? 'jwt' : 'apikey' },
        }));
      } else if (m.type === 'response') {
        if (m.error) {
          if (m.error === 'rate_limit_exceeded') return;
          seNotice(`StreamElements didn't accept that token (${m.data?.message || m.error}). Check it in Settings.`);
          this.stop();
          return;
        }
        if (this.dropped) seNotice('Reconnected to StreamElements.');
        this.dropped = false;
        this.retry = 1000;
      } else if (m.type === 'reconnect' && m.data?.reconnect_token) {
        this.ws = null;
        ws.close();
        this.connect(`${SE_WS}/?reconnect_token=${encodeURIComponent(m.data.reconnect_token)}`);
      } else if (m.type === 'message' && m.topic === 'channel.activities') {
        onActivity(m.data || {});
      }
    };
    ws.onclose = () => {
      if (this.ws !== ws || this.stopped) return;
      if (!this.dropped) seNotice('Lost the connection to StreamElements. Reconnecting…');
      this.dropped = true;
      setTimeout(() => { if (!this.stopped) this.connect(SE_WS); }, this.retry);
      this.retry = Math.min(this.retry * 2, 60000);
    };
  }

  stop() {
    this.stopped = true;
    const ws = this.ws;
    this.ws = null;
    ws?.close();
  }
}

/* ---------- turning activities into chat lines ---------- */

const PROVIDERS = { kick: 'Kick', youtube: 'YouTube', x: 'X', fourthwall: 'Fourthwall' };
// Twitch chat already announces these, so StreamElements copies would be doubles
const TWITCH_DUPES = new Set(['subscriber', 'communityGiftPurchase', 'raid', 'cheer', 'channelPointsRedemption', 'redemption']);
const recentGifters = new Map();

function money(amount, currency) {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'USD' }).format(amount);
  } catch {
    return `${amount} ${currency || ''}`.trim();
  }
}

function tierName(tier) {
  if (tier === 'prime') return 'Prime';
  const n = Number(tier) / 1000;
  return n >= 1 ? `tier ${n}` : '';
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function activityLine(type, d) {
  const who = d.displayName || d.username || 'Someone';
  const amt = Number(d.amount) || 0;
  switch (type) {
    case 'follow':
    case 'follower':
      return `${who} followed`;
    case 'subscriber': {
      const tier = tierName(d.tier);
      if (d.gifted) return `${d.sender || 'Someone'} gifted ${tier ? `a ${tier}` : 'a'} sub to ${who}`;
      if (d.tier === 'prime') return `${who} subscribed with Prime${amt > 1 ? ` for ${plural(amt, 'month')}` : ''}`;
      return `${who} subscribed${tier && tier !== 'tier 1' ? ` at ${tier}` : ''}${amt > 1 ? ` for ${plural(amt, 'month')}` : ''}`;
    }
    case 'communityGiftPurchase':
      return `${who} gifted ${plural(amt || 1, 'sub')}`;
    case 'tip':
      return `${who} tipped ${money(amt, d.currency)}`;
    case 'charityCampaignDonation':
      return `${who} donated ${money(amt, d.currency)} to charity`;
    case 'cheer':
      return `${who} cheered ${plural(amt, 'bit')}`;
    case 'raid':
      return `${who} raided with ${plural(amt, 'viewer')}`;
    case 'host':
      return `${who} hosted with ${plural(amt, 'viewer')}`;
    case 'merch':
    case 'purchase':
      return `${who} bought merch${d.items?.length ? `: ${d.items.map(i => i.name).filter(Boolean).join(', ')}` : ''}`;
    case 'channelPointsRedemption':
    case 'redemption':
      return `${who} redeemed ${d.redemption || d.item || 'a reward'}`;
    case 'sponsor':
    case 'fan':
    case 'supporter':
      return `${who} became a member`;
    case 'superchat':
      return `${who} sent a Super Chat for ${money(amt, d.currency)}`;
    case 'stars':
      return `${who} sent ${plural(amt, 'star')}`;
    case 'hypetrainStart':
      return 'A hype train started';
    case 'hypetrainEnd':
      return `The hype train ended${d.level ? ` at level ${d.level}` : ''}`;
    case 'hypetrainProgress':
    case 'sessionEventsCount':
      return null;
    default:
      return `${who}: ${type}`;
  }
}

function onActivity(a) {
  const type = a.type;
  const d = a.data || {};
  const provider = (a.provider || 'twitch').toLowerCase();
  if (provider === 'twitch' && TWITCH_DUPES.has(type) && !settings.seTwitchDupes) return;
  // a linked Kick chat already announces its own subs
  if (provider === 'kick' && seTarget()?.kick && (type === 'subscriber' || type === 'communityGiftPurchase')) return;

  // a community gift also fires one subscriber event per recipient
  if (type === 'communityGiftPurchase') recentGifters.set((d.username || '').toLowerCase(), Date.now());
  if (type === 'subscriber' && d.gifted && Date.now() - (recentGifters.get((d.sender || '').toLowerCase()) || 0) < 15000) return;

  let line = activityLine(type, d);
  if (!line) return;
  if (PROVIDERS[provider]) line += ` on ${PROVIDERS[provider]}`;

  const ch = seTarget();
  if (!ch) return;
  const msg = {
    id: 'se-' + (a._id || a.activityId || ++localId),
    kind: 'alert',
    platform: provider === 'kick' ? 'kick' : null,
    origin: ch,
    login: (d.username || '').toLowerCase(),
    name: d.displayName || d.username || '',
    system: line,
    text: typeof d.message === 'string' ? d.message : '',
    emotes: '',
    badges: '',
    time: Date.parse(a.createdAt) || Date.now(),
  };
  if (ch.history.some(m => m.id === msg.id)) return;
  publish(ch, { kind: 'add', msg });
  if (settings.alertSound) ping(523);
}
