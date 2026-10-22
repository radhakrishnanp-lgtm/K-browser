'use strict';
const path = require('path');
const os = require('os');
const { app, BrowserWindow, ipcMain, Menu, protocol, dialog } = require('electron');
const { LocalConfig, loadManaged } = require('./config');
const { ServerClient, HttpError, fetchCertificate, normalizeServerUrl } = require('./net');
const { discoverServers } = require('./discovery');
const { Shell } = require('./shell');

const RENDERER = path.join(__dirname, '..', 'renderer');

// Debugging switches would expose page contents (including filled passwords).
const DEBUG_SWITCHES = ['remote-debugging-port', 'remote-debugging-pipe', 'inspect', 'inspect-brk', 'inspect-port', 'js-flags'];
if (app.isPackaged && DEBUG_SWITCHES.some((s) => app.commandLine.hasSwitch(s))) {
  app.exit(1);
}

protocol.registerSchemesAsPrivileged([{ scheme: 'kb', privileges: { standard: true, secure: true, supportFetchAPI: true } }]);
app.commandLine.appendSwitch('disable-features', 'Translate,MediaRouter');
if (process.env.KB_USER_DATA) app.setPath('userData', process.env.KB_USER_DATA);

class Controller {
  constructor() {
    this.config = new LocalConfig();
    this.managed = loadManaged();
    this.client = null;
    this.shell = null;
    this.loginWin = null;
    this.events = null;
    this.online = false;
    this.pending = null; // probed server waiting for trust confirmation
    this.iconPath = path.join(__dirname, '..', '..', 'build', 'icon.png');
  }

  get serverUrl() {
    return this.config.get('serverUrl');
  }

  get certPem() {
    return this.config.get('certPem');
  }

  async start() {
    const token = this.config.getToken();
    if (this.serverUrl && this.certPem && token && this.managedMatches()) {
      this.client = new ServerClient({ serverUrl: this.serverUrl, certPem: this.certPem, fingerprint: this.config.get('fingerprint'), token });
      try {
        const boot = await this.client.request('GET', '/api/client/bootstrap');
        return this.openShell(boot);
      } catch (err) {
        if (err instanceof HttpError && err.status === 401) this.config.setToken(null);
        else return this.showLogin(`Cannot reach the K-Browser server (${err.message}).`);
      }
    }
    this.showLogin();
  }

  // A managed.json pins the server; ignore saved state that does not match it.
  managedMatches() {
    if (!this.managed || !this.managed.serverUrl) return true;
    try {
      return normalizeServerUrl(this.managed.serverUrl) === this.serverUrl && (!this.managed.fingerprint || this.managed.fingerprint === this.config.get('fingerprint'));
    } catch {
      return false;
    }
  }

  showLogin(message = '') {
    this.loginMessage = message;
    if (this.loginWin && !this.loginWin.isDestroyed()) {
      this.loginWin.webContents.send('login:message', message);
      this.loginWin.show();
      return;
    }
    this.loginWin = new BrowserWindow({
      width: 460,
      height: 640,
      resizable: false,
      maximizable: false,
      show: false,
      title: 'K-Browser — Sign in',
      autoHideMenuBar: true,
      backgroundColor: '#f1f3f6',
      icon: this.iconPath,
      webPreferences: { preload: path.join(__dirname, 'preload-login.js'), contextIsolation: true, sandbox: true, devTools: !!process.env.KB_DEBUG },
    });
    this.loginWin.setMenuBarVisibility(false);
    this.loginWin.loadFile(path.join(RENDERER, 'login.html'));
    this.loginWin.once('ready-to-show', () => this.loginWin.show());
    this.loginWin.on('closed', () => {
      this.loginWin = null;
      if (!this.shell) app.quit();
    });
  }

  loginInit() {
    const managedUrl = this.managed && this.managed.serverUrl;
    return {
      serverUrl: managedUrl || this.serverUrl || '',
      locked: !!(this.managed && this.managed.lockServer && managedUrl),
      username: this.config.get('lastUsername') || '',
      message: this.loginMessage || '',
      device: os.hostname(),
      version: app.getVersion(),
    };
  }

  // Reads the server certificate and decides whether it is already trusted.
  async probe(rawUrl) {
    const serverUrl = normalizeServerUrl(rawUrl);
    const { certPem, fingerprint } = await fetchCertificate(serverUrl);
    const known = this.serverUrl === serverUrl ? this.config.get('fingerprint') : null;
    const managedFp = this.managed && this.managed.fingerprint;
    let status = 'new';
    if (managedFp) status = managedFp === fingerprint ? 'trusted' : 'mismatch';
    else if (known) status = known === fingerprint ? 'trusted' : 'changed';
    if (status === 'mismatch') throw new Error('The server certificate does not match the fingerprint configured by your administrator. Do not continue; contact IT.');
    const client = new ServerClient({ serverUrl, certPem, fingerprint });
    const info = await client.request('GET', '/api/info');
    client.close();
    this.pending = { serverUrl, certPem, fingerprint };
    return { serverUrl, fingerprint, status, name: info.name, banner: info.loginBanner || '' };
  }

  async login({ serverUrl, username, password, otp }) {
    const target = normalizeServerUrl(serverUrl);
    if (!this.pending || this.pending.serverUrl !== target) await this.probe(target);
    const { certPem, fingerprint } = this.pending;
    const client = new ServerClient({ serverUrl: target, certPem, fingerprint });
    let res;
    try {
      res = await client.request('POST', '/api/auth/login', { username, password, otp: otp || undefined, kind: 'browser', device: os.hostname() });
    } catch (err) {
      if (err.body && err.body.needOtp) return { needOtp: true, message: err.message };
      throw err;
    }
    client.token = res.token;
    this.config.set({ serverUrl: target, certPem, fingerprint, lastUsername: username });
    this.config.setToken(res.token);
    if (this.client) this.client.close();
    this.client = client;
    if (res.mustChangePassword) return { mustChangePassword: true };
    await this.enter();
    return { ok: true };
  }

  async enter() {
    const boot = await this.client.request('GET', '/api/client/bootstrap');
    this.openShell(boot);
  }

  openShell(boot) {
    this.shell = new Shell(this, boot);
    this.startEvents();
    if (this.loginWin && !this.loginWin.isDestroyed()) {
      const w = this.loginWin;
      this.loginWin = null;
      w.destroy();
    }
  }

  startEvents() {
    if (this.events) this.events.close();
    this.events = this.client.stream('/api/client/events', {
      onStatus: (status) => {
        if (status === 'unauthorized') return this.logout('Your session has ended. Please sign in again.', { callServer: false });
        const was = this.online;
        this.online = status === 'online';
        if (this.shell && was !== this.online) {
          this.shell.pushState();
          if (this.online) this.refresh();
        }
      },
      onEvent: (event, data) => this.onServerEvent(event, data),
    });
  }

  async refresh() {
    if (!this.shell) return;
    try {
      this.shell.update(await this.client.request('GET', '/api/client/bootstrap'));
    } catch (err) {
      if (err.status === 401) this.logout('Your session has ended. Please sign in again.', { callServer: false });
    }
  }

  onServerEvent(event, data) {
    if (event === 'refresh') return this.refresh();
    if (event === 'logout') return this.logout(data.reason || 'You were signed out by your administrator.', { callServer: false });
    if (this.shell) this.shell.handleServerEvent(event, data);
  }

  async logout(message = '', { callServer = true } = {}) {
    if (this.loggingOut) return;
    this.loggingOut = true;
    try {
      if (this.events) this.events.close();
      this.events = null;
      if (callServer && this.client) await this.client.request('POST', '/api/auth/logout', {}).catch(() => {});
      this.config.setToken(null);
      this.showLogin(message);
      const shell = this.shell;
      this.shell = null;
      if (shell) await shell.close();
    } finally {
      this.loggingOut = false;
    }
  }

  onShellClosed(shell) {
    if (this.shell === shell) {
      this.shell = null;
      // Window closed by the user: keep the session (token) and quit.
      if (this.events) this.events.close();
      if (!this.loginWin) app.quit();
    }
  }
}

let controller = null;

function fromShell(event) {
  return controller && controller.shell && event.sender === controller.shell.win.webContents;
}

function fromLogin(event) {
  return controller && controller.loginWin && event.sender === controller.loginWin.webContents;
}

function registerIpc() {
  const loginHandle = (channel, fn) =>
    ipcMain.handle(channel, async (event, ...args) => {
      if (!fromLogin(event)) throw new Error('forbidden');
      try {
        return { ok: true, value: await fn(...args) };
      } catch (err) {
        return { ok: false, error: err.message };
      }
    });
  loginHandle('login:init', () => controller.loginInit());
  loginHandle('login:discover', () => discoverServers());
  loginHandle('login:probe', (url) => controller.probe(url));
  loginHandle('login:submit', (form) => controller.login(form));
  loginHandle('login:set-password', async (current, next) => {
    await controller.client.request('POST', '/api/auth/password', { current, next });
    await controller.enter();
    return true;
  });

  ipcMain.on('ui', (event, channel, ...args) => {
    if (!fromShell(event)) return;
    controller.shell.handleUi(channel, args);
  });
  ipcMain.handle('ui:invoke', async (event, channel, ...args) => {
    if (!fromShell(event)) throw new Error('forbidden');
    try {
      return { ok: true, value: await controller.shell.handleUi(channel, args) };
    } catch (err) {
      return { ok: false, error: err.message };
    }
  });
}

// Hardening that applies to every web contents in the app.
app.on('web-contents-created', (event, contents) => {
  contents.on('will-attach-webview', (e) => e.preventDefault());
  if (contents.getType() === 'window' || contents.getType() === 'browserView') {
    contents.on('will-navigate', (e, url) => {
      // The shell and login UIs are local files and must never navigate away.
      const current = contents.getURL();
      if (current.startsWith('file:') && !url.startsWith('file:')) e.preventDefault();
    });
  }
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const w = (controller && controller.shell && controller.shell.win) || (controller && controller.loginWin);
    if (w && !w.isDestroyed()) {
      if (w.isMinimized()) w.restore();
      w.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    registerIpc();
    controller = new Controller();
    controller.start().catch((err) => {
      dialog.showErrorBox('K-Browser', err.stack || String(err));
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    if (!controller || (!controller.shell && !controller.loginWin)) app.quit();
  });
}
