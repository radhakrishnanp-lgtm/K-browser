'use strict';
/* K-Browser Admin Console — dependency-free single page app. */

const state = { token: sessionStorage.getItem('kb_token') || '', me: null, users: [], groups: [] };
const $ = (sel, root = document) => root.querySelector(sel);

// ---- tiny DOM helper (never uses innerHTML for data) -----------------------
function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3500);
}

function fmtTime(iso) {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString();
}

function ago(iso) {
  if (!iso) return 'never';
  const s = Math.round((Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${s}s ago`;
  if (s < 3600) return `${Math.round(s / 60)}m ago`;
  if (s < 86400) return `${Math.round(s / 3600)}h ago`;
  return `${Math.round(s / 86400)}d ago`;
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(state.token ? { Authorization: 'Bearer ' + state.token } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  if (res.status === 401 && path !== '/auth/login') {
    signOut(false);
    throw new Error('Session expired, please sign in again');
  }
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  if (!res.ok) {
    const err = new Error((data && data.error) || `Request failed (${res.status})`);
    err.data = data;
    throw err;
  }
  return data;
}

async function download(path, filename) {
  const res = await fetch('/api' + path, { headers: { Authorization: 'Bearer ' + state.token } });
  if (!res.ok) return toast('Download failed');
  const blob = await res.blob();
  const a = h('a', { href: URL.createObjectURL(blob), download: filename });
  document.body.append(a);
  a.click();
  a.remove();
}

// ---- modal ------------------------------------------------------------------
function modal(title, body, { onSave, saveLabel = 'Save', wide } = {}) {
  return new Promise((resolve) => {
    const err = h('div', { class: 'error' });
    const close = (v) => {
      back.remove();
      resolve(v);
    };
    const save = h('button', { class: 'primary', type: 'submit' }, saveLabel);
    const form = h(
      'form',
      {
        class: 'modal',
        style: wide ? 'max-width:900px' : null,
        onsubmit: async (e) => {
          e.preventDefault();
          if (!onSave) return close(true);
          save.disabled = true;
          err.textContent = '';
          try {
            close(await onSave());
          } catch (ex) {
            err.textContent = ex.message;
            save.disabled = false;
          }
        },
      },
      h('h2', {}, title),
      body,
      err,
      h('div', { class: 'foot' }, h('button', { type: 'button', onclick: () => close(null) }, onSave ? 'Cancel' : 'Close'), onSave ? save : null)
    );
    const back = h('div', { class: 'modal-back', onmousedown: (e) => e.target === back && close(null) }, form);
    $('#modal-root').append(back);
    const first = form.querySelector('input:not([type=checkbox]),textarea,select');
    if (first) first.focus();
  });
}

function confirmBox(text, label = 'Confirm') {
  return modal('Please confirm', h('p', {}, text), { onSave: async () => true, saveLabel: label });
}

function showSecret(title, text, secret) {
  return modal(title, h('div', {}, h('p', {}, text), h('div', { class: 'secret' }, secret)));
}

// ---- reusable editors -------------------------------------------------------
function checkList(items, selected, label) {
  const sel = new Set(selected || []);
  const box = h(
    'div',
    { class: 'checks' },
    items.length
      ? items.map((it) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: it.id, checked: sel.has(it.id) }), label(it)))
      : h('span', { class: 'muted' }, 'None yet')
  );
  box.values = () => [...box.querySelectorAll('input:checked')].map((i) => i.value);
  return box;
}

function rulesEditor(rules) {
  const list = h('div', { class: 'rules' });
  const addRow = (r = { pattern: '', action: 'block', note: '', enabled: true }) => {
    const expired = r.expiresAt && Date.parse(r.expiresAt) < Date.now();
    const row = h(
      'div',
      { class: 'rule' + (expired ? ' expired' : ''), 'data-expires': r.expiresAt || '' },
      h('input', { placeholder: 'youtube.com, category:social, *.example.com …', value: r.pattern, 'data-k': 'pattern', list: 'kb-categories' }),
      h('select', { 'data-k': 'action' }, h('option', { value: 'block' }, 'Block'), h('option', { value: 'allow' }, 'Allow')),
      h('input', { placeholder: 'When (optional): Mon-Fri 09:00-18:00', value: r.schedule || '', 'data-k': 'schedule', title: 'Leave empty for always. Examples: "Mon-Fri 09:00-18:00", "Sat,Sun", "13:00-14:00"' }),
      h('input', { placeholder: 'Note (optional)', value: r.note || '', 'data-k': 'note' }),
      h('label', { class: 'check', title: r.expiresAt ? `Expires ${fmtTime(r.expiresAt)}` : 'Enabled' }, h('input', { type: 'checkbox', checked: r.enabled !== false, 'data-k': 'enabled' }), r.expiresAt ? (expired ? 'Expired' : 'Until ' + new Date(r.expiresAt).toLocaleDateString()) : 'On'),
      h('button', { type: 'button', class: 'small danger', onclick: () => row.remove() }, '✕')
    );
    row.querySelector('[data-k=action]').value = r.action === 'allow' ? 'allow' : 'block';
    list.append(row);
  };
  (rules || []).forEach(addRow);
  const wrap = h(
    'div',
    { class: 'rules' },
    list,
    h('div', {}, h('button', { type: 'button', class: 'small', onclick: () => addRow() }, '+ Add rule'))
  );
  wrap.values = () =>
    [...list.children]
      .map((row) => ({
        pattern: row.querySelector('[data-k=pattern]').value.trim(),
        action: row.querySelector('[data-k=action]').value,
        note: row.querySelector('[data-k=note]').value.trim(),
        schedule: row.querySelector('[data-k=schedule]').value.trim(),
        expiresAt: row.dataset.expires || undefined,
        enabled: row.querySelector('[data-k=enabled]').checked,
      }))
      .filter((r) => r.pattern && !(r.expiresAt && Date.parse(r.expiresAt) < Date.now()));
  return wrap;
}

function bookmarksEditor(bookmarks) {
  const list = h('div', { class: 'rules' });
  const addRow = (b = { title: '', url: '' }) => {
    const row = h(
      'div',
      { class: 'bm' },
      h('input', { placeholder: 'Title', value: b.title, 'data-k': 'title' }),
      h('input', { placeholder: 'https://…', value: b.url, 'data-k': 'url' }),
      h('button', { type: 'button', class: 'small danger', onclick: () => row.remove() }, '✕')
    );
    list.append(row);
  };
  (bookmarks || []).forEach(addRow);
  const wrap = h('div', { class: 'rules' }, list, h('div', {}, h('button', { type: 'button', class: 'small', onclick: () => addRow() }, '+ Add bookmark')));
  wrap.values = () =>
    [...list.children]
      .map((row) => ({ title: row.querySelector('[data-k=title]').value.trim(), url: row.querySelector('[data-k=url]').value.trim() }))
      .filter((b) => b.url);
  return wrap;
}

const OVERRIDES = [
  ['allowDownloads', 'Allow downloads', 'bool'],
  ['allowPrinting', 'Allow printing', 'bool'],
  ['allowMedia', 'Allow camera / microphone', 'bool'],
  ['allowDevTools', 'Allow developer tools', 'bool'],
  ['allowFileUrls', 'Allow opening local files', 'bool'],
  ['logActivity', 'Log browsing activity', 'bool'],
  ['clearDataOnLogout', 'Clear cookies on sign-out', 'bool'],
  ['idleLogoutMinutes', 'Auto sign-out after idle minutes (0 = off)', 'num'],
  ['maxTabs', 'Maximum open tabs (0 = unlimited)', 'num'],
  ['homepage', 'Home page', 'text'],
];

function overridesEditor(values) {
  values = values || {};
  const rows = OVERRIDES.map(([key, label, type]) => {
    let input;
    if (type === 'bool') {
      input = h('select', { 'data-k': key, 'data-t': type }, h('option', { value: '' }, 'Inherit'), h('option', { value: 'true' }, 'Yes'), h('option', { value: 'false' }, 'No'));
      input.value = values[key] === undefined ? '' : String(values[key]);
    } else {
      input = h('input', { 'data-k': key, 'data-t': type, placeholder: 'Inherit', value: values[key] === undefined ? '' : values[key] });
    }
    return h('label', {}, label, input);
  });
  const wrap = h('div', { class: 'row' }, rows);
  wrap.values = () => {
    const out = {};
    for (const el of wrap.querySelectorAll('[data-k]')) {
      const v = el.value.trim();
      if (v === '') continue;
      const t = el.dataset.t;
      out[el.dataset.k] = t === 'bool' ? v === 'true' : t === 'num' ? Number(v) : v;
    }
    return out;
  };
  return wrap;
}

function modeSelect(value, allowInherit) {
  const s = h(
    'select',
    {},
    allowInherit ? h('option', { value: 'inherit' }, 'Inherit') : null,
    h('option', { value: 'blocklist' }, 'Block list — allow everything except blocked sites'),
    h('option', { value: 'allowlist' }, 'Allow list — block everything except allowed sites')
  );
  s.value = value || (allowInherit ? 'inherit' : 'blocklist');
  return s;
}

async function loadDirectory() {
  [state.users, state.groups] = await Promise.all([api('GET', '/admin/users'), api('GET', '/admin/groups')]);
}

const groupName = (id) => (state.groups.find((g) => g.id === id) || {}).name || '?';
const userName = (id) => {
  const u = state.users.find((x) => x.id === id);
  return u ? u.displayName || u.username : '?';
};

// ---- pages --------------------------------------------------------------------
const pages = {};
const ROLE_LABELS = { admin: 'Admin', helpdesk: 'Helpdesk', auditor: 'Auditor', user: 'Staff' };
const money = (n) => {
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: state.currency || 'INR', maximumFractionDigits: 0 }).format(n || 0);
  } catch {
    return `${state.currency || ''} ${Math.round(n || 0)}`;
  }
};
const duration = (secs) => {
  const m = Math.round(secs / 60);
  return m < 60 ? `${m} min` : `${Math.floor(m / 60)} h ${m % 60} min`;
};

pages.dashboard = async (main) => {
  const o = await api('GET', '/admin/overview');
  $('#org-name').textContent = o.orgName;
  state.currency = o.settings.currency;
  setRequestCount(o.pendingRequests);
  if (!o.me.twoFactor) main.append(h('div', { class: 'alert' }, 'Your console account is not protected by two-factor authentication. ', h('a', { href: '#security' }, 'Set it up now'), '.'));
  if (o.pendingRequests) main.append(h('div', { class: 'alert' }, `${o.pendingRequests} access request(s) are waiting for you. `, h('a', { href: '#requests' }, 'Review')));
  for (const r of o.subscriptions.renewalsSoon) main.append(h('div', { class: 'alert' }, `Subscription "${r.name}" renews on ${r.renewalDate}.`));
  const stat = (n, l) => h('div', { class: 'stat' }, h('div', { class: 'n' }, n), h('div', { class: 'l' }, l));
  main.append(
    h('h1', {}, 'Dashboard'),
    h('p', { class: 'sub' }, `Server ${o.server.hostname} · v${o.server.version}`),
    h('div', { class: 'grid' }, stat(o.online, 'Browsers online'), stat(o.users, 'Users'), stat(o.credentials, 'Site logins'), stat(o.last24h.visits, 'Page visits (24h)'), stat(o.last24h.blocked, 'Blocked (24h)'), stat(o.last24h.fills, 'Auto sign-ins (24h)'), stat(o.last24h.failedLogins, 'Failed logins (24h)'), stat(o.pendingRequests, 'Pending requests'), stat(o.subscriptions.seatsInUse, 'Licence seats in use'), stat(money(o.subscriptions.monthlyCost), 'Subscriptions / month')),
    h('div', { style: 'height:16px' }),
    h(
      'div',
      { class: 'grid', style: 'grid-template-columns:repeat(auto-fit,minmax(320px,1fr))' },
      h('div', { class: 'panel' }, h('h2', {}, 'Top sites (24h)'), o.topSites.length ? h('table', {}, h('tbody', {}, o.topSites.map((s) => h('tr', {}, h('td', {}, s.host), h('td', {}, s.visits))))) : h('p', { class: 'muted' }, 'No activity yet.')),
      h('div', { class: 'panel' }, h('h2', {}, 'Recent events'), activityTable(o.recent, true))
    )
  );
};

function activityTable(rows, compact) {
  if (!rows.length) return h('p', { class: 'muted' }, 'Nothing here yet.');
  const badge = (t) => h('span', { class: 'badge ' + (t === 'blocked' || t.includes('failed') || t.includes('blocked') ? 'bad' : t.startsWith('admin') ? 'warn' : t === 'credential.fill' ? 'ok' : '') }, t);
  return h(
    'div',
    { class: 'table-wrap' },
    h(
      'table',
      {},
      h('thead', {}, h('tr', {}, h('th', {}, 'Time'), h('th', {}, 'Event'), h('th', {}, 'User'), compact ? null : h('th', {}, 'IP'), h('th', {}, 'Details'))),
      h(
        'tbody',
        {},
        rows.map((e) =>
          h(
            'tr',
            {},
            h('td', { title: fmtTime(e.ts) }, compact ? ago(e.ts) : fmtTime(e.ts)),
            h('td', {}, badge(e.type)),
            h('td', {}, e.username || '—'),
            compact ? null : h('td', {}, e.ip || ''),
            h('td', {}, e.title ? h('div', {}, e.title) : null, e.url ? h('div', { class: 'url', title: e.url }, e.url) : null, e.detail ? h('div', { class: 'muted' }, e.detail) : null)
          )
        )
      )
    )
  );
}

pages.sessions = async (main) => {
  const sessions = await api('GET', '/admin/sessions');
  const sendCommand = async (target, extra) => {
    const kind = h('select', {}, h('option', { value: 'message' }, 'Show a message'), h('option', { value: 'open-url' }, 'Open a website'), h('option', { value: 'close-tabs' }, 'Close all tabs'), h('option', { value: 'refresh' }, 'Reload policy now'), h('option', { value: 'clear-data' }, 'Clear cookies & sign out of sites'));
    const text = h('textarea', { placeholder: 'Message text' });
    const url = h('input', { placeholder: 'https://…' });
    const level = h('select', {}, h('option', { value: 'info' }, 'Info'), h('option', { value: 'warning' }, 'Warning'), h('option', { value: 'critical' }, 'Critical'));
    const r = await modal(
      'Send to ' + (target === 'all' ? 'all browsers' : extra.label),
      h('div', { class: 'rules' }, h('label', {}, 'Action', kind), h('label', {}, 'Message', text), h('label', {}, 'Level', level), h('label', {}, 'URL (for "Open a website")', url)),
      { onSave: () => api('POST', '/admin/command', { target, ...extra, command: kind.value, text: text.value, url: url.value, level: level.value }), saveLabel: 'Send' }
    );
    if (r) toast(`Delivered to ${r.delivered} browser(s)`);
  };
  main.append(
    h('h1', {}, 'Live sessions'),
    h('p', { class: 'sub' }, 'Who is signed in to K-Browser right now and what they have open.'),
    h('div', { class: 'toolbar' }, h('button', { class: 'primary', onclick: () => sendCommand('all', {}) }, 'Message / command to everyone'), h('button', { onclick: () => route() }, 'Refresh'))
  );
  if (!sessions.length) return main.append(h('p', { class: 'muted' }, 'No sessions.'));
  main.append(
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Device'), h('th', {}, 'Viewing'), h('th', {}, 'Last seen'), h('th', {}, ''))),
        h(
          'tbody',
          {},
          sessions.map((s) =>
            h(
              'tr',
              {},
              h('td', {}, h('span', { class: 'dot' + (s.online ? ' on' : '') }), s.displayName || s.username, h('div', { class: 'muted' }, s.kind === 'console' ? 'Admin console' : `${s.platform || ''} ${s.appVersion ? 'v' + s.appVersion : ''}`)),
              h('td', {}, s.device || '—', h('div', { class: 'muted' }, s.ip)),
              h('td', {}, s.currentTitle || (s.currentUrl ? '' : '—'), s.currentUrl ? h('div', { class: 'url', title: s.currentUrl }, s.currentUrl) : null, s.tabCount ? h('div', { class: 'muted' }, `${s.tabCount} tab(s)`) : null),
              h('td', {}, ago(s.lastSeen)),
              h(
                'td',
                {},
                h(
                  'div',
                  { class: 'actions' },
                  s.online && s.kind === 'browser' ? h('button', { class: 'small', onclick: () => sendCommand('session', { sessionId: s.id, label: s.username }) }, 'Send…') : null,
                  h(
                    'button',
                    {
                      class: 'small danger',
                      onclick: async () => {
                        if (!(await confirmBox(`Sign ${s.username} out of ${s.device || 'this device'}?`, 'Sign out'))) return;
                        await api('POST', `/admin/sessions/${s.id}/logout`, {});
                        route();
                      },
                    },
                    'Sign out'
                  )
                )
              )
            )
          )
        )
      )
    )
  );
};

async function editUser(user) {
  const isNew = !user;
  user = user || { role: 'user', enabled: true, groupIds: [], policy: { mode: 'inherit', rules: [] }, settings: {}, bookmarks: [] };
  const f = {
    username: h('input', { value: user.username || '', required: true }),
    displayName: h('input', { value: user.displayName || '' }),
    email: h('input', { value: user.email || '', type: 'email' }),
    password: h('input', { type: 'password', placeholder: isNew ? 'Leave blank to generate one' : 'Leave blank to keep current', autocomplete: 'new-password' }),
    role: h('select', {}, h('option', { value: 'user' }, 'Staff'), h('option', { value: 'helpdesk' }, 'Helpdesk (console: users, sessions, requests)'), h('option', { value: 'auditor' }, 'Auditor (console: read-only)'), h('option', { value: 'admin' }, 'Administrator (full control)')),
    enabled: h('input', { type: 'checkbox', checked: user.enabled !== false }),
    mustChange: h('input', { type: 'checkbox', checked: !!user.mustChangePassword }),
    groups: checkList(state.groups, user.groupIds, (g) => g.name),
    mode: modeSelect(user.policy.mode, true),
    rules: rulesEditor(user.policy.rules),
    settings: overridesEditor(user.settings),
    bookmarks: bookmarksEditor(user.bookmarks),
  };
  f.role.value = user.role;
  const result = await modal(
    isNew ? 'Add user' : `Edit ${user.username}`,
    h(
      'div',
      { class: 'rules' },
      h('div', { class: 'row' }, h('label', {}, 'Username (used to sign in to K-Browser)', f.username), h('label', {}, 'Display name', f.displayName)),
      h('div', { class: 'row' }, h('label', {}, 'Password', f.password), h('label', {}, 'Role', f.role)),
      h('div', { class: 'row' }, h('label', {}, 'Email (optional)', f.email), h('div', {}, h('label', { class: 'check' }, f.enabled, 'Account enabled'), h('label', { class: 'check' }, f.mustChange, 'Must change password at next sign-in'))),
      h('fieldset', {}, h('legend', {}, 'Groups'), f.groups),
      h('fieldset', {}, h('legend', {}, 'Personal web filter (checked before group and global rules)'), h('label', {}, 'Mode', f.mode), f.rules),
      h('fieldset', {}, h('legend', {}, 'Personal browser settings'), f.settings),
      h('fieldset', {}, h('legend', {}, 'Personal bookmarks'), f.bookmarks)
    ),
    {
      wide: true,
      onSave: () => {
        const body = {
          username: f.username.value,
          displayName: f.displayName.value,
          email: f.email.value,
          role: f.role.value,
          enabled: f.enabled.checked,
          mustChangePassword: f.mustChange.checked,
          groupIds: f.groups.values(),
          policy: { mode: f.mode.value, rules: f.rules.values() },
          settings: f.settings.values(),
          bookmarks: f.bookmarks.values(),
        };
        if (f.password.value) body.password = f.password.value;
        return isNew ? api('POST', '/admin/users', body) : api('PUT', `/admin/users/${user.id}`, body);
      },
    }
  );
  if (result && result.generatedPassword) await showSecret('User created', `Give ${result.username} this password for K-Browser:`, result.generatedPassword);
  return result;
}

pages.users = async (main) => {
  await loadDirectory();
  const filter = h('input', { placeholder: 'Search users…', oninput: () => render() });
  const body = h('div');
  const render = () => {
    const q = filter.value.toLowerCase();
    const rows = state.users.filter((u) => !q || `${u.username} ${u.displayName} ${u.email}`.toLowerCase().includes(q));
    body.replaceChildren(
      h(
        'div',
        { class: 'table-wrap' },
        h(
          'table',
          {},
          h('thead', {}, h('tr', {}, h('th', {}, 'User'), h('th', {}, 'Role'), h('th', {}, 'Groups'), h('th', {}, 'Status'), h('th', {}, 'Last sign-in'), h('th', {}, ''))),
          h(
            'tbody',
            {},
            rows.map((u) =>
              h(
                'tr',
                {},
                h('td', {}, h('span', { class: 'dot' + (u.online ? ' on' : '') }), h('strong', {}, u.username), u.displayName ? h('div', { class: 'muted' }, u.displayName) : null),
                h('td', {}, u.role === 'user' ? 'Staff' : h('span', { class: 'badge warn' }, ROLE_LABELS[u.role] || u.role), u.twoFactor ? h('span', { class: 'badge ok', title: 'Two-factor authentication on' }, '2FA') : null),
                h('td', {}, u.groupIds.map(groupName).join(', ') || h('span', { class: 'muted' }, '—')),
                h('td', {}, u.enabled ? h('span', { class: 'badge ok' }, 'Enabled') : h('span', { class: 'badge off' }, 'Disabled')),
                h('td', {}, ago(u.lastLoginAt)),
                h(
                  'td',
                  {},
                  h(
                    'div',
                    { class: 'actions' },
                    h('button', { class: 'small', onclick: async () => (await editUser(u)) && route() }, 'Edit'),
                    h('button', { class: 'small', onclick: () => showEffective(u) }, 'Effective access'),
                    h(
                      'button',
                      {
                        class: 'small',
                        onclick: async () => {
                          if (!(await confirmBox(`Generate a new K-Browser password for ${u.username}?`, 'Reset password'))) return;
                          const r = await api('POST', `/admin/users/${u.id}/reset-password`, { mustChangePassword: false });
                          showSecret('Password reset', `New password for ${u.username}:`, r.password);
                        },
                      },
                      'Reset password'
                    ),
                    u.twoFactor
                      ? h('button', { class: 'small', onclick: async () => { if (await confirmBox(`Turn off two-factor authentication for ${u.username}? They can set it up again after signing in.`, 'Reset 2FA')) { await api('POST', `/admin/users/${u.id}/reset-2fa`, {}); route(); } } }, 'Reset 2FA')
                      : null,
                    h(
                      'button',
                      {
                        class: 'small danger',
                        onclick: async () => {
                          if (!(await confirmBox(`Delete ${u.username}? This cannot be undone.`, 'Delete'))) return;
                          await api('DELETE', `/admin/users/${u.id}`);
                          route();
                        },
                      },
                      'Delete'
                    )
                  )
                )
              )
            )
          )
        )
      )
    );
  };
  main.append(
    h('h1', {}, 'Users'),
    h('p', { class: 'sub' }, 'Staff accounts for signing in to K-Browser. Their website passwords are managed under Site logins.'),
    h('div', { class: 'toolbar' }, filter, h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: async () => (await editUser()) && route() }, '+ Add user')),
    body
  );
  render();
};

async function showEffective(u) {
  const e = await api('GET', `/admin/users/${u.id}/effective`);
  const testInput = h('input', { placeholder: 'Test a URL, e.g. https://youtube.com' });
  const testOut = h('div', { class: 'muted' });
  await modal(
    `Effective access — ${u.username}`,
    h(
      'div',
      { class: 'rules' },
      h('div', {}, h('strong', {}, 'Filter mode: '), e.policy.mode === 'allowlist' ? 'Allow list (only listed sites)' : 'Block list (everything except blocked)'),
      e.policy.rules.length
        ? h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, e.policy.rules.map((r) => h('tr', {}, h('td', {}, r.pattern), h('td', {}, h('span', { class: 'badge ' + (r.action === 'allow' ? 'ok' : 'bad') }, r.action)), h('td', { class: 'muted' }, r.source))))))
        : h('div', { class: 'muted' }, 'No rules.'),
      h('div', { class: 'toolbar' }, testInput, h('button', { type: 'button', onclick: async () => { const r = await api('POST', '/admin/policy/test', { url: testInput.value, userId: u.id }); testOut.textContent = (r.allowed ? '✔ Allowed' : '✖ Blocked') + (r.rule ? ` by rule "${r.rule.pattern}" (${r.rule.source})` : ` (${r.reason})`); } }, 'Test')),
      testOut,
      h('div', {}, h('strong', {}, 'Site logins available: '), e.credentials.map((c) => c.name).join(', ') || 'none')
    ),
    { wide: true }
  );
}

pages.groups = async (main) => {
  await loadDirectory();
  const edit = async (g) => {
    const isNew = !g;
    g = g || { name: '', description: '', policy: { mode: 'inherit', rules: [] }, settings: {}, bookmarks: [] };
    const members = state.users.filter((u) => u.groupIds.includes(g.id)).map((u) => u.id);
    const f = {
      name: h('input', { value: g.name, required: true }),
      description: h('input', { value: g.description || '' }),
      members: checkList(state.users, members, (u) => u.displayName || u.username),
      mode: modeSelect(g.policy && g.policy.mode, true),
      rules: rulesEditor(g.policy && g.policy.rules),
      settings: overridesEditor(g.settings),
      bookmarks: bookmarksEditor(g.bookmarks),
    };
    const r = await modal(
      isNew ? 'Add group' : `Edit ${g.name}`,
      h(
        'div',
        { class: 'rules' },
        h('div', { class: 'row' }, h('label', {}, 'Name', f.name), h('label', {}, 'Description', f.description)),
        h('fieldset', {}, h('legend', {}, 'Members'), f.members),
        h('fieldset', {}, h('legend', {}, 'Group web filter'), h('label', {}, 'Mode', f.mode), f.rules),
        h('fieldset', {}, h('legend', {}, 'Group browser settings'), f.settings),
        h('fieldset', {}, h('legend', {}, 'Group bookmarks'), f.bookmarks)
      ),
      {
        wide: true,
        onSave: () => {
          const body = { name: f.name.value, description: f.description.value, memberIds: f.members.values(), policy: { mode: f.mode.value, rules: f.rules.values() }, settings: f.settings.values(), bookmarks: f.bookmarks.values() };
          return isNew ? api('POST', '/admin/groups', body) : api('PUT', `/admin/groups/${g.id}`, body);
        },
      }
    );
    if (r) route();
  };
  main.append(
    h('h1', {}, 'Groups'),
    h('p', { class: 'sub' }, 'Departments or teams. Give a whole group the same site logins, web filter rules, settings and bookmarks.'),
    h('div', { class: 'toolbar' }, h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => edit() }, '+ Add group')),
    state.groups.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Group'), h('th', {}, 'Members'), h('th', {}, 'Filter'), h('th', {}, ''))),
            h(
              'tbody',
              {},
              state.groups.map((g) =>
                h(
                  'tr',
                  {},
                  h('td', {}, h('strong', {}, g.name), g.description ? h('div', { class: 'muted' }, g.description) : null),
                  h('td', {}, g.memberCount),
                  h('td', {}, `${(g.policy && g.policy.mode) || 'inherit'} · ${((g.policy && g.policy.rules) || []).length} rules`),
                  h(
                    'td',
                    {},
                    h(
                      'div',
                      { class: 'actions' },
                      h('button', { class: 'small', onclick: () => edit(g) }, 'Edit'),
                      h('button', { class: 'small danger', onclick: async () => { if (await confirmBox(`Delete group ${g.name}?`, 'Delete')) { await api('DELETE', `/admin/groups/${g.id}`); route(); } } }, 'Delete')
                    )
                  )
                )
              )
            )
          )
        )
      : h('p', { class: 'muted' }, 'No groups yet.')
  );
};

pages.credentials = async (main) => {
  await loadDirectory();
  const creds = await api('GET', '/admin/credentials');
  const edit = async (c) => {
    const isNew = !c;
    c = c || { name: '', match: [], loginUrl: '', username: '', autoFill: true, autoSubmit: false, showOnNewTab: true, everyone: false, enabled: true, assignedUserIds: [], assignedGroupIds: [] };
    const f = {
      name: h('input', { value: c.name, required: true, placeholder: 'e.g. Canva – Design team account' }),
      loginUrl: h('input', { value: c.loginUrl, placeholder: 'https://www.canva.com/login' }),
      match: h('textarea', { placeholder: 'One per line, e.g. canva.com' }, (c.match || []).join('\n')),
      username: h('input', { value: c.username, autocomplete: 'off', placeholder: 'Account username / email' }),
      password: h('input', { type: 'password', autocomplete: 'new-password', placeholder: c.hasPassword ? '•••••••• (saved — type to replace)' : 'Account password' }),
      totp: h('input', { autocomplete: 'off', placeholder: c.hasTotp ? '(saved — type to replace)' : 'Optional: base32 2FA secret, e.g. JBSWY3DPEHPK3PXP' }),
      clearTotp: h('input', { type: 'checkbox' }),
      plan: h('input', { value: c.plan || '', placeholder: 'e.g. Canva Teams – annual' }),
      vendor: h('input', { value: c.vendor || '', placeholder: 'e.g. Canva' }),
      seats: h('input', { type: 'number', min: 0, value: c.seats || 0 }),
      costMonthly: h('input', { type: 'number', min: 0, step: '0.01', value: c.costMonthly || 0 }),
      renewalDate: h('input', { type: 'date', value: c.renewalDate || '' }),
      autoFill: h('input', { type: 'checkbox', checked: c.autoFill }),
      autoSubmit: h('input', { type: 'checkbox', checked: c.autoSubmit }),
      showOnNewTab: h('input', { type: 'checkbox', checked: c.showOnNewTab }),
      enabled: h('input', { type: 'checkbox', checked: c.enabled }),
      everyone: h('input', { type: 'checkbox', checked: c.everyone }),
      users: checkList(state.users, c.assignedUserIds, (u) => u.displayName || u.username),
      groups: checkList(state.groups, c.assignedGroupIds, (g) => g.name),
      usernameSelector: h('input', { value: c.usernameSelector || '', placeholder: 'auto-detect' }),
      passwordSelector: h('input', { value: c.passwordSelector || '', placeholder: 'auto-detect' }),
      totpSelector: h('input', { value: c.totpSelector || '', placeholder: 'auto-detect' }),
      submitSelector: h('input', { value: c.submitSelector || '', placeholder: 'auto-detect' }),
      notes: h('textarea', { placeholder: 'Internal notes (plan, renewal date, owner…)' }, c.notes || ''),
    };
    const r = await modal(
      isNew ? 'Add site login' : `Edit ${c.name}`,
      h(
        'div',
        { class: 'rules' },
        h('div', { class: 'row' }, h('label', {}, 'Name', f.name), h('label', {}, 'Login page URL', f.loginUrl)),
        h('label', {}, 'Websites this login is used on', f.match, h('span', { class: 'help' }, 'Leave empty to use the login page domain. "example.com" also covers its subdomains.')),
        h('fieldset', {}, h('legend', {}, 'Account (stored encrypted, never shown to staff)'), h('div', { class: 'row' }, h('label', {}, 'Username / email', f.username), h('label', {}, 'Password', f.password)), h('label', {}, 'Two-factor (TOTP) secret', f.totp), c.hasTotp ? h('label', { class: 'check' }, f.clearTotp, 'Remove saved 2FA secret') : null),
        h('fieldset', {}, h('legend', {}, 'Who can use it'), h('label', { class: 'check' }, f.everyone, 'Everyone'), h('div', {}, h('strong', {}, 'Groups'), f.groups), h('div', {}, h('strong', {}, 'Users'), f.users), h('span', { class: 'help' }, 'If a user has several logins for the same site, a personal assignment wins over a group one; they can switch from the key icon in the address bar.')),
        h(
          'fieldset',
          {},
          h('legend', {}, 'Subscription & licence'),
          h('div', { class: 'row' }, h('label', {}, 'Plan', f.plan), h('label', {}, 'Vendor', f.vendor)),
          h('div', { class: 'row' }, h('label', {}, 'Seats (max people at the same time, 0 = no limit)', f.seats), h('label', {}, 'Monthly cost', f.costMonthly)),
          h('label', {}, 'Renewal date', f.renewalDate)
        ),
        h(
          'fieldset',
          {},
          h('legend', {}, 'Shared signed-in session (no password needed)'),
          c.hasSession
            ? h('div', {}, h('span', { class: 'badge ok' }, 'Session shared'), ` by ${c.sessionCapturedBy || '?'} · ${fmtTime(c.sessionCapturedAt)} `, h('button', { type: 'button', class: 'small danger', onclick: async () => { await api('DELETE', `/admin/credentials/${c.id}/session`); toast('Shared session removed'); } }, 'Remove'))
            : h('div', { class: 'muted' }, 'None.'),
          h('span', { class: 'help' }, 'To share: sign in to the website in your own K-Browser, then open the ⋮ menu → "Share this site’s sign-in with staff…". Staff assigned to this login are then signed in with your session — the password never leaves your computer. Re-share when the site logs you out.')
        ),
        h('fieldset', {}, h('legend', {}, 'Behaviour'), h('label', { class: 'check' }, f.autoFill, 'Fill automatically when the login page opens'), h('label', { class: 'check' }, f.autoSubmit, 'Press the sign-in button automatically'), h('label', { class: 'check' }, f.showOnNewTab, 'Show as a shortcut on the new tab page'), h('label', { class: 'check' }, f.enabled, 'Enabled')),
        h('fieldset', {}, h('legend', {}, 'Advanced: CSS selectors (only if auto-detect fails)'), h('div', { class: 'row' }, h('label', {}, 'Username field', f.usernameSelector), h('label', {}, 'Password field', f.passwordSelector)), h('div', { class: 'row' }, h('label', {}, '2FA code field', f.totpSelector), h('label', {}, 'Submit button', f.submitSelector))),
        h('label', {}, 'Notes', f.notes)
      ),
      {
        wide: true,
        onSave: () => {
          const body = {
            name: f.name.value,
            loginUrl: f.loginUrl.value,
            match: f.match.value,
            username: f.username.value,
            autoFill: f.autoFill.checked,
            autoSubmit: f.autoSubmit.checked,
            showOnNewTab: f.showOnNewTab.checked,
            enabled: f.enabled.checked,
            everyone: f.everyone.checked,
            assignedUserIds: f.users.values(),
            assignedGroupIds: f.groups.values(),
            usernameSelector: f.usernameSelector.value,
            passwordSelector: f.passwordSelector.value,
            totpSelector: f.totpSelector.value,
            submitSelector: f.submitSelector.value,
            notes: f.notes.value,
            plan: f.plan.value,
            vendor: f.vendor.value,
            seats: Number(f.seats.value) || 0,
            costMonthly: Number(f.costMonthly.value) || 0,
            renewalDate: f.renewalDate.value,
          };
          if (f.password.value) body.password = f.password.value;
          if (f.totp.value) body.totpSecret = f.totp.value;
          if (f.clearTotp.checked) body.clearTotp = true;
          return isNew ? api('POST', '/admin/credentials', body) : api('PUT', `/admin/credentials/${c.id}`, body);
        },
      }
    );
    if (r) route();
  };
  const who = (c) => [c.everyone ? 'Everyone' : null, ...c.assignedGroupIds.map((id) => 'Group: ' + groupName(id)), ...c.assignedUserIds.map(userName)].filter(Boolean).join(', ') || '— not assigned —';
  main.append(
    h('h1', {}, 'Site logins'),
    h('p', { class: 'sub' }, 'Your paid website accounts. Staff are signed in automatically and never see the password. Different staff can get different accounts for the same website.'),
    h('div', { class: 'toolbar' }, h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => edit() }, '+ Add site login')),
    creds.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Name'), h('th', {}, 'Websites'), h('th', {}, 'Account'), h('th', {}, 'Assigned to'), h('th', {}, ''))),
            h(
              'tbody',
              {},
              creds.map((c) =>
                h(
                  'tr',
                  {},
                  h('td', {}, h('strong', {}, c.name), c.enabled ? null : h('span', { class: 'badge off' }, 'disabled'), c.notes ? h('div', { class: 'muted' }, c.notes) : null),
                  h('td', {}, c.match.join(', ')),
                  h('td', {}, c.username || '—', h('div', {}, c.hasPassword ? h('span', { class: 'badge ok' }, 'password') : c.hasSession ? null : h('span', { class: 'badge bad' }, 'no password'), ' ', c.hasSession ? h('span', { class: 'badge ok' }, 'shared session') : null, ' ', c.seats ? h('span', { class: 'badge' }, `${c.seatsInUse.length}/${c.seats} seats`) : null, ' ', c.hasTotp ? h('span', { class: 'badge ok' }, '2FA') : null, ' ', c.autoSubmit ? h('span', { class: 'badge' }, 'auto-submit') : null)),
                  h('td', {}, who(c)),
                  h(
                    'td',
                    {},
                    h(
                      'div',
                      { class: 'actions' },
                      h('button', { class: 'small', onclick: () => edit(c) }, 'Edit'),
                      h('button', { class: 'small danger', onclick: async () => { if (await confirmBox(`Delete ${c.name}?`, 'Delete')) { await api('DELETE', `/admin/credentials/${c.id}`); route(); } } }, 'Delete')
                    )
                  )
                )
              )
            )
          )
        )
      : h('p', { class: 'muted' }, 'No site logins yet. Add your first shared subscription account.')
  );
};

pages.filter = async (main) => {
  const [policy, cats] = await Promise.all([api('GET', '/admin/policy'), api('GET', '/admin/categories')]);
  const mode = modeSelect(policy.mode, false);
  const rules = rulesEditor(policy.rules);
  const testInput = h('input', { placeholder: 'https://www.youtube.com/watch?v=…' });
  const testOut = h('span', { class: 'muted' });
  main.append(
    h('h1', {}, 'Web filter'),
    h('p', { class: 'sub' }, 'Global rules for every user. Group and personal rules (set on the group or user) are checked first. The first matching rule wins.'),
    h(
      'div',
      { class: 'panel rules' },
      h('label', {}, 'Mode', mode),
      rules,
      h(
        'div',
        { class: 'help' },
        'Patterns: ',
        h('code', {}, 'example.com'),
        ' (site + subdomains) · ',
        h('code', {}, '*.example.com'),
        ' (subdomains only) · ',
        h('code', {}, '=example.com'),
        ' (exact host) · ',
        h('code', {}, 'example.com/path'),
        ' · ',
        h('code', {}, 'https://*.site.com/x/*'),
        ' · ',
        h('code', {}, '192.168.1.0/24'),
        ' · ',
        h('code', {}, '*'),
        ' (everything) · ',
        h('code', {}, 'category:social'),
        ' (built-in category). "When" limits a rule to certain times, e.g. ',
        h('code', {}, 'Mon-Fri 09:00-18:00'),
        ' blocks only during office hours.'
      ),
      h('div', {}, h('button', { class: 'primary', onclick: async () => { await api('PUT', '/admin/policy', { mode: mode.value, rules: rules.values() }); toast('Web filter saved and pushed to all browsers'); } }, 'Save & push to browsers'))
    ),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Built-in categories'),
      h('p', { class: 'help' }, 'Use these as patterns, e.g. block category:social Mon-Fri 09:00-18:00.'),
      h('div', { class: 'table-wrap' }, h('table', {}, h('tbody', {}, cats.map((c) => h('tr', {}, h('td', {}, h('code', {}, `category:${c.key}`)), h('td', {}, c.label), h('td', { class: 'muted' }, `${c.examples.join(', ')} … (${c.count})`))))))
    ),
    h('div', { class: 'panel' }, h('h2', {}, 'Test a URL against the global rules'), h('div', { class: 'toolbar' }, testInput, h('button', { onclick: async () => { const r = await api('POST', '/admin/policy/test', { url: testInput.value }); testOut.textContent = r.allowed ? '✔ Allowed' : '✖ Blocked'; testOut.textContent += r.rule ? ` by "${r.rule.pattern}"` : ` (${r.reason})`; } }, 'Test'), testOut), h('p', { class: 'help' }, 'Note: save first; the test uses the saved rules. Use "Effective access" on a user to test their combined rules.'))
  );
};

pages.bookmarks = async (main) => {
  const list = await api('GET', '/admin/bookmarks');
  const ed = bookmarksEditor(list);
  main.append(
    h('h1', {}, 'Bookmarks'),
    h('p', { class: 'sub' }, 'Shown on the bookmarks bar of every browser. Groups and users can have extra bookmarks.'),
    h('div', { class: 'panel rules' }, ed, h('div', {}, h('button', { class: 'primary', onclick: async () => { await api('PUT', '/admin/bookmarks', ed.values()); toast('Bookmarks saved'); } }, 'Save')))
  );
};

pages.activity = async (main) => {
  await loadDirectory();
  const user = h('select', {}, h('option', { value: '' }, 'All users'), state.users.map((u) => h('option', { value: u.id }, u.username)));
  const type = h(
    'select',
    {},
    h('option', { value: '' }, 'All events'),
    h('option', { value: 'visit' }, 'Page visits'),
    h('option', { value: 'blocked,access.request' }, 'Blocked sites & access requests'),
    h('option', { value: 'credential.fill,session.use' }, 'Auto sign-ins & shared sessions'),
    h('option', { value: 'dlp.blocked' }, 'Data protection blocks'),
    h('option', { value: 'seat.denied' }, 'Licence seat full'),
    h('option', { value: 'login,logout,login.failed' }, 'K-Browser sign-ins'),
    h('option', { value: 'download,download.blocked' }, 'Downloads'),
    h('option', { value: 'admin.user.create,admin.user.update,admin.user.delete,admin.credential.create,admin.credential.update,admin.credential.delete,admin.policy.update,admin.settings.update,admin.group.create,admin.group.update,admin.group.delete,admin.bookmarks.update,admin.session.logout,admin.user.reset-password' }, 'Admin changes')
  );
  const q = h('input', { placeholder: 'Search URL, title…' });
  const since = h('input', { type: 'date' });
  const out = h('div');
  const params = () => {
    const p = new URLSearchParams();
    if (user.value) p.set('userId', user.value);
    if (type.value) p.set('type', type.value);
    if (q.value) p.set('q', q.value);
    if (since.value) p.set('since', new Date(since.value).toISOString());
    return p;
  };
  const load = async () => {
    const p = params();
    p.set('limit', '500');
    out.replaceChildren(activityTable(await api('GET', '/admin/audit?' + p), false));
  };
  for (const el of [user, type, since]) el.addEventListener('change', load);
  q.addEventListener('keydown', (e) => e.key === 'Enter' && load());
  main.append(
    h('h1', {}, 'Activity log'),
    h('p', { class: 'sub' }, 'Sign-ins, visited pages, blocked attempts, auto sign-ins, downloads and admin changes.'),
    h('div', { class: 'toolbar' }, user, type, since, q, h('button', { onclick: load }, 'Search'), h('span', { class: 'spacer' }), h('button', { onclick: () => download('/admin/audit.csv?' + params(), 'kbrowser-activity.csv') }, 'Export CSV')),
    out
  );
  load();
};

pages.settings = async (main) => {
  const s = await api('GET', '/admin/settings');
  const f = {};
  const field = (key, label, type, help) => {
    let input;
    if (type === 'bool') input = h('input', { type: 'checkbox', checked: s[key] });
    else if (type === 'list') input = h('input', { value: (s[key] || []).join(', ') });
    else if (type === 'area') input = h('textarea', {}, s[key] || '');
    else input = h('input', { value: s[key], type: type === 'num' ? 'number' : 'text', min: type === 'num' ? 0 : null });
    f[key] = { input, type };
    return type === 'bool' ? h('label', { class: 'check' }, input, label) : h('label', {}, label, input, help ? h('span', { class: 'help' }, help) : null);
  };
  main.append(
    h('h1', {}, 'Settings'),
    h('p', { class: 'sub' }, 'Defaults for every browser. Groups and users can override most of them.'),
    h(
      'div',
      { class: 'panel rules' },
      h('div', { class: 'row' }, field('orgName', 'Organisation name'), field('homepage', 'Home page', 'text', 'kb://newtab shows the K-Browser start page with your shortcuts')),
      field('searchUrl', 'Search engine URL', 'text', '%s is replaced with the search terms'),
      field('loginBanner', 'Sign-in notice shown to staff', 'area', 'e.g. "Browsing on this computer is monitored according to company policy."'),
      h('div', { class: 'row' }, field('idleLogoutMinutes', 'Auto sign-out after idle minutes (0 = never)', 'num'), field('maxTabs', 'Maximum open tabs (0 = unlimited)', 'num')),
      field('blockedDownloadExtensions', 'Blocked download file types', 'list', 'Comma separated, e.g. exe, msi, bat'),
      h('div', { class: 'row' }, field('currency', 'Currency for subscription costs', 'text', 'e.g. INR, USD, EUR'), field('usageRetentionDays', 'Keep usage statistics for (days)', 'num')),
      h('div', { class: 'row' }, field('safeSearch', 'Force SafeSearch on Google, Bing and DuckDuckGo', 'bool'), (() => {
        const sel = h('select', {}, h('option', { value: 'off' }, 'Off'), h('option', { value: 'moderate' }, 'Moderate'), h('option', { value: 'strict' }, 'Strict'));
        sel.value = s.youtubeRestrict || 'off';
        f.youtubeRestrict = { input: sel, type: 'text' };
        return h('label', {}, 'YouTube Restricted Mode', sel);
      })()),
      h('div', { class: 'checks', style: 'max-height:none' }, field('logActivity', 'Log browsing activity', 'bool'), field('allowDownloads', 'Allow downloads', 'bool'), field('allowPrinting', 'Allow printing', 'bool'), field('allowMedia', 'Allow camera / microphone', 'bool'), field('allowDevTools', 'Allow developer tools', 'bool'), field('allowFileUrls', 'Allow opening local files', 'bool'), field('clearDataOnLogout', 'Clear cookies on sign-out', 'bool')),
      h(
        'div',
        {},
        h(
          'button',
          {
            class: 'primary',
            onclick: async () => {
              const body = {};
              for (const [k, { input, type }] of Object.entries(f)) body[k] = type === 'bool' ? input.checked : type === 'num' ? Number(input.value) : input.value;
              await api('PUT', '/admin/settings', body);
              $('#org-name').textContent = body.orgName;
              toast('Settings saved and pushed to all browsers');
            },
          },
          'Save'
        )
      )
    ),
    h('div', { class: 'panel' }, h('h2', {}, 'Backup'), h('p', { class: 'help' }, 'Exports users, groups, rules and site logins. Passwords stay encrypted and can only be restored together with the server\'s data/vault.key file — keep both safe.'), h('button', { onclick: () => download('/admin/backup', `kbrowser-backup-${new Date().toISOString().slice(0, 10)}.json`) }, 'Download backup'))
  );
};

pages.deploy = async (main) => {
  const o = await api('GET', '/admin/overview');
  const urls = o.server.addresses.length ? o.server.addresses.map((a) => `https://${a}:${o.server.port}`) : [location.origin];
  const managed = JSON.stringify({ serverUrl: urls[0], fingerprint: o.server.fingerprint, lockServer: true }, null, 2);
  main.append(
    h('h1', {}, 'Deploy clients'),
    h('p', { class: 'sub' }, 'Install K-Browser on each staff computer (Windows .exe installer, Linux AppImage or .deb).'),
    h('div', { class: 'panel' }, h('h2', {}, 'Server address'), urls.map((u) => h('div', { class: 'mono' }, u)), h('h2', { style: 'margin-top:14px' }, 'Certificate fingerprint (SHA-256)'), h('div', { class: 'mono' }, o.server.fingerprint), h('p', { class: 'help' }, 'When a staff computer connects for the first time K-Browser shows this fingerprint. It must match exactly — otherwise someone may be intercepting the connection.')),
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Option A — automatic'),
      h('p', {}, 'Open K-Browser on the staff computer. It searches the local network, finds this server and asks the user to confirm the fingerprint above.'),
      h('h2', {}, 'Option B — pre-configured (recommended for many PCs)'),
      h('p', {}, 'Save this as managed.json. Staff cannot change the server and no fingerprint prompt appears.'),
      h('pre', {}, managed),
      h('ul', {}, h('li', {}, 'Windows: ', h('code', {}, 'C:\\ProgramData\\KBrowser\\managed.json')), h('li', {}, 'Linux: ', h('code', {}, '/etc/kbrowser/managed.json')), h('li', {}, 'Or next to the K-Browser executable'))
    )
  );
};


function setRequestCount(n) {
  const el = $('#req-count');
  el.hidden = !n;
  el.textContent = n || '';
}

pages.requests = async (main) => {
  const list = await api('GET', '/admin/requests');
  const pending = list.filter((a) => a.status === 'pending');
  setRequestCount(pending.length);
  const decide = async (a, decision) => {
    if (decision === 'deny') {
      const note = h('input', { placeholder: 'Reason shown to the user (optional)' });
      const ok = await modal(`Decline ${a.username}'s request`, h('div', { class: 'rules' }, h('div', {}, a.url), h('label', {}, 'Note', note)), { onSave: () => api('POST', `/admin/requests/${a.id}/deny`, { note: note.value }), saveLabel: 'Decline' });
      if (ok) route();
      return;
    }
    const dur = h('select', {}, h('option', { value: '60' }, '1 hour'), h('option', { value: '240' }, '4 hours'), h('option', { value: '1440' }, '1 day'), h('option', { value: '10080' }, '7 days'), h('option', { value: '43200' }, '30 days'), h('option', { value: '0' }, 'Permanently'));
    const pattern = h('input', { value: a.host.replace(/^www\./, '') });
    const ok = await modal(
      `Approve ${a.username}'s request`,
      h('div', { class: 'rules' }, h('div', {}, h('strong', {}, 'Site: '), a.url), a.reason ? h('div', {}, h('strong', {}, 'Reason: '), a.reason) : null, h('label', {}, 'Allow this pattern', pattern), h('label', {}, 'For how long', dur), h('p', { class: 'help' }, 'Adds a personal allow rule for this user only. Time-limited rules switch off automatically.')),
      { onSave: () => api('POST', `/admin/requests/${a.id}/approve`, { minutes: Number(dur.value), pattern: pattern.value }), saveLabel: 'Approve' }
    );
    if (ok) route();
  };
  const table = (rows, actions) =>
    rows.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'When'), h('th', {}, 'User'), h('th', {}, 'Site'), h('th', {}, 'Reason'), h('th', {}, actions ? '' : 'Decision'))),
            h(
              'tbody',
              {},
              rows.map((a) =>
                h(
                  'tr',
                  {},
                  h('td', { title: fmtTime(a.createdAt) }, ago(a.createdAt)),
                  h('td', {}, a.username),
                  h('td', {}, h('strong', {}, a.host), h('div', { class: 'url' }, a.url)),
                  h('td', {}, a.reason || h('span', { class: 'muted' }, '—')),
                  h(
                    'td',
                    {},
                    actions
                      ? h('div', { class: 'actions' }, h('button', { class: 'small primary', onclick: () => decide(a, 'approve') }, 'Approve…'), h('button', { class: 'small danger', onclick: () => decide(a, 'deny') }, 'Decline'))
                      : h('div', {}, h('span', { class: 'badge ' + (a.status === 'approved' ? 'ok' : 'bad') }, a.status), ` by ${a.decidedBy || '?'}`, a.expiresAt ? h('div', { class: 'muted' }, `until ${fmtTime(a.expiresAt)}`) : null, a.note ? h('div', { class: 'muted' }, a.note) : null)
                  )
                )
              )
            )
          )
        )
      : h('p', { class: 'muted' }, 'Nothing here.');
  main.append(
    h('h1', {}, 'Access requests'),
    h('p', { class: 'sub' }, 'Staff can ask for a blocked website from the block page. Approve it for a limited time or permanently.'),
    h('h2', {}, `Waiting (${pending.length})`),
    table(pending, true),
    h('h2', { style: 'margin-top:22px' }, 'History'),
    table(list.filter((a) => a.status !== 'pending').slice(0, 100), false)
  );
};

pages.subscriptions = async (main) => {
  const d = await api('GET', '/admin/subscriptions');
  state.currency = d.currency;
  const soon = Date.now() + 30 * 24 * 3600 * 1000;
  main.append(
    h('h1', {}, 'Subscriptions'),
    h('p', { class: 'sub' }, 'Every paid account in the vault: cost, seats, who can use it and how much it is really used. Edit the details under Site logins.'),
    h('div', { class: 'grid' }, h('div', { class: 'stat' }, h('div', { class: 'n' }, money(d.monthlyCost)), h('div', { class: 'l' }, 'Total per month')), h('div', { class: 'stat' }, h('div', { class: 'n' }, money(d.monthlyCost * 12)), h('div', { class: 'l' }, 'Per year')), h('div', { class: 'stat' }, h('div', { class: 'n' }, d.items.length), h('div', { class: 'l' }, 'Accounts')), h('div', { class: 'stat' }, h('div', { class: 'n' }, d.seatsInUse), h('div', { class: 'l' }, 'Seats in use now'))),
    h('div', { style: 'height:16px' }),
    h(
      'div',
      { class: 'table-wrap' },
      h(
        'table',
        {},
        h('thead', {}, h('tr', {}, h('th', {}, 'Account'), h('th', {}, 'Seats in use'), h('th', {}, 'Eligible users'), h('th', {}, 'Used (30 days)'), h('th', {}, 'Cost / month'), h('th', {}, 'Cost per active user'), h('th', {}, 'Renews'))),
        h(
          'tbody',
          {},
          d.items.map((c) =>
            h(
              'tr',
              {},
              h('td', {}, h('strong', {}, c.name), h('div', { class: 'muted' }, [c.vendor, c.plan].filter(Boolean).join(' · ')), c.hasSession ? h('span', { class: 'badge ok' }, 'shared session') : null),
              h('td', {}, c.seats ? `${c.seatsInUse.length} / ${c.seats}` : `${c.seatsInUse.length} (no limit)`, c.seatsInUse.length ? h('div', { class: 'muted' }, c.seatsInUse.join(', ')) : null),
              h('td', {}, c.eligibleUsers),
              h('td', {}, `${c.activeUsers30d} user(s)`, h('div', { class: 'muted' }, `${c.uses30d} sign-ins`)),
              h('td', {}, c.costMonthly ? money(c.costMonthly) : '—'),
              h('td', {}, c.costMonthly && c.activeUsers30d ? money(c.costMonthly / c.activeUsers30d) : c.costMonthly ? h('span', { class: 'badge bad' }, 'unused') : '—'),
              h('td', {}, c.renewalDate ? h('span', { class: Date.parse(c.renewalDate) <= soon ? 'badge warn' : '' }, c.renewalDate) : '—')
            )
          )
        )
      )
    )
  );
};

const DLP_FIELDS = [
  ['blockCopy', 'Block copy / cut'],
  ['blockPaste', 'Block paste / drop'],
  ['blockUpload', 'Block file uploads'],
  ['blockDownload', 'Block downloads'],
  ['blockPrint', 'Block printing'],
  ['watermark', 'Show watermark (user · PC · time)'],
  ['screenshotProtect', 'Block screenshots & screen sharing (Windows)'],
];

pages.dlp = async (main) => {
  await loadDirectory();
  let rules = await api('GET', '/admin/dlp');
  const save = async () => {
    rules = await api('PUT', '/admin/dlp', rules);
    toast('Data protection rules saved and pushed to all browsers');
    route();
  };
  const edit = async (rule) => {
    const isNew = !rule;
    rule = rule || { name: '', match: [], everyone: true, groupIds: [], userIds: [], enabled: true };
    const f = {
      name: h('input', { value: rule.name, placeholder: 'e.g. CRM — customer data' }),
      match: h('textarea', { placeholder: 'One per line: crm.example.com, category:filesharing …', list: 'kb-categories' }, (rule.match || []).join('\n')),
      everyone: h('input', { type: 'checkbox', checked: rule.everyone }),
      groups: checkList(state.groups, rule.groupIds, (g) => g.name),
      users: checkList(state.users, rule.userIds, (u) => u.displayName || u.username),
      enabled: h('input', { type: 'checkbox', checked: rule.enabled !== false }),
    };
    const flags = DLP_FIELDS.map(([k, label]) => {
      const cb = h('input', { type: 'checkbox', checked: !!rule[k], 'data-k': k });
      return h('label', { class: 'check' }, cb, label);
    });
    const ok = await modal(
      isNew ? 'Add data protection rule' : `Edit ${rule.name}`,
      h(
        'div',
        { class: 'rules' },
        h('label', {}, 'Name', f.name),
        h('label', {}, 'Websites', f.match),
        h('fieldset', {}, h('legend', {}, 'Restrictions'), h('div', { class: 'checks', style: 'max-height:none' }, flags)),
        h('fieldset', {}, h('legend', {}, 'Applies to'), h('label', { class: 'check' }, f.everyone, 'Everyone'), h('div', {}, h('strong', {}, 'Groups'), f.groups), h('div', {}, h('strong', {}, 'Users'), f.users)),
        h('label', { class: 'check' }, f.enabled, 'Enabled')
      ),
      {
        wide: true,
        onSave: async () => {
          const row = { ...rule, name: f.name.value, match: f.match.value.split(/[\n,]/).map((x) => x.trim()).filter(Boolean), everyone: f.everyone.checked, groupIds: f.groups.values(), userIds: f.users.values(), enabled: f.enabled.checked };
          for (const cb of flags.map((l) => l.querySelector('input'))) row[cb.dataset.k] = cb.checked;
          if (!row.match.length) throw new Error('Add at least one website');
          rules = isNew ? [...rules, row] : rules.map((x) => (x === rule ? row : x));
          return true;
        },
      }
    );
    if (ok) await save();
  };
  const who = (r) => [r.everyone ? 'Everyone' : null, ...(r.groupIds || []).map((id) => 'Group: ' + groupName(id)), ...(r.userIds || []).map(userName)].filter(Boolean).join(', ') || '— nobody —';
  main.append(
    h('h1', {}, 'Data protection'),
    h('p', { class: 'sub' }, 'Stop company data leaving through the browser: block copy, paste, uploads, downloads, printing and screenshots on chosen websites, and stamp pages with a visible watermark that identifies the user.'),
    h('div', { class: 'toolbar' }, h('span', { class: 'spacer' }), h('button', { class: 'primary', onclick: () => edit() }, '+ Add rule')),
    rules.length
      ? h(
          'div',
          { class: 'table-wrap' },
          h(
            'table',
            {},
            h('thead', {}, h('tr', {}, h('th', {}, 'Rule'), h('th', {}, 'Websites'), h('th', {}, 'Restrictions'), h('th', {}, 'Applies to'), h('th', {}, ''))),
            h(
              'tbody',
              {},
              rules.map((r) =>
                h(
                  'tr',
                  {},
                  h('td', {}, h('strong', {}, r.name), r.enabled === false ? h('span', { class: 'badge off' }, 'off') : null),
                  h('td', {}, r.match.join(', ')),
                  h('td', {}, h('div', { class: 'flags' }, DLP_FIELDS.filter(([k]) => r[k]).map(([, label]) => h('span', { class: 'badge' }, label.replace(/ \(.*\)/, ''))))),
                  h('td', {}, who(r)),
                  h('td', {}, h('div', { class: 'actions' }, h('button', { class: 'small', onclick: () => edit(r) }, 'Edit'), h('button', { class: 'small danger', onclick: async () => { if (await confirmBox(`Delete rule ${r.name}?`, 'Delete')) { rules = rules.filter((x) => x !== r); await save(); } } }, 'Delete')))
                )
              )
            )
          )
        )
      : h('p', { class: 'muted' }, 'No rules yet. Example: protect your CRM or accounting site so customer data cannot be copied, downloaded or printed.')
  );
};

pages.reports = async (main) => {
  await loadDirectory();
  const today = new Date().toISOString().slice(0, 10);
  const weekAgo = new Date(Date.now() - 6 * 86400000).toISOString().slice(0, 10);
  const from = h('input', { type: 'date', value: weekAgo });
  const to = h('input', { type: 'date', value: today });
  const user = h('select', {}, h('option', { value: '' }, 'All users'), state.users.map((u) => h('option', { value: u.id }, u.username)));
  const groupBy = h('select', {}, h('option', { value: 'user' }, 'Per user and site'), h('option', { value: 'host' }, 'Per site (all users)'));
  const out = h('div');
  const params = () => new URLSearchParams({ from: from.value, to: to.value, userId: user.value, groupBy: groupBy.value });
  const load = async () => {
    const d = await api('GET', '/admin/reports/usage?' + params());
    const max = Math.max(1, ...d.rows.map((r) => r.seconds));
    const total = d.rows.reduce((n, r) => n + r.seconds, 0);
    out.replaceChildren(
      h('p', { class: 'muted' }, `${d.from} → ${d.to} · total active browsing ${duration(total)}`),
      d.rows.length
        ? h(
            'div',
            { class: 'table-wrap' },
            h(
              'table',
              {},
              h('thead', {}, h('tr', {}, groupBy.value === 'user' ? h('th', {}, 'User') : null, h('th', {}, 'Site'), h('th', {}, 'Active time'), h('th', { style: 'width:40%' }, ''))),
              h('tbody', {}, d.rows.slice(0, 300).map((r) => h('tr', {}, groupBy.value === 'user' ? h('td', {}, r.username) : null, h('td', {}, r.host), h('td', {}, duration(r.seconds)), h('td', {}, h('div', { class: 'bar', style: `width:${Math.round((r.seconds / max) * 100)}%` })))))
            )
          )
        : h('p', { class: 'muted' }, 'No usage recorded for this period.')
    );
  };
  for (const el of [from, to, user, groupBy]) el.addEventListener('change', load);
  main.append(
    h('h1', {}, 'Usage reports'),
    h('p', { class: 'sub' }, 'Active time per website (only while K-Browser is in front and the user is not idle). Requires "Log browsing activity".'),
    h('div', { class: 'toolbar' }, from, to, user, groupBy, h('span', { class: 'spacer' }), h('button', { onclick: () => download('/admin/reports/usage.csv?' + params(), 'kbrowser-usage.csv') }, 'Export CSV')),
    out
  );
  load();
};

pages.security = async (main) => {
  const [me, settings, integrity] = await Promise.all([api('GET', '/auth/me'), api('GET', '/admin/settings').catch(() => null), api('GET', '/admin/audit/verify')]);
  const twoFa = h('div', { class: 'panel rules' }, h('h2', {}, 'Two-factor authentication for your account'));
  if (me.user.twoFactor) {
    const pw = h('input', { type: 'password', placeholder: 'Your password' });
    twoFa.append(h('p', {}, h('span', { class: 'badge ok' }, 'On'), ' Your account asks for an authenticator code at sign-in.'), h('div', { class: 'toolbar' }, pw, h('button', { class: 'danger', onclick: async () => { await api('POST', '/auth/2fa/disable', { password: pw.value }); toast('Two-factor authentication turned off'); route(); } }, 'Turn off')));
  } else {
    const start = h('button', { class: 'primary' }, 'Set up two-factor authentication');
    start.addEventListener('click', async () => {
      const r = await api('POST', '/auth/2fa/setup', {});
      const code = h('input', { inputmode: 'numeric', maxlength: 6, placeholder: '6-digit code' });
      start.replaceWith(
        h(
          'div',
          { class: 'rules' },
          h('p', {}, 'In Google Authenticator, Microsoft Authenticator, Authy or similar choose "Enter a setup key" and type this key (time based):'),
          h('div', { class: 'secret' }, r.secret.replace(/(.{4})/g, '$1 ').trim()),
          h('p', { class: 'help' }, 'Or paste this link into a password manager that supports TOTP: ', h('code', {}, r.uri)),
          h('div', { class: 'toolbar' }, code, h('button', { class: 'primary', onclick: async () => { try { await api('POST', '/auth/2fa/enable', { code: code.value }); toast('Two-factor authentication is on'); route(); } catch (err) { toast(err.message); } } }, 'Verify & turn on'))
        )
      );
    });
    twoFa.append(h('p', {}, h('span', { class: 'badge bad' }, 'Off'), ' Anyone who learns your password can open this console.'), h('div', {}, start));
  }
  main.append(h('h1', {}, 'Security'), h('p', { class: 'sub' }, 'Protect the console, get alerts, and check the audit trail has not been tampered with.'), twoFa);

  if (settings) {
    const require2fa = h('input', { type: 'checkbox', checked: settings.requireAdmin2fa });
    const url = h('input', { value: settings.webhookUrl || '', placeholder: 'https://hooks.slack.com/services/… or Teams / Google Chat / Discord webhook' });
    const EVENTS = [
      ['blocked', 'Blocked website attempts'],
      ['access.request', 'Access requests'],
      ['login.failed', 'Failed sign-ins'],
      ['seat.denied', 'Licence seat full'],
      ['dlp.blocked', 'Data protection blocks'],
      ['admin.credential.update', 'Site login changes'],
      ['admin.user.create', 'New users'],
      ['admin.session.capture', 'Shared sessions'],
    ];
    const evs = EVENTS.map(([k, label]) => h('label', { class: 'check' }, h('input', { type: 'checkbox', value: k, checked: (settings.webhookEvents || []).includes(k) }), label));
    main.append(
      h(
        'div',
        { class: 'panel rules' },
        h('h2', {}, 'Policies'),
        h('label', { class: 'check' }, require2fa, 'Require two-factor authentication for all console accounts'),
        h('h2', { style: 'margin-top:10px' }, 'Alerts (webhook)'),
        h('label', {}, 'Webhook URL', url),
        h('div', { class: 'checks', style: 'max-height:none' }, evs),
        h(
          'div',
          { class: 'toolbar' },
          h('button', { class: 'primary', onclick: async () => { await api('PUT', '/admin/settings', { requireAdmin2fa: require2fa.checked, webhookUrl: url.value.trim(), webhookEvents: evs.map((l) => l.querySelector('input')).filter((i) => i.checked).map((i) => i.value) }); toast('Saved'); } }, 'Save'),
          h('button', { onclick: async () => { const r = await api('POST', '/admin/settings/test-webhook', {}); toast(r.ok ? 'Test alert sent' : `Webhook failed: ${r.error || r.status}`); } }, 'Send test alert')
        )
      )
    );
  }

  main.append(
    h(
      'div',
      { class: 'panel' },
      h('h2', {}, 'Audit log integrity'),
      integrity.ok
        ? h('p', {}, h('span', { class: 'badge ok' }, 'Verified'), ` All ${integrity.checked} recent log entries are intact. Each entry is chained to the previous one with SHA-256, so editing or deleting a line is detected.`)
        : h('p', {}, h('span', { class: 'badge bad' }, 'Tampering detected'), ` The chain breaks at the entry from ${fmtTime(integrity.brokenAt && integrity.brokenAt.ts)} (${integrity.brokenAt && integrity.brokenAt.type}).`)
    )
  );
};

// ---- shell ----------------------------------------------------------------------
async function route() {
  const name = (location.hash || '#dashboard').slice(1);
  const page = pages[name] || pages.dashboard;
  for (const a of document.querySelectorAll('#nav a')) a.classList.toggle('active', a.getAttribute('href') === '#' + name);
  const main = $('#main');
  const fresh = h('div');
  try {
    await page(fresh);
    main.replaceChildren(fresh);
  } catch (err) {
    main.replaceChildren(h('div', { class: 'panel error' }, err.message));
  }
}

function showApp() {
  $('#login-view').hidden = true;
  $('#app-view').hidden = false;
  $('#me-name').textContent = state.me ? `Signed in as ${state.me.displayName || state.me.username} (${ROLE_LABELS[state.me.role] || state.me.role})` : '';
  api('GET', '/admin/categories')
    .then((cats) => $('#kb-categories').replaceChildren(...cats.map((c) => h('option', { value: `category:${c.key}` }, `${c.label} (${c.count} sites)`))))
    .catch(() => {});
  route();
}

function signOut(callServer = true) {
  if (callServer && state.token) api('POST', '/auth/logout', {}).catch(() => {});
  state.token = '';
  sessionStorage.removeItem('kb_token');
  sessionStorage.removeItem('kb_me');
  $('#app-view').hidden = true;
  $('#login-view').hidden = false;
}

async function changePassword(force) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true, minlength: 8 });
  const again = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const ok = await modal(
    force ? 'Choose a new password' : 'Change password',
    h('div', { class: 'rules' }, force ? h('p', {}, 'Please replace the initial password before continuing.') : null, h('label', {}, 'Current password', cur), h('label', {}, 'New password (8+ characters)', next), h('label', {}, 'Repeat new password', again)),
    {
      onSave: async () => {
        if (next.value !== again.value) throw new Error('Passwords do not match');
        return api('POST', '/auth/password', { current: cur.value, next: next.value });
      },
    }
  );
  if (ok) toast('Password changed');
}

$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const fd = new FormData(e.target);
  $('#login-error').textContent = '';
  try {
    const body = { username: fd.get('username'), password: fd.get('password'), kind: 'console', device: 'Admin console' };
    if (fd.get('otp')) body.otp = fd.get('otp');
    let r;
    try {
      r = await api('POST', '/auth/login', body);
    } catch (err) {
      if (err.data && err.data.needOtp) {
        $('#otp-row').hidden = false;
        $('#login-form [name=otp]').focus();
      }
      throw err;
    }
    state.token = r.token;
    state.me = r.user;
    sessionStorage.setItem('kb_token', r.token);
    sessionStorage.setItem('kb_me', JSON.stringify(r.user));
    e.target.reset();
    $('#otp-row').hidden = true;
    showApp();
    if (r.mustChangePassword) await changePassword(true);
    if (r.mustEnable2fa) {
      toast('Your organisation requires two-factor authentication. Please set it up now.');
      location.hash = '#security';
    }
  } catch (err) {
    $('#login-error').textContent = err.message;
  }
});
$('#logout').addEventListener('click', () => signOut());
$('#change-pw').addEventListener('click', () => changePassword(false));
window.addEventListener('hashchange', route);

if (state.token) {
  try {
    state.me = JSON.parse(sessionStorage.getItem('kb_me') || 'null');
  } catch {
    state.me = null;
  }
  showApp();
} else {
  $('#login-view').hidden = false;
}
