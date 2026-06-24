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
import { analyzeExit as analyzeExitH, HOLDINGS as EXIT_HOLDINGS, RANK as EXIT_RANK, exitOne, volumeProfile, vpConfluence } from './scan_exits.mjs';
import { buildOptionsIdeas, renderOptionsHtml } from './options_ideas.mjs';

const HOLDINGS = new Set(Object.keys(EXIT_HOLDINGS)); // derived from holdings secret (single source of truth)
const LEVERAGED = new Set(['SOXL','SOXS','NVDU','NVDD','TECL','TECS','WEBL','WEBS','TQQQ','SQQQ','SPXL','SPXS','TNA','TZA','ERX','ERY','GUSH','DRIP','AAPU','MSFU','AMZU','GGLL','METU','SPCH','SSPC']);

const UNIVERSE = {
  Semiconductors: ['NVDA','AVGO','AMD','TSM','MU','AMAT','LRCX','KLAC','SMCI','SMH','ARM','MRVL','ASML','TXN','QCOM','ADI','ON','MCHP','CRDO','ALAB','SOXL','SOXS','NVDU','NVDD'],
  'AI / Big tech': ['PLTR','MSFT','GOOGL','META','AMZN','SNOW','CRWD','TSLA','AAPL','NFLX','ORCL','ANET','NOW','PANW','NET','ZS','DDOG','CRM','TECL','TECS','WEBL','WEBS','AAPU','MSFU','AMZU','GGLL','METU'],
  'Tech broad': ['QQQ','XLK','TQQQ','SQQQ'],
  Space: ['SPCX','SPCH','SSPC','RKLB','ASTS','LUNR','RDW'],
  'Nuclear / Uranium': ['CCJ','CEG','VST','OKLO','SMR','LEU','URA'],
  Quantum: ['IONQ','RGTI','QBTS'],
  'Crypto equities': ['COIN','MSTR','HOOD','MARA'],
  'Defense / Drones': ['AVAV','KTOS','LMT','RTX'],
  'Rare earths / Minerals': ['MP','ALB','LAC'],
  Energy: ['XOM','CVX','OXY','SLB','COP','XLE','ERX','ERY','GUSH','DRIP'],
  'Index / regime': ['SPY','IWM','SPXL','SPXS','TNA','TZA'],
  Diversifiers: ['XLF','XLV','GLD','GDX'],
};

// Liquidity gate (LOOSE per user): price >= $3 and >= $15M average daily dollar-volume.
// Disciplined safety net - a curated universe should already pass, but this auto-drops
// anything thin/penny from the BUY candidates regardless of how it got onto the list.
const MIN_PRICE = 3;
const MIN_ADV_USD = 15e6;
function liquidityOf(daily, price) {
  const last = daily.slice(-20);
  const advUsd = last.length ? last.reduce((s, b) => s + b.c * (b.v || 0), 0) / last.length : 0;
  return { advUsd: Math.round(advUsd), illiquid: price < MIN_PRICE || advUsd < MIN_ADV_USD };
}

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
function avgVol(bars, n = 20) { const s = bars.slice(-n); return s.length ? s.reduce((a, b) => a + b.v, 0) / s.length : 0; }
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
function nearestLowBelow(bars, price, s = 2) {
  const ls = pivots(bars, s).lows.map(x => x.p).filter(p => p < price).sort((a, b) => b - a);
  return ls[0] ?? null;
}

// Proper swing-structure state machine: walks fractal pivots in time order, labels each
// swing HH/HL/LH/LL, tracks bull/bear/range state, and surfaces the latest BOS (break in
// the trend = continuation) vs ChoCH (break against = potential reversal). A live close
// beyond the last confirmed swing counts as an in-progress break.
function structure(bars, s = 2) {
  const piv = pivots(bars, s);
  const pts = [...piv.highs.map(h => ({ i: h.i, p: h.p, k: 'H' })), ...piv.lows.map(l => ({ i: l.i, p: l.p, k: 'L' }))].sort((a, b) => a.i - b.i);
  let state = 'range', lastH = null, lastL = null, label = null, event = null, eventLevel = null;
  for (const pt of pts) {
    if (pt.k === 'H') {
      if (lastH != null) {
        if (pt.p > lastH) { label = 'HH'; if (state === 'bear') { event = 'ChoCH-up'; eventLevel = lastH; } else if (state === 'bull') { event = 'BOS-up'; eventLevel = lastH; } state = 'bull'; }
        else label = 'LH';
      }
      lastH = pt.p;
    } else {
      if (lastL != null) {
        if (pt.p < lastL) { label = 'LL'; if (state === 'bull') { event = 'ChoCH-down'; eventLevel = lastL; } else if (state === 'bear') { event = 'BOS-down'; eventLevel = lastL; } state = 'bear'; }
        else label = 'HL';
      }
      lastL = pt.p;
    }
  }
  const c = bars.at(-1).c;
  if (lastH != null && c > lastH) { event = state === 'bear' ? 'ChoCH-up' : 'BOS-up'; eventLevel = lastH; state = 'bull'; }
  else if (lastL != null && c < lastL) { event = state === 'bull' ? 'ChoCH-down' : 'BOS-down'; eventLevel = lastL; state = 'bear'; }
  return { state, bias: state === 'bull' ? 'up' : state === 'bear' ? 'down' : 'flat', label, event, eventLevel };
}

// SMT (Smart-Money Technique) divergence: a name and a correlated anchor (its sector ETF /
// index) should sweep liquidity together. If the name makes a fresh extreme the anchor
// refuses to confirm, that non-confirmation is an institutional tell. Anchors fetched once.
const SMT_ANCHORS = ['SMH', 'QQQ', 'SPY', 'XLE', 'IWM'];
function anchorFor(sym) {
  if (UNIVERSE.Semiconductors.includes(sym)) return sym === 'SMH' ? 'QQQ' : 'SMH';
  if (UNIVERSE['AI / Big tech'].includes(sym) || UNIVERSE['Tech broad'].includes(sym)) return sym === 'QQQ' ? 'SMH' : 'QQQ';
  if (UNIVERSE.Energy.includes(sym)) return sym === 'XLE' ? 'SPY' : 'XLE';
  if (UNIVERSE['Index / regime'].includes(sym)) return sym === 'SPY' ? 'QQQ' : 'SPY';
  if (UNIVERSE.Space.includes(sym)) return 'QQQ';
  if (UNIVERSE['Nuclear / Uranium'].includes(sym)) return 'XLE';        // power/utility cohort vs energy
  if (UNIVERSE.Quantum.includes(sym)) return 'QQQ';                     // high-beta tech vs Nasdaq
  if (UNIVERSE['Crypto equities'].includes(sym)) return 'QQQ';          // risk-on proxy vs Nasdaq
  if (UNIVERSE['Defense / Drones'].includes(sym)) return 'SPY';         // industrials vs broad market
  if (UNIVERSE['Rare earths / Minerals'].includes(sym)) return 'XLE';   // materials cohort vs energy/commodity
  return 'SPY';
}

// Ranked LIQUIDITY DRAWS in the trade direction — the levels price is actually hunting,
// nearest-first, each with a human label. Sources, strongest first: equal highs/lows
// (stacked stops), prior day/week high-low (PDH/PDL/PWH/PWL), raw swing pivots (1H/4H/D),
// and the nearest unfilled fair-value gap (an imbalance magnet). Near-equal levels merge.
function liquidityDraws(dir, price, h1, h4, daily, atrRef) {
  const above = dir === 'long';
  const beyondPx = p => above ? p > price * 1.0006 : p < price * 0.9994;
  const tol = Math.max(atrRef * 0.2, price * 0.0012);
  const out = [];
  for (const [bars, s, tf] of [[h1, 2, '1H'], [h4, 2, '4H'], [daily, 3, 'D']]) {
    const lv = (above ? pivots(bars, s).highs : pivots(bars, s).lows).map(x => x.p).filter(beyondPx).sort((a, b) => a - b);
    const used = new Array(lv.length).fill(false);
    for (let i = 0; i < lv.length; i++) {
      if (used[i]) continue;
      const cluster = [lv[i]];
      for (let j = i + 1; j < lv.length; j++) if (!used[j] && Math.abs(lv[j] - lv[i]) <= tol) { cluster.push(lv[j]); used[j] = true; }
      const p = above ? Math.max(...cluster) : Math.min(...cluster);
      out.push({ p, type: cluster.length >= 2 ? `EQ${above ? 'H' : 'L'} ${tf}` : `${tf} swing`, str: cluster.length >= 2 ? 3 : 1 });
    }
  }
  if (daily.length >= 12) {
    const pd = daily[daily.length - 2], pw = daily.slice(-11, -6);
    const pwH = Math.max(...pw.map(b => b.h)), pwL = Math.min(...pw.map(b => b.l));
    for (const [p, t] of (above ? [[pd.h, 'PDH'], [pwH, 'PWH']] : [[pd.l, 'PDL'], [pwL, 'PWL']])) if (beyondPx(p)) out.push({ p, type: t, str: 2 });
  }
  // nearest OPPOSING order block to mitigate (supply above for longs / demand below for shorts),
  // targeted at its consequent encroachment = 50% of the OB. Requires displacement away from it.
  for (let i = h1.length - 4; i >= Math.max(2, h1.length - 40); i--) {
    const isOpp = above ? (h1[i].c > h1[i].o) : (h1[i].c < h1[i].o);
    if (!isOpp) continue;
    let disp = false;
    for (let k = i + 1; k <= Math.min(h1.length - 1, i + 3); k++) if ((above ? h1[i].l - h1[k].c : h1[k].c - h1[i].h) >= atrRef) { disp = true; break; }
    if (!disp) continue;
    const ce = (h1[i].h + h1[i].l) / 2;
    if (beyondPx(ce)) { out.push({ p: ce, type: 'opp OB (CE)', str: 2 }); break; }
  }
  // nearest unfilled fair-value gap, targeted at its consequent encroachment = 50% of the gap
  for (let i = h1.length - 1; i >= Math.max(2, h1.length - 40); i--) {
    const ce = above ? (h1[i].l > h1[i - 2].h ? (h1[i].l + h1[i - 2].h) / 2 : null) : (h1[i].h < h1[i - 2].l ? (h1[i].h + h1[i - 2].l) / 2 : null);
    if (ce != null && beyondPx(ce)) { out.push({ p: ce, type: '1H FVG (CE)', str: 2 }); break; }
  }
  out.sort((a, b) => above ? a.p - b.p : b.p - a.p);
  const ded = [];
  for (const d of out) { const c = ded.find(x => Math.abs(x.p - d.p) <= tol); if (!c) ded.push(d); else if (d.str > c.str) { c.type = d.type; c.str = d.str; } }
  return ded;
}

// Top-down MULTI-TIMEFRAME ICT engine — BIDIRECTIONAL (long & short). Daily/4H/1H bias
// picks the side; a swing-structure state machine (HH/HL/LH/LL + BOS/ChoCH) + 1H POI
// (OB/FVG/breaker, displacement-validated + freshness/mitigation) -> 15m liquidity sweep
// (volume + SMT-divergence confirmed) -> OTE entry. 12-point confluence.
// Targets tier 1H=day, 4H=swing, Daily=runner (upside for longs, downside for shorts).
const MAXSCORE = 12;
function analyze(symbol, daily, h4, h1, m15, anchors) {
  const price = m15.at(-1).c;
  const f2 = x => x.toFixed(2);

  // ---- MTF bias (Daily, 4H, 1H) -> hunt the favored side ----
  const biasD = biasOf(daily), bias4 = biasOf(h4), bias1 = biasOf(h1);
  const upCount = [biasD, bias4, bias1].filter(b => b === 'up').length;
  const downCount = [biasD, bias4, bias1].filter(b => b === 'down').length;
  const trend = upCount > downCount ? 'long' : downCount > upCount ? 'short' : 'neutral'; // true MTF read (info)
  const dir = trend === 'short' ? 'short' : 'long';   // neutral defaults to long (dip-buy bias)
  const sign = dir === 'long' ? 1 : -1;
  const beyond = (a, b) => sign * (a - b) > 0;         // a further in profit direction than b
  const dC = daily.map(b => b.c);
  const ema200d = ema(dC, 200);
  const trendOk = dir === 'long'
    ? (biasD === 'up' && bias4 !== 'down' && price > ema200d)
    : (biasD === 'down' && bias4 !== 'up' && price < ema200d);

  // ---- Daily dealing range -> discount/premium (longs want discount, shorts want premium) ----
  const dHi = Math.max(...daily.slice(-40).map(b => b.h));
  const dLo = Math.min(...daily.slice(-40).map(b => b.l));
  const mid = (dHi + dLo) / 2;
  const goodLocation = dir === 'long' ? price < mid : price > mid;
  const atr1 = atr(h1, 14) || price * 0.01, atrDaily = atr(daily, 14);
  const n = m15.length;

  // ---- 1H POI on the trade side: OB / FVG, displacement-validated, freshness(mitigation) + breaker ----
  let poiTop = null, poiBot = null, poiKind = null, poiIdx = -1, displaced = false, fresh = false, breaker = false;
  let firstOB = null;
  for (let i = h1.length - 2; i >= Math.max(1, h1.length - 30); i--) {
    const isOB = dir === 'long' ? (h1[i].c < h1[i].o && h1[i].l <= price) : (h1[i].c > h1[i].o && h1[i].h >= price);
    if (!isOB) continue;
    // displacement: strong move OUT of the OB in trade dir within ~3 bars, or an FVG just after
    let disp = false;
    for (let k = i + 1; k <= Math.min(h1.length - 1, i + 3); k++) if (sign * (h1[k].c - h1[i].c) >= 1.2 * atr1) { disp = true; break; }
    if (!disp && i + 2 <= h1.length - 1) disp = dir === 'long' ? (h1[i + 2].l > h1[i].h) : (h1[i + 2].h < h1[i].l);
    if (disp) { poiTop = h1[i].h; poiBot = h1[i].l; poiKind = '1H order block'; poiIdx = i; displaced = true; break; }
    if (!firstOB) firstOB = { top: h1[i].h, bot: h1[i].l, idx: i };
  }
  if (poiBot == null && firstOB) { poiTop = firstOB.top; poiBot = firstOB.bot; poiKind = '1H order block'; poiIdx = firstOB.idx; displaced = false; }
  if (poiBot == null) {   // no OB -> nearest FVG imbalance on our side (an FVG is itself displacement)
    for (let i = h1.length - 1; i >= Math.max(2, h1.length - 30); i--) {
      const isFVG = dir === 'long' ? (h1[i].l > h1[i - 2].h && h1[i - 2].h <= price) : (h1[i].h < h1[i - 2].l && h1[i - 2].l >= price);
      if (!isFVG) continue;
      const a = dir === 'long' ? h1[i].l : h1[i].h, b = dir === 'long' ? h1[i - 2].h : h1[i - 2].l;
      poiTop = Math.max(a, b); poiBot = Math.min(a, b); poiKind = '1H fair-value gap'; poiIdx = i; displaced = true; break;
    }
  }
  // freshness (mitigation): the zone hasn't been revisited since it formed = unmitigated, highest quality
  if (poiIdx >= 0) { let touches = 0; for (let k = poiIdx + 1; k < h1.length - 1; k++) if (h1[k].l <= poiTop && h1[k].h >= poiBot) touches++; fresh = touches === 0; }
  // breaker: a recent opposing pivot price has broken through and may retest as flipped support/resistance
  const piv1 = pivots(h1, 3);
  if (dir === 'long') {
    const bh = piv1.highs.map(x => x.p).filter(p => p < price).sort((x, y) => y - x)[0];
    if (bh != null && (price - bh) / price < 0.05) { breaker = true; if (poiBot == null) { poiTop = bh; poiBot = bh - atr1; poiKind = '1H breaker (reclaimed high)'; fresh = true; displaced = true; } }
  } else {
    const bl = piv1.lows.map(x => x.p).filter(p => p > price).sort((x, y) => x - y)[0];
    if (bl != null && (bl - price) / price < 0.05) { breaker = true; if (poiBot == null) { poiBot = bl; poiTop = bl + atr1; poiKind = '1H breaker (reclaimed low)'; fresh = true; displaced = true; } }
  }
  const poiPresent = poiBot != null;

  // ---- 15m execution: liquidity sweep (opposite side) + BOS/ChoCH, volume-confirmed ----
  const piv = pivots(m15, 2), sHighs = piv.highs, sLows = piv.lows;
  const avgV = avgVol(m15, 20);
  let sweep = false, sweptLvl = null, sweepIdx = -1, sweepPx = null, volSurge = false;
  for (let i = n - 1; i >= Math.max(2, n - 10); i--) {
    const priors = dir === 'long' ? sLows.filter(x => x.i < i) : sHighs.filter(x => x.i < i);
    const lvl = priors.length ? priors.at(-1).p : null;
    if (lvl == null) continue;
    const grabbed = dir === 'long' ? (m15[i].l < lvl && m15[i].c > lvl) : (m15[i].h > lvl && m15[i].c < lvl);
    if (grabbed) { sweep = true; sweptLvl = lvl; sweepIdx = i; sweepPx = dir === 'long' ? m15[i].l : m15[i].h; volSurge = avgV > 0 && m15[i].v > 1.4 * avgV; break; }
  }
  let bos = false, legFar = null;
  if (sweep) {
    const opp = (dir === 'long' ? sHighs : sLows).filter(x => x.i < sweepIdx).at(-1);
    const ref = opp ? opp.p : null;
    let ext = dir === 'long' ? -Infinity : Infinity;
    for (let i = sweepIdx; i < n; i++) { ext = dir === 'long' ? Math.max(ext, m15[i].h) : Math.min(ext, m15[i].l); if (ref != null && beyond(m15[i].c, ref)) bos = true; }
    legFar = ext;
  }
  const legAnchor = sweep ? sweepPx : (dir === 'long' ? (sLows.at(-1)?.p ?? Math.min(...m15.slice(-20).map(b => b.l))) : (sHighs.at(-1)?.p ?? Math.max(...m15.slice(-20).map(b => b.h))));
  if (legFar == null) legFar = dir === 'long' ? (sHighs.at(-1)?.p ?? Math.max(...m15.slice(-20).map(b => b.h))) : (sLows.at(-1)?.p ?? Math.min(...m15.slice(-20).map(b => b.l)));
  const range = Math.max(Math.abs(legFar - legAnchor), 1e-6);

  // ---- Entry zone = a recognized POI inside the OTE discount/premium band, refined to its
  //      consequent encroachment (CE = 50%) — SAME concept set as the stop & targets: order
  //      block / FVG / breaker, premium-discount, displacement, CE. Priority: 15m OB -> 15m FVG
  //      -> the 1H POI (OB/FVG/breaker already found); falls back to the raw OTE band. ----
  const ote62 = legFar - sign * 0.62 * range, ote79 = legFar - sign * 0.79 * range;
  const oteLo = Math.min(ote62, ote79), oteHi = Math.max(ote62, ote79);
  const inBand = (lo, hi) => lo <= oteHi && hi >= oteLo;
  let zLo = oteLo, zHi = oteHi, zoneKind = `OTE 0.62-0.79 (${dir === 'long' ? 'discount' : 'premium'} pullback)`, zfound = false;
  for (let i = n - 2; i >= Math.max(1, n - 45) && !zfound; i--) {           // 15m order block in OTE
    const isOB = dir === 'long' ? (m15[i].c < m15[i].o) : (m15[i].c > m15[i].o);
    if (isOB && inBand(m15[i].l, m15[i].h)) { zLo = Math.max(m15[i].l, oteLo); zHi = Math.min(m15[i].h, oteHi); zoneKind = '15m order block ∩ OTE'; zfound = true; }
  }
  for (let i = n - 1; i >= Math.max(2, n - 45) && !zfound; i--) {           // 15m FVG in OTE
    const isFVG = dir === 'long' ? (m15[i].l > m15[i - 2].h) : (m15[i].h < m15[i - 2].l);
    if (!isFVG) continue;
    const a = dir === 'long' ? m15[i].l : m15[i].h, b = dir === 'long' ? m15[i - 2].h : m15[i - 2].l;
    if (inBand(Math.min(a, b), Math.max(a, b))) { zLo = Math.max(Math.min(a, b), oteLo); zHi = Math.min(Math.max(a, b), oteHi); zoneKind = '15m FVG ∩ OTE'; zfound = true; }
  }
  if (!zfound && poiPresent && inBand(poiBot, poiTop)) {                    // the 1H POI (incl. breaker) in OTE
    zLo = Math.max(poiBot, oteLo); zHi = Math.min(poiTop, oteHi); zoneKind = poiKind + ' ∩ OTE';
  }
  const entryCE = (zLo + zHi) / 2;   // consequent encroachment of the entry POI = the optimal fill
  // entry1 = shallow edge (fills first / nearest price), entry2 = deep edge; clamp to price side
  const zNear = dir === 'long' ? zHi : zLo, zFar = dir === 'long' ? zLo : zHi;
  let entry1, entry2;
  if (dir === 'long') { entry1 = Math.min(zNear, price * 0.999); entry2 = Math.min(zFar, entry1 * 0.999); }
  else { entry1 = Math.max(zNear, price * 1.001); entry2 = Math.max(zFar, entry1 * 1.001); }
  const entryInPoi = poiPresent && entry1 <= poiTop * 1.004 && entry1 >= poiBot * 0.996;

  // ---- Stop: anchored STRICTLY to the displacement-leg origin (the swept extreme that launched
  //      the impulse/BOS, refined by the 15m order-block edge), then extended to clear the nearest
  //      minor pool (stop-hunt awareness) and ATR-buffered. Tighter & cleaner than min-of-many. ----
  const atr15 = atr(m15, 14) || price * 0.005;
  let stop, stopAnchor;
  if (dir === 'long') {
    stopAnchor = Math.min(legAnchor, entry2);   // displacement-leg origin (swept low / OB low)
    const pool = nearestLowBelow(m15, stopAnchor, 2);
    if (pool != null && stopAnchor - pool < 0.5 * atr1) stopAnchor = pool;
    stop = stopAnchor - Math.max(0.0015 * stopAnchor, 0.25 * atr15);
  } else {
    stopAnchor = Math.max(legAnchor, entry2);   // displacement-leg origin (swept high / OB high)
    const pool = nearestHighAbove(m15, stopAnchor, 2);
    if (pool != null && pool - stopAnchor < 0.5 * atr1) stopAnchor = pool;
    stop = stopAnchor + Math.max(0.0015 * stopAnchor, 0.25 * atr15);
  }

  // ---- Tiered targets = ranked LIQUIDITY DRAWS (equal highs/lows, prior day/week H-L, swings,
  //      nearest unfilled FVG), nearest-first; standard-deviation-style projection as fallback ----
  const draws = liquidityDraws(dir, price, h1, h4, daily, atr1);
  const proj = m => price + sign * m * range;
  const gap = Math.max(atr1 * 0.3, price * 0.0015);
  const tierGap = Math.max(gap, 0.6 * range);   // keep day -> swing -> runner meaningfully spread
  const nextBeyond = (lvl, md) => draws.find(d => sign * (d.p - lvl) > md);
  const d1 = draws[0] || null;
  const d2 = d1 ? nextBeyond(d1.p, tierGap) : null;
  const d3 = d2 ? nextBeyond(d2.p, tierGap) : null;
  let T1 = d1 ? d1.p : proj(1.0);
  let T2 = d2 ? d2.p : T1 + sign * Math.max(gap, 0.7 * range);
  let T3 = d3 ? d3.p : T2 + sign * Math.max(gap, 0.8 * range);
  const tt = [d1 ? d1.type : 'measured', d2 ? d2.type : 'measured', d3 ? d3.type : 'measured'];
  if (sign > 0) {
    if (T1 <= price) T1 = proj(0.5);
    if (T2 <= T1) T2 = T1 + Math.max(gap, 0.4 * range);
    if (T3 <= T2) T3 = T2 + Math.max(gap, 0.4 * range);
  } else {
    if (T1 >= price) T1 = proj(0.5);
    if (T2 >= T1) T2 = T1 - Math.max(gap, 0.4 * range);
    if (T3 >= T2) T3 = T2 - Math.max(gap, 0.4 * range);
  }
  const riskU = Math.max(Math.abs(entry1 - stop), 1e-6);
  const rr1 = Math.abs(T1 - entry1) / riskU;

  // ---- Downside draws + bear stop for the OPTIONS put path (= the targets/stop when short) ----
  let D1, D2, D3, putStop;
  if (dir === 'short') { D1 = T1; D2 = T2; D3 = T3; putStop = stop; }
  else {
    D1 = nearestLowBelow(h1, price, 2) ?? (price - 0.5 * range);
    D2 = nearestLowBelow(h4, Math.min(price, D1), 2) ?? (D1 - 0.8 * range);
    D3 = nearestLowBelow(daily, Math.min(D1, D2), 3) ?? (D2 - 1.0 * range);
    if (D1 >= price) D1 = price - 0.3 * range;
    if (D2 >= D1) D2 = D1 - Math.max(0.5 * (price - D1), 0.4 * range);
    if (D3 >= D2) D3 = D2 - Math.max(0.5 * (D1 - D2), 0.4 * range);
    putStop = nearestHighAbove(h1, price, 2) ?? (price + 0.5 * range);
  }

  // ---- Swing-structure state machine (HH/HL/LH/LL + BOS/ChoCH) ----
  const struct1 = structure(h1, 2), structD = structure(daily, 3);
  const structAgree = dir === 'long' ? struct1.state === 'bull' : struct1.state === 'bear';

  // ---- SMT divergence vs a correlated anchor at the sweep (non-confirmation = institutional tell) ----
  const anchorSym = anchorFor(symbol);
  const anchorM15 = anchors ? anchors[anchorSym] : null;
  let smt = false;
  if (sweep && !LEVERAGED.has(symbol) && anchorM15 && anchorM15.length >= 24) {
    const W = 12;
    const sLast = m15.slice(-W), sPrior = m15.slice(-2 * W, -W), aLast = anchorM15.slice(-W), aPrior = anchorM15.slice(-2 * W, -W);
    if (dir === 'long') {
      const symLL = Math.min(...sLast.map(b => b.l)) < Math.min(...sPrior.map(b => b.l));
      const aLL = Math.min(...aLast.map(b => b.l)) < Math.min(...aPrior.map(b => b.l));
      smt = symLL && !aLL;   // name made a lower low, anchor held = bullish divergence
    } else {
      const symHH = Math.max(...sLast.map(b => b.h)) > Math.max(...sPrior.map(b => b.h));
      const aHH = Math.max(...aLast.map(b => b.h)) > Math.max(...aPrior.map(b => b.h));
      smt = symHH && !aHH;   // name made a higher high, anchor failed = bearish divergence
    }
  }

  // ---- 12-point confluence score ----
  const entryLoc = dir === 'long' ? entry1 < mid : entry1 > mid;
  const flags = {
    dailyAligned: dir === 'long' ? biasD === 'up' : biasD === 'down',
    fourHAligned: dir === 'long' ? bias4 === 'up' : bias4 === 'down',
    oneHAligned: dir === 'long' ? bias1 === 'up' : bias1 === 'down',
    location: goodLocation,
    poi: poiPresent,
    entryLoc,
    sweep,
    goodTarget: rr1 >= 1.0,
    volume: volSurge,
    displacement: displaced || bos,
    structure: structAgree,
    smt,
  };
  const score = Object.values(flags).filter(Boolean).length;  // 0..12
  const goodR = rr1 >= 1.0;
  let action = 'AVOID';
  if (trendOk && sweep && goodR && entryInPoi && score >= 9) action = dir === 'long' ? 'BUY' : 'SHORT';
  else if (trendOk && sweep && goodR && score >= 7) action = dir === 'long' ? 'ACCUMULATE' : 'SHORT-SCALE';
  else if (score >= 5) action = 'WATCH';
  const aligned = dir === 'long' ? upCount : downCount;
  const grade = aligned === 3 ? 'A' : aligned === 2 ? 'B' : 'C';

  // ---- Basis: top-down MTF story ----
  const tag = [displaced ? 'displacement-confirmed' : '', fresh ? 'fresh/unmitigated' : '', breaker ? 'breaker' : ''].filter(Boolean).join(', ');
  const bp = [];
  bp.push(`bias: Daily ${biasD}, 4H ${bias4}, 1H ${bias1} (hunting ${dir.toUpperCase()}, grade ${grade})`);
  bp.push(goodLocation ? `price in daily ${dir === 'long' ? 'discount (good value to buy)' : 'premium (good value to short)'}` : `price in daily ${dir === 'long' ? 'premium (chasing)' : 'discount (early to short)'}`);
  bp.push(poiPresent ? `into a ${poiKind} (${f2(poiBot)}-${f2(poiTop)})${tag ? ' [' + tag + ']' : ''}` : `no clean 1H ${dir === 'long' ? 'demand' : 'supply'} zone yet`);
  bp.push(sweep ? `15m grabbed ${dir === 'long' ? 'sell' : 'buy'}-side liquidity (swept ${f2(sweptLvl)})${bos ? `, then ${dir === 'long' ? 'BOS up' : 'ChoCH down'}` : ''}${volSurge ? ', on a volume surge' : ''}` : 'no fresh 15m liquidity grab yet');
  bp.push(`entry POI: ${zoneKind}, ${f2(entry2)} to ${f2(entry1)} (optimal CE ${f2(entryCE)})${entryInPoi ? ', inside the 1H zone' : ''}; stop ${f2(stop)} just beyond the displacement-leg origin (${dir === 'long' ? 'swept low' : 'swept high'})`);
  bp.push(`targets (liquidity draws): TP1 ${f2(T1)} [${tt[0]}] -> TP2 ${f2(T2)} [${tt[1]}] -> TP3 ${f2(T3)} [${tt[2]}]; ~${f2(rr1)}R`);
  bp.push(`structure: 1H ${struct1.state}${struct1.label ? ` (last ${struct1.label})` : ''}${struct1.event ? `, ${struct1.event} @ ${f2(struct1.eventLevel)}` : ''}; Daily ${structD.state}`);
  if (smt) bp.push(`SMT divergence vs ${anchorSym}: anchor did not confirm the ${dir === 'long' ? 'lower low (bullish)' : 'higher high (bearish)'}`);
  const vp = volumeProfile(daily.slice(-30));   // recent ~1-month window (long windows lag on trending names)
  if (vp) bp.push(`volume profile: POC ${vp.poc} (magnet/key support-resistance), value area ${vp.val}-${vp.vah}; entry ${dir === 'short' ? (entry1 > vp.vah ? 'above value (premium - good for a short)' : entry1 < vp.val ? 'below value (extended/late short)' : 'inside value') : (entry1 < vp.val ? 'below value area (real discount)' : entry1 <= vp.vah ? 'inside the fair-value zone' : 'above value area (extended)')}`);
  const vpRead = vp ? vpConfluence(entry1, [T1, T2, T3], vp, dir) : '';
  if (vpRead) bp.push('SMC-vol read: entry ' + vpRead);
  const basis = bp.join('; ');

  return {
    symbol, price: +price.toFixed(2), score, action, basis, grade, direction: dir, trend, vp,
    advUsd: liquidityOf(daily, price).advUsd, illiquid: liquidityOf(daily, price).illiquid,
    leveraged: LEVERAGED.has(symbol), holding: HOLDINGS.has(symbol),
    bias: trendOk ? (dir === 'long' ? 'bull' : 'bear') : 'weak',
    zone: goodLocation ? (dir === 'long' ? 'discount' : 'premium') : (dir === 'long' ? 'premium' : 'discount'),
    flags, displaced, fresh, breaker, volSurge,
    levels: {
      entry1: +entry1.toFixed(2), entry2: +entry2.toFixed(2), stop: +stop.toFixed(2),
      tp1: +T1.toFixed(2), tp2: +T2.toFixed(2), tp3: +T3.toFixed(2), rr: +rr1.toFixed(2),
      dt1: +D1.toFixed(2), dt2: +D2.toFixed(2), dt3: +D3.toFixed(2), putStop: +putStop.toFixed(2), atr: +atrDaily.toFixed(2),
    },
  };
}

async function scanOne(symbol, anchors) {
  try {
    const [daily, h1, m15] = await Promise.all([
      fetchCandles(symbol, '1d', '1y'),
      fetchCandles(symbol, '60m', '3mo'),
      fetchCandles(symbol, '15m', '1mo'),
    ]);
    if (daily.length < 200 || h1.length < 40 || m15.length < 60) return { symbol, error: `insufficient data` };
    const h4 = resample(h1, 4);
    return analyze(symbol, daily, h4, h1, m15, anchors);
  } catch (e) { return { symbol, error: e.message }; }
}

function buildReport(rows, errs, exitRows = [], optIdeas = { calls: [], puts: [] }) {
  const ts = new Date().toLocaleString('en-US', { timeZone: 'America/New_York' });
  const data = JSON.stringify(rows.map(r => ({ sym: r.symbol, score: r.score, action: r.action, grade: r.grade, dir: r.trend, price: r.price, bias: r.bias, zone: r.zone, hold: r.holding ? 1 : 0, lev: r.leveraged ? 1 : 0, basis: r.basis, vp: r.vp, ...r.levels })));
  const skipped = errs.length ? ' &middot; skipped: ' + errs.map(e => e.symbol).join(', ') : '';
  const esc = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  let brHtml = '';
  try {
    const bf = join(__reportDir, 'briefing.json');
    if (existsSync(bf)) {
      const b = JSON.parse(readFileSync(bf, 'utf8'));
      brHtml = '<h2 style="font-size:16px;font-weight:600;margin:14px 0 6px">Today\'s briefing</h2>'
        + '<div style="border:1px solid var(--line);border-left:3px solid var(--accent);border-radius:10px;padding:13px 16px;line-height:1.65;font-size:14px;background:var(--card)">'
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
      + '<div class="controls" style="margin:8px 0"><select id="h-sym" title="jump to one holding"><option value="">All holdings</option>' + exitRows.map(r => '<option>' + r.sym + '</option>').join('') + '</select></div>'
      + '<table class="cards"><thead><tr><th>Signal</th><th title="Trend health across Daily/4H/1H. A=all up (healthy), C=broken">Grade</th><th title="overall trend Daily/4H/1H">Trend</th><th>Holding</th><th class="r">Price now</th><th class="r">Your cost</th><th class="r">Gain/loss</th><th class="r">Safety price</th><th class="r">Take-profit (day&middot;swing&middot;run)</th><th class="r" title="Point of Control + value area from the last 30 days of volume-by-price">Volume 30d (POC&middot;val)</th><th class="r">Avg price</th><th>What to do (plan)</th><th>Basis (why)</th></tr></thead><tbody>'
      + exitRows.map(r => '<tr data-sym="' + r.sym + '"><td data-label="Signal"><span class="pill" style="color:' + exCol(r.status) + '">' + r.status + '</span></td>'
        + '<td data-label="Grade" style="font-weight:600;color:' + (r.grade === 'A' ? '#16a34a' : r.grade === 'B' ? '#d97706' : '#6b7280') + '">' + (r.grade || '-') + '</td>'
        + '<td data-label="Trend" style="font-weight:600;color:' + (r.trend === 'up' ? '#16a34a' : r.trend === 'down' ? '#dc2626' : '#6b7280') + '">' + (r.trend === 'up' ? 'UP' : r.trend === 'down' ? 'DOWN' : 'flat') + '</td>'
        + '<td data-label="Holding"><b>' + r.sym + '</b>' + (r.lev ? ' <span class="tag" style="color:#d97706;border-color:#d97706">LEV</span>' : '') + (r.winner ? ' <span class="tag" style="color:#16a34a;border-color:#16a34a">WIN</span>' : '') + '</td>'
        + '<td data-label="Price now" class="r">' + r.price.toFixed(2) + '</td>'
        + '<td data-label="Your cost" class="r" style="color:var(--muted)">' + (r.cost != null ? r.cost.toFixed(2) : '-') + '</td>'
        + '<td data-label="Gain/loss" class="r" style="color:' + ((r.pnl || 0) >= 0 ? '#16a34a' : '#dc2626') + '">' + (r.pnl != null ? ((r.pnl >= 0 ? '+' : '-') + money(r.pnl) + ' (' + (r.pnlPct >= 0 ? '+' : '') + r.pnlPct.toFixed(1) + '%)') : '-') + '</td>'
        + '<td data-label="Safety price" class="r">' + r.stop + ' <span style="color:var(--muted)">(' + r.distPct.toFixed(1) + '%)</span></td>'
        + '<td data-label="Take-profit" class="r" style="font-size:12px">' + (r.tp1 != null ? r.tp1 + ' &middot; ' + r.tp2 + ' &middot; ' + r.tp3 : '&mdash;') + '</td>'
        + '<td data-label="Volume 30d" class="r" style="font-size:11px">' + (r.vp ? 'POC ' + r.vp.poc + '<div style="color:var(--muted)">VA ' + r.vp.val + '&ndash;' + r.vp.vah + (r.vp.regime === 'choppy' ? ' <b style="color:#dc2626">choppy</b>' : r.vp.regime === 'tight' ? ' tight' : '') + '</div>' : '&mdash;') + '</td>'
        + '<td data-label="Avg price" class="r">' + r.ema50.toFixed(2) + '</td>'
        + '<td data-label="What to do" style="font-size:12px;color:' + exCol(r.status) + '" title="' + esc(r.reason) + '">' + esc(r.plan || r.sellAt) + '</td>'
        + '<td data-label="Basis" style="font-size:11px;color:var(--muted);line-height:1.45">' + esc(r.basis || '') + '</td></tr>').join('')
      + '</tbody></table>';
  }
  // Recommended options (Day/Swing/Runner tiers) - rendered by the shared module.
  const optHtml = renderOptionsHtml(optIdeas);
  // collapsible section: turn a section's leading <h2> into a tappable <summary>
  const sec = (html, open) => { const m = html.match(/^\s*<h2[^>]*>([\s\S]*?)<\/h2>([\s\S]*)$/); return m ? '<details class="sec"' + (open ? ' open' : '') + '><summary>' + m[1] + '</summary>' + m[2] + '</details>' : html; };
  const __out = '<!DOCTYPE html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta http-equiv="refresh" content="300"><title>Investment Navigator</title>'
    + '<link rel="apple-touch-icon" href="/apple-touch-icon.png"><meta name="apple-mobile-web-app-capable" content="yes"><meta name="mobile-web-app-capable" content="yes"><meta name="apple-mobile-web-app-status-bar-style" content="black"><meta name="apple-mobile-web-app-title" content="Investment Navigator"><meta name="theme-color" content="#0f1115"><link rel="manifest" href="/manifest.webmanifest"><link rel="icon" href="/icon-192.png">'
    + '<style>'
    + ':root{--bg:#fff;--fg:#1a1a1a;--muted:#6b7280;--line:#e5e7eb;--card:#f6f7f9;--accent:#2563eb}'
    + '@media(prefers-color-scheme:dark){:root{--bg:#0f1115;--fg:#e8e8e8;--muted:#9aa0aa;--line:#272b32;--card:#161922;--accent:#3b82f6}}'
    + 'body{margin:0;background:var(--bg);color:var(--fg);font-family:-apple-system,Segoe UI,Roboto,Arial,sans-serif;padding:20px;border-top:3px solid var(--accent)}'
    + '.hdr{display:flex;align-items:center;gap:13px;margin:0 0 14px}.logo{width:42px;height:42px;flex:none;border-radius:11px;background:linear-gradient(160deg,#11223f,#2563eb);display:flex;align-items:center;justify-content:center;font-weight:800;color:#fff;font-size:17px;letter-spacing:.5px;box-shadow:0 2px 10px rgba(37,99,235,.3)}h1{font-size:21px;font-weight:700;margin:0;letter-spacing:-.2px}.tagline{color:var(--fg);opacity:.82;font-size:12.5px;margin:3px 0 0;line-height:1.35}.sub{color:var(--muted);font-size:13px;margin-bottom:16px}'
    + '.controls{display:flex;flex-wrap:wrap;gap:10px;align-items:center;margin-bottom:12px}'
    + 'select{padding:6px 8px;border:1px solid var(--line);border-radius:8px;background:var(--bg);color:var(--fg);font-size:13px}'
    + 'label{font-size:13px;display:flex;align-items:center;gap:5px}#count{font-size:13px;color:var(--muted);margin-bottom:8px}'
    + 'table{width:100%;border-collapse:collapse;font-size:13px}th{text-align:left;color:var(--muted);font-weight:500;padding:8px 6px;border-bottom:2px solid var(--line)}'
    + 'td{padding:8px 6px;border-bottom:1px solid var(--line)}.r{text-align:right;font-variant-numeric:tabular-nums}'
    + '.pill{border:1px solid currentColor;padding:2px 8px;border-radius:6px;font-weight:600;font-size:12px;white-space:nowrap}'
    + '.tag{font-size:11px;padding:1px 5px;border-radius:5px;margin-left:4px;border:1px solid}footer{margin-top:16px;color:var(--muted);font-size:12px}'
    + '.tbl{overflow-x:auto;-webkit-overflow-scrolling:touch;max-width:100%;margin-bottom:4px}.tbl th:first-child,.tbl td:first-child{position:sticky;left:0;background:var(--bg);box-shadow:1px 0 0 var(--line)}'
    + '@media(max-width:680px){body{padding:12px}h1{font-size:18px}.sub{font-size:12px}table{font-size:12px}th,td{padding:7px 6px}.controls{gap:6px}select{flex:1 1 auto}}'
    + '.sec{border-top:1px solid var(--line)}.sec>summary{cursor:pointer;list-style:none;font-size:16px;font-weight:650;padding:15px 2px;display:flex;align-items:center;gap:9px;-webkit-user-select:none;user-select:none}.sec>summary::-webkit-details-marker{display:none}.sec>summary::before{content:"\\25B8";color:var(--accent);font-weight:700}.sec[open]>summary::before{content:"\\25BE"}.sec>summary span{font-weight:400;color:var(--muted)}.sec[open]{padding-bottom:12px}'
    + '@media(max-width:680px){.cards thead{display:none}.cards,.cards tbody,.cards tr,.cards td{display:block}.cards tr{border:1px solid var(--line);border-radius:12px;margin:10px 0;padding:2px 14px;background:var(--card)}.cards td{display:flex;justify-content:space-between;align-items:baseline;gap:14px;text-align:right;border:none;border-bottom:1px solid var(--line);padding:8px 0}.cards tr td:last-child{border-bottom:none}.cards td::before{content:attr(data-label);color:var(--muted);font-weight:500;text-align:left;white-space:nowrap;flex:none}.cards td:first-child{position:static;box-shadow:none}.cards td>div{margin-left:auto;text-align:right}}'
    + '</style></head><body>'
    + '<div class="hdr"><div class="logo">IN</div><div><h1>Investment Navigator</h1><div class="tagline">Always watching your money &mdash; like a fund manager who never logs off.</div></div></div><div class="sub">Generated ' + ts + ' ET &middot; ' + rows.length + ' scanned' + skipped + ' &middot; auto-reloads every 5 min &middot; not financial advice</div>'
    + sec(brHtml, true)
    + sec(evHtml, false)
    + sec(hlHtml, false)
    + sec(exHtml, true)
    + sec(optHtml, false)
    + '<details class="sec"><summary>Buy scan</summary>'
    + '<div class="controls">'
    + '<select id="f-sym" title="jump to one ticker"><option value="">All tickers</option></select>'
    + '<select id="f-score"><option value="7">Actionable (score &ge; 7)</option><option value="9">Strong only (&ge; 9)</option><option value="5">Watch &amp; up (&ge; 5)</option><option value="0">All</option></select>'
    + '<select id="f-sort"><option value="score">Sort: score</option><option value="rr">Sort: reward/risk</option><option value="price">Sort: price</option><option value="sym">Sort: symbol</option></select>'
    + '<label><input type="checkbox" id="f-rr">R &ge; 2</label><label><input type="checkbox" id="f-hold">My holdings</label><label><input type="checkbox" id="f-lev">Hide leveraged</label>'
    + '</div><div id="count"></div>'
    + '<table class="cards"><thead><tr><th>Symbol</th><th>Score</th><th title="A=Daily/4H/1H all aligned, B=2 aligned, C=weak">Grade</th><th title="overall trend Daily/4H/1H - longs and shorts are both traded">Trend</th><th>Action</th><th class="r">Price</th><th class="r">Entry zone</th><th class="r">Stop</th><th class="r">TP1 day &middot; TP2 swing &middot; TP3 run</th><th class="r" title="POC + value area from the last 30 days of volume-by-price">Volume 30d (POC&middot;val)</th><th class="r">R</th><th>Basis (why)</th></tr></thead><tbody id="tb"></tbody></table>'
    + '</details>'
    + '<footer><div style="font-weight:700;color:var(--fg);font-size:13px">Investment Navigator</div><div style="margin:2px 0 8px">Your always-on investing cockpit &middot; educational, not financial advice</div>HOLD = you own it &middot; LEV = leveraged ETF, tactical only (decay) &middot; mechanical heuristics, confirm on chart &middot; nothing places orders</footer>'
    + '<script>var DATA=' + data + ';'
    + 'var $=function(id){return document.getElementById(id)};'
    + 'function fmt(n){return n.toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2})}'
    + 'function ac(a){return a==="BUY"?"#16a34a":a==="ACCUMULATE"?"#2563eb":a==="SHORT"?"#dc2626":a==="SHORT-SCALE"?"#d97706":a==="WATCH"?"#6b7280":"#6b7280"}'
    + 'function al(a){return a==="BUY"?"BUY":a==="ACCUMULATE"?"ACCUM":a==="SHORT"?"SHORT":a==="SHORT-SCALE"?"SHORT+":a==="WATCH"?"WATCH":"AVOID"}'
    + 'function gcol(g){return g==="A"?"#16a34a":g==="B"?"#d97706":"#6b7280"}'
    + 'function render(){var mS=+$("f-score").value,so=$("f-sort").value,q2=$("f-rr").checked,ho=$("f-hold").checked,hl=$("f-lev").checked,sy=$("f-sym").value;'
    + 'var rows;if(sy){rows=DATA.filter(function(r){return r.sym===sy})}else{rows=DATA.filter(function(r){return r.score>=mS});if(q2)rows=rows.filter(function(r){return r.rr>=2});if(ho)rows=rows.filter(function(r){return r.hold});if(hl)rows=rows.filter(function(r){return !r.lev})}'
    + 'rows.sort(function(a,b){return so==="sym"?a.sym.localeCompare(b.sym):so==="price"?b.price-a.price:(b[so]-a[so])||(b.score-a.score)});'
    + '$("count").textContent="Showing "+rows.length+" of "+DATA.length+" \\u2014 "+rows.filter(function(r){return r.score>=7}).length+" actionable";'
    + 'var h="";for(var i=0;i<rows.length;i++){var r=rows[i];'
    + 'var tg=(r.hold?"<span class=tag style=\\"color:#2563eb;border-color:#2563eb\\">HOLD</span>":"")+(r.lev?"<span class=tag style=\\"color:#d97706;border-color:#d97706\\">LEV</span>":"");'
    + 'var zc=r.zone==="discount"?"#16a34a":"#d97706";var rc=r.rr>=2?"#16a34a":"var(--muted)";var sc=r.score>=9?"#16a34a":r.score>=7?"#2563eb":r.score>=5?"var(--muted)":"#dc2626";'
    + 'h+="<tr><td data-label=\'Symbol\'><b>"+r.sym+"</b>"+tg+"</td>"'
    + '+"<td data-label=\'Score\' style=\\"color:"+sc+";font-weight:600\\">"+r.score+"/12</td>"'
    + '+"<td data-label=\'Grade\' style=\\"color:"+gcol(r.grade)+";font-weight:600\\">"+(r.grade||"-")+"</td>"'
    + '+"<td data-label=\'Trend\' style=\\"font-weight:600;color:"+(r.dir==="short"?"#dc2626":r.dir==="long"?"#16a34a":"#6b7280")+"\\">"+(r.dir==="short"?"DOWN":r.dir==="long"?"UP":"flat")+"</td>"'
    + '+"<td data-label=\'Action\'><span class=pill style=\\"color:"+ac(r.action)+"\\">"+al(r.action)+"</span></td>"'
    + '+"<td data-label=\'Price\' class=r>"+fmt(r.price)+"</td>"'
    + '+"<td data-label=\'Entry zone\' class=r>"+fmt(r.entry1)+"\\u2013"+fmt(r.entry2)+"<div style=\\"font-size:11px;color:"+zc+"\\">"+(r.dir==="short"?(r.zone==="premium"?"premium (good short)":"discount (late short)"):(r.zone==="discount"?"discount (good)":"premium (chasing)"))+"</div></td>"'
    + '+"<td data-label=\'Stop\' class=r style=\\"color:#dc2626\\">"+fmt(r.stop)+"</td>"'
    + '+"<td data-label=\'Take-profit\' class=r style=\\"color:var(--muted)\\">"+fmt(r.tp1)+" \\u00b7 <span style=\\"color:var(--fg)\\">"+fmt(r.tp2)+"</span> \\u00b7 "+fmt(r.tp3)+"</td>"'
    + '+"<td data-label=\'Volume 30d\' class=r style=\\"font-size:11px\\">"+(r.vp?"POC "+r.vp.poc+"<div style=\\"color:var(--muted)\\">VA "+r.vp.val+"\\u2013"+r.vp.vah+(r.vp.regime==="choppy"?" <b style=\\"color:#dc2626\\">choppy</b>":r.vp.regime==="tight"?" tight":"")+"</div>":"\\u2014")+"</td>"'
    + '+"<td data-label=\'R\' class=r style=\\"color:"+rc+";font-weight:600\\">"+r.rr.toFixed(1)+"R</td>"'
    + '+"<td data-label=\'Basis\' style=\\"font-size:11px;color:var(--muted);max-width:360px;line-height:1.45\\">"+(r.basis||"")+"</td></tr>"}'
    + 'if(!rows.length)h="<tr><td colspan=12 style=\\"padding:16px;text-align:center;color:var(--muted)\\">No setups match these filters.</td></tr>";$("tb").innerHTML=h}'
    + '["f-sym","f-score","f-sort","f-rr","f-hold","f-lev"].forEach(function(id){$(id).addEventListener("input",render)});'
    + '(function(){var sl=$("f-sym"),sy=DATA.map(function(r){return r.sym}).sort();for(var i=0;i<sy.length;i++){var o=document.createElement("option");o.value=o.textContent=sy[i];sl.appendChild(o)}})();'
    + 'var hs=$("h-sym");if(hs){hs.addEventListener("input",function(){var v=hs.value,tr=document.querySelectorAll("tr[data-sym]");for(var j=0;j<tr.length;j++){tr[j].style.display=(!v||tr[j].getAttribute("data-sym")===v)?"":"none"}})}render();'
    + '</scr' + 'ipt></body></html>';
  // Wrap every table in a horizontal-scroll container so wide tables swipe cleanly on phones.
  return __out.replace(/<table>/g, '<div class="tbl"><table>').replace(/<\/table>/g, '</table></div>');
}

async function main() {
  let symbols = subset.length ? subset : [...new Set(Object.values(UNIVERSE).flat())];
  const results = [];
  // pre-fetch SMT anchor 15m candles ONCE (sector/index correlates), reused for every name
  const anchors = {};
  for (const a of SMT_ANCHORS) { try { anchors[a] = await fetchCandles(a, '15m', '1mo'); } catch (e) {} await new Promise(r => setTimeout(r, 120)); }
  // light throttle to be gentle on Yahoo
  for (const s of symbols) { results.push(await scanOne(s, anchors)); await new Promise(r => setTimeout(r, 120)); }

  const scanned = results.filter(r => !r.error);
  // Drop illiquid/penny names from BUY candidates (keep my own holdings regardless).
  const dropped = scanned.filter(r => r.illiquid && !r.holding);
  const ok = scanned.filter(r => !r.illiquid || r.holding).sort((a, b) => b.score - a.score);
  const errs = results.filter(r => r.error);
  if (dropped.length) console.error('liquidity gate dropped: ' + dropped.map(r => r.symbol).join(', '));

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
  console.log(`INVESTMENT NAVIGATOR — ${ok.length} scanned, ${buys.length} actionable buy setups\n`);
  const icon = a => a === 'BUY' ? 'BUY  ' : a === 'ACCUMULATE' ? 'ACCUM' : a === 'SHORT' ? 'SHORT' : a === 'SHORT-SCALE' ? 'SHRT+' : a === 'WATCH' ? 'WATCH' : 'AVOID';
  for (const r of buys) {
    const tags = [r.holding ? 'HOLDING' : '', r.leveraged ? 'LEVERAGED/tactical' : ''].filter(Boolean).join(' ');
    const L = r.levels;
    console.log(`${icon(r.action)} ${r.symbol.padEnd(5)} ${String(r.score)}/12  $${r.price}  ${r.bias}/${r.zone} ${tags}`);
    console.log(`      E1 ${L.entry1} | E2 ${L.entry2} | Stop ${L.stop} | TP1 ${L.tp1} | TP2 ${L.tp2} | TP3 ${L.tp3} | ~${L.rr}R`);
  }
  if (!buys.length) console.log('(no actionable long/short setups this run)');
  const watch = ok.filter(r => r.action === 'WATCH').map(r => `${r.symbol}(${r.score})`);
  if (watch.length) console.log(`\nWATCH: ${watch.join(', ')}`);
  if (errs.length) console.log(`\nskipped: ${errs.map(e => e.symbol).join(', ')}`);
}

main();
