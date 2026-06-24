// Holdings EXIT monitor — watches ONLY my positions for sell/trim signals.
// Combines fixed stop levels (edit below) + mechanical signals
// (broke daily swing low, lost 50-EMA, winner reversing in premium).
// Free Yahoo candle data, no API key. Alert-only change detection.
//
// Usage: node scan_exits.mjs            (digest + ALERT line)
//        node scan_exits.mjs --json

import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

// Holdings come from the HOLDINGS_JSON environment variable (a private GitHub
// Secret in the cloud). The example below is only a fallback so the code runs
// without leaking a real portfolio in this public repo.
const DEFAULT_HOLDINGS = {
  AAPL: { shares: 50, stop: 190, cost: 205.00 },
  MSFT: { shares: 20, stop: 380, cost: 410.00 },
  NVDA: { shares: 30, stop: 150, cost: 165.00 },
  SPY:  { shares: 25, stop: 560, cost: 590.00 },
  QQQ:  { shares: 15, stop: 470, cost: 500.00, winner: true },
};
let HOLDINGS = DEFAULT_HOLDINGS;
if (process.env.HOLDINGS_JSON) {
  try { HOLDINGS = JSON.parse(process.env.HOLDINGS_JSON); }
  catch (e) { console.error('Bad HOLDINGS_JSON, using default:', e.message); }
}

const asJson = process.argv.includes('--json');

async function fetchCandles(symbol, interval, range) {
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${symbol}?interval=${interval}&range=${range}`;
  const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
  if (!r.ok) throw new Error(`${symbol} ${interval} HTTP ${r.status}`);
  const res = (await r.json()).chart?.result?.[0];
  if (!res) throw new Error(`${symbol} ${interval} no data`);
  const q = res.indicators.quote[0], out = [];
  for (let i = 0; i < res.timestamp.length; i++) {
    if (q.open[i] == null || q.high[i] == null || q.low[i] == null || q.close[i] == null) continue;
    out.push({ t: res.timestamp[i], o: q.open[i], h: q.high[i], l: q.low[i], c: q.close[i], v: q.volume[i] || 0 });
  }
  return out;
}
function ema(arr, p) { const k = 2 / (p + 1); let e = arr[0]; for (let i = 1; i < arr.length; i++) e = arr[i] * k + e * (1 - k); return e; }
function pivots(bars, s = 3) {
  const highs = [], lows = [];
  for (let i = s; i < bars.length - s; i++) {
    let ph = true, pl = true;
    for (let j = 1; j <= s; j++) {
      if (!(bars[i].h > bars[i - j].h && bars[i].h > bars[i + j].h)) ph = false;
      if (!(bars[i].l < bars[i - j].l && bars[i].l < bars[i + j].l)) pl = false;
    }
    if (ph) highs.push(bars[i].h);
    if (pl) lows.push(bars[i].l);
  }
  return { highs, lows };
}
const f2 = n => (Math.round(n * 100) / 100);

// Volume-by-price profile from OHLCV bars -> POC (point of control = highest-volume price,
// a magnet/support-resistance) + value area (VAL..VAH, the ~70% of volume = "fair" range).
// Each bar's volume is spread across the price range it covered (approximation of intrabar VP).
function volumeProfile(bars, binCount = 48) {
  if (!bars || bars.length < 20) return null;
  const lo = Math.min(...bars.map(b => b.l)), hi = Math.max(...bars.map(b => b.h));
  if (!(hi > lo)) return null;
  const bs = (hi - lo) / binCount;
  const vol = new Array(binCount).fill(0);
  for (const b of bars) {
    const v = b.v || 0; if (!v) continue;
    const s = Math.max(0, Math.floor((b.l - lo) / bs));
    const e = Math.min(binCount - 1, Math.floor((b.h - lo) / bs));
    const per = v / (e - s + 1);
    for (let i = s; i <= e; i++) vol[i] += per;
  }
  let poc = 0; for (let i = 1; i < binCount; i++) if (vol[i] > vol[poc]) poc = i;
  const total = vol.reduce((a, x) => a + x, 0) || 1;
  let acc = vol[poc], loB = poc, hiB = poc;
  while (acc < total * 0.7 && (loB > 0 || hiB < binCount - 1)) {
    const bel = loB > 0 ? vol[loB - 1] : -1, abv = hiB < binCount - 1 ? vol[hiB + 1] : -1;
    if (abv >= bel) acc += vol[++hiB]; else acc += vol[--loB];
  }
  const val = f2(lo + loB * bs), vah = f2(lo + (hiB + 1) * bs), px = bars.at(-1).c;
  const widthPct = px > 0 ? Math.round((vah - val) / px * 100) : 0;   // value-area width as % of price = choppiness
  return { poc: f2(lo + (poc + 0.5) * bs), val, vah, widthPct, regime: widthPct > 15 ? 'choppy' : widthPct < 7 ? 'tight' : 'normal' };
}

// Short SMC x volume-profile confluence read: where the ref (entry/price) sits vs value,
// and whether a take-profit lines up with a volume wall (POC / value edge = strong TP)
// or sits in open space (price rips through). dir = 'long' | 'short'.
function vpConfluence(ref, tps, vp, dir = 'long') {
  if (!vp || ref == null) return '';
  const { poc, val, vah } = vp;
  const near = (a, b) => b > 0 && Math.abs(a - b) / b <= 0.015;
  const loc = dir === 'short'
    ? (ref > vah ? 'premium (above value - good to short)' : ref < val ? 'extended/late (below value)' : 'inside value')
    : (ref < val ? 'discount (below value)' : ref > vah ? 'extended (above value)' : 'inside value');
  const lab = ['TP1', 'TP2', 'TP3'];
  const walls = dir === 'short' ? [poc, val] : [poc, vah];
  let wall = '';
  for (let i = 0; i < (tps || []).length; i++) { if (tps[i] != null && walls.some(L => near(tps[i], L))) { wall = lab[i] + ' at a volume wall (strong take-profit)'; break; } }
  return loc + '; ' + (wall || 'targets in open space (less resistance)') + (vp.regime === 'choppy' ? '; choppy range (trade tactical)' : '');
}

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
  const c = bars.map(b => b.c);
  const len = Math.min(50, Math.max(10, bars.length - 1));
  const e = ema(c, len), ePrev = ema(c.slice(0, -5), len);
  const rising = e > ePrev, falling = e < ePrev;
  const p = pivots(bars, 2);
  let hh = false, hl = false, lh = false, ll = false;
  if (p.highs.length >= 2) { hh = p.highs.at(-1) > p.highs.at(-2); lh = p.highs.at(-1) < p.highs.at(-2); }
  if (p.lows.length >= 2) { hl = p.lows.at(-1) > p.lows.at(-2); ll = p.lows.at(-1) < p.lows.at(-2); }
  if (rising && !(lh && ll)) return 'up';
  if (falling && !(hh && hl)) return 'down';
  return 'flat';
}
function nearestHighAbove(bars, price, s = 2) {
  const hs = pivots(bars, s).highs.filter(h => h > price).sort((a, b) => a - b);
  return hs[0] ?? null;
}

function analyzeExit(sym, cfg, daily, h1) {
  const price = h1.at(-1).c;
  const dC = daily.map(b => b.c);
  const ema50 = ema(dC, 50), ema200 = ema(dC, 200);
  const dp = pivots(daily, 3);
  const swingLow = dp.lows.at(-1);
  const hh = Math.max(...daily.slice(-60).map(b => b.h)), ll = Math.min(...daily.slice(-60).map(b => b.l));
  const premium = price > (hh + ll) / 2;
  const belowEma50 = price < ema50;
  const structBreak = swingLow != null && price < swingLow && belowEma50;
  const hp = pivots(h1, 3);
  const h1Low = hp.lows.at(-1);
  const h1Bear = h1Low != null && price < h1Low;
  const winnerReverse = cfg.winner && premium && h1Bear;
  const distPct = ((price - cfg.stop) / price) * 100;
  const biasD = biasOf(daily), bias4 = biasOf(resample(h1, 4)), bias1 = biasOf(h1);
  const upCount = [biasD, bias4, bias1].filter(b => b === 'up').length;
  const downCount = [biasD, bias4, bias1].filter(b => b === 'down').length;
  const grade = upCount === 3 ? 'A' : upCount === 2 ? 'B' : 'C';
  const trend = upCount > downCount ? 'up' : downCount > upCount ? 'down' : 'flat';

  let status = 'HOLD', reason = '';
  if (price <= cfg.stop) { status = 'SELL'; reason = `now at ${f2(price)} - it fell below your safety price of ${cfg.stop}`; }
  else if (structBreak) { status = 'SELL'; reason = `it dropped below its recent low (${f2(swingLow)}) and its average price line (${f2(ema50)}) - the uptrend has broken`; }
  else if (winnerReverse) { status = 'TRIM'; reason = `a big winner that is starting to turn down while expensive - good idea to lock in some profit`; }
  else if (belowEma50) { status = 'TRIM'; reason = `slipped below its average price line (${f2(ema50)}) - it is losing steam`; }
  else if (distPct <= 3) { status = 'WATCH'; reason = `getting close - only ${f2(distPct)}% above your safety price of ${cfg.stop}`; }
  else { status = 'HOLD'; reason = `looks fine - it is above its average price line (${f2(ema50)}), and your safety price ${cfg.stop} is ${f2(distPct)}% below`; }

  let sellAt;
  if (status === 'SELL' && price <= cfg.stop) sellAt = `Sell now - it hit your safety price ${cfg.stop}`;
  else if (status === 'SELL') sellAt = `Sell around now (${f2(price)}); if it bounces up near ${f2(ema50)}, that is a better price to sell into`;
  else if (status === 'TRIM') sellAt = `Sell some now (around ${f2(price)}); sell the rest if it drops below ${cfg.stop}`;
  else sellAt = `Keep it; only sell if it drops below ${cfg.stop}`;

  const cost = cfg.cost != null ? cfg.cost : null;
  const pnl = cost != null ? (price - cost) * cfg.shares : null;
  const pnlPct = cost != null ? (price / cost - 1) * 100 : null;

  const eb = [`trend: Daily ${biasD}, 4H ${bias4}, 1H ${bias1} (grade ${grade})`];
  if (structBreak) eb.push(`broke below a recent swing low (${f2(swingLow)}) - took sell-side liquidity, the up-move structure cracked`);
  else if (!belowEma50) eb.push('still making higher lows (market structure intact)');
  else eb.push('structure wobbling - lost upward momentum');
  eb.push(premium ? 'in the expensive (premium) part of its range' : 'in the cheaper (discount) part of its range');
  if (winnerReverse) eb.push('a big winner just starting to turn down from its highs (take profit)');
  eb.push(belowEma50 ? `below its 50-day average line (${f2(ema50)}) - trend filter weak` : `above its 50-day average line (${f2(ema50)}) - trend filter ok`);
  eb.push(distPct >= 0 ? `now ${f2(distPct)}% above your safety price (${cfg.stop})` : `now below your safety price (${cfg.stop})`);
  const vp = volumeProfile(daily.slice(-30));   // recent ~1-month window (long windows lag on trending names)
  if (vp) eb.push(`volume profile: POC ${vp.poc} (the magnet/key support-resistance), value area ${vp.val}-${vp.vah} (price ${price < vp.val ? 'below value = cheap' : price > vp.vah ? 'above value = extended' : 'inside the fair-value zone'})`);
  const basis = eb.join('; ');

  // ---- upside take-profit levels (liquidity draws above): TP1 1H day, TP2 4H swing, TP3 daily runner ----
  let T1 = nearestHighAbove(h1, price, 2) ?? price * 1.02;
  let T2 = nearestHighAbove(resample(h1, 4), Math.max(price, T1), 2) ?? T1 * 1.03;
  let T3 = nearestHighAbove(daily, Math.max(T1, T2), 3) ?? T2 * 1.05;
  if (T1 <= price) T1 = price * 1.02;
  if (T2 <= T1) T2 = T1 * 1.03;
  if (T3 <= T2) T3 = T2 * 1.05;
  T1 = f2(T1); T2 = f2(T2); T3 = f2(T3);

  // ---- adaptive position/profit plan ----
  let plan;
  if (status === 'SELL') plan = sellAt;
  else if (status === 'TRIM') plan = `${sellAt}; if it holds, next upside ${T1} / ${T2}`;
  else if (pnlPct != null && pnlPct < 0) plan = `Down ${f2(Math.abs(pnlPct))}% - play defense: hold above ${cfg.stop}, needs to reclaim ${T1} to turn up${cost != null ? `; breakeven ${f2(cost)}` : ''}`;
  else if (price >= T1 * 0.995) plan = `At first target ${T1} - trim ~1/3 here, lift your stop, let the rest run to ${T2} / ${T3}`;
  else if (cfg.winner || (pnlPct != null && pnlPct >= 25)) plan = `Up ${pnlPct != null ? f2(pnlPct) + '%' : 'nicely'} - protect it: trim ~1/3 near ${T1}, trail your stop up, ride the rest to ${T2} / ${T3}`;
  else if (trend === 'up') plan = `Healthy - ride toward ${T1} then ${T2}; trim ~1/3 at each and move your stop up. Bail under ${cfg.stop}`;
  else plan = `Hold; first upside ${T1}, then ${T2} / ${T3}. Bail under ${cfg.stop}`;
  const vpRead = vpConfluence(price, [T1, T2, T3], vp, 'long');
  if (vpRead) plan += '  |  vol: ' + vpRead;

  return { sym, status, reason, sellAt, plan, basis, grade, trend, price: f2(price), stop: cfg.stop, tp1: T1, tp2: T2, tp3: T3, vp, ema50: f2(ema50), distPct: f2(distPct), premium, lev: !!cfg.lev, winner: !!cfg.winner, note: cfg.note || '', shares: cfg.shares, cost: cost != null ? f2(cost) : null, pnl: pnl != null ? f2(pnl) : null, pnlPct: pnlPct != null ? f2(pnlPct) : null };
}

async function one(sym, cfg) {
  try {
    const [daily, h1] = await Promise.all([fetchCandles(sym, '1d', '1y'), fetchCandles(sym, '60m', '1mo')]);
    if (daily.length < 60 || h1.length < 10) {
      // limited history (e.g. a new IPO) - still show current price + P&L, but no structure
      const price = daily.length ? daily.at(-1).c : (h1.length ? h1.at(-1).c : null);
      if (price == null) return { sym, error: 'insufficient data' };
      const cost = cfg.cost != null ? cfg.cost : null;
      const pnl = cost != null ? (price - cost) * cfg.shares : null;
      const pnlPct = cost != null ? (price / cost - 1) * 100 : null;
      const distPct = ((price - cfg.stop) / price) * 100;
      return {
        sym, status: 'NEW', grade: '-', trend: 'flat',
        reason: 'too new for structure analysis (limited price history)',
        sellAt: `manage manually - safety floor ${cfg.stop}`,
        plan: `manage manually - take profits in stages; safety floor ${cfg.stop}`,
        basis: 'limited data (new listing / low history) - only price and P&L shown, no structural levels',
        price: f2(price), stop: cfg.stop, tp1: null, tp2: null, tp3: null, vp: null, ema50: f2(price), distPct: f2(distPct), premium: false,
        lev: !!cfg.lev, winner: !!cfg.winner, note: cfg.note || '', shares: cfg.shares,
        cost: cost != null ? f2(cost) : null, pnl: pnl != null ? f2(pnl) : null, pnlPct: pnlPct != null ? f2(pnlPct) : null,
      };
    }
    return analyzeExit(sym, cfg, daily, h1);
  } catch (e) { return { sym, error: e.message }; }
}

const RANK = { SELL: 3, TRIM: 2, WATCH: 1, HOLD: 0, NEW: 0 };

async function main() {
  const results = [];
  for (const [sym, cfg] of Object.entries(HOLDINGS)) { results.push(await one(sym, cfg)); await new Promise(r => setTimeout(r, 120)); }
  const ok = results.filter(r => !r.error).sort((a, b) => RANK[b.status] - RANK[a.status]);
  const errs = results.filter(r => r.error);

  // alert-only: flag holdings at SELL/TRIM/WATCH; alert when a NEW one deteriorates
  const flagged = ok.filter(r => RANK[r.status] >= 1).map(r => `${r.sym}:${r.status}`);
  const sells = ok.filter(r => r.status === 'SELL').map(r => r.sym);
  const stateFile = join(__dir, 'state_exits.json');
  let prev = { flagged: null };
  try { if (existsSync(stateFile)) prev = JSON.parse(readFileSync(stateFile, 'utf8')); } catch (e) {}
  const firstRun = prev.flagged == null;
  const newlyFlagged = flagged.filter(x => !(prev.flagged || []).includes(x));
  const alertWorthy = firstRun ? sells.length > 0 : newlyFlagged.length > 0;
  try { writeFileSync(stateFile, JSON.stringify({ flagged, ts: Date.now() })); } catch (e) {}

  if (asJson) { console.log(JSON.stringify({ generated: new Date().toISOString(), results: ok, errors: errs, alertWorthy }, null, 2)); return; }

  console.log('ALERT: ' + (alertWorthy ? 'yes' : 'no'));
  if (newlyFlagged.length) console.log('CHANGES: newly flagged -> ' + newlyFlagged.join(', '));
  console.log('');
  console.log(`HOLDINGS EXIT CHECK — ${ok.length} positions\n`);
  for (const r of ok) {
    const tags = [r.lev ? 'LEVERAGED' : '', r.winner ? 'WINNER' : ''].filter(Boolean).join(' ');
    const pnlStr = r.pnl != null ? `  P&L ${r.pnl >= 0 ? '+' : ''}$${r.pnl} (${r.pnlPct >= 0 ? '+' : ''}${r.pnlPct}%)` : '';
    console.log(`${r.status.padEnd(5)} ${r.sym.padEnd(5)} $${r.price}  stop ${r.stop} (${r.distPct}% away)  50EMA ${r.ema50}${pnlStr} ${tags}`);
    console.log(`      ${r.reason}`);
    console.log(`      SELL TRIGGER: ${r.sellAt}`);
  }
  if (errs.length) console.log(`\nskipped (no data): ${errs.map(e => e.sym).join(', ')}`);
  console.log(`\nNot financial advice - no orders placed.`);
}

export { analyzeExit, HOLDINGS, RANK, fetchCandles, one as exitOne, volumeProfile, vpConfluence };

const __isMain = process.argv[1] && process.argv[1].replace(/\\/g, '/').endsWith('scan_exits.mjs');
if (__isMain) main();
