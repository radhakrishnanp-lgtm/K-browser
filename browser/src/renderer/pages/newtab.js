'use strict';
function tile(item, badge) {
  const a = document.createElement('a');
  a.className = 'tile';
  a.href = item.url;
  const ico = document.createElement('span');
  ico.className = 'ico';
  ico.textContent = (item.name || item.title || '?').slice(0, 1).toUpperCase();
  try {
    const img = document.createElement('img');
    img.src = new URL('/favicon.ico', item.url).href;
    img.alt = '';
    img.onload = () => ico.replaceChildren(img);
  } catch {
    // keep the letter
  }
  const label = document.createElement('span');
  label.textContent = item.name || item.title;
  a.append(ico, label);
  if (badge) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = badge;
    a.append(b);
  }
  return a;
}

fetch('kb://newtab/data.json')
  .then((r) => r.json())
  .then((d) => {
    const hour = new Date().getHours();
    const part = hour < 12 ? 'Good morning' : hour < 17 ? 'Good afternoon' : 'Good evening';
    document.getElementById('greeting').textContent = d.user ? `${part}, ${d.user.split(' ')[0]}` : part;
    document.getElementById('org').textContent = d.orgName || '';
    if (d.apps && d.apps.length) {
      document.getElementById('apps-section').hidden = false;
      for (const a of d.apps) document.getElementById('apps').append(tile(a, '\u{1f511} auto sign-in'));
    }
    if (d.bookmarks && d.bookmarks.length) {
      document.getElementById('bm-section').hidden = false;
      for (const b of d.bookmarks) document.getElementById('bookmarks').append(tile(b));
    }
    document.getElementById('search').addEventListener('submit', (e) => {
      e.preventDefault();
      const q = document.getElementById('q').value.trim();
      if (!q) return;
      const tpl = d.searchUrl || 'https://www.google.com/search?q=%s';
      location.href = tpl.replace('%s', encodeURIComponent(q));
    });
  });
