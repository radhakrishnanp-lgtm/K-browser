'use strict';
const { OVERRIDABLE_SETTINGS } = require('./store');
const { credentialMatches } = require('./match');

function userGroups(store, user) {
  return (user.groupIds || []).map((id) => store.get('groups', id)).filter(Boolean);
}

// Rules are ordered most specific first: user, then each group, then global.
// The first matching rule wins; the mode of the most specific level that sets
// one decides what happens to unmatched URLs.
function effectivePolicy(store, user) {
  const groups = userGroups(store, user);
  const tag = (rules, source) => (rules || []).filter((r) => r && r.pattern).map((r) => ({ ...r, source }));
  const rules = [
    ...tag(user.policy && user.policy.rules, 'user'),
    ...groups.flatMap((g) => tag(g.policy && g.policy.rules, `group:${g.name}`)),
    ...tag(store.data.policy.rules, 'global'),
  ];
  let mode = store.data.policy.mode || 'blocklist';
  const groupMode = groups.map((g) => g.policy && g.policy.mode).find((m) => m && m !== 'inherit');
  if (groupMode) mode = groupMode;
  if (user.policy && user.policy.mode && user.policy.mode !== 'inherit') mode = user.policy.mode;
  return { mode, rules };
}

function effectiveSettings(store, user) {
  const out = { ...store.data.settings };
  const layers = [...userGroups(store, user).map((g) => g.settings || {}), user.settings || {}];
  for (const layer of layers) {
    for (const key of OVERRIDABLE_SETTINGS) {
      if (layer[key] !== undefined && layer[key] !== null && layer[key] !== '') out[key] = layer[key];
    }
  }
  if (user.role === 'admin') out.isAdmin = true;
  return out;
}

function effectiveBookmarks(store, user) {
  const seen = new Set();
  const out = [];
  const add = (list) => {
    for (const b of list || []) {
      if (!b || !b.url || seen.has(b.url)) continue;
      seen.add(b.url);
      out.push({ title: b.title || b.url, url: b.url });
    }
  };
  add(store.data.bookmarks);
  for (const g of userGroups(store, user)) add(g.bookmarks);
  add(user.bookmarks);
  return out;
}

// Returns credentials the user may use, with a priority: direct > group > everyone.
function credentialsForUser(store, user) {
  const groupIds = new Set(user.groupIds || []);
  const out = [];
  for (const c of store.data.credentials) {
    if (c.enabled === false) continue;
    let priority = 0;
    if ((c.assignedUserIds || []).includes(user.id)) priority = 3;
    else if ((c.assignedGroupIds || []).some((g) => groupIds.has(g))) priority = 2;
    else if (c.everyone) priority = 1;
    if (priority) out.push({ credential: c, priority });
  }
  return out.sort((a, b) => b.priority - a.priority);
}

// Public (secret-free) description of a credential sent to browsers.
function publicCredential(c, priority) {
  return {
    id: c.id,
    name: c.name,
    match: c.match || [],
    loginUrl: c.loginUrl || '',
    autoFill: c.autoFill !== false,
    autoSubmit: !!c.autoSubmit,
    showOnNewTab: c.showOnNewTab !== false,
    hasTotp: !!c.totpEnc,
    priority,
  };
}

function credentialAllowedForUser(store, user, credentialId, url) {
  const entry = credentialsForUser(store, user).find((x) => x.credential.id === credentialId);
  if (!entry) return null;
  if (url && !credentialMatches(url, entry.credential)) return null;
  return entry.credential;
}

module.exports = {
  effectivePolicy,
  effectiveSettings,
  effectiveBookmarks,
  credentialsForUser,
  publicCredential,
  credentialAllowedForUser,
  userGroups,
};
