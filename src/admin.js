'use strict';
// The password-protected administration page of the proxy (served under /_admin) and its settings file, admin.json:
//
//   { "passwordHash": "scrypt$16384$8$1$<salt>$<hash>",
//     "notify": { "recipients": ["you@example.com"],
//                 "smtp": { "host": "smtp.example.com", "port": 587, "security": "starttls",
//                           "user": "...", "password": "...", "from": "proxy@example.com" } } }
//
// The page is off unless admin.json holds a password hash. "notify" is used by src/notify.js (the auto-updater's
// e-mails) and edited on the page. The file is created by the installers (`node src/admin.js setup FILE`) and only
// ever rewritten in place: the proxy's account may write it but cannot create files in the settings folder.
//
//   node src/admin.js setup FILE   create FILE if missing, then apply the FOUNDRY_PROXY_* variables that are set:
//                                  FOUNDRY_PROXY_ADMIN_PASSWORD, FOUNDRY_PROXY_NOTIFY_EMAILS (comma separated),
//                                  FOUNDRY_PROXY_SMTP_HOST, _PORT, _SECURITY, _USER, _PASSWORD, _FROM
//   node src/admin.js check FILE   exit 0 when FILE has a password hash (the page is on), 3 when not, 1 on error
//
// Secrets come from the environment, never from the command line, and are never printed.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const { sendMail, isEmail, smtpProblem } = require('./mailer.js');

const scrypt = promisify(crypto.scrypt);
const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 64 };
const MIN_PASSWORD = 8;
const MAX_PASSWORD = 1024;
const MAX_RECIPIENTS = 20;
const MAX_BODY_BYTES = 16 * 1024;
const SESSION_MS = 12 * 60 * 60 * 1000;
const MAX_SESSIONS = 20;
const LOGIN_FAILURES = 5;
const LOCKOUT_MS = 5 * 60 * 1000;
// Across all addresses: more failed logins than this within GLOBAL_WINDOW_MS pause every login for that long.
const GLOBAL_FAILURES = 50;
const GLOBAL_WINDOW_MS = 15 * 60 * 1000;
const COOKIE = 'frp_admin';
const PREFIX = '/_admin';
const SMTP_KEYS = ['host', 'port', 'security', 'user', 'password', 'from'];
const UI_FILES = {
  '': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/': { file: 'index.html', type: 'text/html; charset=utf-8' },
  '/app.js': { file: 'app.js', type: 'text/javascript; charset=utf-8' },
  '/app.css': { file: 'app.css', type: 'text/css; charset=utf-8' },
};
const SECURITY_HEADERS = {
  'Content-Security-Policy':
    "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; " +
    "form-action 'none'; frame-ancestors 'none'; base-uri 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
};

class SettingsError extends Error {}

// A client error in an admin API call: answered with its status and message.
class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/** Default notification settings: nobody to notify. */
function defaultNotify() {
  return {
    recipients: [],
    smtp: { host: '', port: 587, security: 'starttls', user: '', password: '', from: '' },
  };
}

/** Validates notification settings; throws `make(message)` on the first problem, returns a clean copy. */
function cleanNotify(raw, make) {
  const out = defaultNotify();
  if (raw === undefined) return out;
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw make('"notify" must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'recipients' && key !== 'smtp') throw make(`"notify" has unknown key "${key}"`);
  }
  if (raw.recipients !== undefined) {
    if (!Array.isArray(raw.recipients)) throw make('"recipients" must be a list of e-mail addresses');
    const seen = new Set();
    for (const r of raw.recipients) {
      const address = typeof r === 'string' ? r.trim() : r;
      if (!isEmail(address)) throw make(`invalid e-mail address "${String(r).slice(0, 100)}"`);
      if (!seen.has(address.toLowerCase())) out.recipients.push(address);
      seen.add(address.toLowerCase());
    }
    if (out.recipients.length > MAX_RECIPIENTS) throw make(`at most ${MAX_RECIPIENTS} recipients`);
  }
  const smtp = raw.smtp;
  if (smtp !== undefined) {
    if (smtp === null || typeof smtp !== 'object' || Array.isArray(smtp)) throw make('"smtp" must be an object');
    for (const key of Object.keys(smtp)) {
      if (!SMTP_KEYS.includes(key)) throw make(`"smtp" has unknown key "${key}"`);
    }
    for (const key of ['host', 'user', 'password', 'from']) {
      if (smtp[key] === undefined) continue;
      if (typeof smtp[key] !== 'string' || /[\r\n\0]/.test(smtp[key]) || smtp[key].length > 1024) {
        throw make(`invalid SMTP ${key}`);
      }
      out.smtp[key] = key === 'password' ? smtp[key] : smtp[key].trim();
    }
    if (smtp.port !== undefined) out.smtp.port = smtp.port;
    if (smtp.security !== undefined) out.smtp.security = smtp.security;
    // Everything but a missing host (= no mail server yet) must be valid.
    if (out.smtp.host) {
      const problem = smtpProblem(out.smtp);
      if (problem) throw make(problem);
    } else if (!Number.isInteger(out.smtp.port) || out.smtp.port < 1 || out.smtp.port > 65535) {
      throw make('invalid SMTP port');
    } else if (!['starttls', 'tls', 'none'].includes(out.smtp.security)) {
      throw make('SMTP security must be starttls, tls or none');
    } else if (out.smtp.from && !isEmail(out.smtp.from)) {
      throw make('invalid sender address');
    }
  }
  return out;
}

/** Parses admin.json text into { passwordHash, notify }. */
function parseAdminSettings(text, source = 'admin settings') {
  const make = (msg) => new SettingsError(`${source}: ${msg}`);
  let raw;
  try {
    raw = text.trim() === '' ? {} : JSON.parse(text);
  } catch (err) {
    throw make(`not valid JSON (${err.message})`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw make('top level must be an object');
  for (const key of Object.keys(raw)) {
    if (key !== 'passwordHash' && key !== 'notify') throw make(`unknown key "${key}"`);
  }
  let passwordHash = '';
  if (raw.passwordHash !== undefined && raw.passwordHash !== '') {
    if (typeof raw.passwordHash !== 'string' || !parseHash(raw.passwordHash)) throw make('invalid "passwordHash"');
    passwordHash = raw.passwordHash;
  }
  return { passwordHash, notify: cleanNotify(raw.notify, make) };
}

/** Reads admin.json; a missing file means "no admin page, nobody to notify". */
function loadAdminSettings(file) {
  let text;
  try {
    text = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if (err.code === 'ENOENT') return { passwordHash: '', notify: defaultNotify(), missing: true };
    throw new SettingsError(`cannot read ${file}: ${err.message}`);
  }
  return parseAdminSettings(text, file);
}

function serializeAdminSettings(settings) {
  return `${JSON.stringify({ passwordHash: settings.passwordHash || undefined, notify: settings.notify }, null, 2)}\n`;
}

/**
 * Replaces the contents of an existing file without creating a new one (the proxy cannot create files in its
 * settings folder, so there is no temp-file-and-rename; the files are small enough for a single write).
 */
function rewriteFile(file, text) {
  const data = Buffer.from(text, 'utf8');
  const fd = fs.openSync(file, 'r+');
  try {
    fs.writeSync(fd, data, 0, data.length, 0);
    fs.ftruncateSync(fd, data.length);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function parseHash(text) {
  const m = /^scrypt\$(\d+)\$(\d+)\$(\d+)\$([A-Za-z0-9+/=]+)\$([A-Za-z0-9+/=]+)$/.exec(text);
  if (!m) return null;
  const [N, r, p] = [Number(m[1]), Number(m[2]), Number(m[3])];
  // Bounds keep a tampered file from making every login take minutes.
  if (N < 1024 || N > 1048576 || (N & (N - 1)) !== 0 || r < 1 || r > 32 || p < 1 || p > 16) return null;
  const salt = Buffer.from(m[4], 'base64');
  const hash = Buffer.from(m[5], 'base64');
  if (salt.length < 16 || hash.length < 32 || hash.length > 128) return null;
  return { N, r, p, salt, hash };
}

/** Checks a new password's length; returns an error message or ''. */
function passwordProblem(password) {
  if (typeof password !== 'string' || password.length < MIN_PASSWORD) {
    return `the password needs at least ${MIN_PASSWORD} characters`;
  }
  if (password.length > MAX_PASSWORD) return 'the password is too long';
  return '';
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const { N, r, p, keylen } = SCRYPT;
  const hash = await scrypt(String(password).normalize('NFC'), salt, keylen, { N, r, p, maxmem: 256 * N * r });
  return `scrypt$${N}$${r}$${p}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

async function verifyPassword(password, stored) {
  const h = parseHash(stored || '');
  if (!h || typeof password !== 'string' || password.length > MAX_PASSWORD) return false;
  const got = await scrypt(password.normalize('NFC'), h.salt, h.hash.length, {
    N: h.N,
    r: h.r,
    p: h.p,
    maxmem: 256 * h.N * h.r + 1024 * 1024,
  });
  return crypto.timingSafeEqual(got, h.hash);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new HttpError(413, 'request too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

function parseCookies(header) {
  const out = Object.create(null);
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  }
  return out;
}

const sameSecret = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/** Host names a request for the admin page may carry (a guard against DNS rebinding). */
function allowedHosts(publicBaseUrl, extra = []) {
  const hosts = new Set(['localhost', '127.0.0.1', '[::1]']);
  try {
    hosts.add(new URL(publicBaseUrl).hostname.toLowerCase());
  } catch {
    // main() already refuses an invalid PUBLIC_BASE_URL
  }
  for (const h of extra) if (h) hosts.add(String(h).trim().toLowerCase());
  return hosts;
}

let machineCache = { at: 0, names: new Set() };
/** This machine's host name (and name.local) and IP addresses: a browser on the LAN may use any of them. */
function machineHosts(now) {
  if (now - machineCache.at < 30000) return machineCache.names;
  const names = new Set();
  const host = os.hostname().toLowerCase();
  names.add(host);
  if (!host.includes('.')) names.add(`${host}.local`);
  for (const list of Object.values(os.networkInterfaces())) {
    for (const a of list || []) {
      const addr = a.address.replace(/%.*$/, '').toLowerCase();
      names.add(a.family === 'IPv6' || a.family === 6 ? `[${addr}]` : addr);
    }
  }
  machineCache = { at: now, names };
  return names;
}

function hostOf(value) {
  try {
    return new URL(`http://${value}`).hostname.toLowerCase();
  } catch {
    return '';
  }
}

/**
 * The /_admin handler. getModules() => current module map; validateModules(raw) => parsed map (throws on bad input);
 * saveModules(parsed, raw) writes config.json and switches the proxy over; checkRelease(cfg) => latest release info. Returns { handles(pathname), handle(req, res, pathname) }.
 */
function createAdmin({
  adminFile,
  settings,
  publicBaseUrl,
  getModules,
  saveModules,
  checkRelease,
  validateModules,
  extraHosts = [],
  trustProxy = false,
  log = console.log,
  mailer = sendMail,
  now = Date.now,
}) {
  const base = publicBaseUrl.replace(/\/+$/, '');
  const hosts = allowedHosts(publicBaseUrl, extraHosts);
  const sessions = new Map(); // id -> { csrf, expires }
  const failures = new Map(); // remote address -> { count, until }
  let globalFailures = []; // times of recent failed logins, any address
  // DNS rebinding sends the attacker's own name; this machine's names and addresses (LAN access) are fine.
  const hostAllowed = (h) => hosts.has(h) || machineHosts(now()).has(h);
  const ui = Object.create(null);
  for (const [route, { file, type }] of Object.entries(UI_FILES)) {
    ui[route] = { body: fs.readFileSync(path.join(__dirname, 'admin-ui', file)), type };
  }

  const enabled = () => Boolean(settings.passwordHash);

  function persist(next) {
    rewriteFile(adminFile, serializeAdminSettings(next));
    settings = next;
  }

  function send(res, status, body, headers = {}) {
    res.writeHead(status, { 'Cache-Control': 'no-store', ...SECURITY_HEADERS, ...headers });
    res.end(body);
  }
  const sendJson = (res, status, obj, headers = {}) =>
    send(res, status, JSON.stringify(obj), { 'Content-Type': 'application/json; charset=utf-8', ...headers });

  function session(req) {
    const id = parseCookies(req.headers.cookie)[COOKIE];
    if (!id) return null;
    const s = sessions.get(id);
    if (!s) return null;
    if (s.expires < now()) {
      sessions.delete(id);
      return null;
    }
    return { id, ...s };
  }

  function newSession() {
    for (const [id, s] of sessions) if (s.expires < now()) sessions.delete(id);
    while (sessions.size >= MAX_SESSIONS) sessions.delete(sessions.keys().next().value);
    const id = crypto.randomBytes(32).toString('base64url');
    const csrf = crypto.randomBytes(32).toString('base64url');
    sessions.set(id, { csrf, expires: now() + SESSION_MS });
    return { id, csrf };
  }

  // HTTPS: the admin listener's own TLS, or (ADMIN_TRUST_PROXY) a reverse proxy that says so.
  const isSecure = (req) =>
    Boolean(req.socket.encrypted) || (trustProxy && /^https$/i.test(String(req.headers['x-forwarded-proto'] || '')));

  // Behind a trusted reverse proxy the client is the last address it added to X-Forwarded-For.
  function clientIp(req) {
    const fwd = trustProxy ? String(req.headers['x-forwarded-for'] || '').split(',').map((x) => x.trim()).filter(Boolean) : [];
    return fwd.length ? fwd[fwd.length - 1] : req.socket.remoteAddress || '?';
  }

  const cookie = (req, id, maxAge) =>
    `${COOKIE}=${id}; Path=${PREFIX}; HttpOnly; SameSite=Strict; Max-Age=${maxAge}` + (isSecure(req) ? '; Secure' : '');

  function moduleList() {
    const modules = getModules();
    return Object.keys(modules)
      .sort()
      .map((id) => ({ id, ...modules[id], link: `${base}/${encodeURIComponent(id)}/module.json` }));
  }

  function notifyView() {
    const { password, ...smtp } = settings.notify.smtp;
    return { recipients: settings.notify.recipients, smtp: { ...smtp, passwordSet: Boolean(password) } };
  }

  function state(csrf) {
    return { csrf, modules: moduleList(), notify: notifyView(), publicBaseUrl: base };
  }

  /** Builds a module entry from a request body; only non-default asset names are stored. */
  function moduleEntry(body) {
    const entry = { repo: typeof body.repo === 'string' ? body.repo.trim() : body.repo };
    for (const key of ['manifestAsset', 'zipAsset']) {
      const v = typeof body[key] === 'string' ? body[key].trim() : body[key];
      const dflt = key === 'manifestAsset' ? 'module.json' : 'module.zip';
      if (v !== undefined && v !== '' && v !== dflt) entry[key] = v;
    }
    return entry;
  }

  /** Validates the would-be config with the proxy's own rules, then writes it. */
  function applyModules(raw, what) {
    let parsed;
    try {
      parsed = validateModules(raw);
    } catch (err) {
      throw new HttpError(400, err.message.replace(/^admin: /, ''));
    }
    saveModules(parsed, raw);
    log(`admin: ${what}`);
  }

  function rawConfig() {
    const modules = getModules();
    // null prototype: an id like "__proto__" becomes a real key and is refused by validation
    const raw = Object.create(null);
    for (const id of Object.keys(modules)) {
      const { repo, manifestAsset, zipAsset } = modules[id];
      raw[id] = { repo };
      if (manifestAsset !== 'module.json') raw[id].manifestAsset = manifestAsset;
      if (zipAsset !== 'module.zip') raw[id].zipAsset = zipAsset;
    }
    return raw;
  }

  async function login(req, res, body) {
    const ip = clientIp(req);
    const f = failures.get(ip);
    globalFailures = globalFailures.filter((t) => t > now() - GLOBAL_WINDOW_MS);
    if ((f && f.until > now()) || globalFailures.length >= GLOBAL_FAILURES) {
      return sendJson(res, 429, { error: 'too many failed logins; try again in a few minutes' });
    }
    if (await verifyPassword(body.password, settings.passwordHash)) {
      failures.delete(ip);
      const s = newSession();
      log('admin: login');
      return sendJson(res, 200, state(s.csrf), { 'Set-Cookie': cookie(req, s.id, SESSION_MS / 1000) });
    }
    // A lockout that has run out starts the count again.
    const count = (f && !f.until ? f.count : 0) + 1;
    failures.set(ip, { count, until: count >= LOGIN_FAILURES ? now() + LOCKOUT_MS : 0 });
    if (failures.size > 1000) failures.delete(failures.keys().next().value);
    globalFailures.push(now());
    log(`admin: failed login from ${ip}`);
    return sendJson(res, 401, { error: 'wrong password' });
  }

  async function api(req, res, route, s) {
    const method = req.method;
    let body = {};
    if (method !== 'GET' && method !== 'HEAD') {
      if (!/^application\/json\b/i.test(req.headers['content-type'] || '')) {
        throw new HttpError(415, 'expected application/json');
      }
      const origin = req.headers.origin;
      if (origin && origin !== 'null' && !hostAllowed(hostOf(origin.replace(/^[a-z]+:\/\//i, '')))) {
        throw new HttpError(403, 'cross-origin request refused');
      }
      const text = await readBody(req);
      try {
        body = text ? JSON.parse(text) : {};
      } catch {
        throw new HttpError(400, 'invalid JSON');
      }
      if (body === null || typeof body !== 'object' || Array.isArray(body)) throw new HttpError(400, 'invalid JSON');
    }

    if (route === '/api/login' && method === 'POST') return login(req, res, body);
    if (!s) throw new HttpError(401, 'not logged in');
    if (route === '/api/state' && method === 'GET') return sendJson(res, 200, state(s.csrf));
    if (method !== 'GET' && !sameSecret(req.headers['x-csrf-token'] || '', s.csrf)) {
      throw new HttpError(403, 'missing or wrong CSRF token; reload the page');
    }

    if (route === '/api/logout' && method === 'POST') {
      sessions.delete(s.id);
      return sendJson(res, 200, { ok: true }, { 'Set-Cookie': cookie(req, '', 0) });
    }

    if (route === '/api/modules' && method === 'POST') {
      const id = typeof body.id === 'string' ? body.id.trim() : '';
      const raw = rawConfig();
      if (Object.hasOwn(raw, id)) throw new HttpError(409, `module "${id}" already exists`);
      raw[id] = moduleEntry(body);
      applyModules(raw, `added module ${id} (${raw[id].repo})`);
      return sendJson(res, 200, state(s.csrf));
    }

    const m = /^\/api\/modules\/([^/]+)(\/release)?$/.exec(route);
    if (m) {
      let id;
      try {
        id = decodeURIComponent(m[1]);
      } catch {
        throw new HttpError(404, 'no such module');
      }
      const raw = rawConfig();
      if (!Object.hasOwn(raw, id)) throw new HttpError(404, 'no such module');
      if (m[2] && method === 'GET') {
        return sendJson(res, 200, await checkRelease(getModules()[id]));
      }
      if (!m[2] && method === 'PUT') {
        const newId = typeof body.id === 'string' && body.id.trim() ? body.id.trim() : id;
        if (newId !== id && Object.hasOwn(raw, newId)) throw new HttpError(409, `module "${newId}" already exists`);
        // Keep the order of the file: the edited entry stays where it was.
        const next = Object.create(null);
        for (const key of Object.keys(raw)) {
          if (key === id) next[newId] = moduleEntry(body);
          else next[key] = raw[key];
        }
        const what = newId === id ? `changed module ${id}` : `renamed module ${id} to ${newId}`;
        applyModules(next, `${what} (${next[newId].repo})`);
        return sendJson(res, 200, state(s.csrf));
      }
      if (!m[2] && method === 'DELETE') {
        delete raw[id];
        applyModules(raw, `deleted module ${id}`);
        return sendJson(res, 200, state(s.csrf));
      }
    }

    if (route === '/api/notify' && method === 'PUT') {
      const smtpIn = body.smtp && typeof body.smtp === 'object' && !Array.isArray(body.smtp) ? body.smtp : {};
      const smtp = {};
      for (const key of SMTP_KEYS) if (smtpIn[key] !== undefined) smtp[key] = smtpIn[key];
      // An empty or missing password keeps the stored one; clearPassword removes it.
      if (smtp.password === undefined || smtp.password === '') smtp.password = settings.notify.smtp.password;
      if (smtpIn.clearPassword === true) smtp.password = '';
      if (typeof smtp.port === 'string' && /^\d+$/.test(smtp.port)) smtp.port = Number(smtp.port);
      const notify = cleanNotify({ recipients: body.recipients, smtp }, (msg) => new HttpError(400, msg));
      persist({ ...settings, notify });
      log(`admin: notification settings saved (${notify.recipients.length} recipient(s))`);
      return sendJson(res, 200, state(s.csrf));
    }

    if (route === '/api/notify/test' && method === 'POST') {
      const { recipients, smtp } = settings.notify;
      if (!recipients.length) throw new HttpError(400, 'add at least one recipient first');
      try {
        await mailer(smtp, {
          to: recipients,
          subject: 'Foundry release proxy: test e-mail',
          text: 'This is a test e-mail from the administration page of the Foundry release proxy.\n' +
            'The proxy sends its automatic-update notifications to these addresses.\n',
        });
      } catch (err) {
        log(`admin: test e-mail failed (${err.message})`);
        throw new HttpError(502, `sending failed: ${err.message}`);
      }
      log(`admin: test e-mail sent to ${recipients.length} recipient(s)`);
      return sendJson(res, 200, { ok: true });
    }

    if (route === '/api/password' && method === 'PUT') {
      if (!(await verifyPassword(body.current, settings.passwordHash))) {
        throw new HttpError(403, 'the current password is wrong');
      }
      const problem = passwordProblem(body.password);
      if (problem) throw new HttpError(400, problem);
      persist({ ...settings, passwordHash: await hashPassword(body.password) });
      // Every other session ends; this one gets a fresh id.
      sessions.clear();
      const fresh = newSession();
      log('admin: password changed');
      return sendJson(res, 200, state(fresh.csrf), { 'Set-Cookie': cookie(req, fresh.id, SESSION_MS / 1000) });
    }

    throw new HttpError(404, 'not found');
  }

  return {
    /** True for every path below /_admin (answered here, or 404 while the page is off). */
    handles: (pathname) => pathname === PREFIX || pathname.startsWith(`${PREFIX}/`),

    async handle(req, res, pathname) {
      if (!enabled()) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      if (!hostAllowed(hostOf(req.headers.host || ''))) {
        return send(res, 403, 'admin page: unknown host name (see ADMIN_HOSTS in the README)', {
          'Content-Type': 'text/plain; charset=utf-8',
        });
      }
      const route = pathname.slice(PREFIX.length);
      if (Object.hasOwn(ui, route)) {
        if (req.method !== 'GET' && req.method !== 'HEAD') {
          return send(res, 405, 'method not allowed', { Allow: 'GET, HEAD' });
        }
        return send(res, 200, req.method === 'HEAD' ? undefined : ui[route].body, { 'Content-Type': ui[route].type });
      }
      if (!route.startsWith('/api/')) return send(res, 404, 'not found', { 'Content-Type': 'text/plain; charset=utf-8' });
      try {
        await api(req, res, route, session(req));
      } catch (err) {
        if (err instanceof HttpError) {
          if (!res.headersSent) sendJson(res, err.status, { error: err.message });
          return;
        }
        throw err;
      }
    },
  };
}

/** `node src/admin.js setup FILE`: create FILE if missing and apply the FOUNDRY_PROXY_* variables that are set. */
async function setup(file, env) {
  let settings = { passwordHash: '', notify: defaultNotify() };
  if (fs.existsSync(file)) settings = loadAdminSettings(file);
  const changed = [];
  if (env.FOUNDRY_PROXY_ADMIN_PASSWORD) {
    const problem = passwordProblem(env.FOUNDRY_PROXY_ADMIN_PASSWORD);
    if (problem) throw new SettingsError(`admin password: ${problem}`);
    settings.passwordHash = await hashPassword(env.FOUNDRY_PROXY_ADMIN_PASSWORD);
    changed.push('admin password');
  }
  const notify = { recipients: settings.notify.recipients, smtp: { ...settings.notify.smtp } };
  if (env.FOUNDRY_PROXY_NOTIFY_EMAILS !== undefined && env.FOUNDRY_PROXY_NOTIFY_EMAILS !== '') {
    notify.recipients = env.FOUNDRY_PROXY_NOTIFY_EMAILS.split(/[,;\s]+/).filter(Boolean);
    changed.push('notification recipients');
  }
  for (const key of SMTP_KEYS) {
    const v = env[`FOUNDRY_PROXY_SMTP_${key.toUpperCase()}`];
    if (v === undefined || v === '') continue;
    notify.smtp[key] = key === 'port' ? Number(v) : v;
    if (!changed.includes('SMTP settings')) changed.push('SMTP settings');
  }
  settings.notify = cleanNotify(notify, (msg) => new SettingsError(`notification settings: ${msg}`));
  const text = serializeAdminSettings(settings);
  if (fs.existsSync(file)) rewriteFile(file, text);
  else fs.writeFileSync(file, text, { mode: 0o600 });
  return changed;
}

async function cli(argv, env) {
  const [command, file] = argv;
  if (!file || (command !== 'setup' && command !== 'check')) {
    console.error('usage: node src/admin.js setup FILE | check FILE');
    return 2;
  }
  try {
    if (command === 'check') return loadAdminSettings(file).passwordHash ? 0 : 3;
    const changed = await setup(file, env);
    console.log(changed.length ? `${file}: set ${changed.join(', ')}` : `${file}: unchanged`);
    return 0;
  } catch (err) {
    console.error(`admin: ${err.message}`);
    return 1;
  }
}

if (require.main === module) {
  cli(process.argv.slice(2), process.env).then((code) => {
    process.exitCode = code;
  });
}

module.exports = {
  createAdmin,
  parseAdminSettings,
  loadAdminSettings,
  serializeAdminSettings,
  rewriteFile,
  hashPassword,
  verifyPassword,
  passwordProblem,
  defaultNotify,
  setup,
  cli,
  SettingsError,
};
