'use strict';
(() => {
  const $ = (s, el = document) => el.querySelector(s);
  const view = $('#view');
  const state = { links: [], baseUrl: location.origin };
  const TITLES = { dashboard: 'Dashboard', create: 'Create short link', links: 'All links', analytics: 'Analytics', qr: 'QR codes', settings: 'Settings & help' };

  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const fmtDate = (iso) => (iso ? new Date(iso).toLocaleString() : '—');
  const STATUS = { active: 'Active', paused: 'Paused', expired: 'Expired', limit_reached: 'Limit reached' };

  function toast(msg, type = 'ok') {
    const t = document.createElement('div');
    t.className = `toast ${type === 'error' ? 'error' : ''}`; t.textContent = msg;
    $('#toasts').appendChild(t); setTimeout(() => t.remove(), 3500);
  }

  async function api(path, opts = {}) {
    let res;
    try {
      res = await fetch(path, { ...opts, headers: { 'Content-Type': 'application/json', ...(opts.headers || {}) } });
    } catch { throw Object.assign(new Error('Network error — is the server running?'), { fields: {} }); }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(data.error || `Request failed (${res.status})`), { fields: data.fields || {} });
    return data;
  }

  async function copy(text) {
    try { await navigator.clipboard.writeText(text); toast('Copied to clipboard'); }
    catch {
      const ta = document.createElement('textarea'); ta.value = text; document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); toast('Copied to clipboard'); } catch { toast('Copy failed — select and copy manually', 'error'); }
      ta.remove();
    }
  }

  const loading = (n = 3) => Array.from({ length: n }, () => '<div class="skeleton"></div>').join('');
  const empty = (msg, cta = true) => `<div class="empty"><div class="big">◆</div><p>${msg}</p>${cta ? '<a class="btn btn-primary" href="#/create">Create your first link</a>' : ''}</div>`;
  const errorBox = (msg) => `<div class="alert alert-error" role="alert">${esc(msg)}</div>`;

  function linkRow(l, { compact } = {}) {
    return `<div class="link-item" data-id="${l.id}">
      <div style="min-width:0">
        <div class="link-title">${esc(l.title || l.code)}
          <span class="badge ${l.status}">${STATUS[l.status]}</span>
          ${l.passwordProtected ? '<span class="badge lock">🔒 Protected</span>' : ''}
          ${l.campaign ? `<span class="badge">${esc(l.campaign)}</span>` : ''}
          ${l.tags.map((t) => `<span class="badge">#${esc(t)}</span>`).join('')}
        </div>
        <a class="short" href="${esc(l.shortUrl)}" target="_blank" rel="noopener">${esc(l.shortUrl)}</a>
        <div class="dest" title="${esc(l.originalUrl)}">→ ${esc(l.originalUrl)}</div>
        <div class="muted small">${l.clicks} click${l.clicks === 1 ? '' : 's'}${l.maxClicks ? ` / ${l.maxClicks} max` : ''} · created ${fmtDate(l.createdAt)}${l.expiresAt ? ` · expires ${fmtDate(l.expiresAt)}` : ''}</div>
      </div>
      <div class="actions">
        <button class="btn btn-sm" data-act="copy">Copy</button>
        ${compact ? '' : `
        <button class="btn btn-sm" data-act="toggle">${l.disabled ? 'Resume' : 'Pause'}</button>
        <button class="btn btn-sm" data-act="edit">Edit</button>
        <a class="btn btn-sm" href="/api/links/${l.id}/qr?download=1">QR</a>
        <button class="btn btn-sm btn-danger" data-act="delete">Delete</button>`}
      </div></div>`;
  }

  async function loadLinks() { state.links = await api('/api/links'); return state.links; }

  // ---------- views ----------
  const views = {
    async dashboard() {
      view.innerHTML = `<div class="grid stats">${loading(4)}</div>`;
      const [s, links] = await Promise.all([api('/api/stats'), loadLinks()]);
      view.innerHTML = `
        <div class="grid stats">
          ${[['Total links', s.totalLinks], ['Total clicks', s.totalClicks], ['Clicks today', s.clicksToday], ['Protected links', s.protectedLinks]]
            .map(([k, v]) => `<div class="card stat"><div class="label">${k}</div><div class="value">${v}</div></div>`).join('')}
        </div>
        <div class="grid two" style="margin-top:18px">
          <div class="card"><h2>Recent links</h2>${links.length ? links.slice(0, 5).map((l) => linkRow(l, { compact: true })).join('') : empty('No links yet.')}</div>
          <div class="card"><h2>Recent activity</h2>${activityList(s.recentClicks.slice(0, 8))}</div>
        </div>`;
    },

    async create() {
      view.innerHTML = `<div class="card" style="max-width:820px">
        <form id="create-form" class="form-grid" novalidate>
          <label class="field full"><span>Destination URL *</span><input name="originalUrl" type="url" placeholder="https://example.com/your/long/page" required maxlength="2048"><small class="err" data-err="originalUrl"></small></label>
          <label class="field"><span>Custom alias</span><input name="alias" placeholder="spring-sale" maxlength="32" pattern="[A-Za-z0-9_\\-]{3,32}"><small class="muted small">${esc(state.baseUrl)}/<b id="alias-preview">auto</b></small><small class="err" data-err="alias"></small></label>
          <label class="field"><span>Title</span><input name="title" maxlength="120" placeholder="Spring campaign landing"><small class="err" data-err="title"></small></label>
          <label class="field"><span>Campaign</span><input name="campaign" maxlength="80" placeholder="spring-2026"></label>
          <label class="field"><span>Tags (comma separated)</span><input name="tags" maxlength="300" placeholder="social, email"></label>
          <label class="field"><span>Password (optional)</span><input name="password" type="password" maxlength="128" autocomplete="new-password" placeholder="Min. 4 characters"><small class="err" data-err="password"></small></label>
          <label class="field"><span>Max clicks (optional)</span><input name="maxClicks" type="number" min="1" step="1" placeholder="Unlimited"><small class="err" data-err="maxClicks"></small></label>
          <label class="field"><span>Expires at (optional)</span><input name="expiresAt" type="datetime-local"><small class="err" data-err="expiresAt"></small></label>
          <div class="full row"><button class="btn btn-primary" type="submit" id="create-btn">Shorten link</button><span class="muted small">Only http:// and https:// destinations are accepted.</span></div>
        </form>
        <div id="create-result"></div></div>`;
      const form = $('#create-form');
      form.alias.addEventListener('input', () => { $('#alias-preview').textContent = form.alias.value.trim() || 'auto'; });
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        const v = Object.fromEntries(new FormData(form));
        const errs = validateClient(v);
        showErrors(form, errs);
        if (Object.keys(errs).length) return;
        const btn = $('#create-btn'); btn.disabled = true; btn.innerHTML = '<span class="spinner"></span> Creating…';
        try {
          const body = { ...v, expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : '', maxClicks: v.maxClicks || '' };
          const link = await api('/api/links', { method: 'POST', body: JSON.stringify(body) });
          form.reset(); $('#alias-preview').textContent = 'auto';
          $('#create-result').innerHTML = `<div class="alert alert-ok" style="margin-top:16px">Short link created${link.passwordProtected ? ' (password protected)' : ''}!</div>
            <div class="result"><a class="short" style="font-size:18px" href="${esc(link.shortUrl)}" target="_blank" rel="noopener">${esc(link.shortUrl)}</a>
            <button class="btn btn-sm" id="copy-new">Copy</button><a class="btn btn-sm" href="/api/links/${link.id}/qr?download=1">Download QR</a></div>
            <img src="/api/links/${link.id}/qr" alt="QR code for ${esc(link.shortUrl)}" width="160" style="margin-top:14px;border-radius:10px;background:#fff;padding:4px">`;
          $('#copy-new').addEventListener('click', () => copy(link.shortUrl));
          toast('Link created');
        } catch (err) {
          showErrors(form, err.fields); toast(err.message, 'error');
        } finally { btn.disabled = false; btn.textContent = 'Shorten link'; }
      });
    },

    async links() {
      view.innerHTML = `<div class="toolbar"><input id="search" type="search" placeholder="Search title, URL, alias, tag…"><select id="filter">
        <option value="">All statuses</option><option value="active">Active</option><option value="paused">Paused</option><option value="expired">Expired</option>
        <option value="limit_reached">Limit reached</option><option value="protected">Protected</option></select></div><div class="card" id="list">${loading()}</div>`;
      await loadLinks();
      const render = () => {
        const q = $('#search').value.trim().toLowerCase(); const f = $('#filter').value;
        const items = state.links.filter((l) => (!f || (f === 'protected' ? l.passwordProtected : l.status === f)) &&
          (!q || [l.title, l.originalUrl, l.code, l.campaign, ...l.tags].join(' ').toLowerCase().includes(q)));
        $('#list').innerHTML = state.links.length ? (items.length ? items.map((l) => linkRow(l)).join('') : empty('No links match your filters.', false)) : empty('You haven’t created any links yet.');
      };
      $('#search').addEventListener('input', render); $('#filter').addEventListener('change', render);
      render();
    },

    async analytics() {
      view.innerHTML = loading(3);
      const s = await api('/api/stats');
      const days = []; for (let i = 13; i >= 0; i--) days.push(new Date(Date.now() - i * 864e5).toISOString().slice(0, 10));
      const map = Object.fromEntries(s.daily.map((d) => [d.day, d.n])); const max = Math.max(1, ...days.map((d) => map[d] || 0));
      view.innerHTML = `
        <div class="grid stats">
          ${[['Total links', s.totalLinks], ['Total clicks', s.totalClicks], ['Clicks today', s.clicksToday], ['Protected', s.protectedLinks]]
            .map(([k, v]) => `<div class="card stat"><div class="label">${k}</div><div class="value">${v}</div></div>`).join('')}</div>
        <div class="card" style="margin-top:18px"><h2>Clicks — last 14 days</h2>
          <div class="bars">${days.map((d) => `<div class="bar" title="${d}: ${map[d] || 0}" style="height:${((map[d] || 0) / max) * 100}%"><span>${d.slice(8)}</span></div>`).join('')}</div><div style="height:22px"></div></div>
        <div class="grid two" style="margin-top:18px">
          <div class="card"><h2>Most-clicked links</h2>${s.topLinks.length ? `<ul class="list">${s.topLinks.map((l) => `<li><span>${esc(l.title || l.code)} <span class="muted mono small">/${esc(l.code)}</span></span><b>${l.click_count}</b></li>`).join('')}</ul>` : empty('No clicks recorded yet.', false)}</div>
          <div class="card"><h2>Devices</h2>${s.devices.length ? `<ul class="list">${s.devices.map((d) => `<li><span>${esc(d.device)}</span><b>${d.n}</b></li>`).join('')}</ul>` : empty('No device data yet.', false)}</div>
        </div>
        <div class="card" style="margin-top:18px"><h2>Recent click activity</h2>${s.recentClicks.length ? `<div class="table-wrap"><table><thead><tr><th>Time</th><th>Link</th><th>Device</th><th>Browser</th><th>Referrer</th></tr></thead><tbody>
          ${s.recentClicks.map((c) => `<tr><td>${fmtDate(c.clicked_at)}</td><td class="mono">/${esc(c.code)}</td><td>${esc(c.device)}</td><td>${esc(c.browser)}</td><td>${esc(c.referrer || 'Direct')}</td></tr>`).join('')}</tbody></table></div>` : empty('No activity yet.', false)}</div>`;
    },

    async qr() {
      view.innerHTML = `<div class="grid qr-grid">${loading(3)}</div>`;
      const links = await loadLinks();
      view.innerHTML = links.length ? `<div class="grid qr-grid">${links.map((l) => `<div class="card qr-card">
        <img src="/api/links/${l.id}/qr" alt="QR code for ${esc(l.shortUrl)}" loading="lazy">
        <div style="margin-top:10px;font-weight:600">${esc(l.title || l.code)}</div><div class="short small">${esc(l.shortUrl)}</div>
        <div class="row" style="justify-content:center;margin-top:10px"><a class="btn btn-sm btn-primary" href="/api/links/${l.id}/qr?download=1">Download PNG</a></div></div>`).join('')}</div>`
        : `<div class="card">${empty('Create a link to generate its QR code.')}</div>`;
    },

    async settings() {
      view.innerHTML = `<div class="grid two">
        <div class="card stack"><h2>Workspace</h2>
          <div><div class="muted small">Short link base URL</div><code>${esc(state.baseUrl)}</code></div>
          <p class="muted small">Set the <code>BASE_URL</code> environment variable to use a custom domain. On Render, the service URL is detected automatically.</p>
          <h2>How it works</h2>
          <ul class="muted small" style="padding-left:18px;margin:0">
            <li>Normal links redirect instantly (HTTP 302) to the destination.</li>
            <li>Protected links show a password page; the correct password redirects to the exact saved destination.</li>
            <li>Paused, expired and limit-reached links show an “unavailable” page.</li>
            <li>Clicks are counted once per successful visit. IP addresses are never stored.</li>
          </ul></div>
        <div class="card stack"><h2>Help</h2>
          <p class="muted small"><b>Aliases</b> — 3–32 characters: letters, numbers, <code>-</code> and <code>_</code>. Must be unique.</p>
          <p class="muted small"><b>Passwords</b> are hashed with bcrypt and can’t be recovered — set a new one via Edit.</p>
          <p class="muted small"><b>Security</b> — password attempts and link creation are rate-limited.</p>
          <p class="muted small"><b>Note</b> — this dashboard has no login. Deploy privately or add authentication before sharing the dashboard URL.</p>
        </div></div>`;
    },
  };

  function activityList(items) {
    return items.length ? `<ul class="list">${items.map((c) => `<li><span class="mono">/${esc(c.code)}</span><span class="muted small">${esc(c.device)} · ${fmtDate(c.clicked_at)}</span></li>`).join('')}</ul>`
      : empty('Clicks will show up here.', false);
  }

  function validateClient(v) {
    const e = {};
    try { const u = new URL(v.originalUrl.trim()); if (!/^https?:$/.test(u.protocol)) throw 0; } catch { e.originalUrl = 'Enter a valid http:// or https:// URL.'; }
    if (v.alias && !/^[A-Za-z0-9_-]{3,32}$/.test(v.alias.trim())) e.alias = 'Alias must be 3–32 letters, numbers, - or _.';
    if (v.password && v.password.length < 4) e.password = 'Password must be at least 4 characters.';
    if (v.maxClicks && (!Number.isInteger(Number(v.maxClicks)) || Number(v.maxClicks) < 1)) e.maxClicks = 'Must be a whole number ≥ 1.';
    if (v.expiresAt && new Date(v.expiresAt).getTime() <= Date.now()) e.expiresAt = 'Expiry must be in the future.';
    return e;
  }
  function showErrors(form, errs = {}) {
    form.querySelectorAll('[data-err]').forEach((el) => {
      const k = el.dataset.err; el.textContent = errs[k] || '';
      if (form[k]) form[k].classList.toggle('invalid', !!errs[k]);
    });
  }

  // ---------- edit dialog ----------
  const dlg = $('#edit-dialog');
  function toLocalInput(iso) { if (!iso) return ''; const d = new Date(iso); return new Date(d - d.getTimezoneOffset() * 6e4).toISOString().slice(0, 16); }
  function openEdit(l) {
    dlg.innerHTML = `<form id="edit-form" class="stack" novalidate><h2>Edit /${esc(l.code)}</h2>
      <label class="field"><span>Destination URL</span><input name="originalUrl" value="${esc(l.originalUrl)}" required><small class="err" data-err="originalUrl"></small></label>
      <label class="field"><span>Title</span><input name="title" value="${esc(l.title || '')}" maxlength="120"></label>
      <div class="form-grid"><label class="field"><span>Campaign</span><input name="campaign" value="${esc(l.campaign || '')}" maxlength="80"></label>
      <label class="field"><span>Tags</span><input name="tags" value="${esc(l.tags.join(', '))}"></label>
      <label class="field"><span>Max clicks</span><input name="maxClicks" type="number" min="1" value="${l.maxClicks ?? ''}"><small class="err" data-err="maxClicks"></small></label>
      <label class="field"><span>Expires at</span><input name="expiresAt" type="datetime-local" value="${toLocalInput(l.expiresAt)}"><small class="err" data-err="expiresAt"></small></label></div>
      <label class="field"><span>${l.passwordProtected ? 'New password (leave blank to keep current)' : 'Set password (optional)'}</span><input name="password" type="password" autocomplete="new-password" maxlength="128"><small class="err" data-err="password"></small></label>
      ${l.passwordProtected ? '<label class="field check"><input type="checkbox" name="removePassword"> Remove password protection</label>' : ''}
      <div class="row" style="justify-content:flex-end"><button type="button" class="btn" id="edit-cancel">Cancel</button><button class="btn btn-primary" type="submit">Save changes</button></div></form>`;
    dlg.showModal();
    $('#edit-cancel').addEventListener('click', () => dlg.close());
    const form = $('#edit-form');
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      const v = Object.fromEntries(new FormData(form));
      const errs = validateClient({ ...v, expiresAt: '' }); delete errs.alias; showErrors(form, errs);
      if (Object.keys(errs).length) return;
      const body = { originalUrl: v.originalUrl, title: v.title, campaign: v.campaign, tags: v.tags, maxClicks: v.maxClicks || null,
        expiresAt: v.expiresAt ? new Date(v.expiresAt).toISOString() : null, removePassword: !!v.removePassword };
      if (v.password) body.password = v.password;
      try { await api(`/api/links/${l.id}`, { method: 'PATCH', body: JSON.stringify(body) }); dlg.close(); toast('Link updated'); route(); }
      catch (err) { showErrors(form, err.fields); toast(err.message, 'error'); }
    });
  }

  // ---------- delegated actions ----------
  view.addEventListener('click', async (e) => {
    const btn = e.target.closest('[data-act]'); if (!btn) return;
    const id = Number(btn.closest('[data-id]').dataset.id); const l = state.links.find((x) => x.id === id); if (!l) return;
    const act = btn.dataset.act;
    if (act === 'copy') return copy(l.shortUrl);
    if (act === 'edit') return openEdit(l);
    try {
      btn.disabled = true;
      if (act === 'toggle') { await api(`/api/links/${id}`, { method: 'PATCH', body: JSON.stringify({ disabled: !l.disabled }) }); toast(l.disabled ? 'Link resumed' : 'Link paused'); }
      if (act === 'delete') { if (!confirm(`Delete ${l.shortUrl}? This cannot be undone.`)) { btn.disabled = false; return; } await api(`/api/links/${id}`, { method: 'DELETE' }); toast('Link deleted'); }
      route();
    } catch (err) { toast(err.message, 'error'); btn.disabled = false; }
  });

  // ---------- router ----------
  async function route() {
    const name = (location.hash.replace(/^#\/?/, '') || 'dashboard').split('?')[0];
    const key = views[name] ? name : 'dashboard';
    document.querySelectorAll('.nav a').forEach((a) => a.classList.toggle('active', a.dataset.view === key));
    $('#view-title').textContent = TITLES[key]; document.title = `${TITLES[key]} · LinkPulse Studio`;
    $('#sidebar').classList.remove('open');
    try { await views[key](); } catch (err) { view.innerHTML = errorBox(err.message || 'Something went wrong.'); }
  }
  $('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
  window.addEventListener('hashchange', route);

  api('/api/config').then((c) => { state.baseUrl = c.baseUrl; $('#base-url').textContent = c.baseUrl.replace(/^https?:\/\//, ''); }).catch(() => {}).finally(route);
})();
