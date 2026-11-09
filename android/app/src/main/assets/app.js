'use strict';
/* Mango Monitor UI. Talks only to our own backend (via Android bridge, or fetch in a browser). */
const NATIVE = typeof Android !== 'undefined';
const VERSION = (window.Android && Android.version) ? Android.version() : '3.7.5'; // single source: versionName in app/build.gradle
// Heat-pump presets: everything scales from the 25 kW unit (compressor 4100 W). Any other kW can be typed by hand (Core.presetFor).
const PRESETS = {}; [18, 25, 30, 35].forEach(k => { PRESETS[k] = Core.presetFor(k); });
const STRCFG = k => /Code$|^powerSrc$|^model$/.test(k);
const store = {
  get: k => { const v = NATIVE ? Android.get(k) : localStorage.getItem('mm_' + k); return v === '' ? null : v; },
  set: (k, v) => { v = v == null ? '' : String(v); NATIVE ? Android.set(k, v) : localStorage.setItem('mm_' + k, v); }
};
const S = { me: null, hid: null, did: null, tab: 'home', dev: null, ov: [], period: 'month', stats: null, auto: null, hrs: 24, shift: 0, cur: {}, series: null, unseen: 0, W: {}, timer: null, zoom: {}, live: [], barKey: 'kwh', barSel: null, dv: 'hour', tarOpen: false, notifOpen: false, fo: {}, hlOpen: {} };
const $ = id => document.getElementById(id), main = $('main');
const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const nf = (v, d = 1) => v == null || isNaN(v) ? '—' : (+v).toFixed(d);
const num = v => (v === '' || v == null || isNaN(+v)) ? null : +v;
const DIRECT = () => true; // v3.6: only the standalone mode exists
const LOCALE = { uz: 'uz', uzc: 'uz-Cyrl', ru: 'ru', en: 'en' };

// ---------- bridge ----------
let cbSeq = 0; const cbs = {};
window.__cb = (id, status, text) => { const c = cbs[id]; delete cbs[id]; if (c) c(status, text); };
function api(method, path, body) { return LocalApi.handle(method, path, body); }
function tuyaCall(method, path, body) {
  return new Promise(res => {
    if (typeof Android === 'undefined' || !Android.tuya) return res({ success: false, msg: 'no bridge' });
    const id = ++cbSeq; cbs[id] = (s, t) => { let j; try { j = JSON.parse(t); } catch (e) { j = { success: false, msg: 'network' }; } res(j); };
    Android.tuya(id, method, path, body ? JSON.stringify(body) : '');
  });
}
function authenticate(reason) {
  if (!NATIVE) return Promise.resolve(true);
  return new Promise(res => { const id = ++cbSeq; cbs[id] = s => res(s === 200); Android.auth(id, reason || ''); });
}
const errMsg = r => r.status === 0 ? t('offline_srv') : r.status === 403 ? t('forbidden') : ({ bad_credentials: 'bad_cred', exists: 'exists', bad_input: 'bad_input', too_many: 'too_many', claimed: 'd_claimed', already_added: 'd_dup', tuya: 'd_fail' }[r.j.error] ? t({ bad_credentials: 'bad_cred', exists: 'exists', bad_input: 'bad_input', too_many: 'too_many', claimed: 'd_claimed', already_added: 'd_dup', tuya: 'd_fail' }[r.j.error]) : (r.j.message || t('error')));

// ---------- ui helpers ----------
let toastT; function toast(m) { const e = $('toast'); e.textContent = m; e.style.display = 'block'; clearTimeout(toastT); toastT = setTimeout(() => e.style.display = 'none', 2400); }
function openSheet(html) { $('sheetc').innerHTML = html; $('sheet').classList.add('on'); }
function closeSheet() { $('sheet').classList.remove('on'); }
function ask(msg) {
  return new Promise(res => { window.__ask = v => { closeSheet(); res(v); }; openSheet(`<p>${esc(msg)}</p><div class="row"><button class="btn sec sp" onclick="__ask(false)">${t('no')}</button><button class="btn sp" onclick="__ask(true)">${t('yes')}</button></div>`); });
}
const sw = (act, on, extra = '') => `<label class="sw"><input type="checkbox" data-c="${act}" ${extra} ${on ? 'checked' : ''}><i></i></label>`;
function applyTheme() {
  const r = document.documentElement; r.dataset.theme = store.get('theme') || 'auto'; r.dataset.accent = store.get('accent') || 'mango';
  r.lang = LANG === 'uzc' ? 'uz-Cyrl' : LANG;
}
const fmtT = (ts, long) => { const d = new Date(ts); const p = n => String(n).padStart(2, '0'); return long ? `${p(d.getDate())}.${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}` : `${p(d.getHours())}:${p(d.getMinutes())}`; };
const fmtD = ts => { const d = new Date(ts), p = n => String(n).padStart(2, '0'); return `${p(d.getDate())}.${p(d.getMonth() + 1)}`; };

// ---------- charts ----------
const CH = {}; let chSeq = 0, pinch = null;
// builds the inside of a line chart for the current zoom window (S.zoom[id] = [from, to] as fractions of the full time range)
function chartBody(c) {
  const { series, o, id, W, pl, pr } = c, H = o.h || 130, pt = 8, pb = 16, xs = [];
  series.forEach(s => s.pts.forEach(p => xs.push(p[0])));
  if (!xs.length) return null;
  const X0 = Math.min(...xs), X1 = Math.max(...xs), zm = S.zoom[id] || [0, 1], x0 = X0 + zm[0] * (X1 - X0), x1 = X0 + zm[1] * (X1 - X0), ys = [];
  series.forEach(s => s.pts.forEach(p => { if (p[1] != null && p[0] >= x0 && p[0] <= x1) ys.push(p[1]); }));
  c.x0 = x0; c.x1 = x1;
  if (!ys.length) return `<text x="${W / 2}" y="${H / 2}" text-anchor="middle">${t('no_data')}</text>`;
  let y0 = Math.min(...ys), y1 = Math.max(...ys); if (o.zero) y0 = Math.min(0, y0); if (y1 - y0 < 1) { y1 += .5; y0 -= .5; }
  const X = x => pl + (x - x0) / (x1 - x0 || 1) * (W - pl - pr), Y = y => pt + (1 - (y - y0) / (y1 - y0)) * (H - pt - pb);
  let g = `<defs><clipPath id="cp_${id}"><rect x="${pl}" y="0" width="${W - pl - pr}" height="${H - pb}"/></clipPath></defs>`;
  for (let i = 0; i <= 2; i++) { const v = y0 + (y1 - y0) * i / 2, y = Y(v); g += `<line class="gl" x1="${pl}" x2="${W - pr}" y1="${y}" y2="${y}"/><text x="2" y="${y + 3}">${v.toFixed(o.d || 0)}</text>`; }
  g += `<g clip-path="url(#cp_${id})">`;
  // shaded bands (compressor running): o.band = [[ts_from, ts_to], ...]
  (o.band || []).forEach(b => { const a = X(Math.max(b[0], x0)), e = X(Math.min(b[1], x1)); if (e > a) g += `<rect x="${a.toFixed(1)}" y="${pt}" width="${(e - a).toFixed(1)}" height="${H - pt - pb}" fill="var(--ok)" opacity=".13"/>`; });
  series.forEach(s => { let d = '', pen = false; s.pts.forEach(p => { if (p[1] == null) { pen = false; return; } d += (pen ? 'L' : 'M') + X(p[0]).toFixed(1) + ' ' + Y(p[1]).toFixed(1); pen = true; }); g += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="2" stroke-linejoin="round" ${s.dash ? 'stroke-dasharray="4 3"' : ''}/>`; });
  g += `</g>`;
  const f = o.long ? (x1 - x0 > 2 * 864e5 ? (x => fmtD(x)) : (x => fmtT(x, true))) : (x => fmtT(x));
  g += `<text x="${pl}" y="${H - 3}">${f(x0)}</text><text x="${W - pr}" y="${H - 3}" text-anchor="end">${f(x1)}</text>`;
  g += `<line class="cur" x1="0" x2="0" y1="${pt}" y2="${H - pb}" stroke="var(--tx)" stroke-width="1" opacity="0"/>`;
  return g;
}
function lineChart(series, o = {}) {
  const id = o.id || ('c' + (++chSeq)), c = CH[id] = { id, series, o, W: 320, pl: 30, pr: 6, long: !!o.long, d: o.d || 0 };
  const body = chartBody(c); if (body == null) return `<div class="mut sm">${t('no_data')}</div>`;
  const zb = `<div class="row zb"><button class="btn sec sm" data-a="zoom" data-id="${id}" data-v="in" aria-label="${t('z_in')}">＋</button><button class="btn sec sm" data-a="zoom" data-id="${id}" data-v="out" aria-label="${t('z_out')}">－</button><button class="btn sec sm" data-a="zoom" data-id="${id}" data-v="l">◀</button><button class="btn sec sm" data-a="zoom" data-id="${id}" data-v="r">▶</button><button class="btn sec sm" data-a="zoom" data-id="${id}" data-v="reset">${t('z_reset')}</button></div>`;
  return `<svg class="ch" data-ch="${id}" viewBox="0 0 320 ${o.h || 130}" width="100%" style="touch-action:pan-y">${body}</svg><div class="sm mut chrd" id="rd_${id}">${t('ch_tap')}</div>${zb}`;
}
function redrawChart(id) { const c = CH[id], svg = document.querySelector(`svg[data-ch="${id}"]`); if (!c || !svg) return; svg.innerHTML = chartBody(c) || ''; delete S.cur[id]; const rd = document.getElementById('rd_' + id); if (rd) rd.textContent = t('ch_tap'); }
function setZoom(id, a, b) { if (b - a >= 0.999) delete S.zoom[id]; else { if (a < 0) { b -= a; a = 0; } if (b > 1) { a -= b - 1; b = 1; } S.zoom[id] = [Math.max(0, a), Math.min(1, b)]; } redrawChart(id); }
function chInspect(svg, clientX) {
  const c = CH[svg.dataset.ch]; if (!c || c.x0 == null) return;
  const r = svg.getBoundingClientRect(), fx = Math.min(Math.max((clientX - r.left) / r.width, 0), 1), vx = fx * c.W;
  const ts = c.x0 + (Math.min(Math.max(vx, c.pl), c.W - c.pr) - c.pl) / (c.W - c.pl - c.pr) * (c.x1 - c.x0);
  S.cur[svg.dataset.ch] = fx;
  const line = svg.querySelector('line.cur'); if (!line) return; line.setAttribute('x1', vx); line.setAttribute('x2', vx); line.setAttribute('opacity', '.6');
  const parts = [];
  c.series.forEach(s => { if (!s.name) return; let best = null; s.pts.forEach(p => { if (p[1] != null && (best == null || Math.abs(p[0] - ts) < Math.abs(best[0] - ts))) best = p; }); if (best && Math.abs(best[0] - ts) < (c.x1 - c.x0) / 6) parts.push(`<span style="color:${s.color}">● ${s.name} <b>${(+best[1]).toFixed(s.d != null ? s.d : c.d)}${s.unit || ''}</b></span>`); });
  const when = c.long ? fmtT(ts, true) : fmtT(ts);
  const rd = document.getElementById('rd_' + svg.dataset.ch); if (rd) rd.innerHTML = `<b>${when}</b> &nbsp; ${parts.join(' &nbsp; ')}`;
}
['pointerdown', 'pointermove'].forEach(ev => document.addEventListener(ev, e => { if (pinch) return; const svg = e.target.closest && e.target.closest('svg[data-ch]'); if (svg && (ev === 'pointerdown' || e.buttons || e.pointerType === 'touch')) chInspect(svg, e.clientX); }));
// two-finger pinch zoom on any line chart (temperature, power, Hz)
const tdist = ts => Math.hypot(ts[0].clientX - ts[1].clientX, ts[0].clientY - ts[1].clientY);
document.addEventListener('touchstart', e => {
  const svg = e.target.closest && e.target.closest('svg[data-ch]');
  if (svg && e.touches.length === 2 && CH[svg.dataset.ch]) { const r = svg.getBoundingClientRect(), c = CH[svg.dataset.ch], cx = (e.touches[0].clientX + e.touches[1].clientX) / 2, fx = Math.min(1, Math.max(0, ((cx - r.left) / r.width * c.W - c.pl) / (c.W - c.pl - c.pr))); pinch = { id: svg.dataset.ch, d: tdist(e.touches), z: (S.zoom[svg.dataset.ch] || [0, 1]).slice(), fx }; }
  else if (e.touches.length < 2) pinch = null;
}, { passive: true });
document.addEventListener('touchmove', e => { if (!pinch || e.touches.length !== 2) return; e.preventDefault(); const [a, b] = pinch.z, w = b - a, nw = Math.min(1, Math.max(0.03, w * pinch.d / tdist(e.touches))), na = a + (w - nw) * pinch.fx; setZoom(pinch.id, na, na + nw); }, { passive: false });
document.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; }, { passive: true });
function chRestore() { Object.keys(S.cur).forEach(id => { const svg = document.querySelector(`svg[data-ch="${id}"]`); if (svg && CH[id]) { const r = svg.getBoundingClientRect(); chInspect(svg, r.left + S.cur[id] * r.width); } }); }
function barChart(b, key, lab, fmt) {
  const W = 320, H = 140, pl = 4, pb = 16, pt = 12, mx = Math.max(...b.map(x => x[key] || 0), 0.001), bw = (W - pl * 2) / b.length;
  let g = '';
  b.forEach((x, i) => {
    const h = (x[key] || 0) / mx * (H - pt - pb), xx = pl + i * bw, on = S.barSel === i;
    g += `<rect data-a="bar" data-i="${i}" x="${xx}" y="${pt}" width="${bw}" height="${H - pt - pb}" fill="transparent"/>`;
    g += `<rect data-a="bar" data-i="${i}" x="${xx + 1}" y="${H - pb - h}" width="${Math.max(bw - 2, 1)}" height="${h}" rx="2" fill="var(--acc)" opacity="${on || x[key] ? 1 : .25}" ${on ? 'stroke="var(--tx)" stroke-width="1.6"' : ''}/>`;
    if (b.length <= 12 || i % Math.ceil(b.length / 8) === 0) g += `<text x="${xx + bw / 2}" y="${H - 3}" text-anchor="middle">${lab(x.k)}</text>`;
  });
  g += `<text x="${W - 2}" y="9" text-anchor="end">max ${fmt ? fmt(mx) : mx.toFixed(1)}</text>`;
  return `<svg class="ch" viewBox="0 0 ${W} ${H}" width="100%">${g}</svg>`;
}
function scatter(pairs, fit) {
  const W = 320, H = 140, pl = 30, pb = 16, pt = 8, xs = pairs.map(p => p[0]), ys = pairs.map(p => p[1]);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = 0, y1 = Math.max(...ys);
  const X = x => pl + (x - x0) / (x1 - x0 || 1) * (W - pl - 8), Y = y => pt + (1 - (y - y0) / (y1 - y0 || 1)) * (H - pt - pb);
  let g = `<line class="gl" x1="${pl}" x2="${W - 8}" y1="${Y(0)}" y2="${Y(0)}"/><text x="2" y="${pt + 8}">${y1.toFixed(0)}</text><text x="2" y="${Y(0)}">0</text><text x="${pl}" y="${H - 3}">${x0.toFixed(0)}°</text><text x="${W - 8}" y="${H - 3}" text-anchor="end">${x1.toFixed(0)}°</text>`;
  pairs.forEach(p => g += `<circle cx="${X(p[0])}" cy="${Y(p[1])}" r="3" fill="var(--c2)" opacity=".8"/>`);
  if (fit) g += `<line x1="${X(x0)}" y1="${Y(fit.slope * x0 + fit.intercept)}" x2="${X(x1)}" y2="${Y(fit.slope * x1 + fit.intercept)}" stroke="var(--acc)" stroke-width="2"/>`;
  return `<svg class="ch" viewBox="0 0 ${W} ${H}" width="100%">${g}</svg>`;
}

// ---------- boot / session ----------
function logoutLocal() { const was = DIRECT(); store.set('token', ''); store.set('hid', ''); store.set('did', '');  clearInterval(S.timer); clearInterval(S.ltimer); clearInterval(S.fast); clearInterval(S.ctimer); S.me = null; if (NATIVE) Android.setService(false); wizard('lang'); }
async function boot() {
  setLang(store.get('lang') || 'uz'); applyTheme(); showVer();
  setTimeout(updCheck, 800); setInterval(updCheck, 600000); // new version? (every 10 min)
  setTimeout(() => { const s = $('splash'); s.style.opacity = 0; setTimeout(() => s.style.display = 'none', 400); }, 900);
  if (store.get('lock') === '1' && NATIVE) { showLock(); }
  // native side checks the 'mode' flag; old server-mode tokens are dropped first (their change cancels background work), then direct mode is switched on once
  if (store.get('token')) store.set('token', ''); if (store.get('mode') !== 'direct') store.set('mode', 'direct');
  if (!store.get('tuyaId')) return wizard(store.get('lang') ? 'tuya' : 'lang');
  const r = await api('GET', '/api/me');
  if (r.ok) { S.me = r.j; afterLogin(); } else if (r.status === 0) { main.innerHTML = `<div class="card"><p>${t('offline_srv')}</p><button class="btn" onclick="boot()">${t('retry')}</button></div>`; $('tabs').innerHTML = ''; }
}
function showLock() { $('lockbtn').textContent = '🔓 ' + t('app'); $('lock').style.display = 'flex'; unlock(); }
async function unlock() { if (await authenticate(t('app'))) $('lock').style.display = 'none'; }
// ---------- in-app update (Telegram channel): a newer pinned APK blocks the app until it is installed ----------
const nat = (fn, ...a) => new Promise(res => { if (!NATIVE || !Android[fn]) return res(null); const id = ++cbSeq; cbs[id] = (s, tx) => { let j = null; try { j = JSON.parse(tx); } catch (e) { /* */ } res(j); }; Android[fn](id, ...a); });
let updBusy = false, updSkip = '';
const updErr = m => /chat not found/i.test(m) ? t('upd_nochat') : /unauthorized/i.test(m) ? t('upd_badtoken') : t('upd_fail') + ': ' + m;
function hideUpd() { const u = $('upd'); if (u) { u.classList.remove('on'); u.innerHTML = ''; } }
function showUpd(r) {
  const u = $('upd'); if (!u) return; const mb = r.size ? ' · ' + (r.size / 1048576).toFixed(1) + ' MB' : '';
  u.innerHTML = `<div class="card" style="max-width:420px;width:100%"><h2 style="margin-top:0">${t('upd_title')}</h2><p>v${esc(r.current)} → <b>v${esc(r.version)}</b>${mb}</p><p class="sm">${t(r.optional ? 'upd_opt' : 'upd_force')}</p>
  <div id="updbar" style="display:none"><div class="bar"><i id="updfill"></i></div></div><div id="updmsg" class="sm mut"></div>
  <button class="btn" id="updgo" data-a="updgo">${t('upd_btn')}</button>${r.link ? `<button class="btn sec" data-a="updopen" data-url="${esc(r.link)}">${t('upd_open')}</button>` : ''}${r.optional ? `<button class="btn sec" data-a="updlater" data-v="${esc(r.version)}">${t('upd_later')}</button>` : ''}</div>`;
  u.classList.add('on');
}
async function updCheck(manual) {
  if (!NATIVE || updBusy) return; const r = await nat('updCheck');
  if (!r) return;
  if (r.error === 'off') { if (manual === true) toast(t('upd_off')); return; }
  if (!r.available) { if (!updBusy) hideUpd(); if (manual === true) toast(r.error ? updErr(r.error) : t('upd_none')); return; }
  if (r.optional && updSkip === r.version) return;
  showUpd(r);
}
window.__updP = p => { const b = $('updbar'), f = $('updfill'), m = $('updmsg'); if (b) b.style.display = 'block'; if (f) f.style.width = p + '%'; if (m) m.textContent = t('upd_dl') + ' ' + p + '%'; };
window.__updDone = (st, msg) => { // installer finished with a failure / cancel (success restarts the app)
  updBusy = false; const g = $('updgo'), m = $('updmsg'); if (g) g.disabled = false; if (m) m.textContent = st === 3 ? t('upd_cancel') : t('upd_fail') + ': ' + msg;
};
document.addEventListener('visibilitychange', () => { if (!document.hidden) updCheck(); });
function showVer() { const v = $('ver'); if (v) v.textContent = 'v' + VERSION; }
function afterLogin() {
  const homes = S.me.homes;
  if (!homes.length) return wizard('home');
  S.hid = +store.get('hid') || homes[0].id; let h = homes.find(x => x.id === S.hid); if (!h) { h = homes[0]; S.hid = h.id; }
  if (!h.devices.length) return h.role === 'owner' ? wizard('device') : wizard('home');
  if (store.get('did') && h.devices.some(d => d.id === +store.get('did'))) S.did = +store.get('did'); else S.did = h.devices.length > 1 ? 'all' : h.devices[0].id;
  if (NATIVE) { Android.setService(store.get('notif') !== '0'); }
  startApp();
}
function startApp() {
  S.tab = 'home'; renderTabs(); load(); clearInterval(S.timer); S.timer = setInterval(() => { if (!document.hidden) { refresh(); } }, 5000);
  clearInterval(S.fast); S.fast = setInterval(fastTick, 2000);    // heat-power estimate & live tiles: every 2 s
  clearInterval(S.ctimer); S.ctimer = setInterval(chartTick, 10000); // temperature / power / Hz charts: every 10 s
  checkAlerts(); setInterval(checkAlerts, 60000);
  clearInterval(S.ltimer);
  if (DIRECT()) {
    const tk = async () => { const n = await LocalApi.tick(); if (NATIVE && Android.sampleNow) Android.sampleNow(); if (n && S.tab === 'home') refresh(); };
    tk(); S.ltimer = setInterval(tk, 30000);
  }
}
const home = () => S.me.homes.find(h => h.id === S.hid);
const myRole = () => home().role;

// ---------- geolocation: detect region / district from GPS ----------
function geoLocate() {
  return new Promise(res => {
    if (NATIVE && Android.locate) { const id = ++cbSeq; cbs[id] = (st, tx) => { let j = null; try { j = JSON.parse(tx); } catch (e) { /* */ } res(st === 200 && j && j.lat != null ? j : null); }; Android.locate(id); return; }
    if (!navigator.geolocation) return res(null);
    navigator.geolocation.getCurrentPosition(async p => {
      const g = { lat: +p.coords.latitude.toFixed(4), lon: +p.coords.longitude.toFixed(4) };
      try { const a = (await (await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&zoom=10&accept-language=uz&lat=${g.lat}&lon=${g.lon}`)).json()).address || {}; g.region = a.state || ''; g.district = a.county || a.city_district || a.city || a.town || ''; } catch (e) { /* coordinates only */ }
      res(g);
    }, () => res(null), { timeout: 15000 });
  });
}
const geoText = g => [g.region, g.district].filter(Boolean).join(', ') || `${g.lat}, ${g.lon}`;
const geoSaved = () => { try { const g = JSON.parse(store.get('geo') || 'null'); return g && (g.region || g.district) ? geoText(g) : ''; } catch (e) { return ''; } };

// ---------- wizard ----------
const CITIES = [["Toshkent", 41.31, 69.28], ["Samarqand", 39.65, 66.96], ["Buxoro", 39.77, 64.43], ["Andijon", 40.78, 72.34], ["Namangan", 41.0, 71.67], ["Farg'ona", 40.38, 71.78], ["Qarshi", 38.86, 65.79], ["Termiz", 37.22, 67.28], ["Urganch", 41.55, 60.63], ["Nukus", 42.46, 59.61], ["Jizzax", 40.12, 67.84], ["Guliston", 40.49, 68.78], ["Navoiy", 40.1, 65.37]];
const dots = n => `<div class="dots">${[0, 1, 2, 3, 4, 5].map(i => `<i class="${i <= n ? 'on' : ''}"></i>`).join('')}</div>`;
function showQr(token) {
  const box = $('shbox'); if (!box) return; const q = qrcode(0, 'M'); q.addData('tuyaSmart--qrLogin?token=' + token); q.make();
  const n = q.getModuleCount(), cell = 6, mg = 4, px = (n + mg * 2) * cell, cv = document.createElement('canvas'); cv.width = cv.height = px; cv.id = 'shcv'; cv.style.cssText = 'width:100%;max-width:300px;display:block;margin:12px auto;background:#fff;border-radius:8px';
  const g = cv.getContext('2d'); g.fillStyle = '#fff'; g.fillRect(0, 0, px, px); g.fillStyle = '#000'; for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) g.fillRect((c + mg) * cell, (r + mg) * cell, cell, cell);
  box.innerHTML = `<p class="sm" style="margin-top:12px">${t('sh_scan')}</p><div id="shcvw"></div><div class="mut sm" style="text-align:center">${t('sh_wait')}</div><div class="row" style="margin-top:8px">${NATIVE ? `<button class="btn sec sp" data-a="shsave">${t('sh_save')}</button>` : ''}<button class="btn sec sp" data-a="shqr">${t('sh_regen')}</button></div>`;
  $('shcvw').appendChild(cv);
}
function wizard(step) {
  $('tabs').innerHTML = ''; $('bell').style.display = 'none'; clearInterval(S.timer); clearInterval(S.fast); clearInterval(S.ctimer); const W = S.W; let h = '';
  const err = `<div class="err" id="werr"></div>`;
  if (step === 'lang') {
    h = `${dots(0)}<h2>${t('w_title')}</h2><p class="mut">${t('w_sub')}</p><label class="f">${t('lang')}</label>
    <div class="row">${LANGS.map(l => `<button class="btn ${LANG === l[0] ? '' : 'sec'}" data-a="lang" data-v="${l[0]}">${l[1]}</button>`).join('')}</div>
    <label class="f">${t('theme')}</label><div class="row">${['auto', 'dark', 'light'].map(x => `<button class="btn sm ${(store.get('theme') || 'auto') === x ? '' : 'sec'}" data-a="theme" data-v="${x}">${t('theme_' + x)}</button>`).join('')}</div>
    <label class="f">${t('accent')}</label><div class="row">${accents()}</div><p><button class="btn" style="width:100%" data-a="wiz" data-v="tuya">${t('next')}</button></p>`;
  } else if (step === 'tuya') {
    const tm = W.tmode || (store.get('tuyaId') && store.get('tuyaMode') !== 'sharing' ? 'key' : 'sl');
    const tabs = `<div class="seg"><button class="${tm === 'sl' ? 'on' : ''}" data-a="tmode" data-v="sl">${t('sh_tab_sl')}</button><button class="${tm === 'key' ? 'on' : ''}" data-a="tmode" data-v="key">${t('sh_tab_key')}</button></div>`;
    if (tm === 'sl') h = `${dots(1)}<h2>${t('sh_title')}</h2>${tabs}<p class="sm">${t('sh_steps')}</p><label class="f">${t('sh_code')}</label><input id="sh_code" autocapitalize="none" autocomplete="off" spellcheck="false"><div class="err" id="werr"></div><button class="btn" style="width:100%" data-a="shqr">${t('sh_get_qr')}</button><div id="shbox"></div><p class="mut sm">${t('sh_note')}</p>`;
    else h = `${dots(1)}<h2>${t('t_title')}</h2>${tabs}<p class="mut sm">${t('t_hint')}</p><label class="f">${t('t_id')}</label><input id="t_id" autocapitalize="none" autocomplete="off" value="${esc(store.get('tuyaMode') === 'sharing' ? '' : store.get('tuyaId') || '')}"><label class="f">${t('t_secret')}</label><input id="t_secret" type="password" autocomplete="off"><label class="f">${t('t_region')}</label><select id="t_region">${[['eu', 'Central Europe'], ['us', 'Western America'], ['in', 'India'], ['cn', 'China']].map(r => `<option value="${r[0]}" ${(store.get('tuyaRegion') || 'eu') === r[0] ? 'selected' : ''}>${r[1]}</option>`).join('')}</select>${err}<button class="btn" style="width:100%" data-a="savetuya">${t('next')}</button>`;
  } else if (step === 'tuya_old') {
    h = `${dots(1)}<h2>${t('t_title')}</h2><p class="mut sm">${t('t_hint')}</p><label class="f">${t('t_id')}</label><input id="t_id" autocapitalize="none" autocomplete="off" value="${esc(store.get('tuyaId') || '')}"><label class="f">${t('t_secret')}</label><input id="t_secret" type="password" autocomplete="off"><label class="f">${t('t_region')}</label><select id="t_region">${[['eu', 'Central Europe'], ['us', 'Western America'], ['in', 'India'], ['cn', 'China']].map(r => `<option value="${r[0]}" ${(store.get('tuyaRegion') || 'eu') === r[0] ? 'selected' : ''}>${r[1]}</option>`).join('')}</select>${err}<button class="btn" style="width:100%" data-a="savetuya">${t('next')}</button>`;
  } else if (step === 'home') {
    const j = false, seg = '';
    const form = j ? `<label class="f">${t('h_code')}</label><input id="w_code" autocapitalize="characters">`
      : `<label class="f">${t('h_name')}</label><input id="w_hname" value="Uy"><label class="f">${t('geo_label')}</label><div class="row"><span class="sp mut sm" id="w_geo">${W.geo ? esc(geoText(W.geo)) : t('geo_busy')}</span><button class="btn sec sm" data-a="wgeo">${t('geo_btn')}</button></div><details style="margin-top:6px"><summary class="mut sm">${t('geo_manual')}</summary><select id="w_city">${CITIES.map((c, i) => `<option value="${i}">${c[0]}</option>`).join('')}</select></details><label class="f">${t('h_price')}</label><input id="w_price" type="number" inputmode="decimal" value="1000">`;
    h = `${dots(2)}<h2>${j ? t('h_join') : t('h_new')}</h2>${seg}${form}${err}<button class="btn" style="width:100%" data-a="${j ? 'join' : 'mkhome'}">${t('next')}</button>`;
  } else if (step === 'device') {
    const shm = store.get('tuyaMode') === 'sharing';
    h = `${dots(3)}<h2>${t('d_title')}</h2>${shm ? `<p class="mut sm">${t('sh_pick')}</p><div id="shdevs" class="card">${t('loading')}</div><details style="margin-bottom:10px"><summary class="mut sm">${t('sh_manual')}</summary>` : ''}<p class="mut sm">${t('d_hint')}</p><label class="f">${t('d_id')}</label><input id="w_did" autocapitalize="none" autocomplete="off"><label class="f">${t('d_name')}</label><input id="w_dname" value="Nasos">${err}<button class="btn" style="width:100%" data-a="mkdev">${t('next')}</button>${shm ? '</details>' : ''}`;
  } else if (step === 'power') {
    const codes = W.codes || [];
    h = `${dots(4)}<h2>${t('p_title')}</h2><p class="mut sm">${t('p_hint')}</p><label class="f">${t('st_model')}</label><select id="w_model" data-c="wmodel"><option value="">${t('model_other')}</option>${Object.keys(PRESETS).map(k => `<option value="${k}" ${k === Core.DEFAULT_CFG.model ? 'selected' : ''}>${k} kW</option>`).join('')}</select><label class="f">${t('cfg_kw')}</label><input id="w_kw" type="number" inputmode="decimal" step="0.5" data-c="wkw" value="${Core.DEFAULT_CFG.kw}"><p class="mut sm">${t('kw_hint')}</p><div class="grid">${['compW', 'pumpW', 'fanW', 'heatW'].map(k => `<div><label class="f">${t('cfg_' + k)}</label><input id="w_${k}" type="number" inputmode="numeric" value="${Core.DEFAULT_CFG[k]}"></div>`).join('')}</div>
    <label class="f">${t('p_real')}</label><input id="w_powerCode" list="codes" autocapitalize="none" value="${esc((W.suggest || [])[0] || '')}"><datalist id="codes">${codes.map(c => `<option value="${esc(c)}">`).join('')}</datalist>${err}
    <button class="btn" style="width:100%" data-a="savepower">${t('next')}</button>`;
  } else if (step === 'opts') {
    h = `${dots(5)}<h2>${t('o_title')}</h2>${NATIVE ? `<div class="row card"><span class="sp">${t('o_lock')}</span>${sw('wlock', false)}</div>` : ''}<div class="row card"><span class="sp">${t('o_notif')}</span>${sw('wnotif', true)}</div><button class="btn" style="width:100%" data-a="finish">${t('finish')}</button>`;
  }
  main.innerHTML = `<div class="wiz">${h}</div>`; S.wstep = step;
  if (step === 'home' && !(S.W.join && !DIRECT()) && !W.geo && !W.geoTried) { W.geoTried = true; ACT.wgeo(); }
  if (step === 'device' && store.get('tuyaMode') === 'sharing') ACT.shdevs();
  if (step !== 'tuya') S.shRun = (S.shRun || 0) + 1; // stop QR polling when leaving the login step
}
const accents = () => [['mango', '#ff9f1c'], ['sea', '#19b5c9'], ['green', '#38c172'], ['violet', '#8b7bff']].map(([k, c]) => `<button data-a="accent" data-v="${k}" style="width:34px;height:34px;border-radius:50%;border:${(store.get('accent') || 'mango') === k ? '3px solid var(--tx)' : '2px solid var(--line)'};background:${c}"></button>`).join('');
const werr = m => { const e = $('werr'); if (e) e.textContent = m; };

// ---------- actions ----------
const ACT = {
  lang: el => { store.set('lang', el.dataset.v); setLang(el.dataset.v); applyTheme(); S.me ? render() : wizard(S.wstep); },
  theme: el => { store.set('theme', el.dataset.v); applyTheme(); S.me ? render() : wizard(S.wstep); },
  accent: el => { store.set('accent', el.dataset.v); applyTheme(); S.me ? render() : wizard(S.wstep); },
  wiz: el => wizard(el.dataset.v),
  updgo: async () => {
    if (updBusy) return; updBusy = true; const g = $('updgo'), m = $('updmsg'); if (g) g.disabled = true; if (m) m.textContent = t('upd_dl'); window.__updP(0);
    const r = await nat('updInstall');
    if (!r) { updBusy = false; if (g) g.disabled = false; if (m) m.textContent = t('upd_fail'); return; }
    if (r.stage === 'perm') { updBusy = false; if (g) g.disabled = false; if (m) m.textContent = t('upd_perm'); }
    else if (r.stage === 'installing') { if (m) m.textContent = t('upd_inst'); setTimeout(() => { updBusy = false; if (g) g.disabled = false; }, 20000); }
    else { updBusy = false; if (g) g.disabled = false; if (m) m.textContent = r.msg === 'signature' ? t('upd_sig') : updErr(r.msg || ''); }
  },
  updopen: el => { if (NATIVE && Android.updOpen) Android.updOpen(el.dataset.url); },
  updlater: el => { updSkip = el.dataset.v; hideUpd(); },
  updmanual: () => updCheck(true),
  bgallow: () => { NATIVE && Android.batteryAllow && Android.batteryAllow(); },
  bgauto: () => { NATIVE && Android.autostartSettings && Android.autostartSettings(); },
  bgseen: el => { store.set('bgSeen', el.dataset.v); render(); },
  othours: el => { S.auto.offTimer.hours = +el.dataset.v; render(); },
  hlayout: () => openSheet(layoutSheet()),
  hl_move: el => { const l = homeLayout(), i = l.order.indexOf(el.dataset.id), j = i + +el.dataset.d; if (j < 0 || j >= l.order.length) return; [l.order[i], l.order[j]] = [l.order[j], l.order[i]]; saveLayout(l); reopenLayout(); },
  hl_tmove: el => { const l = homeLayout(), a = l.tiles[el.dataset.b], i = a.indexOf(el.dataset.id), j = i + +el.dataset.d; if (j < 0 || j >= a.length) return; [a[i], a[j]] = [a[j], a[i]]; saveLayout(l); reopenLayout(); },
  hl_reset: () => { store.set('homeLayout', ''); reopenLayout(); },
  tmode: el => { S.W.tmode = el.dataset.v; wizard('tuya'); },
  shqr: async () => {
    const code = ($('sh_code') || {}).value ? $('sh_code').value.trim() : S.shCode || ''; if (!code) return werr(t('sh_need_code'));
    S.shCode = code; const run = S.shRun = (S.shRun || 0) + 1; werr(t('loading'));
    const r = await tuyaCall('POST', '/__qr', { usercode: code });
    if (!r.success || !r.result || !r.result.qrcode) return werr(t('sh_bad_code') + (r.msg ? ': ' + r.msg : ''));
    werr(''); showQr(r.result.qrcode);
    const t0 = Date.now(); let fails = 0;
    while (S.shRun === run) {
      await new Promise(res => setTimeout(res, 2500)); if (S.shRun !== run) return;
      const p = await tuyaCall('GET', '/__qrpoll?token=' + encodeURIComponent(r.result.qrcode));
      if (p.success) { S.shRun++; store.set('tuyaMode', 'sharing'); toast(t('sh_ok')); S.W.tmode = null; if (S.me) { S.W = {}; await reloadMe(); afterLogin(); } else wizard('home'); return; }
      if (p.msg === 'network' && ++fails > 4) return werr(t('offline_srv'));
      if (Date.now() - t0 > 100000) { toast(t('sh_expired')); return ACT.shqr(); } // QR lifetime is short: get a fresh one
    }
  },
  shsave: async () => {
    const cv = $('shcv'); if (!cv || !NATIVE || !Android.saveImage) return toast(t('sh_save_fail'));
    const id = ++cbSeq; cbs[id] = s => toast(s === 200 ? t('sh_saved') : t('sh_save_fail'));
    Android.saveImage(id, 'mango-smartlife-qr.png', cv.toDataURL('image/png').split(',')[1]);
  },
  shdevs: async () => {
    const box = $('shdevs'); if (!box) return; const r = await tuyaCall('GET', '/__devices');
    if (!$('shdevs')) return;
    if (!r.success || !Array.isArray(r.result)) { $('shdevs').innerHTML = `<div class="mut sm">${esc(t('sh_dev_fail'))}${r.msg ? ': ' + esc(r.msg) : ''}</div><button class="btn sec sm" data-a="shdevs">${t('retry')}</button>`; return; }
    const L = r.result.slice().sort((a, b) => (b.online - a.online) || ((b.category === 'rs') - (a.category === 'rs')));
    $('shdevs').innerHTML = L.length ? L.map(d => `<div class="row" style="margin:6px 0" data-a="shpick" data-id="${esc(d.id)}" data-name="${esc(d.name)}"><b class="sp">${esc(d.name || d.id)}${d.product ? ` <small class="mut">${esc(d.product)}</small>` : ''}</b>${chip(d.online ? t('online') : t('offline'), d.online ? 'ok' : 'bad')}<button class="btn sm">›</button></div>`).join('') : `<div class="mut sm">${t('sh_none_dev')}</div>`;
  },
  shpick: el => { $('w_did').value = el.dataset.id; $('w_dname').value = el.dataset.name || 'Nasos'; ACT.mkdev(); },
  shrelink: () => { S.W = { tmode: 'sl' }; wizard('tuya'); },
  savetuya: async () => {
    const id = $('t_id').value.trim(), sec = $('t_secret').value.trim(), rg = $('t_region').value;
    if (!id || (!sec && !store.get('tuyaSecret'))) return werr(t('bad_input'));
    store.set('tuyaMode', ''); store.set('tuyaId', id); if (sec) store.set('tuyaSecret', sec); store.set('tuyaRegion', rg);
    werr(t('loading')); const r = await tuyaCall('GET', '/v1.0/token?grant_type=1');
    if (!r.success) return werr(t('t_bad') + (r.msg ? ': ' + r.msg : ''));
    if (S.me) { werr(''); toast(t('saved')); } else wizard('home');
  },
  wgeo: async () => {
    const e = $('w_geo'); if (e) e.textContent = t('geo_busy');
    const g = await geoLocate(); const e2 = $('w_geo');
    if (g) { S.W.geo = g; if (e2) e2.textContent = geoText(g); } else if (e2) e2.textContent = t('geo_fail');
  },
  geo: async el => {
    if (el) el.disabled = true; const lb = $('geoLbl'); if (lb) lb.textContent = t('geo_busy');
    const g = await geoLocate(); if (el) el.disabled = false;
    if (!g) { const l2 = $('geoLbl'); if (l2) l2.textContent = t('geo_fail'); return; }
    const r = await api('PATCH', `/api/homes/${S.hid}`, { lat: g.lat, lon: g.lon });
    if (r.ok) { store.set('geo', JSON.stringify({ region: g.region || '', district: g.district || '' })); await reloadMe(); toast(t('geo_ok')); render(); } else toast(errMsg(r));
  },
  addtier: () => { const T = S.tariff.tiers, l = T[T.length - 1] || { upTo: 0, price: 1000 }; T.push({ upTo: Math.max(+l.upTo * 2, 100), price: +l.price }); render(); },
  rmtier: el => { S.tariff.tiers.splice(+el.dataset.i, 1); render(); },
  tarreset: () => { S.tariff = { enabled: true, tiers: JSON.parse(JSON.stringify(Core.DEFAULT_TIERS)) }; render(); },
  mkhome: async () => {
    const c = CITIES[+$('w_city').value], g = S.W.geo, tar = { enabled: true, tiers: JSON.parse(JSON.stringify(Core.DEFAULT_TIERS)) };
    if (g) store.set('geo', JSON.stringify({ region: g.region || '', district: g.district || '' }));
    const r = await api('POST', '/api/homes', { name: $('w_hname').value || 'Uy', lat: g ? g.lat : c[1], lon: g ? g.lon : c[2], price: +$('w_price').value || 0, tariff: tar }); if (!r.ok) return werr(errMsg(r));
    await reloadMe(); S.hid = r.j.id; store.set('hid', S.hid); wizard('device');
  },
  mkdev: async () => {
    const r = await api('POST', `/api/homes/${S.hid}/devices`, { tuya_id: $('w_did').value.trim(), name: $('w_dname').value.trim() }); if (!r.ok) return werr(errMsg(r));
    S.W.devId = r.j.id; S.W.codes = r.j.codes; S.W.suggest = r.j.suggest.power; wizard('power');
  },
  savepower: async () => {
    const cfg = Core.withDefaults({}); const wkw = num($('w_kw').value); if (wkw > 0) { Object.assign(cfg, Core.presetFor(wkw)); if (PRESETS[wkw]) cfg.model = String(wkw); else delete cfg.model; } ['compW', 'pumpW', 'fanW', 'heatW'].forEach(k => cfg[k] = +$('w_' + k).value || 0); const pc = $('w_powerCode').value.trim(); if (pc) cfg.powerCode = pc;
    const r = await api('PATCH', `/api/devices/${S.W.devId}`, { cfg }); if (!r.ok) return werr(errMsg(r)); wizard('opts');
  },
  finish: async () => { S.W = {}; await reloadMe(); store.set('did', ''); afterLogin(); },
  tab: el => { S.tab = el.dataset.v; renderTabs(); render(); if (S.tab === 'stats') loadStats(); if (S.tab === 'auto') loadAuto(); },
  dev: el => { S.did = el.dataset.v === 'all' ? 'all' : +el.dataset.v; store.set('did', S.did); S.dev = null; S.series = null; S.stats = null; S.auto = null; S.live = []; S.zoom = {}; S.cur = {}; S.barSel = null; render(); load(); if (S.tab === 'stats') loadStats(); if (S.tab === 'auto') loadAuto(); },
  hrs: el => { S.hrs = +el.dataset.v; S.zoom = {}; S.cur = {}; loadSeries(); },
  zoom: el => { const id = el.dataset.id, v = el.dataset.v; let [a, b] = S.zoom[id] || [0, 1]; const w = b - a, c = (a + b) / 2;
    if (v === 'in') { const nw = Math.max(w / 2, 0.03); a = c - nw / 2; b = c + nw / 2; } else if (v === 'out') { const nw = Math.min(w * 2, 1); a = c - nw / 2; b = c + nw / 2; }
    else if (v === 'l') { a -= w * 0.4; b -= w * 0.4; } else if (v === 'r') { a += w * 0.4; b += w * 0.4; } else { a = 0; b = 1; }
    setZoom(id, a, b); },
  bar: el => { const i = +el.dataset.i; S.barSel = S.barSel === i ? null : i; render(); },
  barkey: el => { S.barKey = el.dataset.v; render(); },
  dview: el => { S.dv = el.dataset.v; render(); },
  gosessions: () => { ACT.tab({ dataset: { v: 'stats' } }); },
  period: el => { S.period = el.dataset.v; S.shift = 0; S.barSel = null; loadStats(); },
  shift: el => { S.shift = Math.max(0, S.shift + +el.dataset.v); S.barSel = null; loadStats(); },
  power: async () => { const on = !(S.dev && S.dev.derived.on); if (!(await ask(t(on ? 'c_confirm_on' : 'c_confirm_off')))) return; cmd('switch', on); },
  setT: () => { cmd('temp_set', +$('tset').value); },
  stepT: el => { const i = $('tset'); i.value = (+i.value + +el.dataset.v).toFixed(1); },
  applyDP: el => { const c = el.dataset.code; const i = document.querySelector(`[data-dp="${c}"]`); cmd(c, i.type === 'number' ? +i.value : i.value); },
  dpmode: async el => { if (!(await ask(t('c_mode_ask', { m: modeLabel(el.dataset.v) })))) return; cmd(S.dev.derived.modeCode, el.dataset.v); },
  alerts: () => openAlerts(),
  logout: async () => { if (await ask(t('confirm'))) { logoutLocal(); } },
  delacc: async () => { if (await ask(t('confirm'))) { await api('DELETE', '/api/me'); logoutLocal(); } },
  batt: () => NATIVE && Android.batterySettings(),
  adddev: () => { S.W = {}; wizard('device'); },
  rmdev: async el => { if (await ask(t('confirm'))) { await api('DELETE', `/api/devices/${el.dataset.v}`); await reloadMe(); store.set('did', ''); afterLogin(); } },
  renamedev: async el => { const i = document.querySelector(`[data-nm="${el.dataset.v}"]`); const r = await api('PATCH', `/api/devices/${el.dataset.v}`, { name: i.value }); if (r.ok) { toast(t('saved')); await reloadMe(); render(); } },
  savehome: async () => { const c = CITIES[+$('s_city').value]; const tiers = S.tariff.tiers.map(x => ({ upTo: +x.upTo, price: +x.price })).filter(x => x.upTo > 0 && x.price >= 0).sort((a, b) => a.upTo - b.upTo); const body = { name: $('s_hname').value, price: +$('s_price').value || 0, tariff: S.tariff.enabled && tiers.length ? { enabled: true, tiers } : null }; if (c && $('s_city').value !== '' && !geoSaved()) { body.lat = c[1]; body.lon = c[2]; } const r = await api('PATCH', `/api/homes/${S.hid}`, body); if (r.ok) { toast(t('saved')); S.tariff = null; await reloadMe(); render(); } else toast(errMsg(r)); },
  savecfg: async () => { const cfg = Object.assign({}, S.dev.cfg); document.querySelectorAll('[data-cfg]').forEach(i => { const k = i.dataset.cfg, v = i.value.trim(); if (v === '') delete cfg[k]; else cfg[k] = STRCFG(k) ? v : +v; }); const r = await api('PATCH', `/api/devices/${S.did}`, { cfg }); if (r.ok) { toast(t('saved')); load(); } else toast(errMsg(r)); },
  addslot: () => { S.auto.schedule.slots.push({ days: [1, 2, 3, 4, 5, 6, 7], from: '06:00', to: '22:00', setpoint: '' }); render(); },
  rmslot: el => { S.auto.schedule.slots.splice(+el.dataset.i, 1); render(); },
  dayslot: el => { const s = S.auto.schedule.slots[+el.dataset.i], d = +el.dataset.d, k = s.days.indexOf(d); k < 0 ? s.days.push(d) : s.days.splice(k, 1); render(); },
  addrule: () => { S.auto.weather.rules.push({ below: 0, add: 2 }); render(); },
  rmrule: el => { S.auto.weather.rules.splice(+el.dataset.i, 1); render(); },
  saveauto: async () => { const r = await api('PUT', `/api/devices/${S.did}/auto`, S.auto); toast(r.ok ? t('saved') : errMsg(r)); }
};
document.addEventListener('click', e => { const el = e.target.closest('[data-a]'); if (el && ACT[el.dataset.a]) { e.preventDefault(); ACT[el.dataset.a](el); } });
document.addEventListener('change', e => {
  const el = e.target, c = el.dataset.c; if (!c) return;
  if (c === 'wlock') store.set('lock', el.checked ? '1' : '0'); else if (c === 'wnotif' || c === 'notif') { store.set('notif', el.checked ? '1' : '0'); NATIVE && Android.setService(el.checked); }
  else if (c === 'hl_vis' || c === 'hl_tvis') { const l = homeLayout(); if (el.checked) l.hidden.delete(el.dataset.id); else l.hidden.add(el.dataset.id); saveLayout(l); reopenLayout(); }
  else if (c === 'alertnotif') { store.set('alertNotif', el.checked ? '1' : '0'); }
  else if (c === 'lock') { store.set('lock', el.checked ? '1' : '0'); } else if (c === 'protect') store.set('protect', el.checked ? '1' : '0');
  else if (c === 'dpbool') cmd(el.dataset.code, el.checked);
  else if (c === 'dpenum') cmd(el.dataset.code, el.value);
  else if (c === 'sch') { S.auto.schedule.enabled = el.checked; } else if (c === 'schout') S.auto.schedule.outside = el.value;
  else if (c === 'tar_on') { S.tariff.enabled = el.checked; render(); } else if (c === 'tier') { S.tariff.tiers[+el.dataset.i][el.dataset.k] = +el.value; }
  else if (c === 'wbelow') S.auto.weather.below = num(el.value);
  else if (c === 'oton') S.auto.offTimer.enabled = el.checked;
  else if (c === 'otf') { const k = el.dataset.k; S.auto.offTimer[k] = ['mode', 'at'].includes(k) ? el.value : num(el.value); if (k === 'mode') render(); }
  else if (c === 'wea') S.auto.weather.enabled = el.checked; else if (c === 'weasrc') S.auto.weather.source = el.value;
  else if (c === 'base') S.auto.base = num(el.value); else if (c === 'hold') S.auto.holdMin = num(el.value) || 120;
  else if (c === 'slot') { const s = S.auto.schedule.slots[+el.dataset.i]; s[el.dataset.k] = el.dataset.k === 'setpoint' ? num(el.value) : el.value; }
  else if (c === 'rule') { S.auto.weather.rules[+el.dataset.i][el.dataset.k] = +el.value; }
  else if (c === 'wmodel') { const m = PRESETS[el.value]; if (m) { ['compW', 'pumpW', 'fanW', 'heatW'].forEach(k => { $('w_' + k).value = m[k]; }); $('w_kw').value = m.kw; } else $('w_kw').focus(); }
  else if (c === 'wkw') { const m = Core.presetFor(el.value); if (m) { ['compW', 'pumpW', 'fanW', 'heatW'].forEach(k => { $('w_' + k).value = m[k]; }); $('w_model').value = PRESETS[m.kw] ? String(m.kw) : ''; } }
  else if (c === 'kwin') { const m = Core.presetFor(el.value); if (m) { Object.keys(m).forEach(k => { if (k === 'kw') return; const i = document.querySelector(`[data-cfg="${k}"]`); if (i) i.value = m[k]; }); const ms = document.querySelector('select[data-c="modelsel"]'); if (ms) ms.value = PRESETS[m.kw] ? String(m.kw) : ''; const ps = document.querySelector('[data-cfg="powerSrc"]'); if (ps) ps.value = 'auto'; } }
  else if (c === 'modelsel') { const m = PRESETS[el.value]; if (m) { Object.keys(m).forEach(k => { const i = document.querySelector(`[data-cfg="${k}"]`); if (i) i.value = m[k]; }); const ps = document.querySelector('[data-cfg="powerSrc"]'); if (ps) ps.value = 'auto'; } }
  else if (c === 'modepick') { const cfg = Object.assign({}, S.dev.cfg); if (el.value) cfg.modeCode = el.value; else delete cfg.modeCode; api('PATCH', `/api/devices/${S.did}`, { cfg }).then(r => { toast(r.ok ? t('saved') : errMsg(r)); load(); }); }
  else if (c === 'themesel') { store.set('theme', el.value); applyTheme(); } else if (c === 'langsel') ACT.lang({ dataset: { v: el.value } });
});
window.onBackKey = () => { if ($('upd').classList.contains('on')) return true;  if ($('sheet').classList.contains('on')) { closeSheet(); return true; } if (S.me && S.tab !== 'home') { ACT.tab({ dataset: { v: 'home' } }); return true; } return false; };
window.showLock = showLock;
async function reloadMe() { const r = await api('GET', '/api/me'); if (r.ok) S.me = r.j; }

// ---------- tabs / data ----------
const ICON = {
  home: '<path d="M3 11l9-8 9 8M5 10v10h14V10"/>', ctl: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
  stats: '<path d="M4 20V10M10 20V4M16 20v-8M22 20H2"/>', auto: '<rect x="3" y="5" width="18" height="16" rx="2"/><path d="M8 3v4M16 3v4M3 11h18"/>',
  set: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3M5 5l2 2M17 17l2 2M19 5l-2 2M7 17l-2 2"/>'
};
function renderTabs() {
  $('bell').style.display = ''; $('title').textContent = S.me && S.hid ? home().name : 'Mango Monitor';
  $('tabs').innerHTML = ['home', 'ctl', 'stats', 'auto', 'set'].map(k => `<button class="${S.tab === k ? 'on' : ''}" data-a="tab" data-v="${k}"><svg viewBox="0 0 24 24">${ICON[k]}</svg>${t('tab_' + k)}</button>`).join('');
}
async function load() {
  if (S.did === 'all') { S.ov = (await Promise.all(home().devices.map(d => api('GET', `/api/devices/${d.id}`)))).filter(r => r.ok).map(r => r.j); render(); return; }
  const r = await api('GET', `/api/devices/${S.did}`);
  if (r.ok) {
    S.dev = r.j;
    // one-time upgrade of v3.4 settings to the new compressor powers (25 kW = 4100 W ...)
    const mg = Core.migrateCfg(r.j.cfg); if (mg && myRole() !== 'view') { const pr = await api('PATCH', `/api/devices/${S.did}`, { cfg: mg }); if (pr.ok) { const r2 = await api('GET', `/api/devices/${S.did}`); if (r2.ok) S.dev = r2.j; } }
  }
  render(); loadSeries();
}
async function refresh() {
  if (!S.me || !S.hid || pinch) return;
  if (S.did === 'all') { S.ov = (await Promise.all(home().devices.map(d => api('GET', `/api/devices/${d.id}`)))).filter(r => r.ok).map(r => r.j); if (S.tab === 'home') render(); return; }
  const r = await api('GET', `/api/devices/${S.did}`); if (!r.ok) return; S.dev = r.j;
  const ae = document.activeElement; if (S.tab === 'home' || (S.tab === 'ctl' && !(ae && /INPUT|SELECT/.test(ae.tagName)))) render();
}
async function loadSeries() { if (S.did === 'all' || pinch) return; const r = await api('GET', `/api/devices/${S.did}/series?hours=${S.hrs}`); if (r.ok) { S.series = r.j; if (S.tab === 'home') render(); } }
// live points (every 10 s) are kept in memory and replace the coarse 5-minute points for the recent part of the charts
function pushLive() {
  const d = S.dev; if (!d || !d.derived) return; const v = d.derived, now = Date.now(), last = S.live[S.live.length - 1];
  if (last && now - last.ts < 4000) return;
  S.live.push({ ts: now, p: v.w, tc: v.tcur, tset: v.tset, tamb: v.tamb, tout: v.tout, tbuf: v.tbuf, hz: v.hz, cp: v.comp ? 1 : 0 });
  if (S.live.length > 2160) S.live.splice(0, S.live.length - 2160);
}
async function chartTick() { if (!S.me || S.did === 'all' || document.hidden || pinch) return; pushLive(); if (S.tab === 'home') await loadSeries(); }
// fast tick: only the live tiles are patched in place (no full re-render), so nothing jumps while the person is scrolling
const mval = (v, unit) => `${v}${v === '—' ? '' : `<span class="sm mut"> ${unit || ''}</span>`}`;
const copNow = d => d.derived.q != null && d.derived.w > 200 ? d.derived.q * 1000 / d.derived.w : null;
function patchLive() {
  const d = S.dev; if (!d || !d.derived) return; const v = d.derived, set = (id, html) => { const e = $(id); if (e) e.innerHTML = html; };
  const dt = v.tout != null && v.tin != null ? v.tout - v.tin : null;
  set('lv_heat', mval(nf(v.q, 2), 'kW')); set('lv_cop', mval(nf(copNow(d), 2), '')); set('lv_pw', mval(nf(v.w / 1000, 2), 'kW')); set('lv_a', mval(nf(v.a, 1), 'A')); set('lv_dt', mval(nf(dt, 1), '°'));
}
async function fastTick() {
  if (!S.me || S.did === 'all' || S.tab !== 'home' || document.hidden || S.fastBusy || pinch) return; S.fastBusy = true;
  try { const r = await api('GET', `/api/devices/${S.did}`); if (r.ok) { S.dev = r.j; patchLive(); } } finally { S.fastBusy = false; }
}
async function loadStats() { if (S.did === 'all') return; S.stats = null; render(); const r = await api('GET', `/api/devices/${S.did}/stats?period=${S.period}${S.period === 'day' && S.shift ? '&shift=' + S.shift : ''}`); if (r.ok) { S.stats = r.j; render(); } }
async function loadAuto() { if (S.did === 'all') return; const r = await api('GET', `/api/devices/${S.did}/auto`); if (r.ok) { const a = r.j; a.schedule = Object.assign({ enabled: false, outside: 'off', slots: [] }, a.schedule); a.weather = Object.assign({ enabled: false, source: 'device', below: -3, rules: [] }, a.weather); a.offTimer = Object.assign({ enabled: false, mode: 'after', hours: 6, at: '06:00' }, a.offTimer); S.auto = a; render(); } }
async function cmd(code, value) {
  if (myRole() === 'view') return toast(t('forbidden'));
  if (code === 'switch' && store.get('protect') === '1' && !(await authenticate(t('c_power')))) return;
  const r = await api('POST', `/api/devices/${S.did}/command`, { code, value }); toast(r.ok ? t('sent') : errMsg(r)); setTimeout(refresh, 1500);
}
// every card of the Settings tab becomes a collapsed section (title = summary); open/closed state is remembered
function foldCards(root) {
  [...root.children].forEach(c => {
    if (!c.classList.contains('card')) return; const h3 = c.firstElementChild; if (!h3 || h3.tagName !== 'H3') return;
    const key = h3.textContent.trim(), det = document.createElement('details'), sum = document.createElement('summary');
    sum.style.fontWeight = '600'; sum.textContent = key; det.appendChild(sum); h3.remove();
    while (c.firstChild) det.appendChild(c.firstChild);
    det.open = !!S.fo[key]; det.addEventListener('toggle', () => { S.fo[key] = det.open; }); c.appendChild(det);
  });
}
function render() {
  if (!S.me) return; $('title').textContent = home().name; let h = '';
  const devs = home().devices;
  if (devs.length > 1 && S.tab !== 'set') h += `<div class="dev-chips"><span class="chip ${S.did === 'all' ? 'on' : ''}" data-a="dev" data-v="all">${t('all')}</span>${devs.map(d => `<span class="chip ${S.did === d.id ? 'on' : ''}" data-a="dev" data-v="${d.id}">${esc(d.name)}</span>`).join('')}</div>`;
  const need = S.did === 'all' && ['ctl', 'stats', 'auto'].includes(S.tab);
  if (need) h += `<div class="card mut">${t('all')} → ${t('tab_home')}</div>`;
  else h += ({ home: homeTab, ctl: ctlTab, stats: statsTab, auto: autoTab, set: setTab }[S.tab])();
  const sc = main.scrollTop; main.innerHTML = h; if (S.tab === 'set') foldCards(main); main.scrollTop = sc; chRestore();
}
const MODE_ICON = { heating: '🔥', heat: '🔥', cooling: '❄️', cool: '❄️', auto: '🅰️', hot_water: '🚿', dhw: '🚿', floor_heating: '♨️', eco: '🌿', boost: '⚡', turbo: '⚡', silent: '🤫', night: '🌙' };
const modeLabel = m => { const k = 'mode_' + String(m).toLowerCase(); const x = t(k); return (MODE_ICON[String(m).toLowerCase()] ? MODE_ICON[String(m).toLowerCase()] + ' ' : '') + (x === k ? String(m).replace(/_/g, ' ') : x); };
const chip = (txt, cls) => `<span class="chip ${cls || ''}">${txt}</span>`;
function metric(label, val, unit, est, id) { return `<div class="m"><small>${label}${est ? ' · ' + t('est') : ''}</small><b${id ? ` id="${id}"` : ''}>${val}${val === '—' ? '' : `<span class="sm mut"> ${unit || ''}</span>`}</b></div>`; }

const durFmt = m => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;
// cost / energy of the pump session since it was last switched on (or the one that just ended)
function sessionCard(d) {
  const ls = d.lastSession;
  if (!ls) return `<div class="card" style="margin-top:10px"><h3>${t('ses_title')}</h3><div class="mut sm">${t('ses_none')}</div></div>`;
  return `<div class="card" style="margin-top:10px"><h3>${t('ses_title')}</h3><div class="row" style="margin-bottom:8px">${chip(ls.running ? t('ses_running') : t('ses_ended'), ls.running ? 'ok' : '')}<span class="sm mut">${ls.approx ? '~' : ''}${fmtT(ls.s, true)}${ls.e ? ' → ' + fmtT(ls.e, true) : ''}</span></div>
  <div class="grid3">${metric('kWh', nf(ls.kwh, 2), '')}${metric(t('cost'), ls.cost.toLocaleString(), "so'm")}${metric(t('ses_dur'), durFmt(ls.dur_min), '')}</div>
  <div class="sm mut" style="margin-top:6px">${t('ses_comp')}: ${ls.comp_min} ${t('s_min')} · <a href="#" data-a="gosessions" style="color:var(--acc)">${t('s_sessions')} →</a></div></div>`;
}
// ---------- main screen layout: show/hide (filter) and reorder blocks and tiles ----------
const HOME_BLOCKS = [['status', 'hb_status'], ['tiles1', 'hb_tiles1', ['m_tout', 'm_tbuf', 'm_hz']], ['metrics', 'hb_metrics', ['pw', 'cur', 'volt', 'cos', 'cop', 'copd', 'dt', 'flow', 'heat']], ['session', 'hb_session'],
  ['today', 'hb_today', ['kwh', 'cost', 'comph', 'starts', 'defn', 'deflast', 'costnow', 'tariff']], ['range', 'hb_range'], ['ch_temp', 'ch_temp'], ['ch_power', 'ch_power'], ['ch_hz', 'ch_hz']];
const TILE_LBL = { m_tout: 'm_tout', m_tbuf: 'm_tbuf', m_hz: 'm_hz', pw: 'm_power', cur: 'm_current', volt: 'm_voltage', cos: 'm_cos', cop: 'm_cop', copd: 'm_cop_day', dt: 'm_dt', flow: 'm_flow', heat: 'm_heat', kwh: null, cost: 'cost', comph: 'comp_h', starts: 'starts', defn: 'defr_n', deflast: 'defr_last', costnow: 'cost_now', tariff: 'tariff' };
function homeLayout() {
  let L = {}; try { L = JSON.parse(store.get('homeLayout') || '{}') || {}; } catch (e) { L = {}; }
  const order = (L.o || []).filter(id => HOME_BLOCKS.some(b => b[0] === id)); HOME_BLOCKS.forEach(b => { if (!order.includes(b[0])) order.push(b[0]); });
  const tiles = {}; HOME_BLOCKS.forEach(b => { if (b[2]) { const o = ((L.t || {})[b[0]] || []).filter(x => b[2].includes(x)); b[2].forEach(x => { if (!o.includes(x)) o.push(x); }); tiles[b[0]] = o; } });
  return { order, tiles, hidden: new Set(L.h || []) };
}
function saveLayout(l) { store.set('homeLayout', JSON.stringify({ o: l.order, t: l.tiles, h: [...l.hidden] })); }
function layoutSheet() {
  const L = homeLayout(), tl = id => TILE_LBL[id] ? t(TILE_LBL[id]) : 'kWh';
  return `<h3>${t('hl_title')}</h3><p class="mut sm">${t('hl_hint')}</p>` + L.order.map((id, i) => { const b = HOME_BLOCKS.find(x => x[0] === id), n = b[2] ? L.tiles[id].filter(x => !L.hidden.has(x)).length : 0;
    return `<div class="card" style="padding:8px 10px"><div class="row">${sw('hl_vis', !L.hidden.has(id), `data-id="${id}"`)}<b class="sp">${t(b[1])}</b><button class="btn sec sm" data-a="hl_move" data-id="${id}" data-d="-1" ${i === 0 ? 'disabled' : ''}>▲</button><button class="btn sec sm" data-a="hl_move" data-id="${id}" data-d="1" ${i === L.order.length - 1 ? 'disabled' : ''}>▼</button></div>`
      + (b[2] ? `<details style="margin-top:6px" ${(S.hlOpen || {})[id] ? 'open' : ''} ontoggle="S.hlOpen=S.hlOpen||{};S.hlOpen['${id}']=this.open"><summary class="mut sm">${t('hl_tiles')} (${n}/${b[2].length})</summary>` + L.tiles[id].map((x, j, arr) => `<div class="row" style="margin:6px 0">${sw('hl_tvis', !L.hidden.has(x), `data-id="${x}"`)}<span class="sp sm">${tl(x)}</span><button class="btn sec sm" data-a="hl_tmove" data-b="${id}" data-id="${x}" data-d="-1" ${j === 0 ? 'disabled' : ''}>▲</button><button class="btn sec sm" data-a="hl_tmove" data-b="${id}" data-id="${x}" data-d="1" ${j === arr.length - 1 ? 'disabled' : ''}>▼</button></div>`).join('') + `</details>` : '') + `</div>`; }).join('')
    + `<div class="row"><button class="btn sec sp" data-a="hl_reset">${t('hl_reset')}</button><button class="btn sp" onclick="closeSheet()">${t('hl_done')}</button></div>`;
}
function reopenLayout() { const sh = $('sheet'), y = sh.scrollTop, y2 = $('sheetc').scrollTop; openSheet(layoutSheet()); sh.scrollTop = y; $('sheetc').scrollTop = y2; render(); }
// warning card: background monitoring blocked by the phone (battery saver / auto-start) or interrupted recently
function bgBanner() {
  if (!NATIVE || !Android.bgStatus) return ''; let b; try { b = JSON.parse(Android.bgStatus()); } catch (e) { return ''; }
  const gapRecent = b.gap > 180000 && b.gapAt && Date.now() - b.gapAt < 24 * 3600e3 && store.get('bgSeen') !== String(b.gapAt);
  if (b.battery && b.notif && !gapRecent) return '';
  const lines = [];
  if (!b.battery) lines.push(t('bg_batt'));
  if (!b.notif) lines.push(t('bg_notif'));
  if (gapRecent) lines.push(t('bg_gap', { m: Math.round(b.gap / 60000), t: fmtT(b.gapAt - b.gap, true) }));
  return `<div class="card" style="border:1px solid var(--warn)"><b>⚠ ${t('bg_title')}</b><div class="sm" style="margin:6px 0">${lines.join('<br>')}</div><div class="sm mut">${t('bg_hint')}</div>
  <div class="row" style="margin-top:8px">${b.battery ? '' : `<button class="btn sm sp" data-a="bgallow">${t('bg_allow')}</button>`}<button class="btn sec sm sp" data-a="bgauto">${t('bg_autostart')}</button>${gapRecent && b.battery ? `<button class="btn sec sm sp" data-a="bgseen" data-v="${b.gapAt}">${t('bg_ok')}</button>` : ''}</div></div>`;
}
function homeTab() {
  if (S.did === 'all') {
    if (!S.ov.length) return `<div class="card">${t('loading')}</div>`;
    const kw = S.ov.reduce((s, d) => s + d.derived.w, 0) / 1000, kwh = S.ov.reduce((s, d) => s + d.today.kwh, 0), price = S.ov[0].price || 0;
    return `<div class="grid"><div class="card"><small class="mut">${t('total_now')}</small><div class="big">${nf(kw, 2)}<span class="sm mut"> kW</span></div></div><div class="card"><small class="mut">${t('total_day')}</small><div class="big">${nf(kwh, 1)}<span class="sm mut"> kWh</span></div><div class="mut sm">${S.ov.reduce((x, d) => x + (d.today.cost != null ? d.today.cost : Math.round(d.today.kwh * price)), 0).toLocaleString()} so'm</div></div></div>` +
      S.ov.map(d => `<div class="card" data-a="dev" data-v="${d.id}"><div class="row"><b class="sp">${esc(d.name)}</b>${chip(d.online ? t('online') : t('offline'), d.online ? 'ok' : 'bad')}${chip(d.derived.on ? t('status_on') : t('status_off'), d.derived.on ? 'on' : '')}</div><div class="row" style="margin-top:6px"><span class="big" style="font-size:30px">${nf(d.derived.tcur)}°</span><span class="mut">→ ${nf(d.derived.tset)}°</span><span class="sp"></span><b>${nf(d.derived.w / 1000, 2)} kW</b></div></div>`).join('');
  }
  const d = S.dev; if (!d) return `<div class="card">${t('loading')}</div>`;
  const v = d.derived, val = d.values, price = d.price || 0, cop = v.q != null && v.w > 200 ? v.q * 1000 / v.w : null;
  const dt = v.tout != null && v.tin != null ? v.tout - v.tin : null;
  const costNow = Math.round(v.w / 1000 * price);
  const tile = (lbl, val2, unit) => metric(lbl, val2 == null ? '' : val2, unit);
  const T = { // every tile of the main screen (id -> html)
    m_tout: () => tile(t('m_tout'), v.tout != null ? nf(v.tout, 1) : null, 'C'), m_tbuf: () => tile(t('m_tbuf'), v.tbuf != null ? nf(v.tbuf, 1) : null, 'C'), m_hz: () => tile(t('m_hz'), v.hz != null ? nf(v.hz, 0) : null, 'Hz'),
    pw: () => metric(t('m_power'), nf(v.w / 1000, 2), 'kW', !v.real, 'lv_pw'), cur: () => metric(t('m_current'), nf(v.a, 1), 'A', !v.aReal, 'lv_a'), volt: () => metric(t('m_voltage'), nf(v.v, 0), 'V', !v.vReal),
    cos: () => metric(t('m_cos'), v.cos != null ? nf(v.cos, 2) : '', ''), cop: () => metric(t('m_cop'), nf(cop, 2), '', false, 'lv_cop'), copd: () => metric(t('m_cop_day'), nf(d.today.cop, 2), ''),
    dt: () => metric(t('m_dt'), nf(dt, 1), '', false, 'lv_dt'), flow: () => metric(t('m_flow'), v.flow ? nf(v.flow, 0) : '', 'L/min', v.flow && !v.flowReal), heat: () => metric(t('m_heat'), nf(v.q, 2), 'kW', !v.flowReal, 'lv_heat'),
    kwh: () => metric('kWh', nf(d.today.kwh, 1), ''), cost: () => metric(t('cost'), (d.today.cost != null ? d.today.cost : Math.round(d.today.kwh * price)).toLocaleString(), "so'm"), comph: () => metric(t('comp_h'), nf(d.today.comp_h, 1), 'h'),
    starts: () => metric(t('starts'), d.today.starts, ''), defn: () => metric(t('defr_n'), d.today.defr, ''), deflast: () => metric(t('defr_last'), d.lastDefrost ? fmtT(d.lastDefrost.ts) : '', ''),
    costnow: () => metric(t('cost_now'), costNow.toLocaleString(), "so'm/h"), tariff: () => metric(t('tariff'), Math.round(price).toLocaleString(), "so'm/kWh") };
  const L = homeLayout(), grid = id => { const ts = L.tiles[id].filter(x => !L.hidden.has(x)); return ts.length ? `<div class="grid3" style="margin-bottom:10px">${ts.map(x => T[x]()).join('')}</div>` : ''; };
  let s = S.series || []; if (S.live.length) { const t0 = S.live[0].ts; s = s.filter(r => r.ts < t0).concat(S.live); }
  const long = S.hrs > 24, hasHz = s.some(r => r.hz != null), hasBuf = s.some(r => r.tbuf != null), hasOut = s.some(r => r.tout != null);
  const band = []; { let st0 = null; s.forEach(r => { if (r.cp) { if (st0 == null) st0 = r.ts; } else if (st0 != null) { band.push([st0, r.ts]); st0 = null; } }); if (st0 != null && s.length) band.push([st0, s[s.length - 1].ts]); }
  const B = {
    status: () => `<div class="card"><div class="row">${chip(d.online ? t('online') : t('offline'), d.online ? 'ok' : 'bad')}${chip(v.on ? t('status_on') : t('status_off'), v.on ? 'on' : '')}${v.comp ? chip(t('comp'), 'ok') : ''}${val.pump_state ? chip(t('pump'), 'ok') : ''}${v.defrost ? chip(t('defrost'), 'warn') : ''}${val.ele_heating_state ? chip(t('heater'), 'warn') : ''}${v.mode != null ? chip(modeLabel(v.mode)) : ''}<span class="sp"></span><span class="mut sm">${d.age != null ? t('ago', { n: d.age }) : ''}</span></div>
  <div class="row" style="margin-top:10px;align-items:flex-end"><div><small class="mut">${t('water')}</small><div class="big">${nf(v.tcur)}°</div></div><div style="padding-bottom:4px"><small class="mut">${t('target')}</small><div style="font-size:24px;font-weight:600">${nf(v.tset)}°</div></div><div class="sp"></div><div style="text-align:right;padding-bottom:4px"><small class="mut">${t('outdoor')}</small><div style="font-size:24px;font-weight:600">${nf(v.tamb)}°</div></div></div></div>`,
    tiles1: () => grid('tiles1'),
    metrics: () => grid('metrics') + `<div class="sm mut" style="margin:0 2px 8px">${t('src_' + (v.src || 'model'))}</div>`,
    session: () => sessionCard(d),
    today: () => { const g = grid('today'); return g ? `<div class="card" style="margin-top:10px"><h3>${t('today')}</h3>${g}</div>` : ''; },
    range: () => `<div class="seg">${[[24, 'h24'], [168, 'd7r'], [336, 'd14']].map(([k, l]) => `<button class="${S.hrs === k ? 'on' : ''}" data-a="hrs" data-v="${k}">${t(l)}</button>`).join('')}</div>`,
    ch_temp: () => `<div class="card"><h3>${t('ch_temp')}</h3>${lineChart([
    { name: t('water'), unit: '°', pts: s.map(r => [r.ts, r.tc]), color: 'var(--c1)' },
    { name: t('target'), unit: '°', pts: s.map(r => [r.ts, r.tset]), color: 'var(--c3)', dash: 1 },
    { name: t('outdoor'), unit: '°', pts: s.map(r => [r.ts, r.tamb]), color: 'var(--c2)' }]
    .concat(hasOut ? [{ name: t('m_tout'), unit: '°', pts: s.map(r => [r.ts, r.tout]), color: '#ff5d5d' }] : [])
    .concat(hasBuf ? [{ name: t('m_tbuf'), unit: '°', pts: s.map(r => [r.ts, r.tbuf]), color: '#3ecf8e' }] : []), { long, id: 'temp', d: 1 })}
  <div class="row sm mut"><span style="color:var(--c1)">● ${t('water')}</span><span style="color:var(--c3)">● ${t('target')}</span><span style="color:var(--c2)">● ${t('outdoor')}</span>${hasOut ? `<span style="color:#ff5d5d">● ${t('m_tout')}</span>` : ''}${hasBuf ? `<span style="color:#3ecf8e">● ${t('m_tbuf')}</span>` : ''}</div></div>`,
    ch_power: () => `<div class="card"><h3>${t('ch_power')}</h3>${lineChart([{ name: 'kW', unit: ' kW', d: 2, pts: s.map(r => [r.ts, r.p == null ? null : r.p / 1000]), color: 'var(--c1)' }], { long, d: 1, id: 'pwr', zero: true, band })}
  <div class="row sm mut"><span style="color:var(--c1)">● kW</span><span style="color:var(--ok)">▮ ${t('comp')}</span><span class="sp"></span><a href="#" data-a="tab" data-v="stats" style="color:var(--acc)">${t('s_detail')} →</a></div></div>`,
    ch_hz: () => hasHz ? `<div class="card"><h3>${t('ch_hz')}</h3>${lineChart([{ name: 'Hz', unit: ' Hz', d: 0, pts: s.map(r => [r.ts, r.cp ? r.hz : null]), color: 'var(--c3)' }], { long, id: 'hz', zero: true })}</div>` : '' };
  return bgBanner() + `<div class="row" style="margin-bottom:8px"><span class="sp"></span><button class="btn sec sm" data-a="hlayout">⚙ ${t('hl_btn')}</button></div>` + L.order.filter(id => !L.hidden.has(id)).map(id => B[id]()).join('');
}
function ctlTab() {
  const d = S.dev; if (!d) return `<div class="card">${t('loading')}</div>`; const v = d.derived, sp = d.spec.temp_set || {}, sc = Math.pow(10, sp.scale || 0), ro = myRole() === 'view';
  let h = ro ? `<div class="card mut">${t('c_view')}</div>` : '';
  if (d.hold) h += `<div class="card sm mut">${t('c_hold', { n: Math.max(1, Math.round((d.hold - Date.now()) / 60000)) })}</div>`;
  h += `<div class="card"><h3>${t('c_power')}</h3><div class="pwr ${v.on ? 'on' : ''}" ${ro ? '' : 'data-a="power"'}>${v.on ? t('status_on') : t('status_off')}</div></div>
  <div class="card"><h3>${t('c_set')}</h3><div class="row"><button class="btn sec" data-a="stepT" data-v="-0.5" ${ro ? 'disabled' : ''}>−</button><input id="tset" type="number" step="0.5" min="${sp.min != null ? sp.min / sc : 20}" max="${sp.max != null ? sp.max / sc : 75}" value="${v.tset != null ? v.tset : ''}" style="text-align:center;font-size:24px" ${ro ? 'disabled' : ''}><button class="btn sec" data-a="stepT" data-v="0.5" ${ro ? 'disabled' : ''}>+</button></div><p><button class="btn" style="width:100%" data-a="setT" ${ro ? 'disabled' : ''}>${t('c_apply')}</button></p></div>`;
  const mc = v.modeCode, ms = mc && (d.spec[mc] || { type: 'Enum', range: [] });
  const others = Object.keys(d.spec).filter(c => d.spec[c].writable !== false && !['switch', 'temp_set', mc, v.termCode].includes(c) && ['Boolean', 'Enum', 'Integer'].includes(d.spec[c].type));
  if (others.length) h += `<div class="card"><h3>${t('c_other')}</h3>` + others.map(c => {
    const s = d.spec[c], cur = d.values[c], lbl = `<span class="sp">${esc(s.name || c)} <small class="mut">${esc(c)}</small></span>`;
    if (s.type === 'Boolean') return `<div class="row" style="margin:8px 0">${lbl}${sw('dpbool', cur === true, `data-code="${esc(c)}" ${ro ? 'disabled' : ''}`)}</div>`;
    if (s.type === 'Enum') return `<div class="row" style="margin:8px 0">${lbl}<select style="width:46%" data-c="dpenum" data-code="${esc(c)}" ${ro ? 'disabled' : ''}>${(s.range || []).map(o => `<option ${o === cur ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select></div>`;
    const sc2 = Math.pow(10, s.scale || 0); return `<div class="row" style="margin:8px 0">${lbl}<input type="number" style="width:30%" data-dp="${esc(c)}" value="${cur != null ? cur : ''}" step="${(s.step || 1) / sc2}" ${ro ? 'disabled' : ''}><button class="btn sm" data-a="applyDP" data-code="${esc(c)}" ${ro ? 'disabled' : ''}>OK</button></div>`;
  }).join('') + '</div>';
  return h;
}
function statsTab() {
  const st = S.stats, seg = `<div class="seg">${['day', 'week', 'month', 'year'].map(p => `<button class="${S.period === p ? 'on' : ''}" data-a="period" data-v="${p}">${t('s_' + p)}</button>`).join('')}</div>`;
  const dayLbl = S.shift === 0 ? t('s_today') : S.shift === 1 ? t('s_yesterday') : fmtD(Date.now() - S.shift * 864e5);
  const navH = S.period === 'day' ? `<div class="row" style="margin-bottom:10px"><button class="btn sec sm" data-a="shift" data-v="1">‹</button><b class="sp" style="text-align:center">${dayLbl}</b><button class="btn sec sm" data-a="shift" data-v="-1" ${S.shift === 0 ? 'disabled' : ''}>›</button></div>` : '';
  if (!st) return seg + navH + `<div class="card">${t('loading')}</div>`;
  const mon = k => { try { return new Date(2020, +k.slice(5, 7) - 1, 1).toLocaleDateString(LOCALE[LANG] || 'uz', { month: 'short' }); } catch (e) { return k.slice(5, 7); } };
  const lab = st.period === 'day' ? k => k.slice(11, 13) : st.period === 'year' ? mon : k => k.slice(8, 10);
  const T = st.total, P = st.prev, dl = P.kwh > 0 ? (T.kwh - P.kwh) / P.kwh * 100 : null;
  // histogram: tap a bar -> that bar's own details
  const bk = S.barKey || 'kwh', BK = { kwh: [t('bar_kwh'), x => nf(x, 1)], cost: [t('bar_cost'), x => Math.round(x).toLocaleString()], comp_h: [t('bar_comp'), x => nf(x, 1)] };
  const barSeg = `<div class="seg" style="margin:0 0 8px">${[['kwh', 'kWh'], ['cost', t('cost')], ['comp_h', t('comp_h')]].map(([k, l]) => `<button class="${bk === k ? 'on' : ''}" data-a="barkey" data-v="${k}">${l}</button>`).join('')}</div>`;
  const full = b => st.period === 'day' ? `${lab(b.k)}:00 – ${String((+lab(b.k) + 1) % 24).padStart(2, '0')}:00` : st.period === 'year' ? mon(b.k) + ' ' + b.k.slice(0, 4) : b.k.slice(8, 10) + '.' + b.k.slice(5, 7);
  const sel = S.barSel != null && st.buckets[S.barSel] ? st.buckets[S.barSel] : null;
  const info = sel ? `<b>${full(sel)}</b><div class="grid3" style="margin-top:6px">${metric('kWh', nf(sel.kwh, 2), '')}${metric(t('cost'), sel.cost.toLocaleString(), "so'm")}${metric(t('comp_h'), Math.round(sel.comp_h * 60), t('s_min'))}${metric(t('m_hz_avg'), nf(sel.hz, 0), 'Hz')}${metric(t('outdoor'), nf(sel.tout, 1), '°')}${metric('COP', nf(sel.cop, 2), '')}${metric(t('starts'), sel.starts, '')}${metric(t('defr_n'), sel.defr, '')}</div>` : t('bar_tap');
  let h = seg + navH + `<div class="card"><h3>${BK[bk][0]}</h3>${barSeg}${barChart(st.buckets, bk, lab, BK[bk][1])}<div class="sm mut chrd" id="bar_rd">${info}</div></div>
  <div class="grid3">${metric('kWh', nf(T.kwh, 1), '')}${metric(t('cost'), T.cost.toLocaleString(), "so'm")}${metric('COP', nf(T.cop, 2), '')}${metric(t('comp_h'), nf(T.comp_h, 1), 'h')}${metric(t('starts'), T.starts, '')}${metric(t('defr_n'), T.defr, '')}${metric(t('m_hz_avg'), nf(T.hz, 0), 'Hz')}</div>
  <div class="card" style="margin-top:10px"><h3>${t('s_vs')}</h3><div class="row"><span class="sp">${t('s_prev')}: <b>${nf(P.kwh, 1)} kWh</b></span>${dl != null ? chip((dl > 0 ? '+' : '') + nf(dl, 0) + '%', dl > 5 ? 'bad' : dl < -5 ? 'ok' : '') : ''}</div><div class="mut sm">${t('s_avg_out')}: ${nf(T.tout)}° ${P.tout != null ? '(' + nf(P.tout) + '°)' : ''}</div></div>`;
  if (st.forecast) h += `<div class="card"><h3>${t('s_forecast')}</h3><div class="big">${nf(st.forecast.kwh, 0)}<span class="sm mut"> kWh</span></div><div class="mut">≈ ${st.forecast.cost.toLocaleString()} so'm · ${nf(st.forecast.per_day, 1)} kWh ${t('s_perday')}</div></div>`;
  // detailed table: every hour / every pump session / days (months)
  { const R = st.recent || [], sd = x => new Date(x).toDateString();
    const rows = R.map((x, i) => `<tr${i === 0 ? ' style="font-weight:600"' : ''}><td>${i === 0 ? chip(t('ses_last'), 'ok') + ' ' : ''}${x.approx ? '~' : ''}${fmtT(x.s, true)}</td><td>${x.running ? chip(t('ses_running'), 'ok') : fmtT(x.e, sd(x.s) !== sd(x.e))}</td><td>${durFmt(x.dur_min)}</td><td>${nf(x.kwh, 2)}</td><td>${x.cost.toLocaleString()}</td><td>${x.comp_min}</td></tr>`).join('');
    h += `<div class="card"><h3>${t('ses_recent')}</h3>` + (rows ? `<div style="overflow-x:auto"><table class="kv dt"><tr class="mut"><td>${t('ses_start')}</td><td>${t('ses_end')}</td><td>${t('ses_dur')}</td><td>kWh</td><td>so'm</td><td>${t('s_min')}</td></tr>${rows}</table></div><div class="mut sm" style="margin-top:6px">${t('s_ses_hint')}${R.some(x => x.approx) ? ' ' + t('ses_approx') : ''}</div>` : `<div class="mut sm">${t('s_ses_none')}</div>`) + `</div>`; }
  { const hasH = !!st.hours; let dv = S.dv || 'hour'; if (dv === 'ses') dv = 'hour'; if (dv === 'hour' && !hasH) dv = 'bucket'; if (dv === 'bucket' && st.period === 'day') dv = 'hour';
    const views = (hasH ? [['hour', t('s_hours')]] : []).concat(st.period === 'day' ? [] : [['bucket', st.period === 'year' ? t('s_months') : t('s_days')]]);
    const vs = `<div class="seg">${views.map(([k, l]) => `<button class="${dv === k ? 'on' : ''}" data-a="dview" data-v="${k}">${l}</button>`).join('')}</div>`;
    const th = 'position:sticky;top:0;background:var(--card)', wrap = x => `<div style="max-height:380px;overflow:auto">${x}</div>`;
    let body;
    if (dv === 'hour') {
      const rows = (st.hours || []).filter(r => r.kwh > 0 || r.comp_min > 0).reverse().map(r => `<tr><td>${st.period === 'day' ? fmtT(r.ts) : fmtT(r.ts, true)}</td><td>${nf(r.kwh, 2)}</td><td>${r.cost.toLocaleString()}</td><td>${r.comp_min}</td><td>${r.hz != null ? nf(r.hz, 0) : '—'}</td><td>${r.tout != null ? nf(r.tout, 0) + '°' : '—'}</td></tr>`).join('');
      body = rows ? wrap(`<table class="kv dt"><tr class="mut"><td style="${th}">${t('s_hour')}</td><td style="${th}">kWh</td><td style="${th}">so'm</td><td style="${th}">${t('s_min')}</td><td style="${th}">Hz</td><td style="${th}">${t('outdoor')}</td></tr>${rows}</table>`) : `<div class="mut sm">${t('no_data')}</div>`;
    } else if (dv === 'ses') {
      const L = st.sessions || [], sd = x => new Date(x).toDateString();
      const rows = L.map(x => `<tr><td>${fmtT(x.s, true)}</td><td>${x.running ? chip(t('ses_running'), 'ok') : fmtT(x.e, sd(x.s) !== sd(x.e))}</td><td>${durFmt(x.dur_min)}</td><td>${nf(x.kwh, 2)}</td><td>${x.cost.toLocaleString()}</td><td>${x.comp_min}</td></tr>`).join('');
      const tk = L.reduce((a, x) => a + x.kwh, 0), tc = L.reduce((a, x) => a + x.cost, 0);
      body = rows ? wrap(`<table class="kv dt"><tr class="mut"><td style="${th}">${t('ses_start')}</td><td style="${th}">${t('ses_end')}</td><td style="${th}">${t('ses_dur')}</td><td style="${th}">kWh</td><td style="${th}">so'm</td><td style="${th}">${t('s_min')}</td></tr>${rows}<tr><td colspan="3"><b>${t('s_total')}</b></td><td><b>${nf(tk, 2)}</b></td><td><b>${tc.toLocaleString()}</b></td><td></td></tr></table>`) + `<div class="mut sm" style="margin-top:6px">${t('s_ses_hint')}</div>` : `<div class="mut sm">${t('s_ses_none')}</div>`;
    } else {
      const rows = st.buckets.filter(b => b.kwh > 0 || b.comp_h > 0).map(b => `<tr><td>${st.period === 'day' ? lab(b.k) + ':00' : lab(b.k)}</td><td>${nf(b.kwh, 2)}</td><td>${b.cost.toLocaleString()}</td><td>${Math.round(b.comp_h * 60)}</td><td>${b.hz != null ? nf(b.hz, 0) : '—'}</td><td>${b.tout != null ? nf(b.tout, 0) + '°' : '—'}</td></tr>`).join('');
      body = rows ? wrap(`<table class="kv dt"><tr class="mut"><td style="${th}">${t('s_date')}</td><td style="${th}">kWh</td><td style="${th}">so'm</td><td style="${th}">${t('s_min')}</td><td style="${th}">Hz</td><td style="${th}">${t('outdoor')}</td></tr>${rows}</table>`) : `<div class="mut sm">${t('no_data')}</div>`;
    }
    h += `<div class="card"><h3>${t('s_detail')}</h3>${vs}${body}</div>`; }
  h += `<div class="card"><h3>${t('s_corr')}</h3>${st.corr.pairs.length >= 5 ? scatter(st.corr.pairs, st.corr.fit) + (st.corr.fit && st.corr.fit.slope < 0 ? `<div class="sm">${t('s_corr_txt', { x: nf(-st.corr.fit.slope, 1) })}</div>` : '') : `<div class="mut sm">${t('s_corr_few')}</div>`}</div>`;
  return h;
}
function modeOpts(s, i, dis) {
  const d = S.dev, mc = d && d.derived && d.derived.modeCode, ms = mc && (d.spec[mc] || { type: 'Enum', range: ['heating', 'cooling', 'auto', 'hot_water'] }); if (!ms || ms.type !== 'Enum') return '';
  return `<div style="margin-top:6px"><small class="mut">${t('a_mode')}</small><select data-c="slot" data-i="${i}" data-k="mode" ${dis}><option value="">${t('a_mode_keep')}</option>${(ms.range || []).map(o => `<option value="${esc(o)}" ${s.mode === o ? 'selected' : ''}>${esc(modeLabel(o))}</option>`).join('')}</select></div>`;
}
function autoTab() {
  const a = S.auto; if (!a) return `<div class="card">${t('loading')}</div>`; const ro = myRole() === 'view', dis = ro ? 'disabled' : '';
  const fo = (key, title, on, inner) => `<div class="card"><details ${S.fo['a_' + key] ? 'open' : ''} ontoggle="S.fo['a_${key}']=this.open"><summary style="font-weight:600">${title}${on ? ' ' + chip(t('status_on'), 'ok') : ''}</summary>${inner}</details></div>`;
  const en = (c, v) => `<div class="row" style="margin:8px 0"><span class="sp">${t('a_enabled')}</span>${sw(c, v, dis)}</div>`;
  let slots = '';
  a.schedule.slots.forEach((s, i) => {
    slots += `<div class="slot"><div class="days">${[1, 2, 3, 4, 5, 6, 7].map(d => `<span class="chip ${s.days.includes(d) ? 'on' : ''}" data-a="dayslot" data-i="${i}" data-d="${d}">${t('d' + d)}</span>`).join('')}</div>
    <div class="grid3"><div><small class="mut">${t('a_from')}</small><input type="time" value="${esc(s.from)}" data-c="slot" data-i="${i}" data-k="from" ${dis}></div><div><small class="mut">${t('a_to')}</small><input type="time" value="${esc(s.to)}" data-c="slot" data-i="${i}" data-k="to" ${dis}></div><div><small class="mut">${t('a_sp')}</small><input type="number" step="0.5" value="${s.setpoint != null ? s.setpoint : ''}" data-c="slot" data-i="${i}" data-k="setpoint" ${dis}></div></div>${modeOpts(s, i, dis)}
    <div style="text-align:right;margin-top:6px"><button class="btn bad sm" data-a="rmslot" data-i="${i}" ${dis}>${t('delete')}</button></div></div>`;
  });
  const otf = k => `data-c="otf" data-k="${k}" ${dis}`, ot = a.offTimer || {};
  const eta = (() => { const ls = S.dev && S.dev.lastSession; if (!ot.enabled || !ls || !ls.running) return ''; let when; if (ot.mode === 'at') { const m = /^(\d{1,2}):(\d{2})$/.exec(ot.at || '06:00') || [0, 6, 0], x = new Date(ls.s); x.setHours(+m[1], +m[2], 0, 0); if (x.getTime() <= ls.s) x.setDate(x.getDate() + 1); when = x.getTime(); } else when = ls.s + (+ot.hours || 6) * 3600e3; return `<p class="sm">${t('a_ot_eta')}: <b>${fmtT(when, true)}</b></p>`; })();
  let h = fo('sched', t('a_sched'), a.schedule.enabled, `${en('sch', a.schedule.enabled)}<p class="mut sm">${t('a_sched_hint')}</p>
  <label class="f">${t('a_outside')}</label><select data-c="schout" ${dis}><option value="off" ${a.schedule.outside === 'off' ? 'selected' : ''}>${t('a_out_off')}</option><option value="keep" ${a.schedule.outside === 'keep' ? 'selected' : ''}>${t('a_out_keep')}</option></select><div style="margin-top:10px">${slots}<button class="btn sec" data-a="addslot" ${dis}>+ ${t('a_add_slot')}</button></div>`);
  h += fo('weather', t('a_weather'), a.weather.enabled, `${en('wea', a.weather.enabled)}<p class="mut sm">${t('a_hint')}</p>
  <label class="f">${t('a_below_now')}</label><input type="number" step="0.5" value="${a.weather.below != null ? a.weather.below : -3}" data-c="wbelow" ${dis}>
  <label class="f">${t('a_src')}</label><select data-c="weasrc" ${dis}><option value="device" ${a.weather.source === 'device' ? 'selected' : ''}>${t('a_src_dev')}</option><option value="forecast" ${a.weather.source === 'forecast' ? 'selected' : ''}>${t('a_src_fc')}</option></select>`);
  h += fo('ot', t('a_ot_title'), ot.enabled, `${en('oton', ot.enabled)}<p class="mut sm">${t('a_ot_hint')}</p>
  <label class="f">${t('a_ot_mode')}</label><select ${otf('mode')}><option value="after" ${ot.mode !== 'at' ? 'selected' : ''}>${t('a_ot_after')}</option><option value="at" ${ot.mode === 'at' ? 'selected' : ''}>${t('a_ot_at')}</option></select>
  ${ot.mode === 'at' ? `<label class="f">${t('a_ot_time')}</label><input type="time" value="${esc(ot.at || '06:00')}" ${otf('at')}>` : `<label class="f">${t('a_ot_hours')}</label><div class="row" style="margin:4px 0 8px">${[6, 12, 18, 24].map(hh => `<button class="btn ${+ot.hours === hh ? '' : 'sec'} sm sp" data-a="othours" data-v="${hh}" ${dis}>${hh}</button>`).join('')}</div><label class="f">${t('a_ot_custom')}</label><input type="number" step="0.5" min="0.1" value="${ot.hours != null ? ot.hours : 6}" ${otf('hours')}>`}
  ${eta}`);
  h += fo('hold', t('a_hold'), false, `<input type="number" value="${a.holdMin || 120}" data-c="hold" ${dis} style="margin-top:8px">`);
  return h + `<button class="btn" style="width:100%" data-a="saveauto" ${dis}>${t('save')}</button>`;
}
function setTab() {
  const h0 = home(), owner = h0.role === 'owner', me = S.me.user;
  const cityIdx = CITIES.findIndex(c => Math.abs(c[1] - (h0.lat || 0)) < .01);
  if (!S.tariff) S.tariff = JSON.parse(JSON.stringify(h0.tariff && h0.tariff.tiers ? { enabled: true, tiers: h0.tariff.tiers } : { enabled: false, tiers: Core.DEFAULT_TIERS }));
  if (owner && !S.geoTried && !geoSaved()) { S.geoTried = true; setTimeout(() => ACT.geo(null), 300); }
  let h = `${DIRECT() && store.get('tuyaMode') === 'sharing' ? `<div class="card"><h3>${t('st_tuya')}</h3><p class="sm">${t('sh_connected')}</p><button class="btn sec sm" data-a="shrelink">${t('sh_relink')}</button></div>` : DIRECT() ? `<div class="card"><h3>${t('st_tuya')}</h3><p class="mut sm">${t('st_direct_note')}</p><label class="f">${t('t_id')}</label><input id="t_id" autocapitalize="none" value="${esc(store.get('tuyaId') || '')}"><label class="f">${t('t_secret')}</label><input id="t_secret" type="password" placeholder="••••••••"><label class="f">${t('t_region')}</label><select id="t_region">${[['eu', 'Central Europe'], ['us', 'Western America'], ['in', 'India'], ['cn', 'China']].map(r => `<option value="${r[0]}" ${(store.get('tuyaRegion') || 'eu') === r[0] ? 'selected' : ''}>${r[1]}</option>`).join('')}</select><div class="err" id="werr"></div><button class="btn" data-a="savetuya">${t('save')}</button></div>` : `<div class="card"><h3>${t('st_acc')}</h3><div class="row"><b class="sp">${esc(me.name)} <small class="mut">${esc(me.login)}</small></b><button class="btn sec sm" data-a="logout">${t('logout')}</button></div></div>`}
  <div class="card"><h3>${t('st_lang')}</h3><label class="f">${t('lang')}</label><select data-c="langsel">${LANGS.map(l => `<option value="${l[0]}" ${LANG === l[0] ? 'selected' : ''}>${l[1]}</option>`).join('')}</select>
  <label class="f">${t('theme')}</label><select data-c="themesel">${['auto', 'dark', 'light'].map(x => `<option value="${x}" ${(store.get('theme') || 'auto') === x ? 'selected' : ''}>${t('theme_' + x)}</option>`).join('')}</select><label class="f">${t('accent')}</label><div class="row">${accents()}</div></div>
  <div class="card"><h3>${t('st_sec')}</h3>${NATIVE ? `<div class="row" style="margin:6px 0"><span class="sp">${t('st_lock')}</span>${sw('lock', store.get('lock') === '1')}</div>` : ''}<div class="row" style="margin:6px 0"><span class="sp">${t('st_protect')}</span>${sw('protect', store.get('protect') === '1')}</div>
  </div>
  ${NATIVE ? `<div class="card"><details ${S.notifOpen ? 'open' : ''} ontoggle="S.notifOpen=this.open"><summary style="font-weight:600">${t('st_notif_title')}</summary>
  <div class="row" style="margin:10px 0 2px"><span class="sp">${t('st_notif')}</span>${sw('notif', store.get('notif') !== '0')}</div><div class="mut sm">${t('st_notif_hint')}</div>
  <div class="row" style="margin:12px 0 2px"><span class="sp">${t('st_notif_alerts')}</span>${sw('alertnotif', store.get('alertNotif') !== '0')}</div><div class="mut sm">${t('st_notif_alerts_hint')}</div>
  <div style="margin-top:12px"><button class="btn sec sm" data-a="batt">${t('st_batt')}</button><div class="mut sm">${t('st_batt_hint')}</div></div></details></div>` : ''}
  <div class="card"><h3>${t('st_home')}</h3><label class="f">${t('h_name')}</label><input id="s_hname" value="${esc(h0.name)}" ${owner ? '' : 'disabled'}>
  <label class="f">${t('geo_label')}</label><div class="row"><span class="sp sm" id="geoLbl">${esc(geoSaved() || (h0.lat != null ? (cityIdx >= 0 ? CITIES[cityIdx][0] : h0.lat + ', ' + h0.lon) : '—'))}</span>${owner ? `<button class="btn sec sm" data-a="geo">${t('geo_btn')}</button>` : ''}</div>
  <details style="margin-top:6px"><summary class="mut sm">${t('geo_manual')}</summary><select id="s_city" ${owner ? '' : 'disabled'}><option value="">—</option>${CITIES.map((c, i) => `<option value="${i}" ${i === cityIdx ? 'selected' : ''}>${c[0]}</option>`).join('')}</select></details>
  <h3 style="margin-top:14px">${t('tar_title')}</h3>
  <div class="row" style="margin:6px 0"><span class="sp">${t('tar_tiered')}</span>${sw('tar_on', S.tariff.enabled, owner ? '' : 'disabled')}</div>
  ${S.tariff.enabled ? `<details ${S.tarOpen ? 'open' : ''} ontoggle="S.tarOpen=this.open" style="margin:4px 0 8px"><summary class="mut sm" style="padding:4px 0">${t('tar_show')} · ${S.tariff.tiers.length}</summary><p class="mut sm">${t('tar_hint')}</p>` + S.tariff.tiers.map((x, i) => `<div class="row" style="margin-bottom:6px"><span class="sm mut" style="min-width:52px">${i ? S.tariff.tiers[i - 1].upTo : 0} –</span><input type="number" inputmode="decimal" style="width:92px" value="${x.upTo}" data-c="tier" data-i="${i}" data-k="upTo" ${owner ? '' : 'disabled'}><span class="sm mut">kWh =</span><input type="number" inputmode="decimal" style="width:84px" value="${x.price}" data-c="tier" data-i="${i}" data-k="price" ${owner ? '' : 'disabled'}><span class="sm mut">${t('tar_price')}</span>${owner ? `<button class="btn bad sm" data-a="rmtier" data-i="${i}">×</button>` : ''}</div>`).join('') + (owner ? `<div class="row"><button class="btn sec sm" data-a="addtier">+ ${t('tar_add')}</button><button class="btn sec sm" data-a="tarreset">${t('tar_reset')}</button></div>` : '') + '</details>' : ''}
  <label class="f">${t('tar_flat')}</label><input id="s_price" type="number" value="${h0.price || 0}" ${owner ? '' : 'disabled'}>${owner ? `<p><button class="btn" data-a="savehome">${t('save')}</button></p>` : ''}</div>
  <div class="card"><h3>${t('st_devs')}</h3>${h0.devices.map(d => `<div class="row" style="margin:6px 0"><input data-nm="${d.id}" value="${esc(d.name)}" style="flex:1" ${owner ? '' : 'disabled'}>${owner ? `<button class="btn sec sm" data-a="renamedev" data-v="${d.id}">${t('save')}</button><button class="btn bad sm" data-a="rmdev" data-v="${d.id}">×</button>` : ''}</div>`).join('')}${owner ? `<button class="btn sec" data-a="adddev">+ ${t('st_add_dev')}</button>` : ''}</div>`;
  if (S.dev && S.did !== 'all') {
    const c = S.dev.cfg, f = (k, ph) => `<div><label class="f">${t('cfg_' + k)}</label><input data-cfg="${k}" value="${esc(c[k] != null ? c[k] : '')}" placeholder="${ph || ''}" ${owner ? '' : 'disabled'}></div>`;
    const cm = c.model != null ? String(c.model) : '';
    const sel = (k, opts) => `<div><label class="f">${t('cfg_' + k)}</label><select data-cfg="${k}" ${owner ? '' : 'disabled'}>${opts.map(([v, l]) => `<option value="${v}" ${String(c[k] || (k === 'powerSrc' ? 'auto' : '')) === v ? 'selected' : ''}>${l}</option>`).join('')}</select></div>`;
    h += `<div class="card"><h3>${t('st_cfg')} — ${esc(S.dev.name)}</h3>
    <label class="f">${t('st_model')}</label><select data-c="modelsel" data-cfg="model" ${owner ? '' : 'disabled'}><option value="">${t('model_other')}</option>${Object.keys(PRESETS).map(k => `<option value="${k}" ${cm === k ? 'selected' : ''}>${k} kW</option>`).join('')}</select>
    <label class="f">${t('cfg_kw')}</label><input data-cfg="kw" data-c="kwin" type="number" inputmode="decimal" step="0.5" value="${esc(c.kw != null ? c.kw : cm)}" placeholder="25" ${owner ? '' : 'disabled'}><p class="mut sm">${t('model_hint')}</p>
    <div class="grid">${[['compW'], ['ratedHz', '70'], ['pumpW'], ['fanW'], ['heatW'], ['idleW']].map(x => f(x[0], x[1])).join('')}${sel('powerSrc', [['auto', t('ps_auto')], ['hz', t('ps_hz')], ['current', t('ps_current')]])}</div>
    <details style="margin-top:12px"><summary class="mut">${t('st_adv')}</summary><div class="grid">${[['coef', '1'], ['powerCode'], ['powerMul', '1'], ['voltCode'], ['voltMul', '1'], ['currCode'], ['currMul', '1'], ['cosCode'], ['cosMul', '1'], ['voltage', '380'], ['phases', '3'], ['pf', '0.9'], ['flowLpm'], ['flowCode'], ['flowMul', '1'], ['tinCode', 'temp_in'], ['toutCode', 'temp_out'], ['tambCode', 'temp_outdoor'], ['tmax', '75'], ['hzCode', 'auto'], ['hzMul', '1'], ['hzExp', '1'], ['tbufCode', 'auto'], ['modeCode', 'mode']].map(x => f(x[0], x[1])).join('')}</div></details>
    <details style="margin-top:8px"><summary class="mut">${t('st_alert_cfg')}</summary><div class="grid">${[['offlineMin', '3'], ['lowDelta', '8'], ['lowMin', '90'], ['cycleN', '6'], ['defrostMin', '20'], ['freezeT', '2']].map(x => f(x[0], x[1])).join('')}</div></details>${owner ? `<p><button class="btn" data-a="savecfg">${t('save')}</button></p>` : ''}</div>
    <div class="card"><h3>${t('st_info')}</h3><table class="kv">${Object.entries(S.dev.values).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(typeof v === 'boolean' ? (v ? 'true' : 'false') : v)}</td></tr>`).join('')}</table></div>`;
  }
  h += `<div class="card"><div class="row"><span class="sp mut">${t('st_ver')} ${VERSION}</span><button class="btn bad sm" data-a="delacc">${t('st_reset')}</button></div>${NATIVE ? `<button class="btn sec sm" style="margin-top:10px" data-a="updmanual">${t('upd_check')}</button>` : ''}</div>`;
  return h;
}

// ---------- alerts ----------
async function checkAlerts() {
  if (!S.me) return; const r = await api('GET', `/api/alerts?lang=${LANG}`); if (!r.ok) return;
  const seen = +store.get('seenAlert') || 0; S.unseen = r.j.filter(a => a.id > seen).length; $('bellN').innerHTML = S.unseen ? `<span class="badge">${S.unseen}</span>` : '';
}
async function openAlerts() {
  openSheet(`<h3>${t('al_title')}</h3><div>${t('loading')}</div>`); const r = await api('GET', `/api/alerts?lang=${LANG}`); if (!r.ok) return;
  if (r.j.length) store.set('seenAlert', r.j[0].id); S.unseen = 0; $('bellN').innerHTML = '';
  openSheet(`<h3>${t('al_title')}</h3>` + (r.j.length ? r.j.map(a => `<div class="card"><div class="row">${chip(esc(a.device), a.level === 'crit' ? 'bad' : a.level === 'warn' ? 'warn' : '')}<span class="sp"></span><span class="sm mut">${fmtT(a.ts, true)}</span></div><b>${esc(a.title)}</b><div class="sm mut">${esc(a.body)}</div></div>`).join('') : `<p class="mut">${t('al_none')}</p>`) + `<button class="btn sec" style="width:100%" onclick="closeSheet()">${t('close')}</button>`);
}
boot();
