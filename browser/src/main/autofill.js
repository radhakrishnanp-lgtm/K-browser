'use strict';
// Builds the script that fills a site login inside the page. It runs in an
// isolated JavaScript world, so page scripts cannot tamper with it. Staff never
// see the password: the field is kept as type=password, copy/drag is blocked,
// and any element that tries to reveal the password is masked again.

function fillerSource() {
  /* eslint-disable no-undef */
  return function kbFill(data) {
    if (location.origin !== data.origin) return;
    if (window.__kbFillActive) window.__kbFillActive.stop();

    const USER_RE = /user|email|e-mail|login|account|phone|mobile|identifier|uname/i;
    const OTP_RE = /otp|totp|2fa|mfa|one.?time|verification|auth.?code|security.?code|code|token|pin/i;
    const SUBMIT_RE = /sign.?in|log.?in|login|next|continue|submit|verify|proceed|weiter|connexion/i;
    const done = { user: false, pass: false, totp: false };
    let submits = 0;
    let stopped = false;

    const visible = (el) => {
      if (!el || el.disabled || el.readOnly) return false;
      const r = el.getBoundingClientRect();
      if (r.width < 2 || r.height < 2) return false;
      const s = getComputedStyle(el);
      return s.visibility !== 'hidden' && s.display !== 'none' && Number(s.opacity) > 0.05;
    };
    const q = (sel) => {
      if (!sel) return null;
      try {
        return document.querySelector(sel);
      } catch {
        return null;
      }
    };
    const inputs = () => Array.from(document.querySelectorAll('input')).filter(visible);
    const attrs = (el) => `${el.name} ${el.id} ${el.getAttribute('autocomplete') || ''} ${el.getAttribute('aria-label') || ''} ${el.placeholder || ''}`;

    function setValue(el, value) {
      el.focus();
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
    }

    const guarded = new WeakSet();
    function guard(el) {
      if (guarded.has(el)) return;
      guarded.add(el);
      const block = (e) => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      for (const ev of ['copy', 'cut', 'dragstart', 'selectstart']) el.addEventListener(ev, block, true);
      new MutationObserver(() => {
        if (el.type !== 'password') el.type = 'password';
      }).observe(el, { attributes: true, attributeFilter: ['type'] });
    }

    // Masks any other element that ends up holding the password ("show password" tricks).
    function maskLeaks() {
      if (!data.password) return;
      for (const el of document.querySelectorAll('input, textarea')) {
        if (el.value === data.password) {
          if (el instanceof HTMLInputElement) {
            if (el.type !== 'password') el.type = 'password';
            guard(el);
          } else {
            el.value = '';
          }
        }
      }
    }

    function findPassword() {
      const own = q(data.passwordSelector);
      if (own && visible(own)) return own;
      const list = inputs().filter((i) => i.type === 'password' && i.getAttribute('autocomplete') !== 'new-password');
      return list[0] || inputs().find((i) => i.type === 'password') || null;
    }

    function findUsername(pass) {
      const own = q(data.usernameSelector);
      if (own && visible(own)) return own;
      const scope = (pass && pass.form) || document;
      const candidates = Array.from(scope.querySelectorAll('input')).filter(
        (i) => visible(i) && ['text', 'email', 'tel', ''].includes(i.type) && !OTP_RE.test(i.getAttribute('autocomplete') || '')
      );
      const auto = candidates.find((i) => /username|email/.test(i.getAttribute('autocomplete') || ''));
      if (auto) return auto;
      if (pass) {
        const before = candidates.filter((i) => i.compareDocumentPosition(pass) & Node.DOCUMENT_POSITION_FOLLOWING);
        return before.reverse().find((i) => USER_RE.test(attrs(i))) || before[0] || null;
      }
      return candidates.find((i) => i.type === 'email' || USER_RE.test(attrs(i))) || null;
    }

    function findTotp() {
      const own = q(data.totpSelector);
      if (own && visible(own)) return own;
      return (
        inputs().find((i) => i.getAttribute('autocomplete') === 'one-time-code') ||
        inputs().find((i) => ['text', 'tel', 'number'].includes(i.type) && OTP_RE.test(attrs(i)) && (!i.maxLength || i.maxLength <= 10 || i.maxLength === -1)) ||
        null
      );
    }

    function submit(field) {
      if (!data.autoSubmit || submits >= 3) return;
      submits++;
      setTimeout(() => {
        const form = field && field.form;
        let btn = q(data.submitSelector);
        if (!btn && form) btn = form.querySelector('button[type=submit], input[type=submit]') || Array.from(form.querySelectorAll('button')).find((b) => SUBMIT_RE.test(b.textContent || b.value));
        if (!btn) btn = Array.from(document.querySelectorAll('button, input[type=submit], [role=button]')).filter(visible).find((b) => SUBMIT_RE.test(b.textContent || b.value || ''));
        if (btn) btn.click();
        else if (form && form.requestSubmit) form.requestSubmit();
        else if (field) field.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'Enter', keyCode: 13 }));
      }, 350);
    }

    function step() {
      if (stopped) return;
      maskLeaks();
      const pass = findPassword();
      if (pass) guard(pass);
      if (pass && !done.pass && data.password) {
        const user = findUsername(pass);
        if (user && data.username && user.value !== data.username) setValue(user, data.username);
        setValue(pass, data.password);
        guard(pass);
        done.user = true;
        done.pass = true;
        submit(pass);
        return;
      }
      if (!pass && !done.user && data.username) {
        const user = findUsername(null);
        if (user) {
          setValue(user, data.username);
          done.user = true;
          submit(user);
          return;
        }
      }
      if (data.totp && !done.totp && !pass) {
        const t = findTotp();
        if (t) {
          setValue(t, data.totp);
          done.totp = true;
          submit(t);
        }
      }
    }

    const mo = new MutationObserver(() => step());
    mo.observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['type', 'style', 'class', 'hidden'] });
    const iv = setInterval(step, 500);
    const leakIv = setInterval(maskLeaks, 400);
    const stop = () => {
      stopped = true;
      mo.disconnect();
      clearInterval(iv);
    };
    // Keep watching for multi-step logins for a while, then only keep masking.
    setTimeout(stop, 45000);
    setTimeout(() => clearInterval(leakIv), 10 * 60 * 1000);
    window.__kbFillActive = { stop };
    step();
  };
  /* eslint-enable no-undef */
}

function buildFillScript(secret, { origin, autoSubmit }) {
  const data = {
    origin,
    username: secret.username || '',
    password: secret.password || '',
    totp: secret.totp || '',
    usernameSelector: secret.usernameSelector || '',
    passwordSelector: secret.passwordSelector || '',
    totpSelector: secret.totpSelector || '',
    submitSelector: secret.submitSelector || '',
    autoSubmit: !!autoSubmit,
  };
  return `(${fillerSource().toString()})(${JSON.stringify(data)}); void 0;`;
}

module.exports = { buildFillScript };
