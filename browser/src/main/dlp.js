'use strict';
// Data-loss-prevention enforcement inside web pages. The script runs in an
// isolated JavaScript world so the website cannot remove the listeners or the
// watermark through its own scripts. Blocked attempts are reported to the main
// process through a console marker ("__kbdlp:<what>") and logged centrally.

function dlpSource() {
  /* eslint-disable no-undef */
  return function kbDlp(cfg) {
    if (window.__kbDlp) return window.__kbDlp.update(cfg);
    let flags = cfg;
    const report = (what) => console.log('__kbdlp:' + what);

    // Small notice shown inside the page, in a closed shadow root.
    const toastHost = document.createElement('div');
    const toastShadow = toastHost.attachShadow({ mode: 'closed' });
    toastShadow.innerHTML =
      '<style>div{position:fixed;left:50%;bottom:24px;transform:translateX(-50%);background:#1c2333;color:#fff;font:13px system-ui,sans-serif;padding:9px 16px;border-radius:8px;z-index:2147483647;box-shadow:0 4px 16px rgba(0,0,0,.25);pointer-events:none}</style><div></div>';
    let toastTimer = null;
    function toast(text) {
      toastShadow.querySelector('div').textContent = text;
      if (!toastHost.isConnected) document.documentElement.append(toastHost);
      clearTimeout(toastTimer);
      toastTimer = setTimeout(() => toastHost.remove(), 2500);
    }

    const deny = (e, what, text) => {
      e.preventDefault();
      e.stopImmediatePropagation();
      toast(text);
      report(what);
    };

    const hasFiles = (dt) => !!dt && Array.from(dt.types || []).includes('Files');

    const onCopy = (e) => flags.blockCopy && deny(e, 'copy', 'Copying from this site is disabled by your administrator');
    const onPaste = (e) => {
      if (flags.blockUpload && hasFiles(e.clipboardData)) return deny(e, 'upload', 'Uploading files to this site is disabled by your administrator');
      if (flags.blockPaste) deny(e, 'paste', 'Pasting into this site is disabled by your administrator');
    };
    const onDragStart = (e) => flags.blockCopy && deny(e, 'copy', 'Copying from this site is disabled by your administrator');
    const onDrop = (e) => {
      if (flags.blockUpload && hasFiles(e.dataTransfer)) return deny(e, 'upload', 'Uploading files to this site is disabled by your administrator');
      if (flags.blockPaste && !hasFiles(e.dataTransfer)) deny(e, 'paste', 'Dropping content into this site is disabled by your administrator');
    };
    const onDragOver = (e) => {
      if (flags.blockUpload && hasFiles(e.dataTransfer)) {
        e.preventDefault();
        e.dataTransfer.dropEffect = 'none';
      }
    };
    const isFileInput = (el) => el && el.tagName === 'INPUT' && el.type === 'file';
    const onClick = (e) => {
      if (!flags.blockUpload) return;
      const path = e.composedPath ? e.composedPath() : [e.target];
      if (path.some(isFileInput) || (e.target && e.target.closest && isFileInput(e.target.closest('label') && e.target.closest('label').control))) {
        deny(e, 'upload', 'Uploading files to this site is disabled by your administrator');
      }
    };
    const onChange = (e) => {
      if (flags.blockUpload && isFileInput(e.target) && e.target.files && e.target.files.length) {
        e.target.value = '';
        deny(e, 'upload', 'Uploading files to this site is disabled by your administrator');
      }
    };
    for (const [ev, fn] of [
      ['copy', onCopy],
      ['cut', onCopy],
      ['paste', onPaste],
      ['dragstart', onDragStart],
      ['drop', onDrop],
      ['dragover', onDragOver],
      ['click', onClick],
      ['change', onChange],
    ]) {
      window.addEventListener(ev, fn, true);
    }
    // Block programmatic file pickers (showOpenFilePicker / input.showPicker).
    if (flags.blockUpload) {
      try {
        HTMLInputElement.prototype.showPicker = function () {
          if (this.type === 'file') return report('upload');
          return undefined;
        };
      } catch {
        // not supported
      }
    }

    // ---- watermark ------------------------------------------------------------
    let mark = null;
    let markObserver = null;
    function drawWatermark() {
      if (!flags.watermark) {
        if (mark) mark.remove();
        if (markObserver) markObserver.disconnect();
        mark = null;
        return;
      }
      if (!mark) {
        mark = document.createElement('div');
        const shadow = mark.attachShadow({ mode: 'closed' });
        const text = String(flags.watermarkText || '');
        const svg = `<svg xmlns='http://www.w3.org/2000/svg' width='420' height='220'><text x='10' y='120' transform='rotate(-24 210 110)' fill='rgba(90,90,90,0.16)' font-family='Segoe UI, Arial, sans-serif' font-size='15'>${text.replace(/[<>&'"]/g, '')}</text></svg>`;
        shadow.innerHTML = `<style>:host{all:initial}div{position:fixed;inset:0;pointer-events:none;z-index:2147483646;background-image:url("data:image/svg+xml;utf8,${encodeURIComponent(svg)}");background-repeat:repeat}</style><div></div>`;
        markObserver = new MutationObserver(() => {
          if (mark && !mark.isConnected) document.documentElement.append(mark);
          if (mark && mark.style.cssText) mark.style.cssText = '';
          if (mark && mark.hidden) mark.hidden = false;
        });
        markObserver.observe(document.documentElement, { childList: true, subtree: false });
        markObserver.observe(mark, { attributes: true });
      }
      if (!mark.isConnected) document.documentElement.append(mark);
    }
    drawWatermark();

    window.__kbDlp = {
      update(next) {
        flags = next;
        drawWatermark();
      },
    };
  };
  /* eslint-enable no-undef */
}

function buildDlpScript(flags) {
  return `(${dlpSource().toString()})(${JSON.stringify(flags)}); void 0;`;
}

// Runs in the page's own world so that window.print() from site scripts is stopped too.
const PRINT_BLOCK_SCRIPT = `(() => { try { const block = () => console.log('__kbdlp:print'); Object.defineProperty(window, 'print', { value: block, writable: false, configurable: false }); } catch (e) {} })(); void 0;`;

module.exports = { buildDlpScript, PRINT_BLOCK_SCRIPT };
