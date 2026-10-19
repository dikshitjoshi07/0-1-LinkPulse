'use strict';
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const QRCode = require('qrcode');
const db = require('./database/database');

const RESERVED = new Set(['api', 'unlock', 'health', 'index', 'index.html', 'app.js', 'styles.css', 'favicon.ico', 'robots.txt', 'static', 'admin']);
const CODE_RE = /^[A-Za-z0-9_-]{3,32}$/;

// ---------- helpers ----------
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function baseUrl(req) {
  const env = process.env.BASE_URL || process.env.RENDER_EXTERNAL_URL;
  return (env || `${req.protocol}://${req.get('host')}`).replace(/\/+$/, '');
}
function isValidHttpUrl(value, req) {
  if (typeof value !== 'string' || value.length > 2048) return false;
  let u;
  try { u = new URL(value.trim()); } catch { return false; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;
  if (!u.hostname) return false;
  // Prevent pointing a short link at this shortener itself (redirect loops).
  if (req && u.host.toLowerCase() === new URL(baseUrl(req)).host.toLowerCase()) return false;
  return true;
}
function randomCode(len = 7) {
  const chars = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.randomBytes(len);
  let s = '';
  for (let i = 0; i < len; i++) s += chars[bytes[i] % chars.length];
  return s;
}
function uniqueCode() {
  for (let i = 0; i < 20; i++) { const c = randomCode(); if (!db.codeExists(c)) return c; }
  return randomCode(10);
}
const isExpired = (l) => !!l.expires_at && new Date(l.expires_at).getTime() <= Date.now();
const hasReachedLimit = (l) => l.max_clicks != null && l.click_count >= l.max_clicks;
function linkStatus(l) {
  if (l.disabled) return 'paused';
  if (isExpired(l)) return 'expired';
  if (hasReachedLimit(l)) return 'limit_reached';
  return 'active';
}
function publicLink(l, req) {
  // Never expose password_hash.
  return {
    id: l.id, code: l.code, shortUrl: `${baseUrl(req)}/${l.code}`, originalUrl: l.original_url,
    title: l.title, campaign: l.campaign, tags: l.tags ? l.tags.split(',').filter(Boolean) : [],
    passwordProtected: !!l.password_hash, maxClicks: l.max_clicks, expiresAt: l.expires_at,
    disabled: !!l.disabled, clicks: l.click_count, status: linkStatus(l),
    createdAt: l.created_at, updatedAt: l.updated_at,
  };
}
function clickMeta(req) {
  const ua = String(req.get('user-agent') || '');
  const device = /ipad|tablet/i.test(ua) ? 'Tablet' : /mobi|android|iphone/i.test(ua) ? 'Mobile' : ua ? 'Desktop' : 'Unknown';
  const browser = /edg\//i.test(ua) ? 'Edge' : /chrome|crios/i.test(ua) ? 'Chrome' : /firefox|fxios/i.test(ua) ? 'Firefox'
    : /safari/i.test(ua) ? 'Safari' : ua ? 'Other' : 'Unknown';
  let referrer = null;
  try { const r = req.get('referer'); if (r) referrer = new URL(r).host.slice(0, 255); } catch { /* ignore */ }
  return { device, browser, referrer }; // no raw IPs stored
}
const str = (v, max) => (v == null ? null : String(v).trim().slice(0, max) || null);

/** Validates create/update payload. Returns { errors, fields }. */
async function validatePayload(body, req, { partial }) {
  const errors = {}; const f = {};
  if (!partial || 'originalUrl' in body) {
    if (!isValidHttpUrl(body.originalUrl, req)) errors.originalUrl = 'Enter a valid http:// or https:// URL (not this shortener).';
    else f.originalUrl = body.originalUrl.trim();
  }
  for (const [k, max] of [['title', 120], ['campaign', 80]]) if (k in body) {
    if (body[k] != null && typeof body[k] !== 'string') errors[k] = 'Must be text.';
    else f[k] = str(body[k], max);
  }
  if ('tags' in body) {
    const arr = Array.isArray(body.tags) ? body.tags : String(body.tags || '').split(',');
    const tags = [...new Set(arr.map((t) => String(t).trim().toLowerCase().replace(/[^a-z0-9 _-]/g, '').slice(0, 30)).filter(Boolean))].slice(0, 10);
    f.tags = tags.length ? tags.join(',') : null;
  }
  if ('maxClicks' in body) {
    if (body.maxClicks === null || body.maxClicks === '') f.maxClicks = null;
    else {
      const n = Number(body.maxClicks);
      if (!Number.isInteger(n) || n < 1 || n > 1e9) errors.maxClicks = 'Click limit must be a whole number ≥ 1.';
      else f.maxClicks = n;
    }
  }
  if ('expiresAt' in body) {
    if (body.expiresAt === null || body.expiresAt === '') f.expiresAt = null;
    else {
      const d = new Date(body.expiresAt);
      if (isNaN(d.getTime())) errors.expiresAt = 'Invalid expiry date.';
      else if (!partial && d.getTime() <= Date.now()) errors.expiresAt = 'Expiry must be in the future.';
      else f.expiresAt = d.toISOString();
    }
  }
  if ('password' in body && body.password !== undefined) {
    if (body.password === null || body.password === '') { if (partial && body.removePassword) f.passwordHash = null; }
    else if (typeof body.password !== 'string' || body.password.length < 4 || body.password.length > 128) errors.password = 'Password must be 4–128 characters.';
    else f.passwordHash = await bcrypt.hash(body.password, 10);
  }
  if (partial && body.removePassword === true) f.passwordHash = null;
  if (partial && 'disabled' in body) f.disabled = body.disabled ? 1 : 0;
  return { errors, fields: f };
}

// ---------- HTML pages for visitors ----------
function page(title, inner, status = 200) {
  return { status, html: `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${escapeHtml(title)} · LinkPulse Studio</title><meta name="robots" content="noindex"><link rel="stylesheet" href="/styles.css"></head>
<body class="visitor"><main class="visitor-card">
<div class="brand"><span class="brand-mark">◆</span> LinkPulse <em>Studio</em></div>${inner}</main></body></html>` };
}
function passwordPage(code, error) {
  return page('Protected link', `
<h1>This link is protected</h1>
<p class="muted">Enter the password to continue to the destination.</p>
${error ? `<div class="alert alert-error" role="alert" id="pw-error">${escapeHtml(error)}</div>` : ''}
<form method="POST" action="/unlock/${encodeURIComponent(code)}" class="stack" id="unlock-form">
  <label class="field"><span>Password</span>
  <input type="password" name="password" required autofocus autocomplete="current-password" maxlength="128"></label>
  <button class="btn btn-primary" type="submit">Unlock &amp; continue</button>
</form>`, error ? 401 : 200);
}
function unavailablePage(reason, status = 410) {
  const msgs = {
    not_found: ['Link not found', 'This short link doesn’t exist or has been deleted.'],
    paused: ['Link paused', 'The owner has temporarily paused this link.'],
    expired: ['Link expired', 'This short link has expired.'],
    limit_reached: ['Link unavailable', 'This link has reached its maximum number of clicks.'],
    rate: ['Too many attempts', 'Too many password attempts. Please wait a few minutes and try again.'],
  };
  const [t, d] = msgs[reason] || ['Unavailable', 'This link is unavailable.'];
  return page(t, `<h1>${t}</h1><p class="muted">${d}</p>`, status);
}
const send = (res, p) => res.status(p.status).type('html').send(p.html);

// ---------- app ----------
function createApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.disable('x-powered-by');
  app.use(helmet({
    contentSecurityPolicy: {
      directives: {
        'img-src': ["'self'", 'data:'],
        // Browsers apply form-action to redirects after POST; the unlock form must be
        // allowed to land on any external destination, so remove that directive.
        'form-action': null,
      },
    },
    referrerPolicy: { policy: 'strict-origin-when-cross-origin' },
  }));
  app.use(express.json({ limit: '20kb' }));
  app.use(express.urlencoded({ extended: false, limit: '10kb' }));
  app.use(express.static(path.join(__dirname, 'public'), { index: 'index.html', maxAge: '1h' }));

  const createLimiter = rateLimit({ windowMs: 60_000, limit: Number(process.env.CREATE_RATE_LIMIT || 30), standardHeaders: 'draft-7', legacyHeaders: false,
    message: { error: 'Too many links created. Please wait a minute.' } });
  const unlockLimiter = rateLimit({ windowMs: 15 * 60_000, limit: Number(process.env.UNLOCK_RATE_LIMIT || 10), standardHeaders: 'draft-7', legacyHeaders: false,
    keyGenerator: (req) => `${req.ip}:${String(req.params.code).toLowerCase()}`,
    handler: (req, res) => send(res, unavailablePage('rate', 429)) });

  app.get('/health', (req, res) => res.json({ ok: true }));
  app.get('/api/config', (req, res) => res.json({ baseUrl: baseUrl(req) }));

  app.get('/api/links', (req, res) => res.json(db.listLinks().map((l) => publicLink(l, req))));

  app.post('/api/links', createLimiter, async (req, res, next) => {
    try {
      const body = req.body || {};
      const { errors, fields } = await validatePayload(body, req, { partial: false });
      let code;
      if (body.alias != null && String(body.alias).trim() !== '') {
        code = String(body.alias).trim();
        if (!CODE_RE.test(code)) errors.alias = 'Alias must be 3–32 letters, numbers, - or _.';
        else if (RESERVED.has(code.toLowerCase())) errors.alias = 'That alias is reserved.';
        else if (db.codeExists(code)) errors.alias = 'That alias is already taken.';
      } else code = uniqueCode();
      if (Object.keys(errors).length) return res.status(errors.alias === 'That alias is already taken.' && Object.keys(errors).length === 1 ? 409 : 400).json({ error: Object.values(errors)[0], fields: errors });
      const link = db.createLink({ code, title: null, campaign: null, tags: null, passwordHash: null, maxClicks: null, expiresAt: null, ...fields });
      res.status(201).json(publicLink(link, req));
    } catch (e) {
      if (/UNIQUE/i.test(e.message)) return res.status(409).json({ error: 'That alias is already taken.', fields: { alias: 'That alias is already taken.' } });
      next(e);
    }
  });

  app.patch('/api/links/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!db.findLinkById(id)) return res.status(404).json({ error: 'Link not found.' });
      const { errors, fields } = await validatePayload(req.body || {}, req, { partial: true });
      if (Object.keys(errors).length) return res.status(400).json({ error: Object.values(errors)[0], fields: errors });
      res.json(publicLink(db.updateLink(id, fields), req));
    } catch (e) { next(e); }
  });

  app.delete('/api/links/:id', (req, res) => {
    if (!db.deleteLink(Number(req.params.id))) return res.status(404).json({ error: 'Link not found.' });
    res.status(204).end();
  });

  app.get('/api/links/:id/qr', async (req, res, next) => {
    try {
      const l = db.findLinkById(Number(req.params.id));
      if (!l) return res.status(404).json({ error: 'Link not found.' });
      const url = `${baseUrl(req)}/${l.code}`;
      const buf = await QRCode.toBuffer(url, { type: 'png', width: 512, margin: 2, errorCorrectionLevel: 'M' });
      res.set('X-QR-Content', url).type('png');
      if (req.query.download) res.attachment(`linkpulse-${l.code}.png`);
      res.send(buf);
    } catch (e) { next(e); }
  });

  app.get('/api/stats', (req, res) => res.json(db.stats()));
  app.use('/api', (req, res) => res.status(404).json({ error: 'Not found' }));

  // ---------- visitor flow ----------
  app.get('/:code', (req, res) => {
    const link = db.findLinkByCode(req.params.code);
    if (!link) return send(res, unavailablePage('not_found', 404));
    const status = linkStatus(link);
    if (status !== 'active') return send(res, unavailablePage(status));
    if (link.password_hash) { res.set('Cache-Control', 'no-store'); return send(res, passwordPage(link.code)); }
    if (!db.recordClick(link.id, clickMeta(req))) return send(res, unavailablePage('limit_reached'));
    res.set('Cache-Control', 'no-store');
    return res.redirect(302, link.original_url);
  });

  app.post('/unlock/:code', unlockLimiter, async (req, res, next) => {
    try {
      res.set('Cache-Control', 'no-store');
      const link = db.findLinkByCode(req.params.code);
      if (!link) return send(res, unavailablePage('not_found', 404));
      if (!link.password_hash) return res.status(400).type('text').send('This link is not password protected');
      const pw = typeof req.body?.password === 'string' ? req.body.password : '';
      const valid = pw.length > 0 && pw.length <= 128 && await bcrypt.compare(pw, link.password_hash);
      if (!valid) return send(res, passwordPage(link.code, 'Incorrect password. Please try again.'));
      const status = linkStatus(link);
      if (status !== 'active') return send(res, unavailablePage(status));
      if (!db.recordClick(link.id, clickMeta(req))) return send(res, unavailablePage('limit_reached'));
      // The original saved destination — never the short URL or app root.
      return res.redirect(302, link.original_url);
    } catch (e) { next(e); }
  });

  app.use((req, res) => send(res, unavailablePage('not_found', 404)));
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[error]', err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed request body.' });
    if (req.path.startsWith('/api')) return res.status(500).json({ error: 'Something went wrong. Please try again.' });
    res.status(500).type('html').send(page('Error', '<h1>Something went wrong</h1><p class="muted">Please try again shortly.</p>').html);
  });
  return app;
}

if (require.main === module) {
  db.init();
  const port = Number(process.env.PORT) || 3000;
  const server = createApp().listen(port, '0.0.0.0', () => console.log(`LinkPulse Studio listening on http://0.0.0.0:${port}`));
  const shutdown = () => server.close(() => { db.close(); process.exit(0); });
  process.on('SIGTERM', shutdown); process.on('SIGINT', shutdown);
}

module.exports = { createApp, db };
