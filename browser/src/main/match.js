'use strict';
// URL pattern matching shared by the control server and the browser client.
// NOTE: an identical copy lives in server/src/match.js — keep them in sync
// (server/test/match.test.js fails if they differ).
//
// Supported pattern forms:
//   *                         every http(s) URL
//   example.com               example.com and all of its subdomains
//   *.example.com             subdomains of example.com only (not the apex)
//   =example.com              exactly this host, no subdomains
//   example.com/path          host (and subdomains) + path prefix
//   example.com:8080          host + explicit port
//   https://example.com/a/*   full-URL glob ("*" matches anything)
//   192.168.1.0/24            IPv4 CIDR range
//   category:social           a built-in website category (see CATEGORIES)
//
// Rules may also carry:
//   schedule: "Mon-Fri 09:00-18:00"  rule only applies at these local times
//   expiresAt: ISO date              rule stops applying after this moment

const CATEGORIES = {
  social: {
    label: 'Social networks',
    domains: ['facebook.com', 'fb.com', 'instagram.com', 'twitter.com', 'x.com', 'tiktok.com', 'snapchat.com', 'linkedin.com', 'pinterest.com', 'reddit.com', 'tumblr.com', 'threads.net', 'bsky.app', 'mastodon.social', 'quora.com', 'vk.com', 'sharechat.com', 'koo.in', 'weibo.com', 'discord.com'],
  },
  video: {
    label: 'Video streaming',
    domains: ['youtube.com', 'youtu.be', 'googlevideo.com', 'netflix.com', 'primevideo.com', 'hotstar.com', 'disneyplus.com', 'hulu.com', 'twitch.tv', 'vimeo.com', 'dailymotion.com', 'jiocinema.com', 'sonyliv.com', 'zee5.com', 'mxplayer.in', 'max.com', 'crunchyroll.com', 'kick.com'],
  },
  music: {
    label: 'Music streaming',
    domains: ['spotify.com', 'music.youtube.com', 'gaana.com', 'jiosaavn.com', 'wynk.in', 'soundcloud.com', 'music.apple.com', 'pandora.com', 'deezer.com', 'tidal.com'],
  },
  games: {
    label: 'Games',
    domains: ['steampowered.com', 'steamcommunity.com', 'epicgames.com', 'roblox.com', 'miniclip.com', 'poki.com', 'crazygames.com', 'chess.com', 'lichess.org', 'ea.com', 'battle.net', 'itch.io', 'friv.com', 'y8.com', 'armorgames.com', 'kongregate.com'],
  },
  shopping: {
    label: 'Shopping',
    domains: ['amazon.com', 'amazon.in', 'flipkart.com', 'myntra.com', 'ajio.com', 'meesho.com', 'snapdeal.com', 'ebay.com', 'aliexpress.com', 'temu.com', 'shein.com', 'etsy.com', 'walmart.com', 'nykaa.com', 'tatacliq.com', 'bigbasket.com', 'blinkit.com', 'swiggy.com', 'zomato.com'],
  },
  news: {
    label: 'News & media',
    domains: ['cnn.com', 'bbc.com', 'bbc.co.uk', 'nytimes.com', 'theguardian.com', 'ndtv.com', 'timesofindia.indiatimes.com', 'indiatimes.com', 'hindustantimes.com', 'thehindu.com', 'indianexpress.com', 'news18.com', 'aajtak.in', 'foxnews.com', 'reuters.com', 'bloomberg.com', 'news.google.com', 'msn.com', 'yahoo.com'],
  },
  gambling: {
    label: 'Gambling & betting',
    domains: ['bet365.com', 'betway.com', 'dream11.com', 'mpl.live', 'pokerstars.com', 'draftkings.com', 'fanduel.com', '1xbet.com', 'parimatch.com', 'stake.com', 'rummycircle.com', 'pokerbaazi.com', 'my11circle.com', 'williamhill.com', '888.com'],
  },
  adult: {
    label: 'Adult content',
    domains: ['pornhub.com', 'xvideos.com', 'xnxx.com', 'xhamster.com', 'redtube.com', 'youporn.com', 'onlyfans.com', 'chaturbate.com', 'stripchat.com', 'spankbang.com', 'brazzers.com', 'livejasmin.com', 'eporner.com'],
  },
  dating: {
    label: 'Dating',
    domains: ['tinder.com', 'bumble.com', 'hinge.co', 'okcupid.com', 'match.com', 'badoo.com', 'aisle.co', 'trulymadly.com', 'happn.com', 'grindr.com', 'shaadi.com', 'jeevansathi.com', 'bharatmatrimony.com'],
  },
  filesharing: {
    label: 'File sharing & personal cloud',
    domains: ['wetransfer.com', 'mega.nz', 'mediafire.com', 'dropbox.com', 'drive.google.com', 'onedrive.live.com', '1drv.ms', 'box.com', 'pcloud.com', 'sendspace.com', 'filemail.com', 'gofile.io', 'transfer.sh', 'icloud.com', 'terabox.com', 'zippyshare.com'],
  },
  webmail: {
    label: 'Personal webmail',
    domains: ['mail.google.com', 'outlook.live.com', 'mail.yahoo.com', 'mail.proton.me', 'proton.me', 'zoho.com', 'gmx.com', 'aol.com', 'yandex.com', 'tutanota.com', 'rediffmail.com'],
  },
  ai: {
    label: 'AI assistants',
    domains: ['chatgpt.com', 'openai.com', 'claude.ai', 'gemini.google.com', 'copilot.microsoft.com', 'perplexity.ai', 'poe.com', 'character.ai', 'deepseek.com', 'grok.com', 'meta.ai', 'you.com', 'mistral.ai'],
  },
  proxy: {
    label: 'Proxies & VPNs',
    domains: ['hidemyass.com', 'hide.me', 'proxysite.com', 'kproxy.com', 'croxyproxy.com', 'nordvpn.com', 'expressvpn.com', 'protonvpn.com', 'windscribe.com', 'surfshark.com', 'torproject.org', 'hola.org', 'psiphon.ca', 'ultrasurf.us', 'browsec.com'],
  },
  torrents: {
    label: 'Torrents & piracy',
    domains: ['thepiratebay.org', '1337x.to', 'rarbg.to', 'yts.mx', 'torrentz2.eu', 'limetorrents.info', 'nyaa.si', 'fitgirl-repacks.site', 'tamilrockers.ws', 'movierulz.com', 'filmyzilla.com', 'fmovies.to', 'utorrent.com', 'bittorrent.com'],
  },
  jobs: {
    label: 'Job search',
    domains: ['naukri.com', 'indeed.com', 'monster.com', 'glassdoor.com', 'foundit.in', 'shine.com', 'timesjobs.com', 'instahyre.com', 'wellfound.com', 'internshala.com', 'apna.co', 'hirist.tech'],
  },
};

const DAY_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];
const scheduleCache = new Map();

// "Mon-Fri 09:00-18:00", "Sat,Sun", "09:00-13:00", "Mon-Fri 09:00-13:00 14:00-18:00"
function parseSchedule(text) {
  const key = String(text || '').trim().toLowerCase();
  if (!key) return null;
  if (scheduleCache.has(key)) return scheduleCache.get(key);
  let days = null;
  const ranges = [];
  for (const token of key.split(/\s+/)) {
    const time = token.match(/^(\d{1,2}):(\d{2})-(\d{1,2}):(\d{2})$/);
    if (time) {
      const from = Number(time[1]) * 60 + Number(time[2]);
      const to = Number(time[3]) * 60 + Number(time[4]);
      if (from > 24 * 60 || to > 24 * 60 || Number(time[2]) > 59 || Number(time[4]) > 59) throw new Error(`Invalid time range "${token}"`);
      ranges.push([from, to]);
      continue;
    }
    days = days || new Set();
    for (const part of token.split(',').filter(Boolean)) {
      const span = part.split('-');
      const a = DAY_NAMES.indexOf(span[0].slice(0, 3));
      const b = span.length > 1 ? DAY_NAMES.indexOf(span[1].slice(0, 3)) : a;
      if (a === -1 || b === -1 || span.length > 2) throw new Error(`Invalid day "${part}" (use Mon, Tue, … or Mon-Fri)`);
      for (let d = a; ; d = (d + 1) % 7) {
        days.add(d);
        if (d === b) break;
      }
    }
  }
  const parsed = { days, ranges };
  scheduleCache.set(key, parsed);
  return parsed;
}

function inSchedule(text, now = new Date()) {
  const s = parseSchedule(text);
  if (!s) return true;
  const minutes = now.getHours() * 60 + now.getMinutes();
  const day = now.getDay();
  if (!s.ranges.length) return !s.days || s.days.has(day);
  return s.ranges.some(([from, to]) => {
    if (from <= to) return (!s.days || s.days.has(day)) && minutes >= from && minutes < to;
    // overnight range such as 22:00-06:00: the morning part belongs to the previous day
    if (minutes >= from) return !s.days || s.days.has(day);
    return minutes < to && (!s.days || s.days.has((day + 6) % 7));
  });
}

function ruleActive(rule, now = new Date()) {
  if (!rule || rule.enabled === false) return false;
  if (rule.expiresAt && Date.parse(rule.expiresAt) <= now.getTime()) return false;
  if (rule.schedule) {
    try {
      return inSchedule(rule.schedule, now);
    } catch {
      return false;
    }
  }
  return true;
}

function globToRegExp(glob) {
  const escaped = glob.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
  return new RegExp('^' + escaped + '$', 'i');
}

function ipv4ToInt(ip) {
  const parts = ip.split('.');
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const v = Number(p);
    if (v > 255) return null;
    n = n * 256 + v;
  }
  return n;
}

function parseUrl(url) {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

function hostMatches(host, patternHost, mode) {
  host = host.toLowerCase().replace(/\.$/, '');
  patternHost = patternHost.toLowerCase().replace(/\.$/, '');
  if (mode === 'exact') return host === patternHost;
  if (mode === 'subdomains') return host.endsWith('.' + patternHost);
  return host === patternHost || host.endsWith('.' + patternHost);
}

function matchesPattern(url, pattern) {
  if (!pattern || typeof pattern !== 'string') return false;
  pattern = pattern.trim();
  if (!pattern) return false;
  const u = typeof url === 'string' ? parseUrl(url) : url;
  if (!u) return false;
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  if (pattern === '*') return true;

  if (pattern.toLowerCase().startsWith('category:')) {
    const cat = CATEGORIES[pattern.slice(9).trim().toLowerCase()];
    return !!cat && cat.domains.some((d) => hostMatches(u.hostname, d, 'domain'));
  }

  if (pattern.includes('://')) {
    return globToRegExp(pattern).test(u.href);
  }

  const cidr = pattern.match(/^(\d{1,3}(?:\.\d{1,3}){3})\/(\d{1,2})$/);
  if (cidr) {
    const base = ipv4ToInt(cidr[1]);
    const host = ipv4ToInt(u.hostname);
    const bits = Number(cidr[2]);
    if (base === null || host === null || bits > 32) return false;
    const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
    return ((base & mask) >>> 0) === ((host & mask) >>> 0);
  }

  let mode = 'domain';
  if (pattern.startsWith('=')) {
    mode = 'exact';
    pattern = pattern.slice(1);
  } else if (pattern.startsWith('*.')) {
    mode = 'subdomains';
    pattern = pattern.slice(2);
  }

  const slash = pattern.indexOf('/');
  let hostPart = slash === -1 ? pattern : pattern.slice(0, slash);
  const pathPart = slash === -1 ? '' : pattern.slice(slash);

  let port = null;
  const portMatch = hostPart.match(/^(.*):(\d+)$/);
  if (portMatch) {
    hostPart = portMatch[1];
    port = portMatch[2];
  }

  if (!hostMatches(u.hostname, hostPart, mode)) return false;
  if (port !== null) {
    const actualPort = u.port || (u.protocol === 'https:' ? '443' : '80');
    if (actualPort !== port) return false;
  }
  if (pathPart) {
    const p = pathPart.toLowerCase();
    if (p.includes('*')) {
      if (!globToRegExp(p).test((u.pathname + u.search).toLowerCase())) return false;
    } else if (!u.pathname.toLowerCase().startsWith(p)) {
      return false;
    }
  }
  return true;
}

const INTERNAL_SCHEMES = new Set(['kb:', 'about:', 'data:', 'blob:']);

// policy = { mode: 'blocklist' | 'allowlist', rules: [{ pattern, action: 'allow'|'block', source, schedule, expiresAt }] }
// Rules are evaluated in order; the first active match wins. Without a match the mode decides.
function evaluateUrl(url, policy, now = new Date()) {
  const u = parseUrl(url);
  if (!u) return { allowed: false, reason: 'invalid-url', rule: null };
  if (INTERNAL_SCHEMES.has(u.protocol)) return { allowed: true, reason: 'internal', rule: null };
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    return { allowed: false, reason: 'scheme', rule: null };
  }
  const rules = (policy && policy.rules) || [];
  for (const rule of rules) {
    if (ruleActive(rule, now) && matchesPattern(u, rule.pattern)) {
      return { allowed: rule.action !== 'block', reason: 'rule', rule };
    }
  }
  const mode = (policy && policy.mode) || 'blocklist';
  return { allowed: mode !== 'allowlist', reason: 'default', rule: null };
}

function credentialMatches(url, credential) {
  return (credential.match || []).some((p) => matchesPattern(url, p));
}

// Combines all data-protection rules that apply to a URL into one set of restrictions.
const DLP_FLAGS = ['blockCopy', 'blockPaste', 'blockPrint', 'blockDownload', 'blockUpload', 'watermark', 'screenshotProtect'];
function dlpFor(url, rules) {
  const out = {};
  for (const r of rules || []) {
    if (r.enabled === false || !(r.match || []).some((p) => matchesPattern(url, p))) continue;
    for (const f of DLP_FLAGS) if (r[f]) out[f] = true;
  }
  return out;
}

module.exports = {
  matchesPattern,
  evaluateUrl,
  credentialMatches,
  globToRegExp,
  parseSchedule,
  inSchedule,
  ruleActive,
  dlpFor,
  DLP_FLAGS,
  CATEGORIES,
};
