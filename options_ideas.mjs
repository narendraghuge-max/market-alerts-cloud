// Recommended directional options ideas derived from the SMC buy-scan results.
// Calls on the strongest bullish setups, puts on the most bearish (DOWN) names.
// Uses CBOE's free delayed options feed (no API key). Decision-support only.

// underlying ticker -> matching leveraged ETF play (bull for calls, bear for puts).
// Single-stock 2x where it exists, else the sector/index proxy.
const ETF = {
  NVDA: { bull: 'NVDU (2x)', bear: 'NVDD (2x)' },
  AAPL: { bull: 'AAPU (2x)', bear: '' },
  MSFT: { bull: 'MSFU (2x)', bear: '' },
  AMZN: { bull: 'AMZU (2x)', bear: '' },
  GOOGL: { bull: 'GGLL (2x)', bear: '' },
  META: { bull: 'METU (2x)', bear: '' },
  SPCX: { bull: 'SPCH (2x)', bear: 'SSPC (2x)' },
};
// sector fallback by membership
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
    const price = d.current_price;
    const opts = d.options.map(o => { const p = parseOcc(o.option); return p ? { ...p, bid: o.bid, ask: o.ask, iv: o.iv, delta: o.delta, oi: o.open_interest, vol: o.volume } : null; }).filter(Boolean);
    return { price, opts };
  } catch (e) { return null; }
}

// Adaptive OTM strike: sized to the setup's target (calls) or the implied-vol
// expected move (puts), then scaled by conviction (higher score -> further OTM).
// ~30-45 DTE, liquidity floor so the quote is tradable.
function pick(chain, type, nowMs, info = {}) {
  const price = chain.price;
  const all = chain.opts.filter(o => o.type === type);
  const expiries = [...new Set(all.map(o => o.expiryMs))].sort((a, b) => a - b);
  const targetMs = nowMs + 35 * 864e5;
  const expiry = expiries.filter(e => e - nowMs >= 14 * 864e5).sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0] || expiries.find(e => e > nowMs);
  if (!expiry) return null;
  const dte = Math.round((expiry - nowMs) / 864e5);
  const chain2 = all.filter(o => o.expiryMs === expiry);
  if (!chain2.length) return null;
  // expected move from at-the-money implied volatility over the holding period
  const atm = chain2.slice().sort((a, b) => Math.abs(a.strike - price) - Math.abs(b.strike - price))[0];
  const iv = (atm && atm.iv > 0) ? atm.iv : 0.5;
  const EM = price * iv * Math.sqrt(dte / 365);
  // conviction: stronger setups push the strike further OTM (more leverage)
  const sc = info.score || 5;
  const cf = sc >= 8 ? 0.65 : sc >= 7 ? 0.55 : sc >= 5 ? 0.42 : 0.32;
  let desired;
  if (type === 'C') {
    const tgt = (info.target && info.target > price) ? info.target : price + EM; // anchor to swing target if we have it
    desired = price + cf * (tgt - price);
    if (!(desired > price)) desired = price + 0.3 * EM;
  } else {
    const tgt = (info.target && info.target > 0 && info.target < price) ? info.target : price - EM;
    desired = price - cf * (price - tgt);
    if (!(desired < price)) desired = price - 0.3 * EM;
  }
  // predictive guardrail: keep the strike within ~1.25x the implied move (don't chase a far target into a lottery strike)
  const maxOff = 1.25 * EM;
  desired = type === 'C' ? Math.min(desired, price + maxOff) : Math.max(desired, price - maxOff);
  // nearest listed strike on the OTM side to the desired level, with a liquidity floor
  let side = type === 'C' ? chain2.filter(o => o.strike >= price) : chain2.filter(o => o.strike <= price);
  if (!side.length) side = chain2;
  const liquid = side.filter(o => (o.oi || 0) >= 25);
  const pool = liquid.length ? liquid : side;
  pool.sort((a, b) => Math.abs(a.strike - desired) - Math.abs(b.strike - desired));
  const top = pool[0];
  if (!top) return null;
  const mid = (top.bid > 0 && top.ask > 0) ? (top.bid + top.ask) / 2 : (top.ask || top.bid || 0);
  return {
    strike: top.strike,
    expiry: new Date(expiry).toISOString().slice(0, 10),
    dte,
    premium: +mid.toFixed(2),
    breakeven: +(type === 'C' ? top.strike + mid : top.strike - mid).toFixed(2),
    iv: top.iv ? +(top.iv * 100).toFixed(0) : null,
    oi: top.oi || 0,
    otmPct: +Math.abs((top.strike - price) / price * 100).toFixed(1),
  };
}

export async function buildOptionsIdeas(ok, nowMs, n = 6) {
  // options only on regular underlyings (never on 2x/3x leveraged or inverse ETFs - confusing/illiquid)
  const bullish = ok.filter(r => !r.leveraged && r.dir !== 'short' && (r.action === 'BUY' || r.action === 'ACCUMULATE' || r.score >= 5)).slice(0, n);
  const bearish = ok.filter(r => !r.leveraged && r.dir === 'short').sort((a, b) => b.score - a.score).slice(0, n);
  const calls = [], puts = [];
  for (const r of bullish) {
    const ch = await fetchChain(r.symbol);
    const c = ch ? pick(ch, 'C', nowMs, { target: r.tp2, score: r.score }) : null;
    calls.push({ sym: r.symbol, score: r.score, grade: r.grade, action: r.action, target: r.tp2, invalid: r.stop, etf: etfFor(r.symbol).bull, contract: c });
    await new Promise(z => setTimeout(z, 100));
  }
  for (const r of bearish) {
    const ch = await fetchChain(r.symbol);
    const p = ch ? pick(ch, 'P', nowMs, { score: r.score }) : null;
    puts.push({ sym: r.symbol, score: r.score, grade: r.grade, etf: etfFor(r.symbol).bear, contract: p });
    await new Promise(z => setTimeout(z, 100));
  }
  return { calls, puts };
}
