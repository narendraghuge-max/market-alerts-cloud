// SMC / ICT scanner — free Yahoo candle data, no API key.
// Computes the 8-point confluence funnel + 6 staged price levels per symbol.
// Usage:  node scan_smc.mjs            (full universe, text digest)
//         node scan_smc.mjs --json     (machine-readable)
//         node scan_smc.mjs NVDA AVGO  (ad-hoc subset)
//
// HTF bias = Daily; entry setup + levels = 1h. Mirrors the documented strategy.

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __reportDir = dirname(fileURLToPath(import.meta.url));
import { analyzeExit as analyzeExitH, HOLDINGS as EXIT_HOLDINGS, RANK as EXIT_RANK, exitOne } from './scan_exits.mjs';
import { buildOptionsIdeas, renderOptionsHtml } from './options_ideas.mjs';

const HOLDINGS = new Set(Object.keys(EXIT_HOLDINGS)); // derived from holdings secret (single source of truth)
const LEVERAGED = new Set(['SOXL','SOXS','NVDU','NVDD','TECL','TECS','WEBL','WEBS','TQQQ','SQQQ','SPXL','SPXS','TNA','TZA','ERX','ERY','GUSH','DRIP','AAPU','MSFU','AMZU','GGLL','METU','SPCH','SSPC']);

const UNIVERSE = {
  Semiconductors: ['NVDA','AVGO','AMD','TSM','MU','AMAT','LRCX','SMCI','SMH','ARM','MRVL','ASML','SOXL','SOXS','NVDU','NVDD'],
  'AI / Big tech': ['PLTR','MSFT','GOOGL','META','AMZN','SNOW','CRWD','TSLA','AAPL','NFLX','ORCL','ANET','TECL','TECS','WEBL','WEBS','AAPU','MSFU','AMZU','GGLL','METU'],
  'Tech broad': ['QQQ','XLK','TQQQ','SQQQ'],
  Energy: ['XOM','CVX','OXY','SLB','COP','XLE','ERX','ERY','GUSH','DRIP'],
  'Index / regime': ['SPY','IWM','SPXL','SPXS','TNA','TZA'],
  Diversifiers: ['XLF','XLV','GLD','GDX'],
  Space: ['SPCX','SPCH','SSPC'],
};

const argv = process.argv.slice(2);
const asJson = argv.includes('--json');
const reportOnly = argv.includes('--report-only'); // regenerate report.html only, skip alert state
const subset = argv.filter(a => !a.startsWith('--')).map(s => s.toUpperCase());

async function fetchCandles(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${symbol} ${interval} HTTP ${r.status}`);
  const j = await r.json();
  const res = j.chart?.result?.[0];
  if (!res) throw new Error(`${symbol} ${interval} no data`);
  const q = res.indicators.quote[0];
  const out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    out.push({ t: res.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  }
  return out;
}

function ema(arr, p) { const k = 2 / (p + 1); let e = arr[0]; for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k); return e; }
function atr(bars, p = 14) {
  const tr = [];
  for (let i = 1; i < bars.length; i++) tr.push(Math.max(bars[i].h - bars[i].l, Math.abs(bars[i].h - bars[i - 1].c), Math.abs(bars[i].l - bars[i - 1].c)));
  return tr.slice(-p).reduce((s, x) => s + x, 0) / Math.min(p, tr.length);
}
// fractal pivots (strength s on each side)
function pivots(bars, s = 3) {
  const highs = [], lows = [];
  for (let i = s; i < bars.length - s; i++) {
    let ph = true, pl = true;
    for (let j = 1; j <= s; j++) {
      if (!(bars[i].h > bars[i - j].h && bars[i].h > bars[i + j].h)) ph = false;
      if (!(bars[i].l < bars[i - j].l && bars[i].l < bars[i + j].l)) pl = false;
    }
    if (ph) highs.push({ i, p: bars[i].h });
    if (pl) lows.push({ i, p: bars[i].l });
  }
  return { highs, lows };
}

// --- MTF helpers ---
function resample(bars, factor) {
  const out = [];
  for (let i = 0; i < bars.length; i += factor) {
    const c = bars.slice(i, i + factor);
    if (!c.length) continue;
    out.push({ t: c[0].t, o: c[0].o, h: Math.max(...c.map(b => b.h)), l: Math.min(...c.map(b => b.l)), c: c[c.length - 1].c, v: c.reduce((s, b) => s + b.v, 0) });
  }
  return out;
}
function biasOf(bars) {
  // Looser: trend = EMA slope (so pullbacks still read with-trend), structure only vetoes.
  const c = bars.map(b => b.c);
  const len = Math.min(50, Math.max(10, bars.length - 1));
  const e = ema(c, len), ePrev = ema(c.slice(0, -5), len);
  const rising = e > ePrev, falling = e < ePrev;
  const p = pivots(bars, 2);
  let hh = false, hl = false, lh = false, ll = false;
  if (p.highs.length >= 2) { hh = p.highs.at(-1).p > p.highs.at(-2).p; lh = p.highs.at(-1).p < p.highs.at(-2).p; }
  if (p.lows.length >= 2) { hl = p.lows.at(-1).p > p.lows.at(-2).p; ll = p.lows.at(-1).p < p.lows.at(-2).p; }
  if (rising && !(lh && ll)) return 'up';      // rising average + structure not clearly down
  if (falling && !(hh && hl)) return 'down';
  return 'flat';
}
function nearestHighAbove(bars, price, s = 2) {
  const hs = pivots(bars, s).highs.map(x => x.p).filter(p => p > price).sort((a, b) => a - b);
  return hs[0] ?? null;
}

// Top-down MULTI-TIMEFRAME ICT engine (LONG setups only). Daily/4H/1H bias -> 1H POI
// -> 15m precise entry. Targets tier 1H=day, 4H=swing, Daily=runner.
// "direction" is INFO ONLY (the trend read up/down/flat); setups & levels are always long.
function analyze(symbol, daily, h4, h1, m15) {
  const price = m15.at(-1).c;
  const f2 = x => x.toFixed(2);

  // ---- MTF bias (Daily, 4H, 1H) ----
  const biasD = biasOf(daily), bias4 = biasOf(h4), bias1 = biasOf(h1);
  const upCount = [biasD, bias4, bias1].filter(b => b === 'up').length;
  const downCount = [biasD, bias4, bias1].filter(b => b === 'down').length;
  const direction = upCount > downCount ? 'long' : downCount > upCount ? 'short' : 'neutral';  // INFO only
  const dC = daily.map(b => b.c);
  const dAbove200 = price > ema(dC, 200);
  const trendOk = biasD === 'up' && bias4 !== 'down' && dAbove200;

  // ---- Daily dealing range -> discount/premium ----
  const dHi = Math.max(...daily.slice(-40).map(b => b.h));
  const dLo = Math.min(...daily.slice(-40).map(b => b.l));
  const discount = price < (dHi + dLo) / 2;

  // ---- 1H point of interest: bullish order block / FVG at-or-below price ----
  let poiTop = null, poiBot = null, poiKind = null;
  for (let i = h1.length - 2; i >= Math.max(1, h1.length - 30); i--) {
    if (h1[i].c < h1[i].o && h1[i].l <= price) { poiTop = h1[i].h; poiBot = h1[i].l; poiKind = '1H order block'; break; }
  }
  for (let i = h1.length - 1; i >= Math.max(2, h1.length - 30); i--) {
    if (h1[i].l > h1[i - 2].h && h1[i - 2].h <= price) {
      const bot = h1[i - 2].h, top = h1[i].l;
      if (poiBot == null || bot > poiBot) { poiTop = top; poiBot = bot; poiKind = '1H fair-value gap'; }
      break;
    }
  }
  const poiPresent = poiBot != null;

  // ---- 15m execution: fresh sweep + break of structure ----
  const n = m15.length;
  const piv = pivots(m15, 2);
  const sHighs = piv.highs, sLows = piv.lows;
  let sweep = false, sweepLow = null, sweepIdx = -1, raided = null;
  for (let i = n - 1; i >= Math.max(2, n - 10); i--) {
    const priorLows = sLows.filter(x => x.i < i);
    const lvl = priorLows.length ? priorLows.at(-1).p : null;
    if (lvl != null && m15[i].l < lvl && m15[i].c > lvl) { sweep = true; sweepLow = m15[i].l; sweepIdx = i; raided = lvl; break; }
  }
  let bosUp = false, legHigh = null;
  if (sweep) {
    const ph = sHighs.filter(x => x.i < sweepIdx).at(-1);
    const ref = ph ? ph.p : null;
    let hi = -Infinity;
    for (let i = sweepIdx; i < n; i++) { if (m15[i].h > hi) hi = m15[i].h; if (ref != null && m15[i].c > ref) bosUp = true; }
    legHigh = hi;
  }
  const legLow = sweep ? sweepLow : (sLows.at(-1)?.p ?? Math.min(...m15.slice(-20).map(b => b.l)));
  const lh = legHigh ?? (sHighs.at(-1)?.p ?? Math.max(...m15.slice(-20).map(b => b.h)));
  const range = Math.max(lh - legLow, 1e-6);

  // ---- Entry: leg-anchored OTE (0.62-0.79 retracement = a real discount pullback), refined by an OB/FVG inside it ----
  const ote62 = lh - 0.62 * range;   // shallow retrace -> Entry-1 (fills first)
  const ote79 = lh - 0.79 * range;   // deep retrace    -> Entry-2
  const oteLo = Math.min(ote62, ote79), oteHi = Math.max(ote62, ote79);
  let refTop = ote62, refBot = ote79, zoneKind = '15m OTE 0.62-0.79 (discount pullback)';
  // refine: a 15m bullish order block (down-candle) overlapping the OTE band = the origin zone
  for (let i = n - 2; i >= Math.max(1, n - 45); i--) {
    if (m15[i].c < m15[i].o && m15[i].l <= oteHi && m15[i].h >= oteLo) {
      refTop = Math.min(m15[i].h, oteHi); refBot = Math.max(m15[i].l, oteLo);
      zoneKind = '15m order block in the OTE zone'; break;
    }
  }
  if (zoneKind.indexOf('order block') < 0) {  // else a 15m bullish FVG inside the OTE band
    for (let i = n - 1; i >= Math.max(2, n - 45); i--) {
      if (m15[i].l > m15[i - 2].h && m15[i].l >= oteLo && m15[i - 2].h <= oteHi) {
        refTop = Math.min(m15[i].l, oteHi); refBot = Math.max(m15[i - 2].h, oteLo);
        zoneKind = '15m FVG in the OTE zone'; break;
      }
    }
  }
  // Entry-1 = shallow edge, Entry-2 = deep edge; clamp at/below price (if price already deep in discount, entries sit near price)
  const entry1 = Math.min(refTop, price * 0.999);
  const entry2 = Math.min(refBot, entry1 * 0.999);
  const entryInPoi = poiPresent && entry1 <= poiTop * 1.004 && entry1 >= poiBot * 0.996;

  // ---- Stop: below the swept liquidity low (structural invalidation) ----
  const structLow = Math.min(legLow, entry2, poiPresent ? poiBot : Infinity);
  const stop = structLow - 0.0015 * structLow;

  // ---- Tiered targets: 1H (day) -> 4H (swing) -> Daily (runner) ----
  let T1 = nearestHighAbove(h1, price, 2) ?? (price + 0.5 * range);
  let T2 = nearestHighAbove(h4, Math.max(price, T1), 2) ?? (T1 + 0.8 * range);
  let T3 = nearestHighAbove(daily, Math.max(T1, T2), 3) ?? (T2 + 1.0 * range);
  if (T1 <= price) T1 = price + 0.3 * range;
  if (T2 <= T1) T2 = T1 + Math.max(0.5 * (T1 - entry1), 0.4 * range);
  if (T3 <= T2) T3 = T2 + Math.max(0.5 * (T2 - T1), 0.4 * range);
  const riskU = Math.max(entry1 - stop, 1e-6);
  const rr1 = (T1 - entry1) / riskU;

  // ---- MTF score ----
  const entryDisc = entry1 < (dHi + dLo) / 2;   // entry itself sits in the discount half
  const flags = {
    dailyUp: biasD === 'up', fourHUp: bias4 === 'up', oneHUp: bias1 === 'up',
    discount, poi: poiPresent, entryDisc, sweep, goodTarget: rr1 >= 1.0,
  };
  const score = Object.values(flags).filter(Boolean).length;
  const goodR = rr1 >= 1.0;
  let action = 'AVOID';
  if (trendOk && sweep && goodR && entryInPoi && score >= 7) action = 'BUY';
  else if (trendOk && sweep && goodR && score >= 5) action = 'ACCUMULATE';
  else if (score >= 3) action = 'WATCH';
  const grade = upCount === 3 ? 'A' : upCount === 2 ? 'B' : 'C';

  // ---- Basis: top-down MTF story ----
  const bp = [];
  bp.push(`bias: Daily ${biasD}, 4H ${bias4}, 1H ${bias1} (trend ${direction}, grade ${grade})`);
  bp.push(discount ? 'price in daily discount (good value)' : 'price in daily premium (chasing)');
  bp.push(poiPresent ? `pulling into a ${poiKind} (${f2(poiBot)}-${f2(poiTop)})` : 'no clean 1H demand zone below yet');
  bp.push(sweep ? `15m grabbed liquidity (swept ${f2(raided ?? legLow)})${bosUp ? ' and broke structure up' : ''}` : 'no fresh 15m liquidity grab yet');
  bp.push(`entry in the ${zoneKind}: ${f2(entry2)} (deep 0.79) to ${f2(entry1)} (shallow 0.62)${entryInPoi ? ', inside the 1H zone' : ''}`);
  bp.push(`targets: TP1 ${f2(T1)} = 1H liquidity (day) -> TP2 ${f2(T2)} = 4H liquidity (swing) -> TP3 ${f2(T3)} = daily liquidity (runner)`);
  if (direction === 'short') bp.push('heads-up: overall trend is DOWN, so a long here is counter-trend (lower odds)');
  const basis = bp.join('; ');

  return {
    symbol, price: +price.toFixed(2), score, action, basis, grade, direction,
    leveraged: LEVERAGED.has(symbol), holding: HOLDINGS.has(symbol),
    bias: trendOk ? 'bull' : 'weak', zone: discount ? 'discount' : 'premium',
    flags,
    levels: {
      entry1: +entry1.toFixed(2), entry2: +entry2.toFixed(2), stop: +stop.toFixed(2),
      tp1: +T1.toFixed(2), tp2: +T2.toFixed(2), tp3: +T3.toFixed(2), rr: +rr1.toFixed(2),
    },
  };
}

async function scanOne(symbol) {
  try {
    const [daily, h1, m15] = await Promise.all([
      fetchCandles(symbol, '1d', '1y'),
      fetchCandles(symbol, '60m', '3mo'),
      fetchCandles(symbol, '15m', '1mo'),
    ]);
    if (daily.length < 200 || h1.length < 40 || m15.length < 60) return { symbol, error: `insufficient data` };
    const h4 = resample(h1, 4);
    return analyze(symbol, daily, h4, h1, m15);
  } catch (e) { return { symbol, error: e.message }; }
}

function buildReport(rows, errs, exitRows = [], optIdeas = { calls: [], puts: [] }) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const data = JSON.stringify(rows.map(r => ({ sym: r.symbol, score: r.score, action: r.action, grade: r.grade, dir: r.direction, price: r.price, bias: r.bias, zone: r.zone, hold: r.holding ? 1 : 0, lev: r.leveraged ? 1 : 0, basis: r.basis, ...r.levels })));
  const skipped = errs.length ? ' &middot; skipped: ' + errs.map(e => e.symbol).join(', ') : '';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let brHtml = '';
  try {
    const bf = join(__reportDir, 'briefing.json');
    if (existsSync(bf)) {
      const b = JSON.parse(readFileSync(bf, 'utf8'));
      brHtml = '<h2 style="font-size:16px;font-weight:600;margin:14px 0 6px">Today\'s briefing</h2>'
        + '<div style="border:1px solid var(--line);border-radius:10px;padding:12px 16px;line-height:1.65;font-size:14px">'
        + esc(b.text).replace(/\n/g, '<br>')
        + '<div class="sub" style="margin:8px 0 0">' + esc(b.ts) + ' ET</div></div>';
    }
  } catch (e) {}
  let events = [];
  try { const ef = join(__reportDir, 'events.json'); if (existsSync(ef)) events = JSON.parse(readFileSync(ef, 'utf8')); } catch (e) {}
  const nowMs = Date.now();
  const MAXAGE = 36 * 3600 * 1000; // only show events from the last 36 hours
  events = events
    .map(e => ({ ...e, _t: e.epoch != null ? e.epoch : (Date.parse(String(e.ts).replace(',', '')) || 0) }))
    .sort((a, b) => b._t - a._t)
    .filter(e => e._t === 0 || (nowMs - e._t) <= MAXAGE)
    .slice(0, 8); // newest 8 only
  let evHtml = '<h2 style="font-size:16px;font-weight:600;margin:18px 0 6px">Market events <span style="font-size:12px;font-weight:400;color:var(--muted)">(last 36h, newest 8)</span></h2>';
  if (events.length) {
    evHtml += '<table><thead><tr><th style="width:130px">Time (ET)</th><th>Event</th><th>Triggers</th></tr></thead><tbody>'
      + events.map(e => '<tr><td style="color:var(--muted);font-size:12px">' + esc(e.ts) + '</td>'
        + '<td>' + esc(e.headline) + '</td>'
        + '<td style="font-size:12px;color:var(--muted)">' + esc(e.detail || '') + '</td></tr>').join('')
      + '</tbody></table>';
  } else {
    evHtml += '<div class="sub">No material market events in the last 36 hours.</div>';
  }
  // Raw market headlines: always-on free feed (separate from the AI-analyzed events above).
  let hlHtml = '';
  try {
    const hf = join(__reportDir, 'headlines.json');
    if (existsSync(hf)) {
      let hl = JSON.parse(readFileSync(hf, 'utf8'))
        .map(e => ({ ...e, _t: e.epoch != null ? e.epoch : (Date.parse(String(e.ts).replace(',', '')) || 0) }))
        .sort((a, b) => b._t - a._t).slice(0, 8);
      if (hl.length) {
        hlHtml = '<h2 style="font-size:16px;font-weight:600;margin:18px 0 6px">Latest headlines <span style="font-size:12px;font-weight:400;color:var(--muted)">(live feed — not analyzed)</span></h2>'
          + '<table><thead><tr><th style="width:130px">Time (ET)</th><th>Headline</th><th>Source</th></tr></thead><tbody>'
          + hl.map(e => '<tr><td style="color:var(--muted);font-size:12px">' + esc(e.ts) + '</td>'
            + '<td>' + esc(e.headline) + '</td>'
            + '<td style="font-size:12px;color:var(--muted)">' + esc(e.detail || '') + '</td></tr>').join('')
          + '</tbody></table>';
      }
    }
  } catch (e) {}
  const exCol = s => s === 'SELL' ? '#dc2626' : s === 'TRIM' ? '#d97706' : s === 'WATCH' ? '#6b7280' : s === 'NEW' ? '#6b7280' : '#16a34a';
  let exHtml = '';
  if (exitRows && exitRows.length) {
    const money = n => '$' + Math.abs(Math.round(n)).toLocaleString('en-US');
    const totEq = exitRows.reduce((s, r) => s + r.price * (r.shares || 0), 0);
    const totPnl = exitRows.reduce((s, r) => s + (r.pnl || 0), 0);
    exHtml = '<h2 style="font-size:16px;font-weight:600;margin:18px 0 6px">Holdings &mdash; exit watch</h2>'
      + '<div class="sub">' + exitRows.length + ' holdings &middot; total value ' + money(totEq) + ' &middot; total gain/loss <span style="color:' + (totPnl >= 0 ? '#16a34a' : '#dc2626') + '">' + (totPnl >= 0 ? '+' : '-') + money(totPnl) + '</span></div>'
      + '<table><thead><tr><th>Signal</th><th title="Trend health across Daily/4H/1H. A=all up (healthy), C=broken">Grade</th><th title="overall trend Daily/4H/1H">Trend</th><th>Holding</th><th class="r">Price now</th><th class="r">Your cost</th><th class="r">Gain/loss</th><th class="r">Safety price</th><th class="r">Avg price</th><th>What to do</th><th>Basis (why)</th></tr></thead><tbody>'
      + exitRows.map(r => '<tr><td><span class="pill" style="color:' + exCol(r.status) + '">' + r.status + '</span></td>'
        + '<td style="font-weight:600;color:' + (r.grade === 'A' ? '#16a34a' : r.grade === 'B' ? '#d97706' : '#6b7280') + '">' + (r.grade || '-') + '</td>'
        + '<td style="font-weight:600;color:' + (r.trend === 'up' ? '#16a34a' : r.trend === 'down' ? '#dc2626' : '#6b7280') + '">' + (r.trend === 'up' ? 'UP' : r.trend === 'down' ? 'DOWN' : 'flat') + '</td>'
        + '<td><b>' + r.sym + '</b>' + (r.lev ? ' <span class="tag" style="color:#d97706;border-color:#d97706">LEV</span>' : '') + (r.winner ? ' <span class="tag" style="color:#16a34a;border-color:#16a34a">WIN</span>' : '') + '</td>'
        + '<td class="r">' + r.price.toFixed(2) + '</td>'
        + '<td class="r" style="color:var(--muted)">' + (r.cost != null ? r.cost.toFixed(2) : '-') + '</td>'
        + '<td class="r" style="color:' + ((r.pnl || 0) >= 0 ? '#16a34a' : '#dc2626') + '">' + (r.pnl != null ? ((r.pnl >= 0 ? '+' : '-') + money(r.pnl) + ' (' + (r.pnlPct >= 0 ? '+' : '') + r.pnlPct.toFixed(1) + '%)') : '-') + '</td>'
        + '<td class="r">' + r.stop + ' <span style="color:var(--muted)">(' + r.distPct.toFixed(1) + '%)</span></td>'
        + '<td class="r">' + r.ema50.toFixed(2) + '</td>'
        + '<td style="font-size:12px;color:' + exCol(r.status) + '" title="' + esc(r.reason) + '">' + r.sellAt + '</td>'
        + '<td style="font-size:11px;color:var(--muted);max-width:340px;line-height:1.45">' + esc(r.basis || '') + '</td></tr>').join('')
      + '</tbody></table>';
  }
  // Recommended options (Day/Swing/Runner tiers) - rendered by the shared module.
  const optHtml = renderOptionsHtml(optIdeas);
  const __out = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="refresh" content="300"><title>SMC scan</title><style>'
    + ':root{--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb}'
    + '@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8e8e8;--muted:#9aa0aa;--line:#272b32}}'
    + 'body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:20px}'
    + 'h1{font-size:20px;font-weight:600;margin:0 0 2px}.sub{color:var(--muted);font-size:13px;margin-bottom:16px}'
    + '.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}'
    + 'select{padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px}'
    + 'label{font-size:13px;display:flex;align-items:center;gap:5px}#count{font-size:13px;color:var(--muted);margin-bottom:8px}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-weight:500;padding:8px 6px;border-bottom:2px solid var(--line)}'
    + 'td{padding:8px 6px;border-bottom:1px solid var(--line)}.r{text-align:right;font-variant-numeric:tabular-nums}'
    + '.pill{border:1px solid currentColor;padding:2px 8px;border-radius:6px;font-weight:600;font-size:12px;white-space:nowrap}'
    + '.tag{font-size:11px;padding:1px 5px;border-radius:5px;margin-left:4px;border:1px solid}footer{margin-top:16px;color:var(--muted);font-size:12px}'
    + '.tbl{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;margin-bottom:4px}'
    + '@media(max-width:680px){body{padding:12px}h1{font-size:18px}.sub{font-size:12px}table{font-size:12px}th,td{padding:7px 6px}.controls{gap:6px}select{flex:1 1 auto}}'
    + '</style></head><body>'
    + '<h1>SMC scan</h1><div class="sub">Generated ' + ts + ' ET &middot; ' + rows.length + ' scanned' + skipped + ' &middot; auto-reloads every 5 min &middot; not financial advice</div>'
    + brHtml
    + evHtml
    + hlHtml
    + exHtml
    + optHtml
    + '<h2 style="font-size:16px;font-weight:600;margin:22px 0 6px">Buy scan</h2>'
    + '<div class="controls">'
    + '<select id="f-score"><option value="5">Actionable (score &ge; 5)</option><option value="7">Buy only (&ge; 7)</option><option value="3">Watch &amp; up (&ge; 3)</option><option value="0">All</option></select>'
    + '<select id="f-sort"><option value="score">Sort: score</option><option value="rr">Sort: reward/risk</option><option value="price">Sort: price</option><option value="sym">Sort: symbol</option></select>'
    + '<label><input type="checkbox" id="f-rr">R &ge; 2</label><label><input type="checkbox" id="f-hold">My holdings</label><label><input type="checkbox" id="f-lev">Hide leveraged</label>'
    + '</div><div id="count"></div>'
    + '<table><thead><tr><th>Symbol</th><th>Score</th><th title="A=Daily/4H/1H all aligned, B=2 aligned, C=weak">Grade</th><th title="overall trend (info only - setups are long)">Trend</th><th>Action</th><th class="r">Price</th><th class="r">Entry zone</th><th class="r">Stop</th><th class="r">TP1 day &middot; TP2 swing &middot; TP3 run</th><th class="r">R</th><th>Basis (why)</th></tr></thead><tbody id="tb"></tbody></table>'
    + '<footer>HOLD = you own it &middot; LEV = leveraged ETF, tactical only (decay) &middot; mechanical heuristics, confirm on chart &middot; nothing places orders</footer>'
    + '<script>var DATA=' + data + ';'
    + 'var $=function(id){return document.getElementById(id)};'
    + 'function fmt(n){return n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}'
    + 'function ac(a){return a==="BUY"?"#16a34a":a==="ACCUMULATE"?"#2563eb":a==="SHORT"?"#dc2626":a==="SHORT-SCALE"?"#d97706":a==="WATCH"?"#6b7280":"#6b7280"}'
    + 'function al(a){return a==="BUY"?"BUY":a==="ACCUMULATE"?"ACCUM":a==="SHORT"?"SHORT":a==="SHORT-SCALE"?"SHORT+":a==="WATCH"?"WATCH":"AVOID"}'
    + 'function gcol(g){return g==="A"?"#16a34a":g==="B"?"#d97706":"#6b7280"}'
    + 'function render(){var mS=+$("f-score").value,so=$("f-sort").value,q2=$("f-rr").checked,ho=$("f-hold").checked,hl=$("f-lev").checked;'
    + 'var rows=DATA.filter(function(r){return r.score>=mS});if(q2)rows=rows.filter(function(r){return r.rr>=2});if(ho)rows=rows.filter(function(r){return r.hold});if(hl)rows=rows.filter(function(r){return !r.lev});'
    + 'rows.sort(function(a,b){return so==="sym"?a.sym.localeCompare(b.sym):so==="price"?b.price-a.price:(b[so]-a[so])||(b.score-a.score)});'
    + '$("count").textContent="Showing "+rows.length+" of "+DATA.length+" \\u2014 "+rows.filter(function(r){return r.score>=5}).length+" actionable";'
    + 'var h="";for(var i=0;i<rows.length;i++){var r=rows[i];'
    + 'var tg=(r.hold?"<span class=tag style=\\"color:#2563eb;border-color:#2563eb\\">HOLD</span>":"")+(r.lev?"<span class=tag style=\\"color:#d97706;border-color:#d97706\\">LEV</span>":"");'
    + 'var zc=r.zone==="discount"?"#16a34a":"#d97706";var rc=r.rr>=2?"#16a34a":"var(--muted)";var sc=r.score>=7?"#16a34a":r.score>=5?"#2563eb":r.score>=3?"var(--muted)":"#dc2626";'
    + 'h+="<tr><td><b>"+r.sym+"</b>"+tg+"</td>"'
    + '+"<td style=\\"color:"+sc+";font-weight:600\\">"+r.score+"/8</td>"'
    + '+"<td style=\\"color:"+gcol(r.grade)+";font-weight:600\\">"+(r.grade||"-")+"</td>"'
    + '+"<td style=\\"font-weight:600;color:"+(r.dir==="short"?"#dc2626":r.dir==="long"?"#16a34a":"#6b7280")+"\\">"+(r.dir==="short"?"DOWN":r.dir==="long"?"UP":"flat")+"</td>"'
    + '+"<td><span class=pill style=\\"color:"+ac(r.action)+"\\">"+al(r.action)+"</span></td>"'
    + '+"<td class=r>"+fmt(r.price)+"</td>"'
    + '+"<td class=r>"+fmt(r.entry1)+"\\u2013"+fmt(r.entry2)+"<div style=\\"font-size:11px;color:"+zc+"\\">"+r.zone+"</div></td>"'
    + '+"<td class=r style=\\"color:#dc2626\\">"+fmt(r.stop)+"</td>"'
    + '+"<td class=r style=\\"color:var(--muted)\\">"+fmt(r.tp1)+" \\u00b7 <span style=\\"color:var(--fg)\\">"+fmt(r.tp2)+"</span> \\u00b7 "+fmt(r.tp3)+"</td>"'
    + '+"<td class=r style=\\"color:"+rc+";font-weight:600\\">"+r.rr.toFixed(1)+"R</td>"'
    + '+"<td style=\\"font-size:11px;color:var(--muted);max-width:360px;line-height:1.45\\">"+(r.basis||"")+"</td></tr>"}'
    + 'if(!rows.length)h="<tr><td colspan=11 style=\\"padding:16px;text-align:center;color:var(--muted)\\">No setups match these filters.</td></tr>";$("tb").innerHTML=h}'
    + '["f-score","f-sort","f-rr","f-hold","f-lev"].forEach(function(id){$(id).addEventListener("input",render)});render();'
    + '</scr' + 'ipt></body></html>';
  // Wrap every table in a horizontal-scroll container so wide tables swipe cleanly on phones.
  return __out.replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, '</table></div>');
}

async function main() {
  let symbols = subset.length ? subset : [...new Set(Object.values(UNIVERSE).flat())];
  const results = [];
  // light throttle to be gentle on Yahoo
  for (const s of symbols) { results.push(await scanOne(s)); await new Promise(r => setTimeout(r, 120)); }

  const ok = results.filter(r => !r.error).sort((a, b) => b.score - a.score);
  const errs = results.filter(r => r.error);

  // holdings exit-watch rows for the dashboard
  const exitRows = [];
  for (const [sym, cfg] of Object.entries(EXIT_HOLDINGS)) {
    const row = await exitOne(sym, cfg);   // handles full structure + limited-data (new IPO) holdings
    if (row && !row.error) exitRows.push(row);
    await new Promise(r => setTimeout(r, 120));
  }
  exitRows.sort((a, b) => (EXIT_RANK[b.status] ?? 0) - (EXIT_RANK[a.status] ?? 0));

  // directional options ideas from the scan (calls on bullish, puts on bearish) - best effort
  let optIdeas = { calls: [], puts: [] };
  try { optIdeas = await buildOptionsIdeas(ok, Date.now()); } catch (e) { console.error('options ideas failed:', e.message); }

  try { writeFileSync(join(__reportDir, 'report.html'), buildReport(ok, errs, exitRows, optIdeas)); console.error('report -> ' + join(__reportDir, 'report.html')); } catch (e) { console.error('report write failed:', e.message); }

  if (reportOnly) { console.error('report-only: report.html regenerated, alert state untouched'); return; }

  // --- alert-only change detection (vs previous run) ---
  const ACTIONABLE = new Set(['BUY', 'ACCUMULATE']);
  const act5 = ok.filter(r => ACTIONABLE.has(r.action)).map(r => r.symbol);
  const buy7 = ok.filter(r => r.action === 'BUY').map(r => r.symbol);
  const stateFile = join(__reportDir, 'state.json');
  let prev = { actionable: null, buys: [] };
  try { if (existsSync(stateFile)) prev = JSON.parse(readFileSync(stateFile, 'utf8')); } catch (e) {}
  const firstRun = prev.actionable == null;
  const seteq = (a, b) => a.length === b.length && a.every(x => b.includes(x));
  const actChanged = !firstRun && !seteq([...act5].sort(), [...(prev.actionable || [])].sort());
  const newBuys = buy7.filter(s => !(prev.buys || []).includes(s));
  const added = act5.filter(s => !(prev.actionable || []).includes(s));
  const removed = (prev.actionable || []).filter(s => !act5.includes(s));
  const alertWorthy = firstRun ? buy7.length > 0 : (actChanged || newBuys.length > 0);
  try { writeFileSync(stateFile, JSON.stringify({ actionable: act5, buys: buy7, ts: Date.now() })); } catch (e) {}
  const changeBits = [];
  if (newBuys.length) changeBits.push('new strong setup: ' + newBuys.join(', '));
  if (added.length) changeBits.push('+actionable: ' + added.join(', '));
  if (removed.length) changeBits.push('-actionable: ' + removed.join(', '));
  if (!asJson) {
    console.log('ALERT: ' + (alertWorthy ? 'yes' : 'no'));
    if (changeBits.length) console.log('CHANGES: ' + changeBits.join(' | '));
    console.log('');
  }

  if (asJson) { console.log(JSON.stringify({ generated: new Date().toISOString(), results: ok, errors: errs }, null, 2)); return; }

  const buys = ok.filter(r => ACTIONABLE.has(r.action));
  console.log(`SMC SCAN — ${ok.length} scanned, ${buys.length} actionable buy setups\n`);
  const icon = a => a === 'BUY' ? 'BUY  ' : a === 'ACCUMULATE' ? 'ACCUM' : a === 'SHORT' ? 'SHORT' : a === 'SHORT-SCALE' ? 'SHRT+' : a === 'WATCH' ? 'WATCH' : 'AVOID';
  for (const r of buys) {
    const tags = [r.holding ? 'HOLDING' : '', r.leveraged ? 'LEVERAGED/tactical' : ''].filter(Boolean).join(' ');
    const L = r.levels;
    console.log(`${icon(r.action)} ${r.symbol.padEnd(5)} ${String(r.score)}/8  $${r.price}  ${r.bias}/${r.zone} ${tags}`);
    console.log(`      E1 ${L.entry1} | E2 ${L.entry2} | Stop ${L.stop} | TP1 ${L.tp1} | TP2 ${L.tp2} | TP3 ${L.tp3} | ~${L.rr}R`);
  }
  if (!buys.length) console.log('(no actionable long/short setups this run)');
  const watch = ok.filter(r => r.action === 'WATCH').map(r => `${r.symbol}(${r.score})`);
  if (watch.length) console.log(`\nWATCH: ${watch.join(', ')}`);
  if (errs.length) console.log(`\nskipped: ${errs.map(e => e.symbol).join(', ')}`);
}

main();
