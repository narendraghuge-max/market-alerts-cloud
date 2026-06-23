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

// Lightweight Black-Scholes (rates=0) used to project what the contract is worth
// if the underlying tags the take-target — i.e. a sensible limit-SELL anchor.
function ncdf(x) {
  const s = x < 0 ? -1 : 1, z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + s * y);
}
function bsPrice(type, S, K, Tyears, sigma) {
  const intrinsic = type === 'C' ? Math.max(0, S - K) : Math.max(0, K - S);
  if (!(Tyears > 0) || !(sigma > 0) || !(S > 0) || !(K > 0)) return intrinsic;
  const v = sigma * Math.sqrt(Tyears);
  const d1 = (Math.log(S / K) + 0.5 * sigma * sigma * Tyears) / v, d2 = d1 - v;
  const px = type === 'C' ? S * ncdf(d1) - K * ncdf(d2) : K * ncdf(-d2) - S * ncdf(-d1);
  return Math.max(px, intrinsic);
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
  const cf = score >= 8 ? 0.6 : score >= 7 ? 0.5 : score >= 5 ? 0.4 : 0.3;
  // Anchor the strike so the take-target prints IN-the-money: a call strike must sit
  // AT or BELOW the target (a put AT or ABOVE it) — otherwise the option is still OTM
  // when the target hits and you'd sell for less than you paid. Aim partway from spot
  // to the target (conviction-scaled) and hard-cap on the in-the-money side of it.
  // tgtUsed = the structural scan target when it's a real directional draw (above spot
  // for calls / below for puts), else fall back to the implied move. Everything below
  // (strike cap, displayed target, exit premium) keys off this one value, so they stay
  // consistent and the option is always in-the-money when the target prints.
  let desired, side, tgtUsed;
  if (type === 'C') {
    tgtUsed = (target && target > price) ? target : price + EM;
    desired = Math.max(price - 0.4 * EM, Math.min(price + cf * (tgtUsed - price), tgtUsed));
    side = chain2.filter(o => o.strike <= tgtUsed && o.strike >= price - 0.6 * EM);
    if (!side.length) side = chain2.filter(o => o.strike <= tgtUsed);
  } else {
    tgtUsed = (target && target > 0 && target < price) ? target : price - EM;
    desired = Math.min(price + 0.4 * EM, Math.max(price - cf * (price - tgtUsed), tgtUsed));
    side = chain2.filter(o => o.strike >= tgtUsed && o.strike <= price + 0.6 * EM);
    if (!side.length) side = chain2.filter(o => o.strike >= tgtUsed);
  }
  if (!side.length) side = chain2;
  const liquid = side.filter(o => (o.oi || 0) >= 25 && (o.ask > 0 || o.bid > 0));
  const quoted = side.filter(o => o.ask > 0 || o.bid > 0);
  const pool = liquid.length ? liquid : (quoted.length ? quoted : side);
  pool.sort((a, b) => Math.abs(a.strike - desired) - Math.abs(b.strike - desired));
  const top = pool[0];
  if (!top) return null;
  const mid = (top.bid > 0 && top.ask > 0) ? (top.bid + top.ask) / 2 : (top.ask || top.bid || 0);
  // Projected SELL premium if the underlying tags `target`. Assume the target prints
  // around a third of the way through the horizon (~70% of time-to-expiry still left)
  // — a realistic, fillable limit-sell anchor, not an instant-spike best case.
  // If no listed strike sits on the in-the-money side of the target (weak/late setup),
  // clamp the effective target to the chosen strike so it's never below it — the exit
  // then prices at-the-money and the multiple honestly goes <1x (red = skip / use ETF).
  const effTarget = type === 'C' ? Math.max(tgtUsed, top.strike) : Math.min(tgtUsed, top.strike);
  const sigma = (top.iv && top.iv > 0) ? top.iv : iv;
  const tRemain = Math.max(1, dte * 0.7) / 365;
  const exitPrem = +bsPrice(type, effTarget, top.strike, tRemain, sigma).toFixed(2);
  const exitMult = mid > 0 ? +(exitPrem / mid).toFixed(1) : null;
  return {
    strike: top.strike,
    target: +effTarget.toFixed(2),
    expiry: new Date(expiry).toISOString().slice(0, 10),
    dte,
    otmPct: +Math.abs((top.strike - price) / price * 100).toFixed(1),
    premium: +mid.toFixed(2),
    exitPrem,
    exitMult,
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
  // An option is only worth buying over the ETF if it clears a real gain at its target
  // (after the time-decay it pays while you hold it). Below this, steer to the ETF.
  const GOOD = 1.15;
  const tierRows = (idea, isCall) => TIERS.map((t, i) => {
    const c = idea.tiers ? idea.tiers[t.key] : null;
    const tgt = c ? c.target : (idea.targets || {})[t.key];
    const col = isCall ? '#16a34a' : '#dc2626';
    const bt = i === 0 ? '2px solid var(--line)' : 'none';
    const td = (inner, extra) => '<td style="border-top:' + bt + ';' + (extra || '') + '">' + inner + '</td>';
    const symCell = i === 0 ? '<b>' + esc(idea.sym) + '</b><div style="font-size:11px;color:var(--muted)">' + idea.score + '/8 ' + esc(idea.grade || '-') + '</div>' : '';
    const etfCell = i === 0 ? (idea.etf ? esc(idea.etf) : '<span style="color:var(--muted)">&mdash;</span>') : '';
    const stop = idea.invalid ? '$' + idea.invalid : '&mdash;';
    const wins = c && c.exitMult != null && c.exitMult >= GOOD;
    let contract, buy, sell, greeks;
    if (wins) {
      contract = '$' + c.strike + ' <span style="color:var(--muted)">(' + c.otmPct + '% OTM)</span> &middot; ' + c.expiry + ' &middot; ' + c.dte + 'd' + (c.iv ? ' &middot; IV' + c.iv + '%' : '');
      buy = '$' + c.premium;
      sell = '<b style="color:#16a34a">$' + c.exitPrem + '</b> <span style="color:#16a34a">(' + c.exitMult + 'x)</span>';
      greeks = '&Delta;' + (c.delta != null ? c.delta : '-') + (c.theta != null ? ' &middot; &theta;' + c.theta : '');
    } else {
      // The option's decay would eat the move — point at the leveraged ETF (Alt column).
      contract = '<span style="color:var(--muted)">move too small for the option &mdash; <b>use the ETF</b> (Alt col) for this horizon</span>';
      buy = '&mdash;'; sell = '<span style="color:var(--muted)">ETF</span>'; greeks = '';
    }
    return '<tr>'
      + td(symCell)
      + td(etfCell, 'font-size:12px')
      + td('<b style="color:' + col + '">' + t.label + '</b>' + (tgt ? ' <span style="color:var(--muted)">&rarr; $' + tgt + '</span>' : ''), 'font-size:12px')
      + td(contract, 'font-size:12px')
      + '<td class="r" style="border-top:' + bt + '">' + buy + '</td>'
      + '<td class="r" style="border-top:' + bt + '">' + sell + '</td>'
      + td(greeks, 'font-size:11px;color:var(--muted)')
      + td(stop, 'font-size:11px;color:var(--muted)')
      + '</tr>';
  }).join('');
  const callBlocks = oi.calls.map(c => tierRows(c, true)).join('');
  const putBlocks = oi.puts.map(p => tierRows(p, false)).join('');
  if (callBlocks || putBlocks) {
    html += '<div class="sub"><b>How to read this:</b> each name shows 3 holding lengths &mdash; <b>Day</b> (~days), <b>Swing</b> (~2 weeks), <b>Runner</b> (~1 month+). For each: <b>Buy ~</b> = the option mid you pay to open, <b>Sell ~</b> = the estimated mid to close when price reaches the target (the <b>x</b> is your gain &mdash; set your limit-sell there). Only <b>profitable</b> options are shown; when the move is too small to beat time-decay, the row says <b>use the ETF</b> instead (the Alt column &mdash; no expiry, no decay). <b>Stop</b> = the underlying price that kills the idea. &Delta;/&theta; = how much the option moves with the stock / loses per day. High-risk; confirm live pricing; not advice.</div>';
    html += '<table><thead><tr><th>Symbol</th><th>Alt (lev. ETF)</th><th>Horizon &rarr; target</th><th>Suggested contract</th><th class="r">Buy ~</th><th class="r">Sell ~</th><th>Greeks</th><th>Stop</th></tr></thead><tbody>';
    if (oi.calls.length) html += '<tr><td colspan="8" style="font-weight:600;color:#16a34a;background:rgba(22,163,74,0.06)">CALLS &mdash; bullish setups</td></tr>' + callBlocks;
    if (oi.puts.length) html += '<tr><td colspan="8" style="font-weight:600;color:#dc2626;background:rgba(220,38,38,0.06)">PUTS &mdash; bearish (downtrend) names</td></tr>' + putBlocks;
    html += '</tbody></table>';
  } else {
    html += '<div class="sub">No high-conviction options ideas right now (no qualifying bullish/bearish setups in the latest scan).</div>';
  }
  return html;
}
