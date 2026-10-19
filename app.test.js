'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const os = require('os');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const QRCode = require('qrcode');

process.env.UNLOCK_RATE_LIMIT = '1000';
process.env.CREATE_RATE_LIMIT = '1000';
delete process.env.BASE_URL; delete process.env.RENDER_EXTERNAL_URL;
const { createApp, db } = require('../server');

const DEST = 'https://example.com/page?ref=linkpulse#section';
let server, base, dir;

before(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lp-'));
  db.init(path.join(dir, 'test.db'));
  server = createApp().listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(dir, { recursive: true, force: true }); });

const get = (p, o = {}) => fetch(base + p, { redirect: 'manual', ...o });
const create = (body) => fetch(base + '/api/links', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
const unlock = (code, password) => fetch(`${base}/unlock/${code}`, { method: 'POST', redirect: 'manual',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ password }) });
const clicksOf = async (id) => (await (await get('/api/links')).json()).find((l) => l.id === id).clicks;

test('1. homepage loads (no "Cannot GET /")', async () => {
  const r = await get('/');
  assert.equal(r.status, 200);
  const html = await r.text();
  assert.match(html, /LinkPulse/); assert.doesNotMatch(html, /Cannot GET/);
});

test('2. CSS and JS assets load', async () => {
  const css = await get('/styles.css'); assert.equal(css.status, 200); assert.match(css.headers.get('content-type'), /css/);
  const js = await get('/app.js'); assert.equal(js.status, 200); assert.match(js.headers.get('content-type'), /javascript/);
});

test('3. normal short link redirects to the exact destination', async () => {
  const link = await (await create({ originalUrl: DEST, alias: 'plain1' })).json();
  assert.equal(link.shortUrl, `${base}/plain1`);
  assert.equal(link.passwordHash, undefined); assert.equal(link.password_hash, undefined);
  const r = await get('/plain1');
  assert.equal(r.status, 302); assert.equal(r.headers.get('location'), DEST);
  assert.equal(await clicksOf(link.id), 1);
});

test('4–8. password-protected flow', async () => {
  const res = await create({ originalUrl: DEST, alias: 'secret1', password: 'hunter22' });
  assert.equal(res.status, 201);
  const link = await res.json();
  assert.equal(link.passwordProtected, true);
  assert.ok(!JSON.stringify(await (await get('/api/links')).json()).includes('$2'), 'no hash leaked');

  // 4. shows password form, no redirect, no click
  const g = await get('/secret1');
  assert.equal(g.status, 200);
  const html = await g.text();
  assert.match(html, /<form method="POST" action="\/unlock\/secret1"/);
  assert.match(html, /type="password"/);
  assert.equal(await clicksOf(link.id), 0);

  // 6. wrong password -> error, no redirect, no click
  const bad = await unlock('secret1', 'wrong-pass');
  assert.equal(bad.status, 401); assert.equal(bad.headers.get('location'), null);
  assert.match(await bad.text(), /Incorrect password/);
  assert.equal(await clicksOf(link.id), 0);

  // 5 & 7. correct password -> 302 to exact destination (not /, not /unlock, not the password page)
  const ok = await unlock('secret1', 'hunter22');
  assert.equal(ok.status, 302);
  const loc = ok.headers.get('location');
  assert.equal(loc, DEST);
  assert.ok(!loc.startsWith(base));
  // CSP must not block the cross-origin redirect after the form POST
  assert.doesNotMatch(ok.headers.get('content-security-policy') || '', /form-action/);

  // 8. counted exactly once
  assert.equal(await clicksOf(link.id), 1);
});

test('9. paused, expired and limit-reached links do not redirect', async () => {
  const paused = await (await create({ originalUrl: DEST, alias: 'paused1' })).json();
  await fetch(`${base}/api/links/${paused.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
  let r = await get('/paused1'); assert.equal(r.status, 410); assert.equal(r.headers.get('location'), null);

  const exp = await (await create({ originalUrl: DEST, alias: 'expire1', expiresAt: new Date(Date.now() + 60_000).toISOString() })).json();
  await fetch(`${base}/api/links/${exp.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expiresAt: new Date(Date.now() - 1000).toISOString() }) });
  r = await get('/expire1'); assert.equal(r.status, 410); assert.equal(r.headers.get('location'), null);

  const lim = await (await create({ originalUrl: DEST, alias: 'limit1', maxClicks: 2 })).json();
  assert.equal((await get('/limit1')).status, 302);
  assert.equal((await get('/limit1')).status, 302);
  r = await get('/limit1'); assert.equal(r.status, 410);
  assert.equal(await clicksOf(lim.id), 2);

  // protected + limit: correct password after limit still blocked
  await create({ originalUrl: DEST, alias: 'plim', password: 'abcd', maxClicks: 1 });
  assert.equal((await unlock('plim', 'abcd')).status, 302);
  assert.equal((await unlock('plim', 'abcd')).status, 410);

  r = await get('/does-not-exist'); assert.equal(r.status, 404);
});

test('10. invalid URLs and duplicate aliases are rejected', async () => {
  for (const u of ['not a url', 'javascript:alert(1)', 'ftp://x.com/file', 'data:text/html,hi', '', `${base}/plain1`]) {
    const r = await create({ originalUrl: u }); assert.equal(r.status, 400, `should reject ${u}`);
  }
  const dup = await create({ originalUrl: DEST, alias: 'plain1' }); assert.equal(dup.status, 409);
  const dupCase = await create({ originalUrl: DEST, alias: 'PLAIN1' }); assert.equal(dupCase.status, 409);
  assert.equal((await create({ originalUrl: DEST, alias: 'api' })).status, 400);
  assert.equal((await create({ originalUrl: DEST, alias: 'a b' })).status, 400);
  assert.equal((await create({ originalUrl: DEST, password: 'ab' })).status, 400);
});

test('11. QR code encodes the deployed short URL', async () => {
  const link = await (await create({ originalUrl: DEST, alias: 'qrtest' })).json();
  const r = await get(`/api/links/${link.id}/qr`);
  assert.equal(r.status, 200); assert.equal(r.headers.get('content-type'), 'image/png');
  assert.equal(r.headers.get('x-qr-content'), `${base}/qrtest`);
  const expected = await QRCode.toBuffer(`${base}/qrtest`, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
  assert.ok(Buffer.from(await r.arrayBuffer()).equals(expected));
});

test('analytics reflect real clicks', async () => {
  const s = await (await get('/api/stats')).json();
  assert.ok(s.totalLinks >= 7); assert.ok(s.totalClicks >= 5); assert.ok(s.clicksToday >= 5); assert.ok(s.protectedLinks >= 2);
  assert.ok(s.recentClicks.length > 0);
});

test('12. npm start boots on configured PORT and BASE_URL is used', async () => {
  const port = 40000 + Math.floor(Math.random() * 10000);
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', ['start'], {
    cwd: path.join(__dirname, '..'),
    env: { ...process.env, PORT: String(port), DB_PATH: path.join(dir, 'start.db'), BASE_URL: 'https://lp.example.app' },
    stdio: 'pipe',
  });
  try {
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await new Promise((r) => setTimeout(r, 200));
      try { ok = (await fetch(`http://127.0.0.1:${port}/health`)).ok; } catch { /* not up yet */ }
    }
    assert.ok(ok, 'server responded on PORT');
    const cfg = await (await fetch(`http://127.0.0.1:${port}/api/config`)).json();
    assert.equal(cfg.baseUrl, 'https://lp.example.app');
  } finally { child.kill('SIGTERM'); }
});
