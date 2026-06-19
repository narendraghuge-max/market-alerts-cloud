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

// pick a directional contract: ~30-45 DTE, strike nearest spot, decent liquidity
function pick(chain, type, nowMs) {
  const wantType = type; // 'C' or 'P'
  const expiries = [...new Set(chain.opts.filter(o => o.type === wantType).map(o => o.expiryMs))].sort((a, b) => a - b);
  const targetMs = nowMs + 35 * 864e5;
  const expiry = expiries.filter(e => e - nowMs >= 14 * 864e5).sort((a, b) => Math.abs(a - targetMs) - Math.abs(b - targetMs))[0] || expiries.find(e => e > nowMs);
  if (!expiry) return null;
  const cands = chain.opts.filter(o => o.type === wantType && o.expiryMs === expiry);
  if (!cands.length) return null;
  // nearest-to-spot strike (ATM), with a liquidity floor so the quote is tradable
  const near = cands.filter(o => Math.abs(o.strike - chain.price) / chain.price <= 0.06);
  let pool = near.length ? near : cands;
  const liquid = pool.filter(o => (o.oi || 0) >= 25);
  if (liquid.length) pool = liquid;
  pool.sort((a, b) => Math.abs(a.strike - chain.price) - Math.abs(b.strike - chain.price));
  const top = pool[0];
  if (!top) return null;
  const mid = (top.bid > 0 && top.ask > 0) ? (top.bid + top.ask) / 2 : (top.ask || top.bid || 0);
  return {
    strike: top.strike,
    expiry: new Date(expiry).toISOString().slice(0, 10),
    dte: Math.round((expiry - nowMs) / 864e5),
    premium: +mid.toFixed(2),
    breakeven: +(type === 'C' ? top.strike + mid : top.strike - mid).toFixed(2),
    iv: top.iv ? +(top.iv * 100).toFixed(0) : null,
    oi: top.oi || 0,
  };
}

export async function buildOptionsIdeas(ok, nowMs) {
  // options only on regular underlyings (never on 2x/3x leveraged or inverse ETFs - confusing/illiquid)
  const bullish = ok.filter(r => !r.leveraged && (r.action === 'BUY' || r.action === 'ACCUMULATE') && r.dir !== 'short').slice(0, 3);
  const bearish = ok.filter(r => !r.leveraged && r.dir === 'short').sort((a, b) => b.score - a.score).slice(0, 3);
  const calls = [], puts = [];
  for (const r of bullish) {
    const ch = await fetchChain(r.symbol);
    const c = ch ? pick(ch, 'C', nowMs) : null;
    calls.push({ sym: r.symbol, score: r.score, grade: r.grade, action: r.action, target: r.tp2, invalid: r.stop, etf: etfFor(r.symbol).bull, contract: c });
    await new Promise(z => setTimeout(z, 120));
  }
  for (const r of bearish) {
    const ch = await fetchChain(r.symbol);
    const p = ch ? pick(ch, 'P', nowMs) : null;
    puts.push({ sym: r.symbol, score: r.score, grade: r.grade, etf: etfFor(r.symbol).bear, contract: p });
    await new Promise(z => setTimeout(z, 120));
  }
  return { calls, puts };
}
