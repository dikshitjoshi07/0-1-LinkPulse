'use strict';
// Persistent storage using Node's built-in SQLite (node:sqlite, Node >= 22.13).
// No native compilation needed, so `npm install` works everywhere (incl. Render).
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

let db;

function init(dbPath) {
  const file = dbPath || process.env.DB_PATH || path.join(__dirname, '..', 'data', 'linkpulse.db');
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  db = new DatabaseSync(file);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS links (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      code TEXT NOT NULL UNIQUE COLLATE NOCASE,
      original_url TEXT NOT NULL,
      title TEXT,
      campaign TEXT,
      tags TEXT,
      password_hash TEXT,
      max_clicks INTEGER,
      expires_at TEXT,
      disabled INTEGER NOT NULL DEFAULT 0,
      click_count INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
    );
    CREATE TABLE IF NOT EXISTS clicks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      link_id INTEGER NOT NULL REFERENCES links(id) ON DELETE CASCADE,
      clicked_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      referrer TEXT,
      device TEXT,
      browser TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_clicks_link ON clicks(link_id);
    CREATE INDEX IF NOT EXISTS idx_clicks_time ON clicks(clicked_at);
  `);
  return db;
}

function close() { if (db) { db.close(); db = undefined; } }

const findLinkByCode = (code) => db.prepare('SELECT * FROM links WHERE code = ?').get(code);
const findLinkById = (id) => db.prepare('SELECT * FROM links WHERE id = ?').get(id);
const listLinks = () => db.prepare('SELECT * FROM links ORDER BY created_at DESC, id DESC').all();
const codeExists = (code) => !!db.prepare('SELECT 1 FROM links WHERE code = ?').get(code);

function createLink(l) {
  const r = db.prepare(`INSERT INTO links (code, original_url, title, campaign, tags, password_hash, max_clicks, expires_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(
    l.code, l.originalUrl, l.title, l.campaign, l.tags, l.passwordHash, l.maxClicks, l.expiresAt);
  return findLinkById(Number(r.lastInsertRowid));
}

const UPDATABLE = {
  originalUrl: 'original_url', title: 'title', campaign: 'campaign', tags: 'tags',
  passwordHash: 'password_hash', maxClicks: 'max_clicks', expiresAt: 'expires_at', disabled: 'disabled',
};
function updateLink(id, fields) {
  const sets = []; const vals = [];
  for (const [k, col] of Object.entries(UPDATABLE)) {
    if (k in fields) { sets.push(`${col} = ?`); vals.push(fields[k]); }
  }
  if (!sets.length) return findLinkById(id);
  sets.push("updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')");
  db.prepare(`UPDATE links SET ${sets.join(', ')} WHERE id = ?`).run(...vals, id);
  return findLinkById(id);
}

const deleteLink = (id) => db.prepare('DELETE FROM links WHERE id = ?').run(id).changes > 0;

/**
 * Atomically records one click. Returns false if the click limit was reached
 * concurrently (guarantees count never exceeds max_clicks, never double counts).
 */
function recordClick(linkId, meta = {}) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const r = db.prepare(`UPDATE links SET click_count = click_count + 1
      WHERE id = ? AND (max_clicks IS NULL OR click_count < max_clicks)`).run(linkId);
    if (r.changes === 0) { db.exec('ROLLBACK'); return false; }
    db.prepare('INSERT INTO clicks (link_id, referrer, device, browser) VALUES (?, ?, ?, ?)')
      .run(linkId, meta.referrer || null, meta.device || null, meta.browser || null);
    db.exec('COMMIT');
    return true;
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

function stats() {
  const today = new Date(); today.setUTCHours(0, 0, 0, 0);
  const one = (sql, ...a) => db.prepare(sql).get(...a);
  return {
    totalLinks: one('SELECT COUNT(*) n FROM links').n,
    totalClicks: one('SELECT COALESCE(SUM(click_count),0) n FROM links').n,
    clicksToday: one('SELECT COUNT(*) n FROM clicks WHERE clicked_at >= ?', today.toISOString()).n,
    protectedLinks: one('SELECT COUNT(*) n FROM links WHERE password_hash IS NOT NULL').n,
    topLinks: db.prepare('SELECT id, code, title, original_url, click_count FROM links WHERE click_count > 0 ORDER BY click_count DESC LIMIT 5').all(),
    recentClicks: db.prepare(`SELECT c.clicked_at, c.referrer, c.device, c.browser, l.code, l.title
      FROM clicks c JOIN links l ON l.id = c.link_id ORDER BY c.clicked_at DESC, c.id DESC LIMIT 15`).all(),
    daily: db.prepare(`SELECT substr(clicked_at,1,10) day, COUNT(*) n FROM clicks
      WHERE clicked_at >= ? GROUP BY day ORDER BY day`).all(new Date(Date.now() - 13 * 864e5).toISOString().slice(0, 10)),
    devices: db.prepare('SELECT COALESCE(device,\'Unknown\') device, COUNT(*) n FROM clicks GROUP BY device ORDER BY n DESC').all(),
  };
}

module.exports = { init, close, findLinkByCode, findLinkById, listLinks, codeExists, createLink, updateLink, deleteLink, recordClick, stats };
