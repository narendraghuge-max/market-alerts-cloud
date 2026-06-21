// Directional options ideas from the SMC scan, with DAY / SWING / RUNNER tiers.
// Each tier gets its own expiry (~1wk / ~1mo / ~3mo) and an OTM strike anchored to
// that tier's scan target (TP1 day / TP2 swing / TP3 runner), scaled by conviction
// and capped by the implied-move. Includes greeks + exit levels.
// Data: CBOE free delayed options feed (no key). Decision-support only, never advice.

const ETF = {
  NVDA: { bull: 'NVDU (2x)', bear: 'NVDD (2x)' },
  AAPL: { bull: 'AAPU (2x)', bear: '' },
  MSFT: { bull: 'MSFU (2x)', bear: '' },
  AMZN: { bull: 'AMZU (2x)', bear: '' },
  GOOGL: { bull: 'GGLL (2x)', bear: '' },
  META: { bull: 'METU (2x)', bear: '' },
  SPCX: { bull: 'SPCH (2x)', bear: 'SSPC (2x)' },
};
const SEMIS = new Set(['NVDA', 'AVGO', 'AMD', 'TSM', 'MU', 'AMAT', 'LRCX', 'SMCI', 'SMH', 'ARM', 'MRVL', 'ASML']);
const BIGTECH = new Set(['PLTR', 'MSFT', 'GOOGL', 'META', 'AMZN', 'SNOW', 'CRWD', 'TSLA', 'AAPL', 'NFLX', 'ORCL', 'ANET', 'QQQ', 'XLK']);
const ENERGY = new Set(['XOM', 'CVX', 'OXY', 'SLB', 'COP', 'XLE']);
function etfFor(sym) {
  if (ETF[sym]) return ETF[sym];
  if (SEMIS.has(sym)) return { bull: 'SOXL (3x semis)', bear: 'SOXS (3x semis)' };
  if (BIGTECH.has(sym)) return { bull: 'TQQQ (3x QQQ)', bear: 'SQQQ (3x QQQ)' };
  if (ENERGY.has(sym)) return { bull: 'ERX/GUSH (2x)', bear: 'ERY/DRIP (2x)' };
  if (sym === 'SPY') return { bull: 'SPXL (3x)', bear: 'SPXS (3x)' };
  if (sym === 'IWM') return { bull: 'TNA (3x)', bear: 'TZA (3x)' };
  return { bull: '', bear: '' };
}

function parseOcc(s) {
  const m = s.match(/^([A-Z]+)(\d{2})(\d{2})(\d{2})([CP])(\d{8})$/);
  if (!m) return null;
  const [, , yy, mm, dd, cp, strike] = m;
  return { expiryMs: Date.parse(`20${yy}-${mm}-${dd}T00:00:00Z`), type: cp, strike: parseInt(strike, 10) / 1000 };
}

async function fetchChain(sym) {
  try {
    const r = await fetch(`https://cdn.cboe.com/api/global/delayed_quotes/options/${sym}.json`, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) return null;
    const d = (await r.json()).data;
    if (!d || !d.options || !d.current_price) return null;
    const opts = d.options.map(o => { const p = parseOcc(o.option); return p ? { ...p, bid: o.bid, ask: o.ask, iv: o.iv, delta: o.delta, theta: o.theta, oi: o.open_interest } : null; }).filter(Boolean);
    return { price: d.current_price, opts };
  } catch (e) { return null; }
}

// Adaptive OTM strike for a given horizon: anchor to `target` (or implied move if
// no target), scaled by conviction, capped at 1.25x the implied move; pick the
// nearest liquid listed strike on the OTM side at the expiry closest to targetDTE.
function pickTier(chain, type, nowMs, target, score, targetDTE) {
  const price = chain.price;
  const all = chain.opts.filter(o => o.type === type);
  const expiries = [...new Set(all.map(o => o.expiryMs))].sort((a, b) => a - b);
  const wantMs = nowMs + targetDTE * 864e5;
  const minMs = nowMs + 2 * 864e5;
  const cand = expiries.filter(e => e >= minMs).sort((a, b) => Math.abs(a - wantMs) - Math.abs(b - wantMs));
  // nearest expiry to the target that actually has a tradeable near-the-money quote (skip dead/thin weeklies)
  let expiry = null, chain2 = null;
  for (const e of cand) {
    const cs = all.filter(o => o.expiryMs === e);
    if (cs.some(o => (o.ask > 0 || o.bid > 0) && Math.abs(o.strike - price) / price <= 0.12)) { expiry = e; chain2 = cs; break; }
  }
  if (!expiry) { expiry = cand[0] || expiries.find(e => e > nowMs); chain2 = expiry ? all.filter(o => o.expiryMs === expiry) : null; }
  if (!expiry || !chain2 || !chain2.length) return null;
  const dte = Math.round((expiry - nowMs) / 864e5);
  const atm = chain2.slice().sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
  const iv = (atm && atm.iv > 0) ? atm.iv : 0.5;
  const EM = price * iv * Math.sqrt(dte / 365);
  const cf = score >= 8 ? 0.65 : score >= 7 ? 0.55 : score >= 5 ? 0.42 : 0.32;
  let desired;
  if (type === 'C') {
    const tgt = (target && target > price) ? target : price + EM;
    desired = price + cf * (tgt - price);
    if (!(desired > price)) desired = price + 0.3 * EM;
    desired = Math.min(desired, price + 1.25 * EM);
  } else {
    const tgt = (target && target > 0 && target < price) ? target : price - EM;
    desired = price - cf * (price - tgt);
    if (!(desired < price)) desired = price - 0.3 * EM;
    desired = Math.max(desired, price - 1.25 * EM);
  }
  let side = type === 'C' ? chain2.filter(o => o.strike >= price) : chain2.filter(o => o.strike <= price);
  if (!side.length) side = chain2;
  const liquid = side.filter(o => (o.oi || 0) >= 25 && (o.ask > 0 || o.bid > 0));
  const quoted = side.filter(o => o.ask > 0 || o.bid > 0);
  const pool = liquid.length ? liquid : (quoted.length ? quoted : side);
  pool.sort((a, b) => Math.abs(a.strike - desired) - Math.abs(b.strike - desired));
  const top = pool[0];
  if (!top) return null;
  const mid = (top.bid > 0 && top.ask > 0) ? (top.bid + top.ask) / 2 : (top.ask || top.bid || 0);
  return {
    strike: top.strike,
    expiry: new Date(expiry).toISOString().slice(0, 10),
    dte,
    otmPct: +Math.abs((top.strike - price) / price * 100).toFixed(1),
    premium: +mid.toFixed(2),
    breakeven: +(type === 'C' ? top.strike + mid : top.strike - mid).toFixed(2),
    iv: top.iv ? +(top.iv * 100).toFixed(0) : null,
    delta: top.delta != null ? +Math.abs(top.delta).toFixed(2) : null,
    theta: top.theta != null ? +top.theta.toFixed(2) : null,
    oi: top.oi || 0,
  };
}

const TIERS = [
  { key: 'day', label: 'Day', lo: 4, hi: 21 },
  { key: 'swing', label: 'Swing', lo: 14, hi: 75 },
  { key: 'runner', label: 'Runner', lo: 35, hi: 250 },
];
// Expiry sized to price action: estimate calendar days to reach a target as
// (distance / daily-ATR) trading days, buffered for meandering and converted to
// calendar days, clamped into the tier's range. Falls back to the tier midpoint.
function dteFromATR(distance, atr, lo, hi) {
  if (!atr || atr <= 0 || !(distance > 0)) return Math.round((lo + hi) / 2);
  const tradingDays = distance / atr;
  const calDays = Math.round(tradingDays * 2.5 * 1.4); // x2.5 meander buffer, x1.4 trading->calendar
  return Math.max(lo, Math.min(hi, calDays));
}

export async function buildOptionsIdeas(ok, nowMs, n = 4) {
  const bullish = ok.filter(r => !r.leveraged && r.direction !== 'short' && (r.action === 'BUY' || r.action === 'ACCUMULATE' || r.score >= 5)).slice(0, n);
  const bearish = ok.filter(r => !r.leveraged && r.direction === 'short').sort((a, b) => b.score - a.score).slice(0, n);
  const calls = [], puts = [];
  for (const r of bullish) {
    const L = r.levels || {};
    const ch = await fetchChain(r.symbol);
    const price = ch ? ch.price : r.price;
    const tiers = {};
    for (const t of TIERS) {
      const tgt = t.key === 'day' ? L.tp1 : t.key === 'swing' ? L.tp2 : L.tp3;
      const dte = dteFromATR(Math.abs((tgt || price) - price), L.atr, t.lo, t.hi);
      tiers[t.key] = ch ? pickTier(ch, 'C', nowMs, tgt, r.score, dte) : null;
    }
    calls.push({ sym: r.symbol, score: r.score, grade: r.grade, action: r.action, invalid: L.stop, targets: { day: L.tp1, swing: L.tp2, runner: L.tp3 }, etf: etfFor(r.symbol).bull, tiers });
    await new Promise(z => setTimeout(z, 100));
  }
  for (const r of bearish) {
    const L = r.levels || {};
    const ch = await fetchChain(r.symbol);
    const price = ch ? ch.price : r.price;
    const tiers = {};
    for (const t of TIERS) {
      const tgt = t.key === 'day' ? L.dt1 : t.key === 'swing' ? L.dt2 : L.dt3;
      const dte = dteFromATR(Math.abs(price - (tgt || price)), L.atr, t.lo, t.hi);
      tiers[t.key] = ch ? pickTier(ch, 'P', nowMs, tgt, r.score, dte) : null;
    }
    puts.push({ sym: r.symbol, score: r.score, grade: r.grade, invalid: L.putStop, targets: { day: L.dt1, swing: L.dt2, runner: L.dt3 }, etf: etfFor(r.symbol).bear, tiers });
    await new Promise(z => setTimeout(z, 100));
  }
  return { calls, puts };
}

// Renders the dashboard "Recommended options" section (shared by local + cloud).
export function renderOptionsHtml(optIdeas) {
  const esc = s => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const oi = optIdeas || { calls: [], puts: [] };
  let html = '<h2 style="font-size:16px;font-weight:600;margin:18px 0 6px">Recommended options <span style="font-size:12px;font-weight:400;color:var(--muted)">(Day / Swing / Runner &mdash; high-risk, confirm live pricing, not advice)</span></h2>';
  const tierRows = (idea, isCall) => TIERS.map((t, i) => {
    const c = idea.tiers ? idea.tiers[t.key] : null;
    const tgt = (idea.targets || {})[t.key];
    const col = isCall ? '#16a34a' : '#dc2626';
    const symCell = i === 0 ? '<b>' + esc(idea.sym) + '</b><div style="font-size:11px;color:var(--muted)">' + idea.score + '/8 ' + esc(idea.grade || '-') + '</div>' : '';
    const contract = c ? ('$' + c.strike + ' <span style="color:var(--muted)">(' + c.otmPct + '% OTM)</span> &middot; ' + c.expiry + ' &middot; ' + c.dte + 'd' + (c.iv ? ' &middot; IV' + c.iv + '%' : '')) : '<span style="color:var(--muted)">n/a</span>';
    const greeks = c ? ('&Delta;' + (c.delta != null ? c.delta : '-') + (c.theta != null ? ' &middot; &theta;' + c.theta : '')) : '';
    const exit = ((tgt ? 'take @ $' + tgt : '') + (idea.invalid ? ' &middot; stop @ $' + idea.invalid : '')) || '&mdash;';
    return '<tr>'
      + '<td style="border-top:' + (i === 0 ? '2px solid var(--line)' : 'none') + '">' + symCell + '</td>'
      + '<td style="font-size:12px;border-top:' + (i === 0 ? '2px solid var(--line)' : 'none') + '"><b style="color:' + col + '">' + t.label + '</b>' + (tgt ? ' <span style="color:var(--muted)">&rarr; $' + tgt + '</span>' : '') + '</td>'
      + '<td style="font-size:12px;border-top:' + (i === 0 ? '2px solid var(--line)' : 'none') + '">' + contract + '</td>'
      + '<td class="r" style="border-top:' + (i === 0 ? '2px solid var(--line)' : 'none') + '">' + (c && c.premium ? '$' + c.premium : '&mdash;') + '</td>'
      + '<td style="font-size:11px;color:var(--muted);border-top:' + (i === 0 ? '2px solid var(--line)' : 'none') + '">' + greeks + '</td>'
      + '<td style="font-size:11px;color:var(--muted);border-top:' + (i === 0 ? '2px solid var(--line)' : 'none') + '">' + exit + '</td>'
      + '</tr>';
  }).join('');
  const callBlocks = oi.calls.map(c => tierRows(c, true)).join('');
  const putBlocks = oi.puts.map(p => tierRows(p, false)).join('');
  if (callBlocks || putBlocks) {
    html += '<div class="sub">3 horizons per setup, each anchored to a liquidity draw: <b>Day</b> = 1H, <b>Swing</b> = 4H, <b>Runner</b> = Daily. Strike = OTM toward that target; <b>expiry is ATR-sized</b> (how long price needs to reach the target at its average range). Calls aim at buy-side liquidity above; puts at sell-side liquidity below. &Delta; = directional exposure, &theta; = daily decay. "Exit" = close when the underlying tags take/stop. Options can expire worthless.</div>';
    html += '<table><thead><tr><th>Symbol</th><th>Horizon &rarr; target</th><th>Suggested contract</th><th class="r">~Prem</th><th>Greeks</th><th>Exit</th></tr></thead><tbody>';
    if (oi.calls.length) html += '<tr><td colspan="6" style="font-weight:600;color:#16a34a;background:rgba(22,163,74,0.06)">CALLS &mdash; bullish setups</td></tr>' + callBlocks;
    if (oi.puts.length) html += '<tr><td colspan="6" style="font-weight:600;color:#dc2626;background:rgba(220,38,38,0.06)">PUTS &mdash; bearish (downtrend) names</td></tr>' + putBlocks;
    html += '</tbody></table>';
    const alts = oi.calls.concat(oi.puts).filter(x => x.etf).map(x => esc(x.sym) + '&rarr;' + esc(x.etf));
    if (alts.length) html += '<div class="sub">Leveraged ETF alternatives (same-direction): ' + alts.join(' &middot; ') + '</div>';
  } else {
    html += '<div class="sub">No high-conviction options ideas right now (no qualifying bullish/bearish setups in the latest scan).</div>';
  }
  return html;
}
