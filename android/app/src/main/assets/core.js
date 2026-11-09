/* Pure calculation functions of the standalone (serverless) mode. */
(function(){
'use strict';
// ---------- uz Latin -> Cyrillic ----------
const D = { "o'": 'ў', "g'": 'ғ', sh: 'ш', ch: 'ч', yo: 'ё', yu: 'ю', ya: 'я', ye: 'е', ts: 'ц' };
const S = { a:'а',b:'б',d:'д',e:'е',f:'ф',g:'г',h:'ҳ',i:'и',j:'ж',k:'к',l:'л',m:'м',n:'н',o:'о',p:'п',q:'қ',r:'р',s:'с',t:'т',u:'у',v:'в',x:'х',y:'й',z:'з',c:'к',w:'в',"'":'ъ' };
const KEEP = /(\{[^}]*\}|kWh|kW|COP|ΔT|Tuya|Mango|Alisa|PIN|DP|API|URL|ID|Wi-Fi|Android)/g;
function cyrChunk(t) {
  t = t.replace(/[’‘ʻʼ`´]/g, "'");
  let out = '';
  for (let i = 0; i < t.length;) {
    const low2 = t.substr(i, 2).toLowerCase();
    const ch = t[i], low = ch.toLowerCase();
    const prevLetter = i > 0 && /[A-Za-z']/.test(t[i - 1]);
    let r, adv = 1;
    if (D[low2]) { r = D[low2]; adv = 2; }
    else if (low === 'e' && !prevLetter) r = 'э';
    else if (S[low]) r = S[low];
    else { out += ch; i++; continue; }
    out += (ch !== low && /[A-Z]/.test(ch)) ? r.toUpperCase() : r;
    i += adv;
  }
  return out;
}
function translit(s) {
  return String(s).split(KEEP).map((p, i) => (i % 2 ? p : cyrChunk(p))).join('');
}

// ---------- alert texts ----------
const ALERT = {
  uz: {
    offline: ['Nasos aloqada emas', '{name}: {min} daqiqadan beri javob yo\'q.'],
    restored: ['Aloqa / elektr tiklandi', '{name}: {min} daqiqalik uzilishdan so\'ng qayta ulandi.'],
    low_temp: ['Suv yetarlicha isimayapti', '{name}: suv {t}°, belgilangan {set}°. Farq {min} daqiqadan beri katta.'],
    cycling: ['Kompressor tez-tez yoqilib o\'chyapti', '{name}: oxirgi soatda {n} marta ishga tushdi.'],
    defrost_long: ['Defrost juda cho\'zildi', '{name}: defrost {min} daqiqadan beri davom etyapti.'],
    freeze_risk: ['Muzlash xavfi!', '{name}: tashqi havo {t}°, nasos o\'chiq. Quvurlar muzlashi mumkin.'],
    freeze_on: ['Muzlashdan himoya: nasos yoqildi', '{name}: tashqi havo {t}° (chegara {below}°). Nasos avtomatik yoqildi.']
  },
  ru: {
    offline: ['Насос не на связи', '{name}: нет ответа уже {min} мин.'],
    restored: ['Связь / питание восстановлено', '{name}: снова на связи после перерыва {min} мин.'],
    low_temp: ['Вода недостаточно нагревается', '{name}: вода {t}°, уставка {set}°. Большая разница уже {min} мин.'],
    cycling: ['Компрессор слишком часто включается', '{name}: за последний час {n} запусков.'],
    defrost_long: ['Слишком долгая разморозка', '{name}: разморозка идёт уже {min} мин.'],
    freeze_risk: ['Риск замерзания!', '{name}: на улице {t}°, насос выключен. Трубы могут замёрзнуть.'],
    freeze_on: ['Защита от замерзания: насос включён', '{name}: на улице {t}° (порог {below}°). Насос включён автоматически.']
  },
  en: {
    offline: ['Pump is offline', '{name}: no response for {min} min.'],
    restored: ['Connection / power restored', '{name}: back online after a {min} min outage.'],
    low_temp: ['Water is not heating enough', '{name}: water {t}°, target {set}°. Large gap for {min} min.'],
    cycling: ['Compressor is short-cycling', '{name}: {n} starts in the last hour.'],
    defrost_long: ['Defrost is taking too long', '{name}: defrost running for {min} min.'],
    freeze_risk: ['Freeze risk!', '{name}: outdoor {t}°, pump is off. Pipes may freeze.'],
    freeze_on: ['Freeze protection: pump turned on', '{name}: outdoor {t}° (threshold {below}°). Pump was switched on automatically.']
  }
};
function alertText(kind, params, lang) {
  const base = lang === 'ru' ? 'ru' : lang === 'en' ? 'en' : 'uz';
  const tpl = (ALERT[base][kind]) || [kind, ''];
  const fill = s => s.replace(/\{(\w+)\}/g, (_, k) => (params && params[k] != null ? params[k] : ''));
  let r = { title: fill(tpl[0]), body: fill(tpl[1]) };
  if (lang === 'uzc') r = { title: translit(r.title), body: translit(r.body) };
  return r;
}

// ---------- time helpers ----------
function tzOffset(tz, ts) {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' })
    .formatToParts(new Date(ts)).reduce((a, x) => (a[x.type] = +x.value, a), {});
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) - Math.floor(ts / 1000) * 1000;
}
function localParts(tz, ts) { // dow 1=Mon..7=Sun, minutes since midnight
  const l = new Date(ts + tzOffset(tz, ts));
  return { dow: ((l.getUTCDay() + 6) % 7) + 1, min: l.getUTCHours() * 60 + l.getUTCMinutes() };
}
const hm = s => { const m = /^(\d{1,2}):(\d{2})$/.exec(s || ''); return m ? +m[1] * 60 + +m[2] : null; };

// ---------- device values ----------
const scaleOf = (spec, c) => (spec[c] && spec[c].scale) || 0;
function val(spec, st, c) { const v = st[c]; return typeof v === 'number' ? v / Math.pow(10, scaleOf(spec, c)) : v; }
const findCode = (spec, st, re, bad) => { for (const c of Object.keys(spec || {}).concat(Object.keys(st || {}))) if (re.test(c) && !(bad && bad.test(c))) return c; return null; };
function derive(cfg, spec, st) {
  const num = c => { if (!c) return null; const v = val(spec, st, c); return typeof v === 'number' ? v : null; };
  const first = (...cs) => { for (const c of cs) { const v = num(c); if (v != null) return v; } return null; };
  const hzCode = cfg.hzCode || findCode(spec, st, /freq|(^|_)hz($|_)/i);
  const hzRaw = num(hzCode);
  const hz = hzRaw != null ? hzRaw * (+cfg.hzMul || 1) : null;
  let comp = st.compressor_state === true;
  if (st.compressor_state === undefined && hz != null) comp = hz > 0;
  const stren = typeof st.compressor_strength === 'number' ? st.compressor_strength : 100;
  const vRaw = num(cfg.voltCode), cRaw = num(cfg.currCode), cosRaw = num(cfg.cosCode);
  const v = vRaw != null ? vRaw * (+cfg.voltMul || 1) : (+cfg.voltage || 380);
  const cos = cosRaw != null ? cosRaw * (+cfg.cosMul || 1) : null;
  const k = (+cfg.phases === 1) ? 1 : 1.732;
  let w, real = false, src = 'model';
  if (cfg.powerCode && typeof st[cfg.powerCode] === 'number') { w = st[cfg.powerCode] * (+cfg.powerMul || 1); real = true; src = 'meter'; }
  else if (cRaw != null && cfg.powerSrc !== 'hz') { w = cRaw * (+cfg.currMul || 1) * v * k * (cos || +cfg.pf || 0.9); src = 'current'; }
  else {
    w = 0;
    if (comp) {
      // compW = compressor power at ratedHz (e.g. 5000 W at 70 Hz); above ratedHz the power keeps growing (capped at 2x)
      const ratedHz = +cfg.ratedHz || +cfg.maxHz || 90, cw = +cfg.compW || 0;
      if (hz != null && hz > 0) { w += cw * Math.pow(Math.min(hz / ratedHz, 2), +cfg.hzExp || 1); src = 'hz'; }
      else w += cw * (stren / 100);
    }
    if (st.pump_state === true) w += +cfg.pumpW || 0;
    if (st.draught_fan_state === true) w += +cfg.fanW || 0;
    if (st.ele_heating_state === true) w += +cfg.heatW || 0;
    if (!w && st.switch === true) w = +cfg.idleW || 0;
    w *= +cfg.coef || 1;
    // supply voltage correction (power of a motor load scales roughly with V when only the nominal is known)
    if (vRaw != null && +cfg.voltage) w *= Math.pow(vRaw * (+cfg.voltMul || 1) / +cfg.voltage, +cfg.vExp || 0);
  }
  if (st.compressor_state === undefined && hz == null && real && w > (+cfg.compOnW || 800)) comp = true;
  const a = cRaw != null ? cRaw * (+cfg.currMul || 1) : w / (v * k * (cos || +cfg.pf || 0.9));
  const tin = first(cfg.tinCode || 'temp_in');
  const toutCode = cfg.toutCode || (spec && spec.temp_out || st.temp_out !== undefined ? 'temp_out' : findCode(spec, st, /^(water_?)?(temp_?)?out(let)?(_?(water|temp)\w*)?$|^out(let)?_?temp/i, /door|amb|air/i));
  const tout = first(toutCode);
  const tbufCode = cfg.tbufCode || findCode(spec, st, /buf|tank|(^|_)bak/i, /set|max|min/i);
  const tbuf = first(tbufCode);
  const flowRaw = num(cfg.flowCode);
  const flow = flowRaw != null ? flowRaw * (+cfg.flowMul || 1) : (+cfg.flowLpm || 0);
  const pumping = comp || st.pump_state === true;
  const q = flow > 0 && tin != null && tout != null && pumping ? Math.max(0, flow / 60 * 4.186 * (tout - tin)) : null;
  const isStr = c => (spec && spec[c] && spec[c].type === 'Enum') || typeof (st || {})[c] === 'string';
  let modeCode = cfg.modeCode || (spec && spec.mode ? 'mode' : (st.mode !== undefined ? 'mode' : null));
  if (!modeCode) { for (const c of Object.keys(spec || {}).concat(Object.keys(st || {}))) if (/(^|_)mode($|_)/i.test(c) && !/timer|sched|smart|holiday|sleep|silent|eco|func|temp/i.test(c) && isStr(c)) { modeCode = c; break; } }
  const termCode = cfg.termCode || findCode(spec, st, /radiator|fan_?coil|fcu|terminal|emitter|end_?unit|heat_?(type|end)|floor_?rad/i, /state|temp|fault|speed/);
  return {
    w, real, src, a, aReal: cRaw != null, v, vReal: vRaw != null, cos, comp, defrost: st.defrost === true, on: st.switch === true,
    tcur: first('temp_current'), tset: first('temp_set'), tin, tout, tbuf, hz, hzReal: hzRaw != null, mode: modeCode ? st[modeCode] : null, modeCode, termCode, term: termCode ? st[termCode] : null,
    tamb: first(cfg.tambCode, 'temp_outdoor', 'temp_ambient'), flow, flowReal: flowRaw != null, q
  };
}
function scaled(spec, st) { const o = {}; for (const c in st) o[c] = val(spec, st, c); return o; }

// ---------- stats ranges (in "local pseudo-UTC" ms) ----------
const DAY = 864e5;
function rangeFor(period, off, now) {
  const nl = now + off, d = new Date(nl);
  const dayStart = Math.floor(nl / DAY) * DAY;
  let s, e, ps, pe, key, keys = [];
  const y = d.getUTCFullYear(), m = d.getUTCMonth();
  if (period === 'day') { s = dayStart; e = s + DAY; ps = s - DAY; pe = s; key = 13; for (let h = 0; h < 24; h++) keys.push(new Date(s + h * 36e5).toISOString().slice(0, 13)); }
  else if (period === 'week') { e = dayStart + DAY; s = e - 7 * DAY; ps = s - 7 * DAY; pe = s; key = 10; for (let i = 0; i < 7; i++) keys.push(new Date(s + i * DAY).toISOString().slice(0, 10)); }
  else if (period === 'year') { s = Date.UTC(y, 0, 1); e = Date.UTC(y + 1, 0, 1); ps = Date.UTC(y - 1, 0, 1); pe = s; key = 7; for (let i = 0; i < 12; i++) keys.push(new Date(Date.UTC(y, i, 1)).toISOString().slice(0, 7)); }
  else { s = Date.UTC(y, m, 1); e = Date.UTC(y, m + 1, 1); ps = Date.UTC(y, m - 1, 1); pe = s; key = 10; for (let t = s; t < e; t += DAY) keys.push(new Date(t).toISOString().slice(0, 10)); }
  return { s, e, ps, pe, key, keys, nl };
}
function aggregate(rows, off, key, costs) {
  const m = new Map();
  for (const r of rows) {
    const k = new Date(r.ts + off).toISOString().slice(0, key);
    let b = m.get(k); if (!b) m.set(k, b = { k, kwh: 0, kwh_th: 0, comp_s: 0, starts: 0, defr: 0, to_sum: 0, to_n: 0, hz_sum: 0, cost: 0 });
    b.cost += costs && costs.has(r.ts) ? costs.get(r.ts) : 0;
    b.kwh += r.kwh; b.kwh_th += r.kwh_th; b.comp_s += r.comp_s; b.starts += r.starts; b.defr += r.defr_n; b.to_sum += r.to_sum; b.to_n += r.to_n; b.hz_sum += r.hz_sum || 0;
  }
  return m;
}
function fin(b, price) {
  return {
    k: b.k, kwh: +b.kwh.toFixed(3), kwh_th: +b.kwh_th.toFixed(3), comp_h: +(b.comp_s / 3600).toFixed(2), starts: b.starts, defr: b.defr,
    tout: b.to_n ? +(b.to_sum / b.to_n).toFixed(1) : null, cop: b.kwh > 0.2 && b.kwh_th > 0 ? +(b.kwh_th / b.kwh).toFixed(2) : null, hz: b.comp_s > 0 && b.hz_sum > 0 ? +(b.hz_sum / b.comp_s).toFixed(1) : null, cost: Math.round(b.cost != null && b.cost > 0 ? b.cost : b.kwh * (price || 0))
  };
}
function regress(pairs) {
  const n = pairs.length; if (n < 5) return null;
  const mx = pairs.reduce((s, p) => s + p[0], 0) / n, my = pairs.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pairs) { sxx += (x - mx) ** 2; sxy += (x - mx) * (y - my); syy += (y - my) ** 2; }
  if (!sxx || !syy) return null;
  const slope = sxy / sxx;
  return { slope: +slope.toFixed(3), intercept: +(my - slope * mx).toFixed(2), r2: +((sxy * sxy) / (sxx * syy)).toFixed(2) };
}

// ---------- built-in defaults for a pump (taken from the owner's own working settings; a fresh install needs no re-entry) ----------
const DEFAULT_CFG = {
  model: '25', kw: 25, powerSrc: 'auto', compW: 4100, ratedHz: 70, pumpW: 180, fanW: 200, heatW: 0, idleW: 10, voltage: 380, phases: 3, pf: 0.9, hzExp: 1,
  flowLpm: 71.6, flowCode: 'flow', flowMul: 1, tinCode: 'temp_current', toutCode: 'temp_top', tambCode: 'temp_outdoor', tmax: 77,
  hzCode: 'compressor_strength', hzMul: 1, tbufCode: 'temp_current', termRad: 'radiator', termFan: 'fan coil',
  offlineMin: 5, lowDelta: 8, lowMin: 30, cycleN: 6, defrostMin: 20, freezeT: 3
};
function withDefaults(cfg) { return Object.assign({}, DEFAULT_CFG, cfg || {}, { _dv: 2 }); }

// ---------- model presets: everything scales from the 25 kW unit (compressor 4100 W at ratedHz) ----------
// 18 kW -> 2950 W, 25 kW -> 4100 W, 30 kW -> 4920 W, 35 kW -> 5740 W; any other kW (typed by hand) scales the same way.
function presetFor(kw) {
  kw = +kw; if (!(kw > 0)) return null; const k = kw / 25, r = (x, st) => Math.round(x * k / st) * st;
  return { kw, compW: r(4100, 10), ratedHz: 70, pumpW: r(180, 10), fanW: r(200, 10), heatW: 0, idleW: 10, flowLpm: +(71.6 * k).toFixed(1), voltage: 380, phases: 3, pf: 0.9, hzExp: 1 };
}
// one-time upgrade of settings saved by v3.4 (old presets 3600/5000/6000/7000 W) to the new compressor powers; hand-edited values are kept
const OLD_COMP = { 18: 3600, 25: 5000, 30: 6000, 35: 7000 };
function migrateCfg(cfg) {
  cfg = cfg || {}; if (+cfg._dv >= 2) return null;
  const out = Object.assign({}, cfg, { _dv: 2 }), m = cfg.model != null && cfg.model !== '' ? String(cfg.model) : (+cfg.compW === 5000 ? '25' : '');
  if (m && OLD_COMP[m] && +cfg.compW === OLD_COMP[m]) { const p = presetFor(+m); out.compW = p.compW; out.model = m; out.kw = +m; }
  else if (m && out.kw == null && OLD_COMP[m]) out.kw = +m;
  return out;
}

// ---------- pump sessions (from switch ON to switch OFF) ----------
// ses = { id, s, e|null, kwh, cs (compressor seconds), h: { hourTs: kwh } }; its cost = its share of each hour's cost (tariff-aware)
function sessionOut(ses, rowKwh, costs, now) {
  let cost = 0; for (const k of Object.keys(ses.h || {})) { const hk = +k, tot = rowKwh.get(hk); if (tot > 0) cost += (costs.get(hk) || 0) * Math.min(1, ses.h[k] / tot); }
  return { id: ses.id, approx: !!ses.approx, s: ses.s, e: ses.e || null, running: !ses.e, kwh: +(ses.kwh || 0).toFixed(3), cost: Math.round(cost), comp_min: Math.round((ses.cs || 0) / 60), dur_min: Math.max(0, Math.round(((ses.e || now) - ses.s) / 60000)) };
}
// hourly rows of a range for the detailed table
function hourRows(rows, costs, off) {
  return rows.slice().sort((a, b) => a.ts - b.ts).map(r => ({ ts: r.ts, kwh: +r.kwh.toFixed(3), cost: Math.round(costs.get(r.ts) || 0), comp_min: Math.round(r.comp_s / 60), starts: r.starts, hz: r.comp_s > 0 && r.hz_sum > 0 ? +(r.hz_sum / r.comp_s).toFixed(1) : null, tout: r.to_n ? +(r.to_sum / r.to_n).toFixed(1) : null }));
}

// ---------- tiered electricity tariff (monthly kWh brackets, editable) ----------
// tiers: [{ upTo: 200, price: 650 }, ...] — consumption inside a bracket is billed at that bracket's price; last bracket has no limit.
const DEFAULT_TIERS = [{ upTo: 200, price: 650 }, { upTo: 500, price: 900 }, { upTo: 1000, price: 1100 }, { upTo: 5000, price: 1500 }, { upTo: 10000, price: 1750 }, { upTo: 90000, price: 2000 }];
function normTariff(t) {
  if (!t || typeof t !== 'object' || !Array.isArray(t.tiers)) return null;
  const tiers = t.tiers.map(x => ({ upTo: +x.upTo, price: +x.price })).filter(x => x.upTo > 0 && x.price >= 0).sort((a, b) => a.upTo - b.upTo).slice(0, 12);
  return t.enabled === false || !tiers.length ? null : { enabled: true, tiers };
}
function tierPrice(cum, tiers) { for (const x of tiers) if (cum < x.upTo) return x.price; return tiers[tiers.length - 1].price; }
function tierCost(cum, kwh, tiers) {
  let c = 0, from = cum, left = kwh;
  for (let i = 0; i < tiers.length && left > 1e-9; i++) {
    const hi = i === tiers.length - 1 ? Infinity : tiers[i].upTo;
    if (from >= hi) continue;
    const take = Math.min(left, hi - from); c += take * tiers[i].price; from += take; left -= take;
  }
  return c;
}
// cost of every hourly row; monthly consumption restarts on the 1st (local time)
function hourCosts(rows, flat, tariff, off) {
  const T = normTariff(tariff), out = new Map(), sorted = rows.slice().sort((a, b) => a.ts - b.ts);
  let mk = '', cum = 0;
  for (const r of sorted) {
    if (!T) { out.set(r.ts, r.kwh * (flat || 0)); continue; }
    const k = new Date(r.ts + off).toISOString().slice(0, 7);
    if (k !== mk) { mk = k; cum = 0; }
    out.set(r.ts, tierCost(cum, r.kwh, T.tiers)); cum += r.kwh;
  }
  return out;
}
// price per kWh that applies right now (marginal) given this month's consumption so far
function curPrice(monthKwh, tariff, flat) { const T = normTariff(tariff); return T ? tierPrice(monthKwh, T.tiers) : (flat || 0); }
function monthKwh(rows, off, now) { const mk = new Date(now + off).toISOString().slice(0, 7); let s = 0; for (const r of rows) if (new Date(r.ts + off).toISOString().slice(0, 7) === mk) s += r.kwh; return s; }

// ---------- schedule slot identity (so a schedule command is given only once per occurrence) ----------
function slotKey(sch, tz, now) {
  const { dow, min } = localParts(tz, now), prev = dow === 1 ? 7 : dow - 1, off = tzOffset(tz, now);
  const day = new Date(now + off).toISOString().slice(0, 10), yday = new Date(now + off - DAY).toISOString().slice(0, 10);
  const sl = sch.slots || [];
  for (let i = 0; i < sl.length; i++) {
    const s = sl[i], a = hm(s.from), b = hm(s.to); if (a == null || b == null) continue;
    const days = s.days && s.days.length ? s.days : [1, 2, 3, 4, 5, 6, 7];
    if (a < b) { if (days.includes(dow) && min >= a && min < b) return { slot: s, key: 'on:' + i + ':' + day }; }
    else if (days.includes(dow) && min >= a) return { slot: s, key: 'on:' + i + ':' + day };
    else if (days.includes(prev) && min < b) return { slot: s, key: 'on:' + i + ':' + yday };
  }
  return null;
}

window.Core = { presetFor, migrateCfg, sessionOut, hourRows, DEFAULT_CFG, withDefaults, DEFAULT_TIERS, normTariff, tierPrice, hourCosts, curPrice, monthKwh, slotKey, translit, alertText, tzOffset, localParts, hm, scaleOf, val, derive, scaled, rangeFor, aggregate, fin, regress, DAY };
})();
