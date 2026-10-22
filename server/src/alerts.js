'use strict';
// Sends selected audit events to a webhook (Slack, Microsoft Teams, Google Chat,
// Discord or any HTTP endpoint). The JSON body carries both a human-readable
// "text" (understood by Slack/Teams/Chat) and the raw event.
const MAX_PER_MINUTE = 30;

function describe(e) {
  const who = e.username ? `${e.username}` : 'someone';
  switch (e.type) {
    case 'blocked':
      return `🚫 ${who} tried to open a blocked site: ${e.url}${e.detail ? ` (${e.detail})` : ''}`;
    case 'access.request':
      return `🙋 ${who} requests access to ${e.url}${e.detail ? ` — "${e.detail}"` : ''}`;
    case 'login.failed':
      return `⚠️ Failed K-Browser sign-in for "${who}" from ${e.ip || 'unknown IP'}`;
    case 'seat.denied':
      return `💺 ${who} could not open ${e.detail} — all seats in use`;
    case 'dlp.blocked':
      return `🛡️ ${who}: ${e.detail} on ${e.url}`;
    default:
      return `${e.type}: ${who}${e.detail ? ` — ${e.detail}` : ''}${e.url ? ` ${e.url}` : ''}`;
  }
}

function attachAlerts(audit, store, { post = defaultPost } = {}) {
  let windowStart = Date.now();
  let sent = 0;
  const listener = (e) => {
    const s = store.data.settings;
    if (!s.webhookUrl || !(s.webhookEvents || []).includes(e.type)) return;
    if (Date.now() - windowStart > 60000) {
      windowStart = Date.now();
      sent = 0;
    }
    if (++sent > MAX_PER_MINUTE) return;
    const text = `[${s.orgName}] ${describe(e)}`;
    post(s.webhookUrl, { text, content: text, event: e }).catch((err) => console.warn('webhook failed:', err.message));
  };
  audit.listeners.add(listener);
  return () => audit.listeners.delete(listener);
}

async function defaultPost(url, body) {
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(8000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
}

module.exports = { attachAlerts, describe };
