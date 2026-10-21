'use strict';
const $ = (id) => document.getElementById(id);
const ui = window.kb;
let tabsState = { tabs: [], activeId: null };
let editingAddress = false;

function el(tag, cls, text) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (text !== undefined) e.textContent = text;
  return e;
}

// Keep the tab views positioned right below the browser chrome.
new ResizeObserver(() => ui.send('chrome-height', $('chrome').getBoundingClientRect().height)).observe($('chrome'));

function displayUrl(url) {
  if (!url || url.startsWith('kb://newtab')) return '';
  if (url.startsWith('kb://blocked')) {
    try {
      return new URL(url).searchParams.get('url') || url;
    } catch {
      return url;
    }
  }
  return url;
}

function renderTabs() {
  const box = $('tabs');
  box.textContent = '';
  for (const t of tabsState.tabs) {
    const tab = el('div', 'tab' + (t.id === tabsState.activeId ? ' active' : ''));
    tab.setAttribute('role', 'tab');
    tab.title = `${t.title}\n${displayUrl(t.url)}`;
    tab.draggable = true;
    if (t.loading) tab.append(el('span', 'spin'));
    else if (t.favicon) {
      const img = el('img', 'fav');
      img.src = t.favicon;
      img.onerror = () => img.remove();
      tab.append(img);
    }
    tab.append(el('span', 'title', t.title || 'New tab'));
    const close = el('button', 'close', '✕');
    close.title = 'Close tab (Ctrl+W)';
    close.addEventListener('click', (e) => {
      e.stopPropagation();
      ui.send('close-tab', t.id);
    });
    tab.append(close);
    tab.addEventListener('mousedown', (e) => {
      if (e.button === 0) ui.send('activate', t.id);
      if (e.button === 1) ui.send('close-tab', t.id);
    });
    tab.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      ui.send('tab-menu', t.id);
    });
    tab.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/kb-tab', String(t.id));
      tab.classList.add('dragging');
    });
    tab.addEventListener('dragend', () => tab.classList.remove('dragging'));
    tab.addEventListener('dragover', (e) => e.preventDefault());
    tab.addEventListener('drop', (e) => {
      e.preventDefault();
      const id = Number(e.dataTransfer.getData('text/kb-tab'));
      if (id && id !== t.id) ui.send('move-tab', id, tabsState.tabs.findIndex((x) => x.id === t.id));
    });
    box.append(tab);
  }
}

function renderToolbar() {
  const t = tabsState.tabs.find((x) => x.id === tabsState.activeId);
  $('back').disabled = !t || !t.canGoBack;
  $('forward').disabled = !t || !t.canGoForward;
  $('reload').innerHTML = t && t.loading ? '&#x2715;' : '&#x21bb;';
  $('reload').title = t && t.loading ? 'Stop' : 'Reload (F5)';
  if (!editingAddress) $('address').value = t ? displayUrl(t.url) : '';
  $('lock').textContent = t && t.url.startsWith('https:') ? '\u{1f512}' : t && t.url.startsWith('http:') ? '⚠' : '';
  $('lock').title = t && t.url.startsWith('http:') ? 'Connection is not secure' : 'Secure connection';
  $('zoom').hidden = !t || t.zoom === 100;
  if (t) $('zoom').textContent = `${t.zoom}%`;
  const logins = (t && t.logins) || [];
  $('key').hidden = !logins.length;
  $('key-label').textContent = t && t.filled ? 'Signed in by K-Browser' : logins.length > 1 ? `${logins.length} managed logins` : 'Managed login';
  const n = tabsState.downloads || 0;
  $('dl-count').hidden = !n;
  $('dl-count').textContent = n;
}

ui.on('tabs', (s) => {
  tabsState = s;
  renderTabs();
  renderToolbar();
});

ui.on('state', (s) => {
  const name = (s.user && s.user.displayName) || '';
  $('username').textContent = name;
  $('avatar').textContent = name.slice(0, 1).toUpperCase();
  $('status').classList.toggle('offline', !s.online);
  $('status').title = s.online ? `Connected to ${s.orgName}` : 'Server offline — using the last known policy';
  const bm = $('bookmarks');
  bm.textContent = '';
  for (const b of s.bookmarks || []) {
    const btn = el('button', '', b.title);
    btn.title = b.url;
    btn.addEventListener('click', (e) => (e.ctrlKey || e.button === 1 ? ui.send('new-tab', b.url) : ui.send('navigate', b.url)));
    btn.addEventListener('auxclick', (e) => e.button === 1 && ui.send('new-tab', b.url));
    bm.append(btn);
  }
});

ui.on('notify', (n) => {
  const box = el('div', `notice ${n.level || 'info'}`);
  const text = el('div', 'text', n.text || '');
  if (n.from) text.append(el('div', 'from', `— ${n.from}`));
  box.append(text);
  if (n.action && n.action.path) {
    const a = el('button', '', n.action.label);
    a.addEventListener('click', () => ui.send('show-item', n.action.path));
    box.append(a);
  }
  const close = el('button', '', n.sticky ? 'OK' : '✕');
  close.addEventListener('click', () => box.remove());
  box.append(close);
  $('notices').append(box);
  while ($('notices').children.length > 4) $('notices').firstChild.remove();
  if (!n.sticky && n.level !== 'critical') setTimeout(() => box.remove(), 8000);
});

ui.on('focus-address', () => {
  $('address').focus();
  $('address').select();
});

// ---- toolbar ----------------------------------------------------------------
$('new-tab').addEventListener('click', () => ui.send('new-tab'));
$('back').addEventListener('click', () => ui.send('back'));
$('forward').addEventListener('click', () => ui.send('forward'));
$('reload').addEventListener('click', () => {
  const t = tabsState.tabs.find((x) => x.id === tabsState.activeId);
  ui.send(t && t.loading ? 'stop' : 'reload');
});
$('home').addEventListener('click', () => ui.send('home'));
$('menu').addEventListener('click', () => ui.send('menu'));
$('downloads').addEventListener('click', () => ui.send('downloads'));
$('key').addEventListener('click', () => ui.send('login-menu', tabsState.activeId));
$('tabstrip').addEventListener('dblclick', (e) => e.target.id === 'tabs' && ui.send('new-tab'));

$('address').addEventListener('focus', () => {
  editingAddress = true;
  setTimeout(() => $('address').select(), 0);
});
$('address').addEventListener('blur', () => {
  editingAddress = false;
  renderToolbar();
});
$('address').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    editingAddress = false;
    renderToolbar();
    $('address').blur();
  }
});
$('omnibox').addEventListener('submit', (e) => {
  e.preventDefault();
  const v = $('address').value.trim();
  if (!v) return;
  editingAddress = false;
  $('address').blur();
  ui.send('navigate', v);
});

// ---- find in page ------------------------------------------------------------
function openFind() {
  $('findbar').hidden = false;
  $('find-input').focus();
  $('find-input').select();
}
function closeFind() {
  $('findbar').hidden = true;
  $('find-count').textContent = '';
  ui.send('find-stop');
}
ui.on('find-open', openFind);
ui.on('find-result', (r) => ($('find-count').textContent = r.total ? `${r.active} of ${r.total}` : 'No matches'));
$('find-input').addEventListener('input', () => ui.send('find', $('find-input').value, { forward: true, findNext: false }));
$('findbar').addEventListener('submit', (e) => {
  e.preventDefault();
  ui.send('find', $('find-input').value, { forward: true, findNext: true });
});
$('find-next').addEventListener('click', () => ui.send('find', $('find-input').value, { forward: true, findNext: true }));
$('find-prev').addEventListener('click', () => ui.send('find', $('find-input').value, { forward: false, findNext: true }));
$('find-close').addEventListener('click', closeFind);
$('find-input').addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeFind();
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    ui.send('find', $('find-input').value, { forward: false, findNext: true });
  }
});

// ---- change password -----------------------------------------------------------
ui.on('password-open', () => {
  $('pwform').hidden = false;
  $('pw-msg').textContent = '';
  $('pw-cur').focus();
});
$('pw-cancel').addEventListener('click', () => {
  $('pwform').hidden = true;
  $('pwform').reset();
});
$('pwform').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await ui.invoke('change-password', $('pw-cur').value, $('pw-new').value);
    $('pwform').reset();
    $('pwform').hidden = true;
  } catch (err) {
    $('pw-msg').textContent = err.message;
  }
});
