# K-Browser

A centrally managed, Chromium-based workplace browser for offices with 20–200+ staff.

You keep your paid website accounts (Canva, ChatGPT, Adobe, stock-photo sites, SaaS tools…) in
**one encrypted vault on your own server**. Staff sign in to K-Browser with the username you give
them, and K-Browser signs them in to those websites automatically. **Staff never see the password.**
From the Admin Console you decide who gets which account, which websites are allowed or blocked,
and you can see and control every browser on the LAN live.

Runs on **Windows** and **Linux**.

```
                      ┌───────────────────────────────────────────┐
  Your PC / server    │  K-Browser Control Server (Node.js)        │
                      │  • Admin Console  https://<server>:8443    │
                      │  • Users, groups, encrypted credential vault│
                      │  • Web-filter rules, settings, bookmarks    │
                      │  • Live sessions, audit / activity log      │
                      └──────────────▲────────────────────────────┘
                     HTTPS (pinned)  │  live push (policy, messages, sign-out)
           ┌─────────────────────────┼─────────────────────────┐
     ┌─────┴──────┐           ┌──────┴─────┐            ┌──────┴─────┐
     │ K-Browser  │           │ K-Browser  │    …       │ K-Browser  │
     │ staff PC 1 │           │ staff PC 2 │            │ staff PC N │
     └────────────┘           └────────────┘            └────────────┘
```

## Features

**Shared accounts without sharing passwords**
- Encrypted vault (AES-256-GCM) for site usernames, passwords and **2FA (TOTP) secrets**.
- Assign each login to users, groups or everyone. **Different staff can get different accounts for
  the same website**; personal assignments win over group ones, and the key icon in the address bar
  lets a user switch between the accounts they're allowed to use.
- Automatic fill, optional automatic "Sign in" click, multi-step logins (email → password → 2FA code).
- The password field can't be revealed: "show password" buttons are neutralised, copy/drag is blocked,
  developer tools, `view-source:` and `javascript:` URLs are disabled.
- The server releases a password only to a signed-in browser, only for a site it's assigned for, and
  only on the matching website. Every auto sign-in is written to the audit log.
- **Shared signed-in sessions ("master browser" login):** sign in to a website once in *your own*
  K-Browser, open ⋮ → *Share this site's sign-in with staff…*. Staff assigned to that login are signed
  in with your session cookies, so **no password is needed or sent to their PCs at all**. Useful for
  sites with SMS/e-mail OTP that can't be auto-filled.
- **Licence seat limits:** set "Seats = 3" on a login and only three people can have that site open at
  the same time; the fourth sees "All seats are in use (by A, B, C)". Seats free themselves two minutes
  after a user closes the site.

**Subscriptions & licence management**
- Plan, vendor, seats, monthly cost and renewal date per account.
- Subscriptions page: total monthly/yearly spend, seats in use right now, eligible vs. *actually active*
  users in the last 30 days, **cost per active user**, unused subscriptions and renewals due in 30 days
  (also flagged on the dashboard).

**Data loss prevention (DLP)**
- Per website, per group or per user: **block copy/cut, paste/drop, file uploads, downloads, printing**
  and **screenshots / screen sharing** (Windows content protection).
- **Visible watermark** across the page with the user's name, username, PC name and time, so a phone
  photo of the screen is still traceable.
- A green "Protected" badge in the address bar tells staff which restrictions are active; every blocked
  attempt is logged.

**Web filtering**
- Block-list mode (allow everything except…) or allow-list mode (block everything except…).
- Global, per-group and per-user rules. Patterns: `example.com`, `*.example.com`, `=example.com`,
  `example.com/path`, `https://*.site.com/x/*`, `192.168.1.0/24`, `*`.
- **15 built-in categories** (`category:social`, `video`, `music`, `games`, `shopping`, `news`,
  `gambling`, `adult`, `dating`, `filesharing`, `webmail`, `ai`, `proxy`, `torrents`, `jobs`).
- **Time-based rules**, e.g. block `category:social` only `Mon-Fri 09:00-18:00`, allow YouTube at `13:00-14:00`.
- **Force SafeSearch** (Google, Bing, DuckDuckGo) and **YouTube Restricted Mode** (moderate/strict).
- **Access requests:** the block page has a *Request access* form with a reason. You approve it in the
  console for 1 hour / 4 hours / 1 day / 7 days / 30 days / permanently. The user is told instantly, and
  time-limited approvals switch off by themselves.
- Built-in URL tester and "effective access" view per user.

**Central control**
- Live sessions: who's online, on which PC, what they're viewing and how many tabs they have open.
- Push to one user, one PC or everyone: **message banner**, **open a website**, **close all tabs**,
  **clear cookies**, **force sign-out**. Policy changes apply instantly with no restart.
- Managed bookmarks bar (global, group, user) and a new-tab page with "your apps" shortcuts.
- Settings per org/group/user: downloads on/off, blocked file types (`exe`, `msi`…), printing,
  camera/microphone, developer tools, local files, idle auto sign-out, max tabs, home page,
  clear data on sign-out, activity logging.
- Activity log: sign-ins, failed sign-ins, visits, blocks, auto sign-ins, shared-session use, DLP
  blocks, seat denials, downloads, admin changes. Filter and **export to CSV**.
- **Usage reports:** active time per user per website (only while K-Browser is in front and the user
  isn't idle), by date range, exportable to CSV.
- **Alerts** to Slack, Microsoft Teams, Google Chat, Discord or any webhook for blocked attempts,
  access requests, failed sign-ins, seat-full events, DLP blocks and site-login changes.
- Backup export (secrets stay encrypted).

**Browser**
- Chromium engine (via Electron), tabs with drag-to-reorder, address bar with search, find in page,
  zoom, print, downloads, full screen, spell check, context menus, keyboard shortcuts
  (Ctrl+T/W/L/Tab/F/P/R, Alt+←/→, F5, F11).
- A separate cookie jar per staff account, so several people can share one PC.
- Presents a standard Chrome user agent, so websites treat it like Chrome.

**Enterprise plumbing**
- HTTPS with an auto-generated certificate; browsers **pin its fingerprint** (or use your own cert).
- LAN auto-discovery: staff click **Find** and the server is found automatically.
- `managed.json` to pre-configure and lock the server on every PC (no prompts).
- **Console roles:** *Administrator* (everything), *Helpdesk* (staff accounts, password resets, live
  sessions, access requests; no vault or policy changes) and *Auditor* (read-only). Nobody, not even an
  administrator, can read a stored website password back out of the console.
- **Two-factor authentication** (any authenticator app) for console and staff accounts, with an
  option to require it for every console account.
- **Tamper-evident audit log:** every entry is SHA-256 chained to the previous one, and the Security
  page verifies the chain.
- Login lockout after repeated failed attempts, scrypt password hashing, account disable/remove,
  forced password change on first sign-in.
- Windows installer (NSIS), Linux AppImage and `.deb`. Hardened builds (Electron fuses: no
  run-as-Node, no inspector, ASAR integrity, encrypted cookies; debug switches are refused).

## Quick start

### 1. Run the Control Server (on your own PC or an office server)

Needs [Node.js 20+](https://nodejs.org).

```bash
cd server
npm ci --omit=dev
npm start
```

The first start prints the Admin Console address, the TLS fingerprint and a one-time **admin
password** (also saved in `server/data/initial-admin-password.txt`; delete that file after you sign in).

Open `https://<server-ip>:8443/admin/` in any browser. Your browser will warn about the
self-signed certificate; that's expected the first time. Sign in as `admin` and choose a new password.

Run it permanently:
- **Windows**: elevated PowerShell → `powershell -ExecutionPolicy Bypass -File deploy\install-windows-service.ps1`
  (starts at boot, opens firewall ports 8443/TCP and 41234/UDP).
- **Linux**: see `server/deploy/kbrowser-server.service` (systemd).
- **Docker**: `docker build -t kbrowser-server server && docker run -d --network host -v kb-data:/data kbrowser-server`

Environment variables: `KB_PORT` (8443), `KB_HOST` (0.0.0.0), `KB_DATA_DIR` (`server/data`),
`KB_ADMIN_PASSWORD` (initial admin password), `KB_MASTER_KEY` (base64 32-byte vault key instead of
`data/vault.key`), `KB_DISCOVERY=off`.

Forgot the admin password? `npm run reset-admin` (or `node src/index.js reset-admin <username>`).

To use your own certificate, put `cert.pem` and `key.pem` in `data/tls/` before starting.

### 2. Install K-Browser on staff PCs

Download the installers from the **CI → Artifacts** of this repository (or build them yourself,
below): `K-Browser-Setup-<ver>.exe` for Windows, `.AppImage` / `.deb` for Linux.

On first start the staff member clicks **Find** (or types the server address), checks the
fingerprint matches the one on the Admin Console → *Deploy clients* page, and signs in.

For many PCs, copy a `managed.json` (shown on *Deploy clients*) to
`C:\ProgramData\KBrowser\managed.json` (Windows) or `/etc/kbrowser/managed.json` (Linux). The server
is then pre-set and locked, and no trust prompt appears.

### 3. Set up your office

1. **Groups** → e.g. *Design*, *Sales*, *Accounts*.
2. **Users** → add each staff member, pick their groups. A password is generated if you leave it blank.
3. **Site logins** → *+ Add site login*: name, login page URL, the account username/password (and 2FA
   secret if the account uses an authenticator app), then tick who may use it.
   Example: two Canva accounts → "Canva – Team A" assigned to the *Design* group, "Canva – Priya"
   assigned to Priya only. Priya gets her own account, the rest of Design shares Team A.
4. **Web filter** → choose block-list or allow-list mode and add rules (e.g. block `category:social`
   `Mon-Fri 09:00-18:00`, block `category:adult`; or allow only `canva.com`, `google.com`, your intranet).
   Turn on SafeSearch / YouTube Restricted Mode under **Settings**.
5. **Data protection** → protect sensitive sites (CRM, accounting, HR): no copy, no download, watermark.
6. **Subscriptions** → fill in seats, cost and renewal date on each site login to see your real spend.
7. **Security** → turn on two-factor authentication for your console account and add a Slack/Teams
   webhook for alerts. Give helpers a *Helpdesk* account instead of sharing your admin password.
8. **Bookmarks / Settings** → bookmarks bar, downloads policy, idle sign-out, sign-in notice, etc.
9. **Live sessions / Access requests / Activity log / Usage reports** → watch and control everything.

## Security model — please read

- Website passwords never appear in the K-Browser UI, are never stored on staff PCs (only kept in
  memory for up to 60 s while filling), and are never returned by the Admin Console API after saving.
- The vault key is `server/data/vault.key`. **Back up `data/` (db.json + vault.key) and keep it
  private.** Anyone with both files can decrypt the stored passwords.
- Any software that types a password into a website has to hand the password to the staff PC at some
  point. K-Browser makes it hard to get at: there's no reveal, no copy, no devtools, no debug switches
  and no scripts in the address bar. But a technically skilled user **with administrator rights on
  their own PC** could still pull it out of memory or the network session. For strong protection, give
  staff **standard (non-admin) Windows/Linux accounts**. Where a website supports it, prefer separate
  per-user seats or SSO.
- Make the site patterns precise. A pattern like `google.com` also covers `sites.google.com`, where
  anyone can publish pages. Use `=accounts.example.com` or the exact login host when in doubt.
- Data-protection controls stop the normal ways of copying data out (keyboard, menus, drag & drop,
  uploads, downloads, printing, Windows screenshots) and the watermark deters photos. No browser-based
  DLP can stop someone photographing the screen with a phone or retyping what they see.
- Shared sessions are only as long-lived as the website allows. When the site signs the session out,
  share it again. Some sites bind sessions to an IP address or device and won't accept them on
  another PC.
- To stop staff simply using another browser, remove or restrict the other browsers on their PCs
  through Windows Group Policy / AppLocker or your firewall/proxy.
- Check each website's terms of service: some subscription plans don't allow several people to share
  one seat.

## Development

```bash
# server
cd server && npm ci && npm test        # unit + API tests (node:test)
npm start

# browser
cd browser && npm ci
npm start                              # runs K-Browser from source
npm run test:e2e                       # full end-to-end test (use `xvfb-run -a` on headless Linux)
npm run dist:linux                     # AppImage + deb  → browser/dist/
npm run dist:win                       # NSIS installer  (run on Windows, or Linux with Wine)
```

The end-to-end test starts a real control server and a fake subscription website, launches
K-Browser and checks: staff sign-in, automatic site login with auto-submit, password stays hidden
even when the site's "show password" button is clicked, domain blocking, `javascript:` refusal,
a live admin message, licence seat limits, shared-session sign-in without a password, data
protection (copy blocked, watermark shown), the access-request → approval flow, a live switch to
allow-list mode, the activity log, usage report, audit-chain verification, live session tracking
and remote sign-out.

GitHub Actions (`.github/workflows/ci.yml`) runs the server tests and the end-to-end test on both
**Windows and Linux**, then builds the Windows installer and the Linux packages as downloadable
artifacts.

### Layout

```
server/                 Control Server (Express, no database needed: JSON file + JSONL audit log)
  src/index.js          startup, TLS, LAN discovery
  src/routes/client.js  browser API (sign-in, bootstrap, fill, activity, live events)
  src/routes/admin.js   Admin Console API
  src/policy.js         effective policy/settings/bookmarks/credentials/DLP rules per user
  src/rbac.js           console roles (admin, helpdesk, auditor)
  src/seats.js          concurrent licence-seat tracking
  src/alerts.js         webhook alerts
  src/match.js          URL patterns, categories, schedules, DLP matching (shared with the browser)
  public/admin/         Admin Console (single-page app, no build step)
browser/                K-Browser (Electron)
  src/main/main.js      app lifecycle, sign-in, server connection
  src/main/shell.js     browser window, tabs, auto-login, downloads, remote commands
  src/main/session.js   per-user session: web filter, permissions, kb:// pages, cert pinning
  src/main/autofill.js  isolated-world login filler + password masking
  src/main/dlp.js       isolated-world copy/paste/upload blocking + watermark
  src/renderer/         browser UI, sign-in window, new-tab/blocked/error pages
```
