'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const { app, BrowserWindow, WebContentsView, Menu, clipboard, shell: osShell, Notification, webFrameMain, powerMonitor } = require('electron');
const { configureSession } = require('./session');
const { credentialMatches, evaluateUrl, dlpFor } = require('./match');
const { buildFillScript } = require('./autofill');
const { buildDlpScript, PRINT_BLOCK_SCRIPT } = require('./dlp');

const RENDERER = path.join(__dirname, '..', 'renderer');
const ISOLATED_WORLD = 1001;
const DLP_WORLD = 1002;
const DLP_LABELS = {
  blockCopy: 'copy blocked',
  blockPaste: 'paste blocked',
  blockPrint: 'printing blocked',
  blockDownload: 'downloads blocked',
  blockUpload: 'uploads blocked',
  watermark: 'watermarked',
  screenshotProtect: 'screenshots blocked',
};

// Registrable part of a host name, e.g. app.canva.com -> canva.com, a.b.co.in -> b.co.in
function baseDomain(host) {
  if (/^[\d.]+$/.test(host) || !host.includes('.')) return host;
  const parts = host.split('.');
  const sld = parts[parts.length - 2];
  if (parts.length > 2 && parts[parts.length - 1].length === 2 && ['co', 'com', 'org', 'net', 'gov', 'ac', 'edu', 'ne', 'or', 'nic'].includes(sld)) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}
const contexts = new Map(); // partition -> live policy context for session handlers

function hostOf(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function uniquePath(dir, filename) {
  const safe = filename.replace(/[\\/:*?"<>|]/g, '_') || 'download';
  const ext = path.extname(safe);
  const stem = safe.slice(0, safe.length - ext.length);
  let candidate = path.join(dir, safe);
  for (let i = 1; fs.existsSync(candidate); i++) candidate = path.join(dir, `${stem} (${i})${ext}`);
  return candidate;
}

class Shell {
  constructor(controller, boot) {
    this.controller = controller;
    this.client = controller.client;
    this.boot = boot;
    this.tabs = new Map();
    this.order = [];
    this.activeId = null;
    this.nextId = 1;
    this.chromeHeight = 112;
    this.fullscreen = false;
    this.downloads = [];
    this.activity = [];
    this.secretCache = new Map();
    this.autoSubmits = new Map();
    this.preferred = new Map();
    this.importedSessions = new Map(); // credentialId -> session version already in the cookie jar
    this.seatOk = new Map(); // credentialId -> time of last successful seat check
    this.usage = {}; // host -> active seconds since last report
    this.dlpReports = new Map();
    this.closed = false;
    this.partition = `persist:kb-${boot.user.id}`;

    contexts.set(this.partition, this.makeContext());
    this.ses = configureSession(this.partition, () => contexts.get(this.partition));

    this.win = new BrowserWindow({
      width: 1280,
      height: 820,
      minWidth: 640,
      minHeight: 400,
      show: false,
      title: `K-Browser — ${boot.user.displayName}`,
      backgroundColor: '#f1f3f6',
      autoHideMenuBar: true,
      icon: controller.iconPath,
      webPreferences: {
        preload: path.join(__dirname, 'preload-shell.js'),
        contextIsolation: true,
        sandbox: true,
        devTools: !!process.env.KB_DEBUG,
      },
    });
    this.win.setMenuBarVisibility(false);
    this.win.loadFile(path.join(RENDERER, 'browser.html'));
    this.win.once('ready-to-show', () => {
      this.win.maximize();
      this.win.show();
    });
    this.win.on('resize', () => this.layout());
    this.win.on('maximize', () => this.layout());
    this.win.on('unmaximize', () => this.layout());
    this.win.on('closed', () => this.dispose());
    this.win.webContents.on('before-input-event', (e, input) => this.handleShortcut(e, input, null));
    this.win.webContents.once('did-finish-load', () => {
      this.pushState();
      this.newTab(this.settings.homepage || 'kb://newtab');
    });

    this.activityTimer = setInterval(() => this.flushActivity(), 15000);
    this.idleTimer = setInterval(() => this.checkIdle(), 30000);
    this.usageTimer = setInterval(() => this.trackUsage(), 5000);
  }

  get settings() {
    return this.boot.settings || {};
  }

  makeContext() {
    const serverUrl = new URL(this.controller.serverUrl);
    return {
      policy: this.boot.policy,
      settings: this.boot.settings,
      certPem: this.controller.certPem,
      serverHost: serverUrl.hostname,
      isServerUrl: (url) => {
        try {
          return new URL(url).origin === serverUrl.origin;
        } catch {
          return false;
        }
      },
      onBlocked: (details, verdict) => this.onBlocked(details, verdict),
      onDownload: (event, item, wc) => this.onDownload(event, item, wc),
      onAccessRequest: (url, reason) => this.requestAccess(url, reason),
      prepareNavigation: (details) => this.prepareNavigation(details),
      pageData: (page) => this.pageData(page),
    };
  }

  // Called when the server pushes new policy/settings.
  update(boot) {
    this.boot = boot;
    contexts.set(this.partition, this.makeContext());
    this.secretCache.clear();
    this.pushState();
    // Re-check open tabs against the new policy.
    for (const tab of this.tabs.values()) {
      const url = tab.view.webContents.getURL();
      const ctx = contexts.get(this.partition);
      if (/^https?:/.test(url) && !ctx.isServerUrl(url) && !evaluateUrl(url, boot.policy).allowed) tab.view.webContents.reload();
      this.refreshMatches(tab);
      const before = JSON.stringify(tab.dlp || {});
      if (JSON.stringify(dlpFor(url, boot.dlp)) !== before) this.applyDlp(tab, tab.view.webContents.mainFrame);
    }
    this.updateContentProtection();
    this.pushTabs();
  }

  // ---- UI state ----------------------------------------------------------
  send(channel, payload) {
    if (!this.win.isDestroyed()) this.win.webContents.send(channel, payload);
  }

  pushState() {
    this.send('state', {
      user: this.boot.user,
      orgName: this.boot.orgName,
      bookmarks: this.boot.bookmarks,
      settings: {
        allowPrinting: this.settings.allowPrinting,
        isAdmin: !!this.settings.isAdmin,
        allowDevTools: !!this.settings.allowDevTools,
      },
      online: this.controller.online,
    });
  }

  pushTabs() {
    if (this.pushPending) return;
    this.pushPending = true;
    setTimeout(() => {
      this.pushPending = false;
      if (this.closed) return;
      this.send('tabs', {
        activeId: this.activeId,
        tabs: this.order.map((id) => {
          const t = this.tabs.get(id);
          const wc = t.view.webContents;
          return {
            id,
            title: t.title || (t.url === 'kb://newtab/' ? 'New tab' : t.url),
            url: t.url,
            favicon: t.favicon,
            loading: t.loading,
            canGoBack: wc.navigationHistory.canGoBack(),
            canGoForward: wc.navigationHistory.canGoForward(),
            secure: t.url.startsWith('https:'),
            logins: t.matches.map((c) => ({ id: c.id, name: c.name })),
            filled: !!t.filledCredId,
            protections: Object.keys(t.dlp || {}).map((k) => DLP_LABELS[k]).filter(Boolean),
            zoom: Math.round(wc.getZoomFactor() * 100),
          };
        }),
        downloads: this.downloads.filter((d) => d.state === 'progressing').length,
      });
    }, 30);
  }

  setChromeHeight(h) {
    this.chromeHeight = Math.max(0, Math.round(h));
    this.layout();
  }

  layout() {
    if (this.closed) return;
    const [w, h] = this.win.getContentSize();
    const top = this.fullscreen ? 0 : this.chromeHeight;
    for (const t of this.tabs.values()) {
      t.view.setBounds({ x: 0, y: top, width: w, height: Math.max(0, h - top) });
    }
  }

  // ---- tabs ----------------------------------------------------------------
  newTab(url, { active = true } = {}) {
    const max = Number(this.settings.maxTabs) || 0;
    if (max && this.tabs.size >= max) {
      this.notify({ level: 'warning', text: `Your administrator allows at most ${max} open tabs.` });
      return null;
    }
    const view = new WebContentsView({
      webPreferences: {
        partition: this.partition,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: !!this.settings.allowDevTools,
        spellcheck: true,
        safeDialogs: true,
      },
    });
    view.setBackgroundColor('#ffffff');
    const id = this.nextId++;
    const tab = { id, view, title: '', url: '', favicon: '', loading: false, matches: [], filledCredId: null, dlp: {} };
    this.tabs.set(id, tab);
    const idx = this.activeId ? this.order.indexOf(this.activeId) + 1 : this.order.length;
    this.order.splice(idx, 0, id);
    this.win.contentView.addChildView(view);
    view.setVisible(false);
    this.wireTab(tab);
    this.layout();
    this.navigate(tab, url || this.settings.homepage || 'kb://newtab');
    if (active || !this.activeId) this.activate(id);
    this.pushTabs();
    return tab;
  }

  activate(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    this.activeId = id;
    for (const t of this.tabs.values()) t.view.setVisible(t.id === id);
    this.layout();
    this.updateContentProtection();
    if (tab.url && tab.url !== 'kb://newtab/') tab.view.webContents.focus();
    else this.send('focus-address');
    this.pushTabs();
  }

  closeTab(id) {
    const tab = this.tabs.get(id);
    if (!tab) return;
    const idx = this.order.indexOf(id);
    this.order.splice(idx, 1);
    this.tabs.delete(id);
    this.win.contentView.removeChildView(tab.view);
    tab.view.webContents.close();
    if (!this.order.length) {
      this.activeId = null;
      this.newTab();
      return;
    }
    if (this.activeId === id) this.activate(this.order[Math.min(idx, this.order.length - 1)]);
    this.pushTabs();
  }

  activeTab() {
    return this.tabs.get(this.activeId) || null;
  }

  resolveInput(text) {
    const s = String(text || '').trim();
    if (!s) return null;
    if (/^(https?|kb):\/\//i.test(s)) return s;
    if (/^about:blank$/i.test(s)) return s;
    if (/^file:/i.test(s)) return this.settings.allowFileUrls ? s : `kb://blocked/?url=${encodeURIComponent(s)}&reason=scheme`;
    if (/^[a-z][a-z0-9+.-]*:(?!\d)/i.test(s) && !/^localhost:/i.test(s)) {
      // javascript:, data:, view-source:, chrome:, devtools: … are never allowed from the address bar
      return `kb://blocked/?url=${encodeURIComponent(s)}&reason=scheme`;
    }
    if (!/\s/.test(s) && (/^[^/]+\.[^/]+/.test(s) || /^localhost(:\d+)?(\/|$)/i.test(s) || /^\[[0-9a-f:]+\]/i.test(s))) {
      return (/^(localhost|127\.|10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/.test(s) ? 'http://' : 'https://') + s;
    }
    const tpl = this.boot.settings.searchUrl || 'https://www.google.com/search?q=%s';
    return tpl.replace('%s', encodeURIComponent(s));
  }

  navigate(tab, input) {
    const url = this.resolveInput(input);
    if (!url) return;
    tab.url = url;
    tab.view.webContents.loadURL(url).catch(() => {});
  }

  wireTab(tab) {
    const wc = tab.view.webContents;
    wc.setWindowOpenHandler(({ url, disposition, features }) => {
      if (disposition === 'new-window' && features) {
        return {
          action: 'allow',
          overrideBrowserWindowOptions: {
            autoHideMenuBar: true,
            icon: this.controller.iconPath,
            webPreferences: { sandbox: true, contextIsolation: true, devTools: !!this.settings.allowDevTools },
          },
        };
      }
      this.newTab(url, { active: disposition !== 'background-tab' });
      return { action: 'deny' };
    });
    wc.on('did-create-window', (win) => this.wirePopup(win));
    wc.on('page-title-updated', (e, title) => {
      tab.title = title;
      if (tab.id === this.activeId) this.win.setTitle(`${title} — K-Browser`);
      this.pushTabs();
    });
    wc.on('page-favicon-updated', (e, favicons) => {
      tab.favicon = favicons[0] || '';
      this.pushTabs();
    });
    wc.on('did-start-loading', () => {
      tab.loading = true;
      this.pushTabs();
    });
    wc.on('did-stop-loading', () => {
      tab.loading = false;
      this.pushTabs();
    });
    wc.on('did-navigate', (e, url) => {
      tab.url = url;
      tab.favicon = '';
      tab.filledCredId = null;
      tab.dlp = dlpFor(url, this.boot.dlp);
      this.updateContentProtection();
      this.refreshMatches(tab);
      if (/^https?:/.test(url)) this.logActivity({ type: 'visit', url, title: '', tabId: tab.id });
      this.pushTabs();
    });
    wc.on('did-navigate-in-page', (e, url, isMainFrame) => {
      if (!isMainFrame) return;
      tab.url = url;
      this.refreshMatches(tab);
      this.maybeAutofill(tab, wc.mainFrame);
      this.pushTabs();
    });
    wc.on('did-frame-finish-load', (e, isMainFrame, frameProcessId, frameRoutingId) => {
      const frame = isMainFrame ? wc.mainFrame : webFrameMain.fromId(frameProcessId, frameRoutingId);
      if (!frame) return;
      this.applyDlp(tab, frame);
      this.maybeAutofill(tab, frame);
    });
    // DLP scripts report blocked attempts with a console marker.
    wc.on('console-message', (e, level, message) => {
      const text = typeof message === 'string' ? message : e.message;
      if (typeof text === 'string' && text.startsWith('__kbdlp:')) this.onDlpEvent(tab, text.slice(8));
    });
    wc.on('did-fail-load', (e, code, desc, url, isMainFrame) => {
      if (!isMainFrame || code === -3 || code === -20 || code === -27) return;
      wc.loadURL(`kb://error/?url=${encodeURIComponent(url)}&code=${code}&desc=${encodeURIComponent(desc)}`).catch(() => {});
    });
    wc.on('found-in-page', (e, result) => {
      if (tab.id === this.activeId) this.send('find-result', { active: result.activeMatchOrdinal, total: result.matches });
    });
    wc.on('context-menu', (e, params) => this.contextMenu(tab, params));
    wc.on('before-input-event', (e, input) => this.handleShortcut(e, input, tab));
    wc.on('devtools-opened', () => {
      if (!this.settings.allowDevTools) wc.closeDevTools();
    });
    wc.on('enter-html-full-screen', () => {
      this.fullscreen = true;
      this.win.setFullScreen(true);
      this.layout();
    });
    wc.on('leave-html-full-screen', () => {
      this.fullscreen = false;
      this.win.setFullScreen(false);
      this.layout();
    });
    wc.on('render-process-gone', (e, details) => {
      if (details.reason !== 'clean-exit') {
        wc.loadURL(`kb://error/?url=${encodeURIComponent(tab.url)}&code=crashed&desc=${encodeURIComponent('This page crashed (' + details.reason + ')')}`).catch(() => {});
      }
    });
    wc.on('will-attach-webview', (e) => e.preventDefault());
  }

  wirePopup(win) {
    const wc = win.webContents;
    win.setMenuBarVisibility(false);
    const pseudoTab = { id: -1, view: { webContents: wc }, url: '', matches: [], filledCredId: null, dlp: {} };
    wc.on('did-frame-finish-load', (e, isMainFrame, pid, rid) => {
      pseudoTab.url = wc.getURL();
      this.refreshMatches(pseudoTab);
      const frame = isMainFrame ? wc.mainFrame : webFrameMain.fromId(pid, rid);
      if (!frame) return;
      this.applyDlp(pseudoTab, frame);
      this.maybeAutofill(pseudoTab, frame);
    });
    wc.on('console-message', (e, level, message) => {
      const text = typeof message === 'string' ? message : e.message;
      if (typeof text === 'string' && text.startsWith('__kbdlp:')) this.onDlpEvent(pseudoTab, text.slice(8));
    });
    wc.on('context-menu', (e, params) => this.contextMenu(pseudoTab, params));
    wc.on('before-input-event', (e, input) => {
      if ((input.key === 'F12' || (input.control && input.shift && input.key.toLowerCase() === 'i')) && !this.settings.allowDevTools) e.preventDefault();
    });
    wc.on('devtools-opened', () => {
      if (!this.settings.allowDevTools) wc.closeDevTools();
    });
  }

  // ---- managed logins --------------------------------------------------------
  refreshMatches(tab) {
    const url = tab.view.webContents.getURL() || tab.url;
    tab.matches = /^https?:/.test(url) ? (this.boot.credentials || []).filter((c) => credentialMatches(url, c)) : [];
  }

  chooseCredential(tab, url) {
    if (!tab.matches.length) return null;
    const pref = this.preferred.get(hostOf(url));
    return tab.matches.find((c) => c.id === pref) || tab.matches[0];
  }

  async getSecret(credentialId, url) {
    const key = credentialId;
    const hit = this.secretCache.get(key);
    if (hit && Date.now() - hit.at < 60000 && !hit.secret.totp) return hit.secret;
    const secret = await this.client.request('POST', '/api/client/fill', { credentialId, url });
    this.secretCache.set(key, { secret, at: Date.now() });
    setTimeout(() => {
      const cur = this.secretCache.get(key);
      if (cur && Date.now() - cur.at >= 60000) this.secretCache.delete(key);
    }, 60000);
    return secret;
  }

  // Limits automatic submits so a wrong password cannot cause a login loop.
  allowAutoSubmit(credId) {
    const now = Date.now();
    const recent = (this.autoSubmits.get(credId) || []).filter((t) => now - t < 120000);
    if (recent.length >= 2) return false;
    recent.push(now);
    this.autoSubmits.set(credId, recent);
    return true;
  }

  async maybeAutofill(tab, frame, { force = false, credentialId = null } = {}) {
    let url;
    try {
      url = frame.url;
    } catch {
      return;
    }
    if (!/^https?:/.test(url)) return;
    const creds = (this.boot.credentials || []).filter((c) => credentialMatches(url, c));
    if (!creds.length) return;
    const cred = credentialId ? creds.find((c) => c.id === credentialId) : this.chooseCredential({ matches: creds }, url);
    if (!cred || (!cred.autoFill && !force)) return;
    try {
      const secret = await this.getSecret(cred.id, url);
      if (frame.isDestroyed && frame.isDestroyed()) return;
      if (frame.url !== url) return; // navigated away meanwhile
      const origin = new URL(url).origin;
      const script = buildFillScript(secret, { origin, autoSubmit: cred.autoSubmit && this.allowAutoSubmit(cred.id) });
      const wc = tab.view.webContents;
      if (frame === wc.mainFrame) await wc.executeJavaScriptInIsolatedWorld(ISOLATED_WORLD, [{ code: script }], false);
      else await frame.executeJavaScript(script, false);
      tab.filledCredId = cred.id;
      this.pushTabs();
    } catch (err) {
      if (err && err.status === 404) return;
      console.error('autofill failed:', err.message);
    }
  }

  loginMenu(tabId) {
    const tab = this.tabs.get(tabId) || this.activeTab();
    if (!tab || !tab.matches.length) return;
    const url = tab.view.webContents.getURL();
    const current = this.chooseCredential(tab, url);
    const items = tab.matches.map((c) => ({
      label: `Sign in as: ${c.name}`,
      type: 'radio',
      checked: current && current.id === c.id,
      click: () => {
        this.preferred.set(hostOf(url), c.id);
        this.secretCache.delete(c.id);
        this.maybeAutofill(tab, tab.view.webContents.mainFrame, { force: true, credentialId: c.id });
      },
    }));
    items.push({ type: 'separator' }, { label: 'Fill login now', click: () => this.maybeAutofill(tab, tab.view.webContents.mainFrame, { force: true, credentialId: current && current.id }) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // ---- policy events ------------------------------------------------------------
  onBlocked(details, verdict) {
    const isMain = details.resourceType === 'mainFrame';
    const rule = verdict.rule ? `${verdict.rule.pattern} (${verdict.rule.source || 'policy'})` : verdict.reason;
    this.logActivity({ type: 'blocked', url: details.url, detail: rule });
    if (!isMain) return;
    const wc = details.webContents;
    if (!wc || wc.isDestroyed()) return;
    const target = `kb://blocked/?url=${encodeURIComponent(details.url)}&reason=${encodeURIComponent(verdict.reason)}${verdict.rule ? `&rule=${encodeURIComponent(verdict.rule.pattern)}` : ''}`;
    setImmediate(() => !wc.isDestroyed() && wc.loadURL(target).catch(() => {}));
  }

  onDownload(event, item, wc) {
    const filename = item.getFilename();
    const pageUrl = wc && !wc.isDestroyed() ? wc.getURL() : '';
    if (dlpFor(pageUrl, this.boot.dlp).blockDownload || dlpFor(item.getURL(), this.boot.dlp).blockDownload) {
      event.preventDefault();
      this.logActivity({ type: 'dlp.blocked', url: pageUrl || item.getURL(), detail: `download blocked: ${filename}` });
      this.notify({ level: 'warning', text: 'Downloading from this site is disabled by your administrator.' });
      return;
    }
    const ext = path.extname(filename).slice(1).toLowerCase();
    const blockedExt = (this.settings.blockedDownloadExtensions || []).map((x) => String(x).toLowerCase());
    if (!this.settings.allowDownloads || (ext && blockedExt.includes(ext))) {
      event.preventDefault();
      this.logActivity({ type: 'download.blocked', url: item.getURL(), detail: filename });
      this.notify({ level: 'warning', text: !this.settings.allowDownloads ? 'Downloads are disabled by your administrator.' : `Downloading .${ext} files is blocked by your administrator.` });
      return;
    }
    const dir = app.getPath('downloads');
    const savePath = uniquePath(dir, filename);
    item.setSavePath(savePath);
    const entry = { id: Date.now() + Math.random(), filename: path.basename(savePath), path: savePath, url: item.getURL(), received: 0, total: item.getTotalBytes(), state: 'progressing', item };
    this.downloads.unshift(entry);
    this.downloads = this.downloads.slice(0, 30);
    item.on('updated', (e, state) => {
      entry.received = item.getReceivedBytes();
      entry.total = item.getTotalBytes();
      entry.state = state === 'interrupted' ? 'interrupted' : 'progressing';
      this.pushTabs();
    });
    item.once('done', (e, state) => {
      entry.state = state;
      entry.item = null;
      if (state === 'completed') {
        this.logActivity({ type: 'download', url: entry.url, detail: entry.filename });
        this.notify({ level: 'info', text: `Downloaded ${entry.filename}`, action: { label: 'Show in folder', path: savePath } });
      }
      this.pushTabs();
    });
    this.pushTabs();
  }

  downloadsMenu() {
    if (!this.downloads.length) {
      Menu.buildFromTemplate([{ label: 'No downloads yet', enabled: false }, { label: 'Open downloads folder', click: () => osShell.openPath(app.getPath('downloads')) }]).popup({ window: this.win });
      return;
    }
    const items = this.downloads.slice(0, 15).map((d) => {
      const pct = d.total ? Math.round((d.received / d.total) * 100) : 0;
      const status = d.state === 'progressing' ? ` — ${pct}%` : d.state === 'completed' ? '' : ` — ${d.state}`;
      return {
        label: `${d.filename}${status}`,
        submenu: [
          { label: 'Open', enabled: d.state === 'completed', click: () => osShell.openPath(d.path) },
          { label: 'Show in folder', enabled: d.state === 'completed', click: () => osShell.showItemInFolder(d.path) },
          { label: 'Cancel', visible: d.state === 'progressing', click: () => d.item && d.item.cancel() },
        ],
      };
    });
    items.push({ type: 'separator' }, { label: 'Open downloads folder', click: () => osShell.openPath(app.getPath('downloads')) });
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  pageData(page) {
    if (page === 'newtab') {
      return {
        orgName: this.boot.orgName,
        user: this.boot.user.displayName,
        searchUrl: this.settings.searchUrl,
        bookmarks: this.boot.bookmarks,
        apps: (this.boot.credentials || []).filter((c) => c.showOnNewTab && c.loginUrl).map((c) => ({ name: c.name, url: c.loginUrl })),
      };
    }
    return { orgName: this.boot.orgName };
  }

  // ---- activity reporting --------------------------------------------------------
  logActivity(e) {
    if (e.type === 'visit' && !this.settings.logActivity) return;
    this.activity.push({ ...e, ts: new Date().toISOString() });
    if (e.type === 'visit' && e.tabId) {
      // the title arrives a moment later
      const ev = this.activity[this.activity.length - 1];
      setTimeout(() => {
        const t = this.tabs.get(e.tabId);
        if (t && !ev.title) ev.title = t.title;
      }, 3000);
    }
    if (this.activity.length > 500) this.activity.splice(0, this.activity.length - 500);
  }

  async flushActivity() {
    if (this.flushing || this.closed) return;
    this.flushing = true;
    const events = this.activity.splice(0, 200).map((e) => ({ type: e.type, url: e.url, title: e.title, detail: e.detail }));
    const usage = this.usage;
    this.usage = {};
    // Seat-limited logins that are open in a tab keep their seat.
    const activeCredentials = new Set();
    for (const t of this.tabs.values()) {
      const u = t.view.webContents.getURL();
      for (const c of this.boot.credentials || []) if (c.seats && credentialMatches(u, c)) activeCredentials.add(c.id);
    }
    const tab = this.activeTab();
    const current = {
      url: tab ? tab.view.webContents.getURL() : '',
      title: tab ? tab.title : '',
      tabCount: this.tabs.size,
      appVersion: app.getVersion(),
      platform: `${process.platform}-${process.arch}`,
    };
    try {
      await this.client.request('POST', '/api/client/activity', { events, current, usage, activeCredentials: [...activeCredentials] });
    } catch {
      this.activity.unshift(...events);
      for (const [h, n] of Object.entries(usage)) this.usage[h] = (this.usage[h] || 0) + n;
    } finally {
      this.flushing = false;
    }
  }

  checkIdle() {
    const minutes = Number(this.settings.idleLogoutMinutes) || 0;
    if (!minutes) return;
    if (powerMonitor.getSystemIdleTime() >= minutes * 60) {
      this.controller.logout(`You were signed out after ${minutes} minutes of inactivity.`);
    }
  }

  // Counts active (focused, not idle) seconds per site for productivity reports.
  trackUsage() {
    if (this.closed || this.win.isDestroyed() || !this.win.isFocused()) return;
    if (powerMonitor.getSystemIdleTime() >= 60) return;
    const t = this.activeTab();
    const url = t ? t.view.webContents.getURL() : '';
    if (!/^https?:/.test(url)) return;
    const host = hostOf(url);
    this.usage[host] = (this.usage[host] || 0) + 5;
  }

  // ---- data protection --------------------------------------------------------------
  watermarkText() {
    const u = this.boot.user;
    const stamp = new Date().toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    return `${u.displayName} (${u.username}) · ${os.hostname()} · ${stamp}`;
  }

  applyDlp(tab, frame) {
    let url;
    try {
      url = frame.url;
    } catch {
      return;
    }
    const wc = tab.view.webContents;
    const flags = dlpFor(url, this.boot.dlp);
    if (frame === wc.mainFrame) tab.dlp = flags;
    const pageFlags = { ...flags, watermarkText: this.watermarkText() };
    const inPage = flags.blockCopy || flags.blockPaste || flags.blockUpload || flags.watermark;
    // Sub-frames never get their own watermark; the top frame covers the page.
    if (frame !== wc.mainFrame) pageFlags.watermark = false;
    const run = async () => {
      if (inPage || (frame === wc.mainFrame && wc.__kbHadDlp)) {
        const script = buildDlpScript(pageFlags);
        if (frame === wc.mainFrame) await wc.executeJavaScriptInIsolatedWorld(DLP_WORLD, [{ code: script }], false);
        else await frame.executeJavaScript(script, false);
      }
      if (flags.blockPrint) await frame.executeJavaScript(PRINT_BLOCK_SCRIPT, false);
    };
    if (frame === wc.mainFrame) wc.__kbHadDlp = !!inPage;
    run().catch(() => {});
    if (tab.id !== -1) {
      this.updateContentProtection();
      this.pushTabs();
    }
  }

  // Hides the window from screenshots / screen sharing while a protected site is shown (Windows & macOS).
  updateContentProtection() {
    if (this.closed || this.win.isDestroyed()) return;
    const t = this.activeTab();
    const on = !!(t && t.dlp && t.dlp.screenshotProtect);
    if (on !== this.contentProtected) {
      this.contentProtected = on;
      this.win.setContentProtection(on);
    }
  }

  onDlpEvent(tab, what) {
    const url = tab.view.webContents.getURL();
    const key = `${what}|${url}`;
    const last = this.dlpReports.get(key) || 0;
    if (Date.now() - last < 30000) return;
    this.dlpReports.set(key, Date.now());
    this.logActivity({ type: 'dlp.blocked', url, detail: `${what} blocked` });
    if (what === 'print') this.notify({ level: 'warning', text: 'Printing this site is disabled by your administrator.' });
  }

  // ---- shared sessions & seat limits ----------------------------------------------
  // Runs before a top-level navigation. Returns null (nothing to do) or a promise.
  prepareNavigation(details) {
    const url = details.url;
    const creds = (this.boot.credentials || []).filter((c) => (c.seats || c.hasSession) && credentialMatches(url, c));
    if (!creds.length) return null;
    const cred = this.chooseCredential({ matches: creds }, url);
    const needSeat = cred.seats && Date.now() - (this.seatOk.get(cred.id) || 0) > 60000;
    const needSession = cred.hasSession && this.importedSessions.get(cred.id) !== cred.sessionVersion;
    if (!needSeat && !needSession) return null;
    return (async () => {
      if (needSeat) {
        try {
          await this.client.request('POST', '/api/client/seat', { credentialId: cred.id, url });
          this.seatOk.set(cred.id, Date.now());
        } catch (err) {
          if (err.status === 409) {
            const who = err.body && err.body.holders && err.body.holders.length ? ` (in use by ${err.body.holders.join(', ')})` : '';
            const wc = details.webContents;
            const target = `kb://blocked/?reason=seats&url=${encodeURIComponent(url)}&msg=${encodeURIComponent(err.message + who + '. Please try again later.')}`;
            if (wc && !wc.isDestroyed()) setImmediate(() => wc.loadURL(target).catch(() => {}));
            return { cancel: true };
          }
        }
      }
      if (needSession) {
        try {
          const res = await this.client.request('POST', '/api/client/session', { credentialId: cred.id, url });
          await this.importCookies(res.cookies || []);
          this.importedSessions.set(cred.id, cred.sessionVersion);
        } catch (err) {
          console.error('shared session import failed:', err.message);
        }
      }
      return null;
    })();
  }

  async importCookies(list) {
    for (const c of list) {
      const host = c.domain.replace(/^\./, '');
      const cookie = {
        url: `${c.secure ? 'https' : 'http'}://${host}${c.path || '/'}`,
        name: c.name,
        value: c.value,
        path: c.path || '/',
        secure: !!c.secure,
        httpOnly: !!c.httpOnly,
        sameSite: c.sameSite || 'unspecified',
      };
      if (c.domain.startsWith('.')) cookie.domain = c.domain;
      if (c.expirationDate) cookie.expirationDate = c.expirationDate;
      if (cookie.sameSite === 'no_restriction' && !cookie.secure) cookie.sameSite = 'lax';
      await this.ses.cookies.set(cookie).catch((err) => console.error(`cookie ${c.name}:`, err.message));
    }
  }

  // Administrator: share the sign-in of the current site with staff.
  async shareSessionMenu() {
    const t = this.activeTab();
    const url = t ? t.view.webContents.getURL() : '';
    if (!/^https?:/.test(url)) return this.notify({ level: 'warning', text: 'Open the website you are signed in to first.' });
    let existing = [];
    try {
      existing = await this.client.request('GET', `/api/client/admin/credentials?url=${encodeURIComponent(url)}`);
    } catch (err) {
      return this.notify({ level: 'warning', text: err.message });
    }
    const host = hostOf(url);
    const items = existing.map((c) => ({ label: `${c.hasSession ? 'Update' : 'Add'} shared sign-in for "${c.name}"`, click: () => this.captureSession(url, c.id, c.name) }));
    if (items.length) items.push({ type: 'separator' });
    items.push({ label: `Create new site login for ${host}`, click: () => this.captureSession(url, null, (t && t.title) || host) });
    Menu.buildFromTemplate([{ label: 'Share this sign-in with staff', enabled: false }, { type: 'separator' }, ...items]).popup({ window: this.win });
  }

  async captureSession(url, credentialId, name) {
    const host = hostOf(url);
    const base = baseDomain(host);
    const all = await this.ses.cookies.get({});
    const cookies = all
      .filter((c) => {
        const d = c.domain.replace(/^\./, '');
        return d === base || d.endsWith('.' + base);
      })
      .map((c) => ({
        name: c.name,
        value: c.value,
        domain: c.hostOnly ? c.domain.replace(/^\./, '') : c.domain.startsWith('.') ? c.domain : '.' + c.domain,
        path: c.path,
        secure: c.secure,
        httpOnly: c.httpOnly,
        sameSite: c.sameSite,
        expirationDate: c.expirationDate,
      }));
    try {
      const res = await this.client.request('POST', '/api/client/capture-session', { credentialId, name, url, cookies });
      this.notify({
        level: 'info',
        text: `Shared your ${base} sign-in (${res.cookies} cookies) as "${res.name}". ${res.created ? 'Assign it to staff in the Admin Console → Site logins.' : 'Staff will use it on their next visit.'}`,
        sticky: true,
      });
    } catch (err) {
      this.notify({ level: 'warning', text: err.message });
    }
  }

  async requestAccess(url, reason) {
    try {
      await this.client.request('POST', '/api/client/access-request', { url, reason });
      return true;
    } catch {
      return false;
    }
  }

  // ---- server pushed commands ------------------------------------------------------
  handleServerEvent(event, data) {
    switch (event) {
      case 'message':
        this.notify({ level: data.level, text: data.text, from: data.from, sticky: true });
        if (!this.win.isFocused() && Notification.isSupported()) new Notification({ title: `Message from ${data.from || 'administrator'}`, body: data.text || '' }).show();
        break;
      case 'open-url':
        if (data.url) this.newTab(data.url);
        if (data.text) this.notify({ level: data.level, text: data.text, from: data.from });
        break;
      case 'close-tabs':
        for (const id of [...this.order]) this.closeTab(id);
        if (data.text) this.notify({ level: data.level, text: data.text, from: data.from });
        break;
      case 'clear-data':
        this.ses.clearStorageData().then(() => {
          for (const t of this.tabs.values()) t.view.webContents.reload();
        });
        this.notify({ level: 'info', text: data.text || 'Your administrator cleared the browser data.', from: data.from });
        break;
      default:
        break;
    }
  }

  notify(n) {
    this.send('notify', { id: Date.now() + Math.random(), ...n });
  }

  // ---- input handling -------------------------------------------------------------
  handleShortcut(e, input, tab) {
    if (input.type !== 'keyDown') return;
    const ctrl = input.control || input.meta;
    const key = input.key.toLowerCase();
    const t = tab || this.activeTab();
    const run = (fn) => {
      e.preventDefault();
      fn();
    };
    if (ctrl && !input.shift && key === 't') return run(() => this.newTab());
    if (ctrl && key === 'w') return run(() => t && this.closeTab(t.id));
    if (ctrl && key === 'tab') return run(() => this.cycleTab(input.shift ? -1 : 1));
    if (ctrl && key === 'pagedown') return run(() => this.cycleTab(1));
    if (ctrl && key === 'pageup') return run(() => this.cycleTab(-1));
    if (ctrl && /^[1-9]$/.test(key)) return run(() => this.activate(key === '9' ? this.order[this.order.length - 1] : this.order[Number(key) - 1]));
    if ((ctrl && key === 'l') || (input.alt && key === 'd') || key === 'f6') return run(() => this.send('focus-address'));
    if ((ctrl && key === 'r') || key === 'f5') return run(() => t && (input.shift ? t.view.webContents.reloadIgnoringCache() : t.view.webContents.reload()));
    if (input.alt && key === 'arrowleft') return run(() => t && t.view.webContents.navigationHistory.goBack());
    if (input.alt && key === 'arrowright') return run(() => t && t.view.webContents.navigationHistory.goForward());
    if (input.alt && key === 'home') return run(() => t && this.navigate(t, this.settings.homepage || 'kb://newtab'));
    if (ctrl && key === 'f') return run(() => this.send('find-open'));
    if (ctrl && key === 'p') return run(() => this.print());
    if (ctrl && (key === '=' || key === '+')) return run(() => this.zoom(1));
    if (ctrl && key === '-') return run(() => this.zoom(-1));
    if (ctrl && key === '0') return run(() => this.zoom(0));
    if (key === 'f11') return run(() => this.win.setFullScreen(!this.win.isFullScreen()));
    if (key === 'f12' || (ctrl && input.shift && (key === 'i' || key === 'j' || key === 'c')) || (ctrl && key === 'u')) {
      return run(() => {
        if (this.settings.allowDevTools && t && key !== 'u') t.view.webContents.toggleDevTools();
      });
    }
  }

  cycleTab(dir) {
    if (!this.order.length) return;
    const idx = this.order.indexOf(this.activeId);
    this.activate(this.order[(idx + dir + this.order.length) % this.order.length]);
  }

  zoom(dir) {
    const t = this.activeTab();
    if (!t) return;
    const wc = t.view.webContents;
    wc.setZoomLevel(dir === 0 ? 0 : Math.max(-5, Math.min(5, wc.getZoomLevel() + dir * 0.5)));
    this.pushTabs();
  }

  print() {
    const t = this.activeTab();
    if (!t) return;
    if (!this.settings.allowPrinting) return this.notify({ level: 'warning', text: 'Printing is disabled by your administrator.' });
    if (t.dlp && t.dlp.blockPrint) return this.onDlpEvent(t, 'print');
    t.view.webContents.print();
  }

  find(text, { forward = true, findNext = false } = {}) {
    const t = this.activeTab();
    if (!t) return;
    if (!text) return t.view.webContents.stopFindInPage('clearSelection');
    t.view.webContents.findInPage(text, { forward, findNext });
  }

  stopFind() {
    const t = this.activeTab();
    if (t) t.view.webContents.stopFindInPage('keepSelection');
  }

  contextMenu(tab, p) {
    const wc = tab.view.webContents;
    const items = [];
    if (p.misspelledWord && p.dictionarySuggestions.length) {
      for (const s of p.dictionarySuggestions.slice(0, 5)) items.push({ label: s, click: () => wc.replaceMisspelling(s) });
      items.push({ type: 'separator' });
    }
    if (p.linkURL) {
      items.push(
        { label: 'Open link in new tab', click: () => this.newTab(p.linkURL, { active: false }) },
        { label: 'Copy link address', enabled: !dlp.blockCopy, click: () => clipboard.writeText(p.linkURL) },
        { type: 'separator' }
      );
    }
    if (p.mediaType === 'image' && p.srcURL) {
      items.push(
        { label: 'Open image in new tab', click: () => this.newTab(p.srcURL, { active: false }) },
        { label: 'Copy image', enabled: !dlp.blockCopy, click: () => wc.copyImageAt(p.x, p.y) },
        { label: 'Copy image address', enabled: !dlp.blockCopy, click: () => clipboard.writeText(p.srcURL) },
        { type: 'separator' }
      );
    }
    const isPassword = p.inputFieldType === 'password' || p.formControlType === 'input-password';
    const dlp = tab.dlp || {};
    if (p.isEditable) {
      items.push(
        { label: 'Undo', role: 'undo', enabled: p.editFlags.canUndo },
        { label: 'Redo', role: 'redo', enabled: p.editFlags.canRedo },
        { type: 'separator' },
        { label: 'Cut', role: 'cut', enabled: p.editFlags.canCut && !isPassword && !dlp.blockCopy },
        { label: 'Copy', role: 'copy', enabled: p.editFlags.canCopy && !isPassword && !dlp.blockCopy },
        { label: 'Paste', role: 'paste', enabled: p.editFlags.canPaste && !dlp.blockPaste },
        { label: 'Select all', role: 'selectAll' }
      );
    } else if (p.selectionText) {
      const sel = p.selectionText.trim().slice(0, 60);
      items.push(
        { label: 'Copy', role: 'copy', enabled: !dlp.blockCopy },
        { label: `Search for "${sel}${p.selectionText.length > 60 ? '…' : ''}"`, click: () => this.newTab(this.resolveInput(p.selectionText.includes(' ') ? p.selectionText : p.selectionText + ' ')) }
      );
    }
    if (!p.isEditable && !p.linkURL && !p.selectionText && p.mediaType === 'none') {
      items.push(
        { label: 'Back', enabled: wc.navigationHistory.canGoBack(), click: () => wc.navigationHistory.goBack() },
        { label: 'Forward', enabled: wc.navigationHistory.canGoForward(), click: () => wc.navigationHistory.goForward() },
        { label: 'Reload', click: () => wc.reload() },
        { type: 'separator' },
        { label: 'Print…', visible: !!this.settings.allowPrinting, click: () => this.print() }
      );
    }
    if (this.settings.allowDevTools) items.push({ type: 'separator' }, { label: 'Inspect', click: () => wc.inspectElement(p.x, p.y) });
    while (items.length && items[items.length - 1].type === 'separator') items.pop();
    if (items.length) Menu.buildFromTemplate(items).popup();
  }

  mainMenu() {
    const t = this.activeTab();
    const zoom = t ? Math.round(t.view.webContents.getZoomFactor() * 100) : 100;
    const items = [
      { label: this.boot.user.displayName, enabled: false },
      { label: this.controller.online ? `Connected to ${this.boot.orgName}` : 'Server offline — using last policy', enabled: false },
      { type: 'separator' },
      { label: 'New tab', accelerator: 'CmdOrCtrl+T', click: () => this.newTab() },
      { label: 'Find in page…', accelerator: 'CmdOrCtrl+F', click: () => this.send('find-open') },
      { label: `Zoom (${zoom}%)`, submenu: [{ label: 'Zoom in', click: () => this.zoom(1) }, { label: 'Zoom out', click: () => this.zoom(-1) }, { label: 'Reset', click: () => this.zoom(0) }] },
      { label: 'Print…', accelerator: 'CmdOrCtrl+P', visible: !!this.settings.allowPrinting, click: () => this.print() },
      { label: 'Downloads', click: () => this.downloadsMenu() },
      { label: 'Full screen', accelerator: 'F11', click: () => this.win.setFullScreen(!this.win.isFullScreen()) },
      { type: 'separator' },
      { label: 'Admin console', visible: !!this.settings.isAdmin, click: () => this.newTab(this.controller.serverUrl + '/admin/') },
      { label: 'Share this site’s sign-in with staff…', visible: !!this.settings.isAdmin, click: () => this.shareSessionMenu() },
      { label: 'Change my K-Browser password…', click: () => this.send('password-open') },
      { label: 'About K-Browser', click: () => this.notify({ level: 'info', text: `K-Browser ${app.getVersion()} · Chromium ${process.versions.chrome} · ${process.platform}` }) },
      { type: 'separator' },
      { label: 'Sign out', click: () => this.controller.logout() },
      { label: 'Exit', click: () => app.quit() },
    ];
    Menu.buildFromTemplate(items).popup({ window: this.win });
  }

  // IPC from the shell renderer
  handleUi(channel, args) {
    const t = this.activeTab();
    switch (channel) {
      case 'chrome-height':
        return this.setChromeHeight(args[0]);
      case 'new-tab':
        return this.newTab(args[0]);
      case 'close-tab':
        return this.closeTab(args[0]);
      case 'activate':
        return this.activate(args[0]);
      case 'move-tab': {
        const [id, toIndex] = args;
        const from = this.order.indexOf(id);
        if (from === -1) return;
        this.order.splice(from, 1);
        this.order.splice(Math.max(0, Math.min(toIndex, this.order.length)), 0, id);
        return this.pushTabs();
      }
      case 'navigate':
        if (t) this.navigate(t, args[0]);
        else this.newTab(args[0]);
        if (t) t.view.webContents.focus();
        return;
      case 'back':
        return t && t.view.webContents.navigationHistory.goBack();
      case 'forward':
        return t && t.view.webContents.navigationHistory.goForward();
      case 'reload':
        return t && t.view.webContents.reload();
      case 'stop':
        return t && t.view.webContents.stop();
      case 'home':
        return t && this.navigate(t, this.settings.homepage || 'kb://newtab');
      case 'menu':
        return this.mainMenu();
      case 'downloads':
        return this.downloadsMenu();
      case 'login-menu':
        return this.loginMenu(args[0]);
      case 'find':
        return this.find(args[0], args[1] || {});
      case 'find-stop':
        return this.stopFind();
      case 'show-item':
        return args[0] && osShell.showItemInFolder(args[0]);
      case 'tab-menu': {
        const id = args[0];
        const tab = this.tabs.get(id);
        if (!tab) return;
        Menu.buildFromTemplate([
          { label: 'Reload', click: () => tab.view.webContents.reload() },
          { label: 'Duplicate', click: () => this.newTab(tab.view.webContents.getURL()) },
          { label: tab.view.webContents.isAudioMuted() ? 'Unmute site' : 'Mute site', click: () => tab.view.webContents.setAudioMuted(!tab.view.webContents.isAudioMuted()) },
          { type: 'separator' },
          { label: 'Close', click: () => this.closeTab(id) },
          { label: 'Close other tabs', click: () => this.order.filter((x) => x !== id).forEach((x) => this.closeTab(x)) },
        ]).popup({ window: this.win });
        return;
      }
      case 'change-password':
        return this.client.request('POST', '/api/auth/password', { current: args[0], next: args[1] });
      default:
        return undefined;
    }
  }

  async close({ clearData = false } = {}) {
    if (this.closed) return;
    await this.flushActivity().catch(() => {});
    if (clearData || this.settings.clearDataOnLogout) await this.ses.clearStorageData().catch(() => {});
    if (!this.win.isDestroyed()) this.win.destroy();
    this.dispose();
  }

  dispose() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.activityTimer);
    clearInterval(this.idleTimer);
    clearInterval(this.usageTimer);
    contexts.delete(this.partition);
    this.controller.onShellClosed(this);
  }
}

module.exports = { Shell };
