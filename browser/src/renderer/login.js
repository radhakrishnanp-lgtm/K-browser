'use strict';
const $ = (id) => document.getElementById(id);
let init = null;
let password = '';

function show(section) {
  for (const id of ['signin', 'trust', 'newpw']) $(id).hidden = id !== section;
}

function busy(on) {
  $('submit').disabled = on;
  $('submit').textContent = on ? 'Signing in…' : 'Sign in';
}

async function doLogin() {
  busy(true);
  $('error').textContent = '';
  try {
    const r = await window.kb.submit({ serverUrl: $('server').value, username: $('username').value.trim(), password: $('password').value, otp: $('otp').value.trim() });
    if (r && r.needOtp) {
      $('otp-row').hidden = false;
      $('error').textContent = $('otp').value ? r.message : '';
      $('otp').value = '';
      $('otp').focus();
      return;
    }
    if (r && r.mustChangePassword) {
      password = $('password').value;
      show('newpw');
      $('np1').focus();
    }
  } catch (err) {
    show('signin');
    $('error').textContent = err.message;
    $('password').select();
  } finally {
    busy(false);
  }
}

$('signin').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('error').textContent = '';
  busy(true);
  try {
    const p = await window.kb.probe($('server').value);
    $('server').value = p.serverUrl;
    $('org').textContent = p.name || 'Secure workplace browser';
    if (p.banner) {
      $('banner').textContent = p.banner;
      $('banner').hidden = false;
    }
    if (p.status === 'trusted') return doLogin();
    $('trust-server').textContent = p.serverUrl;
    $('trust-fp').textContent = p.fingerprint;
    const changed = p.status === 'changed';
    $('trust').classList.toggle('changed', changed);
    $('trust-title').textContent = changed ? 'Warning: server identity changed' : 'Trust this server?';
    if (changed) {
      $('trust-text').textContent =
        'The certificate of this server is different from the one this computer trusted before. This can happen after the server was reinstalled — or if someone is intercepting the connection. Only continue if your administrator confirms the fingerprint below.';
    }
    busy(false);
    show('trust');
  } catch (err) {
    busy(false);
    $('error').textContent = err.message;
  }
});

$('trust-ok').addEventListener('click', () => {
  show('signin');
  doLogin();
});
$('trust-cancel').addEventListener('click', () => show('signin'));

$('find').addEventListener('click', async () => {
  const box = $('found');
  box.hidden = false;
  box.textContent = 'Searching the network…';
  try {
    const list = await window.kb.discover();
    box.textContent = '';
    if (!list.length) {
      box.textContent = 'No server found. Ask your administrator for the address.';
      return;
    }
    for (const s of list) {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = s.name || 'K-Browser server';
      const small = document.createElement('small');
      small.textContent = s.url;
      b.append(small);
      b.addEventListener('click', () => {
        $('server').value = s.url;
        box.hidden = true;
        $('username').focus();
      });
      box.append(b);
    }
  } catch (err) {
    box.textContent = err.message;
  }
});

$('newpw').addEventListener('submit', async (e) => {
  e.preventDefault();
  $('np-error').textContent = '';
  if ($('np1').value !== $('np2').value) {
    $('np-error').textContent = 'Passwords do not match';
    return;
  }
  try {
    await window.kb.setPassword(password, $('np1').value);
  } catch (err) {
    $('np-error').textContent = err.message;
  }
});

window.kb.onMessage((msg) => {
  show('signin');
  $('error').textContent = msg || '';
  $('password').value = '';
});

(async () => {
  init = await window.kb.init();
  $('server').value = init.serverUrl;
  $('username').value = init.username;
  if (init.locked) {
    $('server-row').hidden = true;
    $('server-locked').hidden = false;
    $('server-locked').textContent = `Server: ${init.serverUrl} (set by your administrator)`;
  }
  if (init.message) $('error').textContent = init.message;
  $('footer').textContent = `K-Browser ${init.version} · ${init.device}`;
  (init.username ? $('password') : init.serverUrl ? $('username') : $('server')).focus();
  if (!init.serverUrl && !init.locked) $('find').click();
})();
