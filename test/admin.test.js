'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const os = require('node:os');
const fs = require('node:fs');
const net = require('node:net');
const http = require('node:http');
const { createApp, parseConfig } = require('../src/server.js');
const {
  hashPassword,
  verifyPassword,
  parseAdminSettings,
  serializeAdminSettings,
  defaultNotify,
  setup,
} = require('../src/admin.js');
const { sendMail, buildMessage, encodeHeader, isEmail, smtpProblem } = require('../src/mailer.js');
const { notify, parseEnvFile, adminFileFromEnv } = require('../src/notify.js');

const BASE = 'http://localhost:8787';
const API = 'https://api.github.com';
const TOKEN = 'test-token-secret';
const PASSWORD = 'correct horse battery';
const SMTP_SECRET = 'smtp-secret-pw';

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'frp-admin-'));
}

function statusWithHost(url, host) {
  return new Promise((resolve, reject) => {
    http.get(url, { headers: { Host: host } }, (res) => {
      res.resume();
      resolve(res.statusCode);
    }).on('error', reject);
  });
}

let hashCache;
async function passwordHash() {
  hashCache = hashCache || (await hashPassword(PASSWORD));
  return hashCache;
}

// Starts the proxy with config.json and admin.json in a temp folder; returns helpers for the admin API.
async function start({ modules = { alpha: { repo: 'o/alpha' } }, notifySettings, fetchImpl, mailer } = {}) {
  const dir = tmpDir();
  const configFile = path.join(dir, 'config.json');
  const adminFile = path.join(dir, 'admin.json');
  fs.writeFileSync(configFile, JSON.stringify(modules, null, 2));
  const settings = { passwordHash: await passwordHash(), notify: notifySettings || defaultNotify() };
  fs.writeFileSync(adminFile, serializeAdminSettings(settings));
  const logs = [];
  const server = createApp({
    modules: parseConfig(JSON.stringify(modules), 'test', { allowEmpty: true }),
    token: TOKEN,
    publicBaseUrl: BASE,
    configFile,
    admin: { file: adminFile, settings: parseAdminSettings(fs.readFileSync(adminFile, 'utf8')), hosts: [] },
    fetchImpl: fetchImpl || (async (url) => {
      throw new Error(`unexpected fetch ${url}`);
    }),
    mailer,
    log: (line) => logs.push(line),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const url = `http://127.0.0.1:${server.address().port}`;
  let cookie = '';
  let csrf = '';
  const call = async (method, route, body, extra = {}) => {
    const headers = { Cookie: cookie, ...extra };
    if (method !== 'GET') {
      headers['Content-Type'] = headers['Content-Type'] || 'application/json';
      if (csrf && headers['X-CSRF-Token'] === undefined) headers['X-CSRF-Token'] = csrf;
    }
    const res = await fetch(`${url}/_admin/api/${route}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const text = await res.text();
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0];
    let data = null;
    try {
      data = JSON.parse(text);
    } catch {
      data = text;
    }
    if (data && data.csrf) csrf = data.csrf;
    return { status: res.status, data, headers: res.headers, text };
  };
  const login = async (password = PASSWORD) => call('POST', 'login', { password });
  return {
    url,
    dir,
    configFile,
    adminFile,
    logs,
    call,
    login,
    get csrf() {
      return csrf;
    },
    setCsrf(v) {
      csrf = v;
    },
    clearCookie() {
      cookie = '';
    },
    close: () => new Promise((r) => server.close(r)),
  };
}

test('password hashes verify and reject wrong passwords', async () => {
  const hash = await hashPassword('s3cret-password');
  assert.match(hash, /^scrypt\$16384\$8\$1\$/);
  assert.equal(await verifyPassword('s3cret-password', hash), true);
  assert.equal(await verifyPassword('wrong', hash), false);
  assert.equal(await verifyPassword('s3cret-password', ''), false);
  assert.notEqual(await hashPassword('s3cret-password'), hash, 'salted');
});

test('admin settings are validated', async () => {
  assert.deepEqual(parseAdminSettings('').notify.recipients, []);
  assert.throws(() => parseAdminSettings('{"x":1}'), /unknown key "x"/);
  assert.throws(() => parseAdminSettings('{"passwordHash":"plain"}'), /invalid "passwordHash"/);
  assert.throws(() => parseAdminSettings('{"passwordHash":"scrypt$99999999$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' +
    `${'A'.repeat(64)}"}`), /invalid "passwordHash"/);
  assert.throws(() => parseAdminSettings('{"notify":{"recipients":["a@b.c\\r\\nBcc: x@y.z"]}}'), /invalid e-mail/);
  assert.throws(() => parseAdminSettings('{"notify":{"recipients":["not-an-address"]}}'), /invalid e-mail/);
  assert.throws(
    () => parseAdminSettings('{"notify":{"smtp":{"host":"mail.example.com","port":25,"security":"none",' +
      '"user":"u","password":"p","from":"a@example.com"}}}'),
    /without TLS/,
  );
  const ok = parseAdminSettings('{"notify":{"recipients":["A@example.com","a@example.com","b@example.com"]}}');
  assert.deepEqual(ok.notify.recipients, ['A@example.com', 'b@example.com']);
});

test('the admin page is off (404) without a password and needs a login for the API', async () => {
  const dir = tmpDir();
  const configFile = path.join(dir, 'config.json');
  fs.writeFileSync(configFile, '{"alpha":{"repo":"o/alpha"}}');
  const server = createApp({
    modules: parseConfig('{"alpha":{"repo":"o/alpha"}}'),
    token: TOKEN,
    publicBaseUrl: BASE,
    configFile,
    log: () => {},
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try {
    const url = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${url}/_admin/`)).status, 404);
    assert.equal((await fetch(`${url}/_admin/api/state`)).status, 404);
    assert.equal((await fetch(`${url}/_admin/api/login`, { method: 'POST' })).status, 405);
  } finally {
    await new Promise((r) => server.close(r));
  }

  const s = await start();
  try {
    const page = await fetch(`${s.url}/_admin/`);
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    assert.match(page.headers.get('content-security-policy'), /script-src 'self'/);
    assert.equal(page.headers.get('x-frame-options'), 'DENY');
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.match(await page.text(), /Foundry Release Proxy/);
    assert.equal((await fetch(`${s.url}/_admin/app.js`)).status, 200);
    assert.equal((await fetch(`${s.url}/_admin/nope`)).status, 404);
    assert.equal((await s.call('GET', 'state')).status, 401);
    assert.equal((await s.call('POST', 'modules', { id: 'x', repo: 'o/x' })).status, 401);
    const bad = await s.login('wrong password');
    assert.equal(bad.status, 401);
    assert.equal(bad.data.csrf, undefined);
  } finally {
    await s.close();
  }
});

test('login sets a strict HttpOnly cookie and lists the modules with their Foundry links', async () => {
  const s = await start({ modules: { beta: { repo: 'o/beta', zipAsset: 'beta.zip' }, alpha: { repo: 'o/alpha' } } });
  try {
    const res = await s.login();
    assert.equal(res.status, 200);
    const setCookie = res.headers.get('set-cookie');
    assert.match(setCookie, /HttpOnly/);
    assert.match(setCookie, /SameSite=Strict/);
    assert.match(setCookie, /Path=\/_admin/);
    assert.ok(res.data.csrf);
    assert.deepEqual(res.data.modules, [
      { id: 'alpha', repo: 'o/alpha', manifestAsset: 'module.json', zipAsset: 'module.zip',
        link: `${BASE}/alpha/module.json` },
      { id: 'beta', repo: 'o/beta', manifestAsset: 'module.json', zipAsset: 'beta.zip',
        link: `${BASE}/beta/module.json` },
    ]);
    assert.ok(!res.text.includes(TOKEN));
    assert.ok(!res.text.includes('scrypt'));
    const state = await s.call('GET', 'state');
    assert.equal(state.status, 200);
    assert.equal(state.data.modules.length, 2);
  } finally {
    await s.close();
  }
});

test('modules can be added, edited, renamed and deleted; config.json follows and the proxy serves them', async () => {
  const rel = { tag_name: 'v2.0.0', assets: [{ name: 'module.json', url: `${API}/a/1` }] };
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, init });
    if (url === `${API}/repos/o/gamma/releases/latest`) return new Response(JSON.stringify(rel));
    if (url === `${API}/a/1`) return new Response(null, { status: 302, headers: { location: 'https://objects.example/m' } });
    if (url === 'https://objects.example/m') return new Response('{"version":"2.0.0"}');
    throw new Error(`unexpected fetch ${url}`);
  };
  const s = await start({ fetchImpl });
  try {
    await s.login();
    // add
    let res = await s.call('POST', 'modules', { id: 'gamma', repo: 'o/gamma', manifestAsset: '', zipAsset: 'g.zip' });
    assert.equal(res.status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.configFile, 'utf8')), {
      alpha: { repo: 'o/alpha' },
      gamma: { repo: 'o/gamma', zipAsset: 'g.zip' },
    });
    const served = await fetch(`${s.url}/gamma/module.json`);
    assert.equal(served.status, 200);
    assert.equal((await served.json()).manifest, `${BASE}/gamma/module.json`);
    // duplicate and invalid input
    assert.equal((await s.call('POST', 'modules', { id: 'gamma', repo: 'o/x' })).status, 409);
    res = await s.call('POST', 'modules', { id: '../evil', repo: 'o/x' });
    assert.equal(res.status, 400);
    assert.match(res.data.error, /invalid module id/);
    assert.equal((await s.call('POST', 'modules', { id: '__proto__', repo: 'o/x' })).status, 400);
    res = await s.call('POST', 'modules', { id: 'ok', repo: 'not a repo' });
    assert.equal(res.status, 400);
    assert.equal((await s.call('POST', 'modules', { id: 'ok', repo: 'o/x', zipAsset: 'a/b.zip' })).status, 400);
    // edit keeps the position, rename moves the link
    res = await s.call('PUT', 'modules/alpha', { id: 'alpha', repo: 'o/alpha2' });
    assert.equal(res.status, 200);
    res = await s.call('PUT', 'modules/gamma', { id: 'delta', repo: 'o/gamma' });
    assert.equal(res.status, 200);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.configFile, 'utf8'))), ['alpha', 'delta']);
    assert.equal(res.data.modules.find((m) => m.id === 'delta').link, `${BASE}/delta/module.json`);
    assert.equal((await fetch(`${s.url}/gamma/module.json`)).status, 404);
    assert.equal((await s.call('PUT', 'modules/delta', { id: 'alpha', repo: 'o/x' })).status, 409);
    assert.equal((await s.call('PUT', 'modules/nope', { id: 'nope', repo: 'o/x' })).status, 404);
    // delete, down to an empty config
    assert.equal((await s.call('DELETE', 'modules/delta')).status, 200);
    assert.equal((await s.call('DELETE', 'modules/alpha')).status, 200);
    assert.deepEqual(JSON.parse(fs.readFileSync(s.configFile, 'utf8')), {});
    assert.equal((await fetch(`${s.url}/alpha/module.json`)).status, 404);
    assert.ok(s.logs.some((l) => l === 'admin: deleted module alpha'));
    assert.ok(s.logs.every((l) => !l.includes(TOKEN)));
  } finally {
    await s.close();
  }
});

test('state-changing calls need the CSRF token, JSON and an allowed host', async () => {
  const s = await start();
  try {
    await s.login();
    let res = await s.call('POST', 'modules', { id: 'x', repo: 'o/x' }, { 'X-CSRF-Token': 'wrong' });
    assert.equal(res.status, 403);
    res = await s.call('POST', 'modules', { id: 'x', repo: 'o/x' }, { 'X-CSRF-Token': '' });
    assert.equal(res.status, 403);
    res = await s.call('POST', 'modules', { id: 'x', repo: 'o/x' }, { 'Content-Type': 'text/plain' });
    assert.equal(res.status, 415);
    res = await s.call('POST', 'modules', { id: 'x', repo: 'o/x' }, { Origin: 'https://evil.example' });
    assert.equal(res.status, 403);
    // fetch() does not let a test set Host, http.get does (a DNS-rebinding page would send its own name)
    assert.equal(await statusWithHost(`${s.url}/_admin/`, 'evil.example'), 403);
    assert.equal(await statusWithHost(`${s.url}/_admin/`, 'localhost:8787'), 200);
    assert.deepEqual(Object.keys(JSON.parse(fs.readFileSync(s.configFile, 'utf8'))), ['alpha']);
    // proxy routes stay GET/HEAD only
    assert.equal((await fetch(`${s.url}/alpha/module.json`, { method: 'POST' })).status, 405);
  } finally {
    await s.close();
  }
});

test('logins are locked out after repeated failures', async () => {
  const s = await start();
  try {
    for (let i = 0; i < 5; i++) assert.equal((await s.login('nope nope')).status, 401);
    assert.equal((await s.login()).status, 429);
  } finally {
    await s.close();
  }
});

test('logout ends the session', async () => {
  const s = await start();
  try {
    await s.login();
    const res = await s.call('POST', 'logout', {});
    assert.equal(res.status, 200);
    assert.match(res.headers.get('set-cookie'), /Max-Age=0/);
    assert.equal((await s.call('GET', 'state')).status, 401);
  } finally {
    await s.close();
  }
});

test('the release check reports the latest tag or a missing asset', async () => {
  const fetchImpl = async (url) => {
    if (url === `${API}/repos/o/alpha/releases/latest`) {
      return new Response(JSON.stringify({ tag_name: 'v1.0.0', published_at: '2026-01-01T00:00:00Z',
        assets: [{ name: 'module.json' }] }));
    }
    return new Response('{}', { status: 404 });
  };
  const s = await start({ modules: { alpha: { repo: 'o/alpha' }, beta: { repo: 'o/beta' } }, fetchImpl });
  try {
    await s.login();
    let res = await s.call('GET', 'modules/alpha/release');
    assert.equal(res.data.tag, 'v1.0.0');
    assert.deepEqual(res.data.missing, ['module.zip']);
    res = await s.call('GET', 'modules/beta/release');
    assert.match(res.data.error, /no release found/);
    assert.equal((await s.call('GET', 'modules/nope/release')).status, 404);
  } finally {
    await s.close();
  }
});

test('notification settings are saved without ever returning the SMTP password', async () => {
  const sent = [];
  const mailer = async (smtp, msg) => sent.push({ smtp, msg });
  const s = await start({ mailer });
  try {
    await s.login();
    assert.equal((await s.call('POST', 'notify/test', {})).status, 400, 'no recipients yet');
    const body = {
      recipients: ['ops@example.com', 'gm@example.org'],
      smtp: { host: 'smtp.example.com', port: 587, security: 'starttls', user: 'proxy', password: SMTP_SECRET,
        from: 'proxy@example.com' },
    };
    let res = await s.call('PUT', 'notify', body);
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.notify.recipients, body.recipients);
    assert.equal(res.data.notify.smtp.passwordSet, true);
    assert.ok(!res.text.includes(SMTP_SECRET));
    assert.equal(JSON.parse(fs.readFileSync(s.adminFile, 'utf8')).notify.smtp.password, SMTP_SECRET);
    // an empty password keeps the stored one
    res = await s.call('PUT', 'notify', { ...body, recipients: ['ops@example.com'], smtp: { ...body.smtp, password: '' } });
    assert.equal(JSON.parse(fs.readFileSync(s.adminFile, 'utf8')).notify.smtp.password, SMTP_SECRET);
    assert.ok(!(await s.call('GET', 'state')).text.includes(SMTP_SECRET));
    // invalid addresses are refused, header injection included
    res = await s.call('PUT', 'notify', { ...body, recipients: ['a@example.com\r\nBcc: x@example.com'] });
    assert.equal(res.status, 400);
    res = await s.call('PUT', 'notify', { ...body, smtp: { ...body.smtp, security: 'none' } });
    assert.equal(res.status, 400);
    // test mail
    res = await s.call('POST', 'notify/test', {});
    assert.equal(res.status, 200);
    assert.deepEqual(sent[0].msg.to, ['ops@example.com']);
    assert.equal(sent[0].smtp.password, SMTP_SECRET);
    // clearPassword removes it
    res = await s.call('PUT', 'notify', { ...body, smtp: { ...body.smtp, password: '', clearPassword: true } });
    assert.equal(res.data.notify.smtp.passwordSet, false);
    assert.ok(s.logs.every((l) => !l.includes(SMTP_SECRET)));
  } finally {
    await s.close();
  }
});

test('changing the password needs the current one and ends other sessions', async () => {
  const s = await start();
  try {
    await s.login();
    const oldCsrf = s.csrf;
    assert.equal((await s.call('PUT', 'password', { current: 'wrong', password: 'new password 1' })).status, 403);
    assert.equal((await s.call('PUT', 'password', { current: PASSWORD, password: 'short' })).status, 400);
    const res = await s.call('PUT', 'password', { current: PASSWORD, password: 'new password 1' });
    assert.equal(res.status, 200);
    assert.notEqual(s.csrf, oldCsrf);
    const stored = JSON.parse(fs.readFileSync(s.adminFile, 'utf8')).passwordHash;
    assert.equal(await verifyPassword('new password 1', stored), true);
    assert.equal((await s.call('GET', 'state')).status, 200, 'this session goes on');
    s.clearCookie();
    assert.equal((await s.login()).status, 401);
    assert.equal((await s.login('new password 1')).status, 200);
  } finally {
    await s.close();
  }
});

test('setup creates admin.json from the environment and keeps what is not given', async () => {
  const dir = tmpDir();
  const file = path.join(dir, 'admin.json');
  let changed = await setup(file, {
    FOUNDRY_PROXY_ADMIN_PASSWORD: 'first password',
    FOUNDRY_PROXY_NOTIFY_EMAILS: 'a@example.com, b@example.com',
    FOUNDRY_PROXY_SMTP_HOST: 'smtp.example.com',
    FOUNDRY_PROXY_SMTP_PORT: '465',
    FOUNDRY_PROXY_SMTP_SECURITY: 'tls',
    FOUNDRY_PROXY_SMTP_FROM: 'proxy@example.com',
  });
  assert.deepEqual(changed, ['admin password', 'notification recipients', 'SMTP settings']);
  if (process.platform !== 'win32') assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  let settings = parseAdminSettings(fs.readFileSync(file, 'utf8'));
  assert.equal(await verifyPassword('first password', settings.passwordHash), true);
  assert.deepEqual(settings.notify.recipients, ['a@example.com', 'b@example.com']);
  assert.equal(settings.notify.smtp.port, 465);
  changed = await setup(file, { FOUNDRY_PROXY_NOTIFY_EMAILS: 'c@example.com' });
  assert.deepEqual(changed, ['notification recipients']);
  settings = parseAdminSettings(fs.readFileSync(file, 'utf8'));
  assert.equal(await verifyPassword('first password', settings.passwordHash), true);
  assert.equal(settings.notify.smtp.host, 'smtp.example.com');
  await assert.rejects(setup(file, { FOUNDRY_PROXY_ADMIN_PASSWORD: 'short' }), /at least 8/);
  await assert.rejects(setup(file, { FOUNDRY_PROXY_NOTIFY_EMAILS: 'nope' }), /invalid e-mail/);
});

test('mail helpers refuse unsafe input', () => {
  assert.equal(isEmail('a@example.com'), true);
  assert.equal(isEmail('a@example.com>\r\nRCPT TO:<b@example.com'), false);
  assert.equal(isEmail('Name <a@example.com>'), false);
  assert.equal(encodeHeader('Update\r\nBcc: x'), 'Update Bcc: x');
  assert.equal(encodeHeader('Uppdatering klar – v1.2'), `=?UTF-8?B?${Buffer.from('Uppdatering klar – v1.2').toString('base64')}?=`);
  assert.match(smtpProblem({ host: 'h.example', port: 25, security: 'none', user: 'u', from: 'a@example.com' }), /TLS/);
  const msg = buildMessage({ from: 'a@example.com', to: ['b@example.com'], subject: 'Hi', text: '.\nline' });
  assert.match(msg, /^From: a@example.com\r\nTo: b@example.com\r\nSubject: Hi\r\n/);
  const body = msg.split('\r\n\r\n')[1];
  assert.equal(Buffer.from(body.replace(/\r\n/g, ''), 'base64').toString(), '.\r\nline');
});

// A tiny SMTP server for the mailer test: records the conversation.
function fakeSmtp() {
  const transcript = [];
  const server = net.createServer((socket) => {
    let data = false;
    let buffer = '';
    socket.write('220 fake ESMTP\r\n');
    socket.on('data', (chunk) => {
      buffer += chunk.toString();
      let i;
      while ((i = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, i);
        buffer = buffer.slice(i + 2);
        transcript.push(line);
        if (data) {
          if (line === '.') {
            data = false;
            socket.write('250 queued\r\n');
          }
        } else if (/^EHLO /.test(line)) socket.write('250-fake\r\n250-SIZE 1000000\r\n250 8BITMIME\r\n');
        else if (/^(MAIL FROM|RCPT TO):/.test(line)) socket.write('250 ok\r\n');
        else if (line === 'DATA') {
          data = true;
          socket.write('354 go ahead\r\n');
        } else if (line === 'QUIT') socket.end('221 bye\r\n');
        else socket.write('502 no\r\n');
      }
    });
  });
  return { server, transcript };
}

test('sendMail talks SMTP and the notifier mails the configured recipients', async () => {
  const { server, transcript } = fakeSmtp();
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  try {
    const smtp = { host: '127.0.0.1', port, security: 'none', user: '', password: '', from: 'proxy@example.com' };
    await sendMail(smtp, { to: ['a@example.com', 'b@example.com'], subject: 'Hello', text: 'Body' });
    assert.ok(transcript.includes('MAIL FROM:<proxy@example.com>'));
    assert.ok(transcript.includes('RCPT TO:<a@example.com>'));
    assert.ok(transcript.includes('RCPT TO:<b@example.com>'));
    assert.ok(transcript.includes('Subject: Hello'));
    // STARTTLS is not silently skipped
    await assert.rejects(sendMail({ ...smtp, security: 'starttls' }, { to: ['a@example.com'], subject: 'x', text: 'y' }),
      /does not offer STARTTLS/);

    // notify.js reads admin.json through the env file
    const dir = tmpDir();
    fs.writeFileSync(path.join(dir, 'env'), `GITHUB_TOKEN=x\nCONFIG_FILE=${path.join(dir, 'config.json')}\n`);
    assert.equal(adminFileFromEnv(path.join(dir, 'env')), path.join(dir, 'admin.json'));
    const logs = [];
    // no admin.json yet: nothing to do, not an error
    assert.equal(await notify({ 'proxy-env': path.join(dir, 'env'), subject: 's' }, { log: (l) => logs.push(l) }), 0);
    assert.match(logs[0], /no recipients/);
    fs.writeFileSync(path.join(dir, 'admin.json'), JSON.stringify({
      notify: { recipients: ['gm@example.com'], smtp: { ...smtp, user: undefined, password: undefined } },
    }));
    transcript.length = 0;
    await notify({ 'proxy-env': path.join(dir, 'env'), subject: 'updated to 1.3.0', message: 'Updated.' },
      { log: () => {} });
    assert.ok(transcript.includes('RCPT TO:<gm@example.com>'));
    assert.ok(transcript.some((l) => /^Subject: Foundry release proxy \(.*\): updated to 1\.3\.0$/.test(l)));
  } finally {
    await new Promise((r) => server.close(r));
  }
});

test('env files are parsed without shell expansion', () => {
  const env = parseEnvFile('# c\nexport A=1\nB="two words"\nC=\'$HOME\'\nbad line\n');
  assert.equal(env.A, '1');
  assert.equal(env.B, 'two words');
  assert.equal(env.C, '$HOME');
  assert.equal(env.bad, undefined);
});
