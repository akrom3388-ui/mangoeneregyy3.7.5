'use strict';
/* Standalone mode: the same "API" the UI expects, implemented in the app itself.
   Raw samples come from the native sampler (Kotlin, every ~30 s, even when the UI is closed);
   this engine turns them into kWh, COP, cycling, defrost, alerts, statistics and runs the automation. */
const LocalApi = (function () {
  const C = window.Core, LS = window.localStorage, P = 'mmL_';
  const rd = (k, d) => { try { const v = LS.getItem(P + k); return v ? JSON.parse(v) : d; } catch (e) { return d; } };
  const wr = (k, v) => { try { LS.setItem(P + k, JSON.stringify(v, (kk, vv) => (kk[0] === '_' ? undefined : vv))); } catch (e) { /* quota */ } };
  let DB = rd('db', null) || { home: null, devs: [], nid: 1, aid: 1, alerts: [] };
  // fill settings the person never typed with the built-in defaults, once (so a fresh install needs no re-entry)
  DB.devs.forEach(d => { if (!(d.cfg && d.cfg._dv)) d.cfg = C.withDefaults(d.cfg); const mg = C.migrateCfg(d.cfg); if (mg) d.cfg = mg; }); // v3.5: new compressor powers (25 kW = 4100 W ...)
  const H = {}, M = {}, EV = {}, SS = {};
  const hOf = id => H[id] || (H[id] = new Map(rd('h1_' + id, []).map(r => [r.ts, r])));
  const mOf = id => M[id] || (M[id] = new Map(rd('m5_' + id, []).map(r => [r.ts, r])));
  const eOf = id => EV[id] || (EV[id] = rd('ev_' + id, []));
  const sOf = id => SS[id] || (SS[id] = rd('ses_' + id, [])); // pump sessions: switch ON -> switch OFF
  const R = (j, status = 200) => ({ ok: status < 300, status, j });
  const dev = id => DB.devs.find(d => d.id === +id);
  const native = () => typeof Android !== 'undefined';
  const newAlerts = [];
  let ticking = false;

  function saveDb() { wr('db', DB); }
  function saveSeries(id) {
    wr('h1_' + id, [...hOf(id).values()]);
    const cut = Date.now() - 14 * 864e5; for (const k of [...mOf(id).keys()]) if (k < cut) mOf(id).delete(k);
    wr('m5_' + id, [...mOf(id).values()]); wr('ev_' + id, eOf(id).slice(-200));
    if (sOf(id).length > 300) sOf(id).splice(0, sOf(id).length - 300); wr('ses_' + id, sOf(id));
  }
  function syncNative() {
    if (!native()) return;
    const list = DB.devs.map(d => ({ id: d.id, tuya: d.tuya, name: d.name, cfg: d.cfg, auto: d.auto ? { offTimer: d.auto.offTimer || null, weather: d.auto.weather || null } : null, scales: Object.fromEntries(Object.entries(d.spec).map(([k, v]) => [k, v.scale || 0])) }));
    Android.set('dDevices', JSON.stringify(list));
    Android.set('dLoc', DB.home && DB.home.lat != null ? DB.home.lat + ',' + DB.home.lon : '');
  }
  const ci = (cfg, k, def) => (cfg[k] !== undefined && cfg[k] !== '' && !isNaN(+cfg[k]) ? +cfg[k] : def);
  function rawValue(spec, code, v) { const s = spec[code]; return s && s.type === 'Integer' && typeof v === 'number' ? Math.round(v * Math.pow(10, s.scale || 0)) : v; }

  function addAlert(d, kind, level, params, cd, ts) {
    const st = d.state; st.cd = st.cd || {};
    if (cd && st.cd[kind] && ts - st.cd[kind] < cd * 60000) return;
    st.cd[kind] = ts;
    const a = { id: DB.aid++, dev: d.id, kind, level, ts, params: Object.assign({ name: d.name }, params) };
    DB.alerts.push(a); if (DB.alerts.length > 300) DB.alerts.splice(0, DB.alerts.length - 300); newAlerts.push(a);
  }

  // ----- turn one raw sample into buckets / alerts (mirrors the server poller) -----
  function ingest(d, s) {
    if (s.ev) { eOf(d.id).push({ id: DB.aid++, kind: 'auto', ts: s.t, end_ts: s.t, info: s.info || s.ev }); if (/^freeze_on/.test(s.info || '')) { const m = /outdoor (-?[\d.]+)/.exec(s.info); addAlert(d, 'freeze_on', 'info', { t: m ? +m[1] : null, below: ((d.auto || {}).weather || {}).below }, 30, s.t); } return; } // action done by the background automation
    const cfg = d.cfg || {}, state = d.state || (d.state = {}), now = s.t;
    if (typeof s.w === 'number') d.w = s.w;
    if (!s.ok) {
      const offMin = ci(cfg, 'offlineMin', 3);
      if (d.lastOk && !state.offSince && now - d.lastOk > offMin * 60000) { state.offSince = now; addAlert(d, 'offline', 'warn', { min: offMin }, 30, now); }
      return;
    }
    const unreachable = s.online === false;
    if (unreachable && !state.offSince) { state.offSince = now; addAlert(d, 'offline', 'warn', { min: ci(cfg, 'offlineMin', 3) }, 30, now); }
    if (!unreachable && state.offSince) { const min = Math.round((now - state.offSince) / 60000); state.offSince = 0; if (min >= 2) addAlert(d, 'restored', 'info', { min }, 0, now); }
    if (!d.lastOk || now >= d.lastOk) { d.lastOk = now; d.status = s.st; d.online = !unreachable; }
    const der = C.derive(cfg, d.spec, s.st); if (der.tamb == null && typeof s.w === 'number') der.tamb = s.w;
    const dt = state.t ? Math.min((now - state.t) / 1000, 1200) : 0;
    const h = Math.floor(now / 3600000) * 3600000, m5 = Math.floor(now / 300000) * 300000, hm = hOf(d.id);
    const row = hm.get(h) || { ts: h, kwh: 0, kwh_th: 0, comp_s: 0, starts: 0, defr_n: 0, defr_s: 0, to_sum: 0, to_n: 0, tc_sum: 0, tc_n: 0, hz_sum: 0 };
    if (dt > 0) {
      row.kwh += der.w * dt / 3.6e6;
      if (state.q != null || der.q != null) row.kwh_th += (((state.q || 0) + (der.q || 0)) / 2) * dt / 3600;
      if (der.comp) { row.comp_s += dt; if (der.hz != null) row.hz_sum = (row.hz_sum || 0) + der.hz * dt; }
      if (der.defrost) row.defr_s += dt;
    }
    if (der.comp && state.comp === false) { row.starts += 1; (state.starts = state.starts || []).push(now); }
    if (state.starts) state.starts = state.starts.filter(t => now - t < 3600000);
    if (der.defrost && !state.defStart) { row.defr_n += 1; state.defStart = now; eOf(d.id).push({ id: DB.aid++, kind: 'defrost', ts: now, end_ts: null, info: '' }); }
    if (!der.defrost && state.defStart) { const e = eOf(d.id).find(x => x.kind === 'defrost' && x.ts === state.defStart); if (e) e.end_ts = now; state.defStart = 0; }
    if (der.tamb != null) { row.to_sum += der.tamb; row.to_n += 1; }
    if (der.tcur != null) { row.tc_sum += der.tcur; row.tc_n += 1; }
    // pump session: energy of every interval while the pump is ON goes to that session (kept per hour -> tariff-aware cost)
    { const L = sOf(d.id); let ses = state.ses ? L.find(x => x.id === state.ses) : null; if (ses && ses.e) { ses = null; state.ses = 0; }
      if (ses && dt > 0) { const k = der.w * dt / 3.6e6; ses.kwh += k; ses.h[h] = (ses.h[h] || 0) + k; if (der.comp) ses.cs += dt; }
      if (der.on && !ses) { const n = { id: DB.aid++, s: now, e: null, kwh: 0, cs: 0, h: {}, approx: !state.t || dt > 150 }; L.push(n); state.ses = n.id; }
      else if (!der.on && ses) { ses.e = now; state.ses = 0; } }
    hm.set(h, row);
    mOf(d.id).set(m5, { ts: m5, p: der.w, tc: der.tcur, tout: der.tout, tin: der.tin, tamb: der.tamb, tset: der.tset, tbuf: der.tbuf, hz: der.hz, cp: der.comp ? 1 : 0 });
    state.t = now; state.comp = der.comp; state.q = der.q;
    // alerts
    if (der.on && der.tcur != null && der.tset != null && der.tcur < der.tset - ci(cfg, 'lowDelta', 8)) {
      state.lowSince = state.lowSince || now; const min = Math.round((now - state.lowSince) / 60000);
      if (min >= ci(cfg, 'lowMin', 90)) addAlert(d, 'low_temp', 'warn', { t: der.tcur, set: der.tset, min }, 360, now);
    } else state.lowSince = 0;
    if ((state.starts || []).length >= ci(cfg, 'cycleN', 6)) addAlert(d, 'cycling', 'warn', { n: state.starts.length }, 180, now);
    if (state.defStart && (now - state.defStart) / 60000 >= ci(cfg, 'defrostMin', 20)) addAlert(d, 'defrost_long', 'warn', { min: Math.round((now - state.defStart) / 60000) }, 120, now);
    if (der.tamb != null && der.tamb < ci(cfg, 'freezeT', 2) && s.st.switch === false) addAlert(d, 'freeze_risk', 'crit', { t: der.tamb }, 180, now);
  }

  // ----- Tuya helpers -----
  async function pollLive(d) {
    if (d._busy || Date.now() - (d._lp || 0) < 1500) return; d._busy = true;
    try {
      const r = await tuyaCall('GET', `/v1.0/devices/${d.tuya}/status`);
      if (r.success && Array.isArray(r.result)) {
        const st = {}; r.result.forEach(x => { st[x.code] = x.value; }); d.status = st; d.lastOk = Date.now(); d.online = true; d._n = (d._n || 0) + 1;
        if (d._n % 3 === 1) { const i = await tuyaCall('GET', `/v1.0/devices/${d.tuya}`); if (i.success && i.result && typeof i.result.online === 'boolean') d.online = i.result.online; }
      } else if (Date.now() - (d.lastOk || 0) > 180000) d.online = false;
    } catch (e) { /* offline */ }
    d._lp = Date.now(); d._busy = false;
  }
  let wc = { t: 0, v: null };
  async function forecastTemp() {
    const h = DB.home; if (!h || h.lat == null) return null; if (Date.now() - wc.t < 600000) return wc.v;
    try { const j = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${h.lat}&longitude=${h.lon}&current=temperature_2m`)).json(); wc = { t: Date.now(), v: j.current && typeof j.current.temperature_2m === 'number' ? j.current.temperature_2m : null }; } catch (e) { /* keep */ }
    return wc.v;
  }
  async function sendCmd(d, code, value) { return tuyaCall('POST', `/v1.0/devices/${d.tuya}/commands`, { commands: [{ code, value: rawValue(d.spec, code, value) }] }); }

  // ----- automation (schedule + weather), same rules as the server -----
  async function runAuto(d) {
    const auto = d.auto || {}, state = d.state, now = Date.now(), cfg = d.cfg || {}, wz = auto.weather || {}, st = d.status || {};
    if (!(auto.schedule && auto.schedule.enabled) && !wz.enabled) return;
    const der = C.derive(cfg, d.spec, st); if (der.tamb == null && d.w != null) der.tamb = d.w;
    const tz = DB.home.tz || 'Asia/Tashkent';

    // weather = freeze protection: outdoor temp at/below the threshold and the pump is OFF -> switch it ON
    let freezeActive = false;
    if (wz.enabled) {
      let out = der.tamb; if (out == null || wz.source === 'forecast') { const f = await forecastTemp(); if (f != null) out = f; }
      const below = wz.below != null && wz.below !== '' && !isNaN(+wz.below) ? +wz.below : -3;
      if (out != null) {
        freezeActive = out <= below + (state.freezeOn ? 1 : 0);
        if (!native() && out <= below && st.switch === false && (!state.lastFreeze || now - state.lastFreeze > 10 * 60000)) {
          const r = await sendCmd(d, 'switch', true);
          if (r.success) {
            st.switch = true; state.lastFreeze = now; state.freezeOn = true;
            eOf(d.id).push({ id: DB.aid++, kind: 'auto', ts: now, end_ts: now, info: 'freeze_on switch=true' });
            addAlert(d, 'freeze_on', 'info', { t: out, below }, 30, now);
          }
          return;
        }
        if (!freezeActive) state.freezeOn = false;
      }
    }

    if (!(auto.schedule && auto.schedule.enabled)) return;
    if (state.holdUntil && now < state.holdUntil) return; if (state.lastAuto && now - state.lastAuto < 5 * 60000) return;

    // weekly schedule: each on/off command is given ONCE per occurrence; a manual switch cancels the occurrence
    let slotMode = null, wantOn = null, target = null, key = null;
    const sk = C.slotKey(auto.schedule, tz, now);
    if (sk) {
      wantOn = true; key = sk.key; state.lastSlotKey = sk.key; const slot = sk.slot;
      if (slot.mode) slotMode = slot.mode;
      if (slot.setpoint != null && slot.setpoint !== '') {
        target = +slot.setpoint; const sp = d.spec.temp_set || {}, sc = Math.pow(10, sp.scale || 0);
        target = Math.min(Math.min(sp.max != null ? sp.max / sc : 75, +cfg.tmax || 75), Math.max(sp.min != null ? sp.min / sc : 20, target));
      }
    } else if (auto.schedule.outside !== 'keep') { wantOn = false; key = 'off:' + (state.lastSlotKey || ''); }
    if (wantOn === false && freezeActive) wantOn = null;
    const already = key != null && state.doneKey === key;
    const done = []; let failed = false;
    if (wantOn === true && !already && slotMode && der.modeCode && d.spec[der.modeCode] && st[der.modeCode] !== slotMode) { const r = await sendCmd(d, der.modeCode, slotMode); if (r.success) { done.push(der.modeCode + '=' + slotMode); st[der.modeCode] = slotMode; } else failed = true; }
    if (wantOn !== null && !already && st.switch !== undefined && st.switch !== wantOn) { const r = await sendCmd(d, 'switch', wantOn); if (r.success) { done.push('switch=' + wantOn); st.switch = wantOn; } else failed = true; }
    if (target != null && !already && der.tset != null && Math.abs(der.tset - target) >= 0.5 && wantOn !== false) { const r = await sendCmd(d, 'temp_set', Math.round(target * 2) / 2); if (r.success) done.push('temp_set=' + target); else failed = true; }
    if (key != null && !already && wantOn !== null && !failed) state.doneKey = key;
    if (done.length) { state.lastAuto = now; eOf(d.id).push({ id: DB.aid++, kind: 'auto', ts: now, end_ts: now, info: done.join(', ') }); }
  }

  // ----- periodic: ingest raw samples written by the native sampler -----
  async function tick() {
    if (ticking) return 0; ticking = true; let n = 0;
    try {
      const raw = native() && Android.drain ? (Android.drain() || '') : '';
      if (raw) {
        const by = {}; raw.split('\n').forEach(l => { if (!l.trim()) return; try { const s = JSON.parse(l); (by[s.d] = by[s.d] || []).push(s); } catch (e) { /* skip */ } });
        for (const d of DB.devs) (by[d.tuya] || []).sort((a, b) => a.t - b.t).forEach(s => { ingest(d, s); n++; });
      }
      for (const d of DB.devs) if (Date.now() - (d.lastOk || 0) < 180000) { try { await runAuto(d); } catch (e) { /* ignore */ } }
      DB.devs.forEach(d => saveSeries(d.id)); saveDb();
      if (native() && Android.notify) for (const a of newAlerts) if (Date.now() - a.ts < 30 * 60000) { const x = C.alertText(a.kind, a.params, typeof LANG === 'string' ? LANG : 'uz'); Android.notify(x.title, x.body); }
      newAlerts.length = 0;
    } finally { ticking = false; }
    return n;
  }

  // ----- API surface (same shapes as the server) -----
  const homeJson = () => ({ id: 1, name: DB.home.name, tz: DB.home.tz, lat: DB.home.lat, lon: DB.home.lon, price: DB.home.price, tariff: DB.home.tariff || null, role: 'owner', devices: DB.devs.map(d => ({ id: d.id, home_id: 1, name: d.name, role: 'owner', online: !!d.online })) });
  async function deviceGet(d) {
    await pollLive(d);
    const cfg = d.cfg || {}, st = d.status || {}, der = C.derive(cfg, d.spec, st); if (der.tamb == null && d.w != null) der.tamb = d.w;
    const now = Date.now(), off = C.tzOffset(DB.home.tz || 'Asia/Tashkent', now), day0 = Math.floor((now + off) / C.DAY) * C.DAY - off;
    const t = { kwh: 0, th: 0, cs: 0, st: 0, df: 0, dfs: 0 };
    const allH = [...hOf(d.id).values()], mStart = Date.UTC(new Date(now + off).getUTCFullYear(), new Date(now + off).getUTCMonth(), 1) - off, mRows = allH.filter(r => r.ts >= mStart), mCosts = C.hourCosts(mRows, DB.home.price || 0, DB.home.tariff, off);
    let todayCost = 0; mRows.forEach(r => { if (r.ts >= day0) todayCost += mCosts.get(r.ts) || 0; });
    const nowPrice = C.curPrice(C.monthKwh(mRows, off, now), DB.home.tariff, DB.home.price || 0);
    for (const r of hOf(d.id).values()) if (r.ts >= day0) { t.kwh += r.kwh; t.th += r.kwh_th; t.cs += r.comp_s; t.st += r.starts; t.df += r.defr_n; t.dfs += r.defr_s; }
    const lastDef = eOf(d.id).filter(e => e.kind === 'defrost').slice(-1)[0];
    let lastSession = null; { const ls = sOf(d.id).slice(-1)[0];
      if (ls) { const ms = Date.UTC(new Date(ls.s + off).getUTCFullYear(), new Date(ls.s + off).getUTCMonth(), 1) - off, rr = allH.filter(r => r.ts >= ms); lastSession = C.sessionOut(ls, new Map(rr.map(r => [r.ts, r.kwh])), C.hourCosts(rr, DB.home.price || 0, DB.home.tariff, off), now); } }
    return R({
      id: d.id, name: d.name, role: 'owner', online: !!d.online, age: d.lastOk ? Math.round((now - d.lastOk) / 1000) : null, values: C.scaled(d.spec, st), spec: d.spec, cfg, derived: der,
      price: nowPrice, tz: DB.home.tz, tariff: DB.home.tariff || null,
      today: { cost: Math.round(todayCost), kwh: +t.kwh.toFixed(2), kwh_th: +t.th.toFixed(2), comp_h: +(t.cs / 3600).toFixed(2), starts: t.st, defr: t.df, defr_min: +(t.dfs / 60).toFixed(1), cop: t.kwh > 0.2 && t.th > 0 ? +(t.th / t.kwh).toFixed(2) : null },
      lastSession, lastDefrost: lastDef ? { ts: lastDef.ts, end_ts: lastDef.end_ts } : null, hold: (d.state.holdUntil || 0) > now ? d.state.holdUntil : 0
    });
  }
  function statsGet(d, period, shift) {
    const tz = DB.home.tz || 'Asia/Tashkent', now = Date.now(), off = C.tzOffset(tz, now), price = DB.home.price || 0, shiftD = period === 'day' ? Math.min(Math.max(+shift || 0, 0), 60) : 0, Rg = C.rangeFor(period, off, now - shiftD * C.DAY), rows = [...hOf(d.id).values()];
    const sel = (a, b) => rows.filter(r => r.ts >= a && r.ts < b);
    const costs = C.hourCosts(rows, price, DB.home.tariff, off), cur = C.aggregate(sel(Rg.s - off, Rg.e - off), off, Rg.key, costs), prev = C.aggregate(sel(Rg.ps - off, Rg.pe - off), off, Rg.key, costs);
    const blank = k => ({ k, kwh: 0, kwh_th: 0, comp_s: 0, starts: 0, defr: 0, to_sum: 0, to_n: 0, hz_sum: 0, cost: 0 });
    const sum = m => { const t = blank(''); for (const b of m.values()) for (const k of Object.keys(t)) if (k !== 'k') t[k] += b[k]; return C.fin(t, price); };
    const out = { period, shift: shiftD, buckets: Rg.keys.map(k => C.fin(cur.get(k) || blank(k), price)), total: sum(cur), prev: sum(prev) };
    // every hour and every pump session of the selected period (detailed table)
    if (period !== 'year') out.hours = C.hourRows(sel(Rg.s - off, Rg.e - off), costs, off);
    { const rowKwh = new Map(rows.map(r => [r.ts, r.kwh]));
      out.sessions = sOf(d.id).filter(x => x.s < Rg.e - off && (!x.e || x.e >= Rg.s - off)).map(x => C.sessionOut(x, rowKwh, costs, now)).reverse(); }
    out.recent = sOf(d.id).slice(-6).map(x => C.sessionOut(x, new Map(rows.map(r => [r.ts, r.kwh])), costs, now)).reverse(); // latest session + the 5 before it
    if (period === 'month') {
      const elapsed = Math.max((Rg.nl - Rg.s) / C.DAY, 0.05), left = (Rg.e - Rg.nl) / C.DAY;
      const w = rows.filter(r => r.ts >= now - 7 * 864e5).reduce((s, r) => s + r.kwh, 0), avg = (Rg.nl - Rg.s) >= 7 * C.DAY ? w / 7 : out.total.kwh / elapsed, f = out.total.kwh + avg * left;
      out.forecast = { kwh: +f.toFixed(1), cost: Math.round(out.total.cost + avg * left * C.curPrice(f, DB.home.tariff, price)), per_day: +avg.toFixed(2) };
    }
    const nd = new Date(Rg.nl), sy = nd.getUTCMonth() >= 9 ? nd.getUTCFullYear() : nd.getUTCFullYear() - 1, sStart = Date.UTC(sy, 9, 1);
    const sRows = rows.filter(r => r.ts >= sStart - off), sAgg = C.aggregate(sRows, off, 10, C.hourCosts(sRows, price, DB.home.tariff, off)), days = [...sAgg.values()].map(b => C.fin(b, price));
    const pairs = days.filter(x => x.tout != null && x.kwh > 0.5).slice(-60).map(x => [x.tout, x.kwh]);
    out.corr = { pairs, fit: C.regress(pairs) };
    return out;
  }

  async function handle(method, path, body) {
    let m;
    try {
      if (path === '/api/me' && method === 'GET') return R({ user: { id: 1, login: 'local', name: 'Mango' }, homes: DB.home ? [homeJson()] : [] });
      if (path === '/api/me' && method === 'DELETE') {
        Object.keys(LS).filter(k => k.startsWith(P)).forEach(k => LS.removeItem(k));
        if (native()) { ['dDevices', 'dLoc', 'tuyaId', 'tuyaSecret', 'tuyaRegion', 'summary', 'tuyaMode', 'shTok', 'shTerm', 'shEnd', 'shUser'].forEach(k => Android.set(k, '')); }
        DB = { home: null, devs: [], nid: 1, aid: 1, alerts: [] }; return R({ ok: true });
      }
      if (path === '/api/homes' && method === 'POST') {
        DB.home = { name: body.name || 'Uy', tz: body.tz || 'Asia/Tashkent', lat: body.lat != null ? body.lat : null, lon: body.lon != null ? body.lon : null, price: +body.price || 0, tariff: body.tariff || null };
        saveDb(); syncNative(); return R({ id: 1 });
      }
      if ((m = /^\/api\/homes\/1$/.exec(path)) && method === 'PATCH') {
        const h = DB.home; ['name', 'tz', 'lat', 'lon'].forEach(k => { if (body[k] !== undefined) h[k] = body[k]; }); if (body.price !== undefined) h.price = +body.price || 0; if (body.tariff !== undefined) h.tariff = body.tariff || null;
        saveDb(); syncNative(); return R({ ok: true });
      }
      if (/^\/api\/homes\/1\/members$/.test(path)) return R([{ id: 1, name: 'Mango', login: 'local', role: 'owner' }]);
      if ((m = /^\/api\/homes\/1\/devices$/.exec(path)) && method === 'POST') {
        const tid = (body.tuya_id || '').trim(); if (!tid) return R({ error: 'bad_input' }, 400);
        if (DB.devs.some(x => x.tuya === tid)) return R({ error: 'already_added' }, 409);
        const s = await tuyaCall('GET', `/v1.0/devices/${tid}/status`); if (!s.success) return R({ error: 'tuya', message: s.msg || 'Qurilma topilmadi' }, 400);
        const sp = await tuyaCall('GET', `/v1.0/devices/${tid}/specifications`), spec = {};
        if (sp.success) { const fn = (sp.result || {}).functions || []; for (const f of [].concat(fn, (sp.result || {}).status || [])) { let v = {}; try { v = JSON.parse(f.values || '{}'); } catch (e) { /* */ } spec[f.code] = Object.assign({ type: f.type, name: f.name, writable: fn.some(x => x.code === f.code) }, v); } }
        const st = {}; s.result.forEach(x => { st[x.code] = x.value; });
        const d = { id: DB.nid++, tuya: tid, name: body.name || 'Nasos', cfg: C.withDefaults({}), auto: {}, spec, status: st, online: true, lastOk: Date.now(), state: {}, w: null };
        DB.devs.push(d); saveDb(); syncNative();
        return R({ id: d.id, codes: Object.keys(spec), suggest: { power: Object.keys(spec).filter(k => /power|energy/i.test(k)) } });
      }
      if ((m = /^\/api\/devices\/(\d+)(?:\/(\w+))?$/.exec(path))) {
        const d = dev(m[1]); if (!d) return R({ error: 'not_found' }, 404); const sub = m[2];
        if (!sub && method === 'GET') return deviceGet(d);
        if (!sub && method === 'PATCH') { if (body.name) d.name = body.name; if (body.cfg && typeof body.cfg === 'object') d.cfg = body.cfg; saveDb(); syncNative(); return R({ ok: true }); }
        if (!sub && method === 'DELETE') { ['h1_', 'm5_', 'ev_', 'ses_'].forEach(k => LS.removeItem(P + k + d.id)); DB.devs = DB.devs.filter(x => x !== d); saveDb(); syncNative(); return R({ ok: true }); }
        if (sub === 'command' && method === 'POST') {
          if (!body.code || !(d.spec[body.code] || (d.status || {})[body.code] !== undefined)) return R({ error: 'bad_code' }, 400);
          const r = await sendCmd(d, body.code, body.value); if (!r.success) return R({ error: 'tuya', message: r.msg }, 502);
          d.status = Object.assign({}, d.status, { [body.code]: rawValue(d.spec, body.code, body.value) }); d._lp = 0; d.state.holdUntil = Date.now() + (+(d.auto || {}).holdMin || 120) * 60000;
          if (body.code === 'switch' && d.auto && d.auto.schedule && d.auto.schedule.enabled) { const sk = C.slotKey(d.auto.schedule, DB.home.tz || 'Asia/Tashkent', Date.now()); d.state.doneKey = sk ? sk.key : 'off:' + (d.state.lastSlotKey || ''); }
          eOf(d.id).push({ id: DB.aid++, kind: 'cmd', ts: Date.now(), end_ts: Date.now(), info: body.code + '=' + body.value }); saveDb(); return R({ ok: true });
        }
        if (sub === 'auto' && method === 'GET') { const a = d.auto || {}; if (a.weather && !a.m374) { if (+a.weather.below === 3) a.weather.below = -3; a.m374 = true; d.auto = a; saveDb(); syncNative(); } return R(a); }
        if (sub === 'auto' && method === 'PUT') {
          const b = body || {};
          d.auto = { base: b.base === '' || b.base == null ? null : +b.base, holdMin: +b.holdMin || 120,
            schedule: { enabled: !!(b.schedule || {}).enabled, outside: (b.schedule || {}).outside === 'keep' ? 'keep' : 'off', slots: ((b.schedule || {}).slots || []).slice(0, 28).map(s => ({ days: (s.days || []).map(Number).filter(x => x >= 1 && x <= 7), from: s.from, to: s.to, setpoint: s.setpoint === '' || s.setpoint == null ? null : +s.setpoint, mode: s.mode ? String(s.mode).slice(0, 40) : null })) },
            weather: { enabled: !!(b.weather || {}).enabled, source: (b.weather || {}).source === 'forecast' ? 'forecast' : 'device', below: (b.weather || {}).below === '' || (b.weather || {}).below == null || isNaN(+(b.weather || {}).below) ? -3 : +(b.weather || {}).below, rules: [] },
            offTimer: (() => { const z = b.offTimer || {}, n = (x, dflt) => (x === '' || x == null || isNaN(+x)) ? dflt : +x; return { enabled: !!z.enabled, mode: z.mode === 'at' ? 'at' : 'after', hours: Math.min(168, Math.max(0.1, n(z.hours, 6))), at: /^\d{1,2}:\d{2}$/.test(z.at || '') ? z.at : '06:00' }; })(), m374: true };
          d.state.holdUntil = 0; d.state.lastAuto = 0; d.state.doneKey = null; saveDb(); syncNative(); return R({ ok: true });
        }
        if (sub === 'series') { const hrs = Math.min(+(/hours=(\d+)/.exec(path) || [])[1] || 24, 336); return R([]); }
        if (sub === 'events') return R(eOf(d.id).filter(e => e.kind === 'defrost' || e.kind === 'auto').slice(-50).reverse());
      }
      if ((m = /^\/api\/devices\/(\d+)\/series\?hours=(\d+)$/.exec(path))) {
        const d = dev(m[1]), hrs = Math.min(+m[2] || 24, 336), step = hrs <= 24 ? 1 : hrs <= 72 ? 3 : 12, from = Date.now() - hrs * 3600e3;
        return R([...mOf(d.id).values()].filter(r => r.ts >= from).sort((a, b) => a.ts - b.ts).filter((r, i) => i % step === 0));
      }
      if ((m = /^\/api\/devices\/(\d+)\/stats\?period=(\w+)(?:&shift=(\d+))?$/.exec(path))) { const d = dev(m[1]); return R(statsGet(d, ['day', 'week', 'month', 'year'].includes(m[2]) ? m[2] : 'month', m[3])); }
      if (/^\/api\/alerts/.test(path)) {
        const lang = typeof LANG === 'string' ? LANG : 'uz';
        return R(DB.alerts.slice(-60).reverse().map(a => { const d = dev(a.dev); return Object.assign({ id: a.id, dev: a.dev, device: d ? d.name : '', kind: a.kind, level: a.level, ts: a.ts }, C.alertText(a.kind, a.params, lang)); }));
      }
      return R({ error: 'not_supported' }, 404);
    } catch (e) { return R({ error: 'local', message: String(e && e.message || e) }, 500); }
  }
  syncNative();
  return { handle, tick, _db: () => DB };
})();
