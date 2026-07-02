// Portfolio Engine — an HONEST quant allocation/risk engine (decision-support, NOT advice, NOT a guarantee).
// Reads exits.json (holdings w/ price, pnl, stop, lev) + scan.json (universe setups w/ ATR + best risk/reward)
// + optional account meta from portfolio.json (_meta: equity/marginUsed/totalValue).
// Computes: allocation X-ray, risk diagnostics, goal->reality, then asks the AI for a risk-managed ACTION PLAN.
// Writes engine.json for the dashboard. Gated + versioned like make_briefing.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dir = dirname(fileURLToPath(import.meta.url));
const now = Date.now();
const GATE_MS = 28 * 60 * 1000;
const V = 3;                                   // engine prompt/schema version (bump to force one regen)
const TARGET = +(process.env.TARGET_MONTHLY || 2.5);   // realistic monthly return target, %
const read = f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };
const r2 = n => Math.round(n * 100) / 100;
const money = n => '$' + Math.round(n).toLocaleString('en-US');

// ---- refresh gate ----
const prevE = read('engine.json');
if (prevE && prevE.epoch && (now - prevE.epoch) < GATE_MS && prevE.v === V) {
  console.error('engine ' + Math.round((now - prevE.epoch) / 60000) + ' min old - fresh, skip'); process.exit(0);
}

const exits = read('exits.json');
const scan = read('scan.json');
const holdings = (exits?.results || []).filter(h => h.price > 0 && h.shares > 0);
if (!holdings.length) { console.error('no holdings data - skipping engine'); process.exit(0); }
const meta = (read('portfolio.json') || {})._meta || {};    // {equity, marginUsed, totalValue} if captured

// ---- sector + leverage helpers ----
const SEMI = ['NVDA','AVGO','AMD','TSM','MU','AMAT','LRCX','KLAC','SMCI','SMH','ARM','MRVL','ASML','TXN','QCOM','ADI','ON','MCHP','CRDO','ALAB','SOXL','SOXS','NVDU','NVDD'];
const SOFT = ['CRWD','PLTR','MSFT','GOOGL','META','AMZN','SNOW','TSLA','AAPL','NFLX','ORCL','ANET','NOW','PANW','NET','ZS','DDOG','CRM','APP','RDDT','CRWV','NBIS','VRT','GEV'];
const INDEX = ['SPY','QQQ','IWM','XLK','TQQQ','SQQQ','SPXL','SPXS','TNA','TZA','DIA'];
const SPACE = ['SPCX','SPAL','SPCH','SSPC','RKLB','ASTS','LUNR','RDW'];
const INCOME = ['QQQI','JEPI','JEPQ','SPYI'];
const sectorOf = s => SEMI.includes(s) ? 'Semiconductors' : SOFT.includes(s) ? 'AI / Software' : INDEX.includes(s) ? 'Broad index' : SPACE.includes(s) ? 'Space' : INCOME.includes(s) ? 'Income' : 'Other';
const levMult = h => { const t = (h.note || '') + ' ' + h.sym; if (/3x|3X|SOXL|SOXS|TQQQ|SQQQ|SPXL|SPXS|TNA|TZA/.test(t)) return 3; if (h.lev || /2x|2X/.test(t)) return 2; return 1; };

// ---- ATR% (daily vol proxy) per symbol, from the scan ----
const atrPct = {};
for (const s of (scan?.results || [])) { if (s.price > 0 && s.levels?.atr) atrPct[s.symbol] = s.levels.atr / s.price; }
const volOf = h => atrPct[h.sym] != null ? atrPct[h.sym] : (levMult(h) >= 3 ? 0.06 : levMult(h) === 2 ? 0.04 : 0.02);   // fallback daily vol

// ---- Allocation X-ray ----
const rows = holdings.map(h => ({ sym: h.sym, sector: sectorOf(h.sym), value: h.shares * h.price, lev: levMult(h), vol: volOf(h), stop: h.stop, price: h.price, pnlPct: h.pnlPct }));
const gross = rows.reduce((s, x) => s + x.value, 0);
rows.forEach(x => x.w = x.value / gross);
rows.sort((a, b) => b.value - a.value);
const equity = meta.equity || gross;                        // if no margin data, treat equity = gross
const marginUsed = meta.marginUsed || Math.max(0, gross - equity);
const marginLev = gross / equity;                           // gross exposure / your money
const lookThrough = rows.reduce((s, x) => s + x.value * x.lev, 0);   // leverage-ETF-adjusted economic exposure
const trueLev = lookThrough / equity;                       // true economic leverage vs equity
const bySector = {}; rows.forEach(x => bySector[x.sector] = (bySector[x.sector] || 0) + x.value);
const top1 = rows[0], top3 = rows.slice(0, 3).reduce((s, x) => s + x.w, 0);

// ---- Risk diagnostics (correlation-conservative: names are highly correlated tech, so treat as ~perfectly correlated) ----
// per-name daily return std ~ ATR%/1.4 (ATR range overstates std); combine with correlation ~0.65 (tech-heavy but part index/income)
const RHO = 0.65, dstd = x => x.vol * 0.7;
const _L = rows.reduce((s, x) => s + x.w * dstd(x), 0), _Q = rows.reduce((s, x) => s + (x.w * dstd(x)) ** 2, 0);
const portDayVol = Math.sqrt(RHO * _L * _L + (1 - RHO) * _Q);
const portMoVol = portDayVol * Math.sqrt(21);                          // ~1-month std
const moVolOnEquity = portMoVol * marginLev;                           // amplified by margin, on YOUR money
const badMonth = 2 * moVolOnEquity;                                    // ~2-sigma down month, on equity
const allStopsLoss = rows.reduce((s, x) => s + (x.price > x.stop ? x.value * (x.price - x.stop) / x.price : 0), 0);

// ---- Goal -> reality ----
const annual = (Math.pow(1 + TARGET / 100, 12) - 1) * 100;
const moSharpe = (TARGET / 100) / (portMoVol || 0.001);               // return/vol per month (elite is ~>0.3-0.5)

const X = {
  target: TARGET,
  xray: {
    gross, equity, marginUsed, marginLev: r2(marginLev), trueLev: r2(trueLev),
    positions: rows.map(x => ({ sym: x.sym, sector: x.sector, w: Math.round(x.w * 100), value: Math.round(x.value), lev: x.lev, pnlPct: x.pnlPct })),
    sectors: Object.entries(bySector).map(([k, v]) => ({ sector: k, w: Math.round(v / gross * 100) })).sort((a, b) => b.w - a.w),
    top1: { sym: top1.sym, w: Math.round(top1.w * 100) }, top3: Math.round(top3 * 100),
  },
  risk: {
    moSwingPct: r2(moVolOnEquity * 100), badMonthPct: r2(badMonth * 100),
    allStopsLoss: Math.round(allStopsLoss), allStopsPct: r2(allStopsLoss / equity * 100),
    flags: [
      top1.w > 0.30 ? `Concentration: ${top1.sym} is ${Math.round(top1.w * 100)}% of the book` : null,
      (bySector['Semiconductors'] || 0) / gross > 0.45 ? `Sector: ${Math.round((bySector['Semiconductors'] || 0) / gross * 100)}% in semiconductors` : null,
      trueLev > 1.5 ? `Leverage: ~${r2(trueLev)}x true economic exposure vs your equity` : null,
      marginLev > 1.3 ? `Margin: borrowing amplifies every move ~${r2(marginLev)}x on your equity` : null,
    ].filter(Boolean),
  },
  goal: { monthly: TARGET, annual: Math.round(annual), moVolPct: r2(portMoVol * 100), moSharpe: r2(moSharpe) },
};

// ---- best risk/reward LONG setups from the scanner (for the plan) ----
const setups = (scan?.results || [])
  .filter(s => s.score != null && !s.illiquid && s.direction !== 'short' && !/short|avoid/i.test(s.action) && s.levels?.rr >= 1.5)
  .sort((a, b) => (b.score - a.score) || (b.levels.rr - a.levels.rr)).slice(0, 8)
  .map(s => `${s.symbol}: ${s.action} ${s.score}/12, entry ${s.levels.entry1}-${s.levels.entry2}, stop ${s.levels.stop}, targets ${s.levels.tp1}/${s.levels.tp2}/${s.levels.tp3}, R ${s.levels.rr}`);
const attention = holdings.filter(h => h.status === 'SELL' || h.status === 'TRIM').map(h => `${h.sym} ${h.status} (${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}%)`);

// ---- AI action plan ----
const prompt = `You are my portfolio risk manager & allocation strategist. Decision-support, NOT advice, NOT a guarantee - plain English, no jargon.
I'm a retail trader on MARGIN, ~90% tech/chip-concentrated, and I want a DISCIPLINED plan aimed at a realistic ~${TARGET}%/month (I understand that's not guaranteed and some months lose money). Use ONLY the data below; never invent numbers.

MY CURRENT ALLOCATION (% of book): ${X.xray.positions.map(p => `${p.sym} ${p.w}% (${p.sector}${p.lev > 1 ? ', ' + p.lev + 'x' : ''}, ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%)`).join('; ')}
SECTOR MIX: ${X.xray.sectors.map(s => `${s.sector} ${s.w}%`).join(', ')}
RISK NOW: true leverage ~${X.xray.trueLev}x vs equity; expected ~1-month swing ±${X.risk.moSwingPct}%, a bad (2-sigma) month ~-${X.risk.badMonthPct}%; if every stop hit I lose ${money(X.risk.allStopsLoss)} (${X.risk.allStopsPct}% of equity). FLAGS: ${X.risk.flags.join(' | ') || 'none major'}
HOLDINGS FLAGGED BY MY EXIT-SCANNER: ${attention.join(', ') || 'none - all holding up'}
SCANNER'S BEST RISK/REWARD LONG SETUPS RIGHT NOW: ${setups.join(' | ') || '(none strong)'}

Return ONLY valid JSON (no markdown): {"moves":[{"sym":"...","action":"Sell|Trim|Add|Buy|Watch","targetPct":<number>,"note":"<=7 words why"}],"plan":["...","..."],"read":"..."}
moves = 3-7 concrete portfolio moves behind the plan (skip pure no-change holds). action = Sell (exit fully), Trim (reduce a holding), Add (increase a holding), Buy (start a NEW position), Watch (conditional add only if it triggers). targetPct = the % of my book this name should be AFTER the move (0 to fully exit; for Buy/Watch = the intended position size %, usually 3-6). ONLY use tickers from my holdings or the scanner setups above. Be RISK-FIRST: cut leverage/concentration before adding, and keep total adds <= total trims + a cash buffer.
plan = the SAME moves as 4-6 short plain-English sentences (the "why"), prioritized, risk-first.
read = 2-3 sentences: an HONEST read on whether ~${TARGET}%/month is realistic for THIS book and what would have to change (usually less concentration/leverage + consistency). Never promise a return.
Decision-support / educational only. Never guarantee outcomes.`;

async function claude(p) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('no ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 1400, messages: [{ role: 'user', content: p }] }), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error('claude HTTP ' + r.status);
  const t = ((await r.json()).content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!t) throw new Error('claude empty'); return t;
}
async function gemini(p) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('no GEMINI_API_KEY');
  for (const m of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 1500, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' } }), signal: AbortSignal.timeout(45000) });
      if (!r.ok) continue;
      const t = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text; if (t) return t.trim();
    } catch {}
  }
  throw new Error('gemini failed');
}
function parseAI(raw) { const s = raw.indexOf('{'), e = raw.lastIndexOf('}'); const o = JSON.parse(raw.slice(s, e + 1)); if (!Array.isArray(o.plan)) o.plan = []; if (!Array.isArray(o.moves)) o.moves = []; return o; }
const trimSent = (s, max) => { s = String(s).trim(); if (s.length <= max) return s; const cut = s.slice(0, max); const lp = cut.lastIndexOf('. '); return lp > max * 0.5 ? cut.slice(0, lp + 1) : cut.replace(/\s+\S*$/, '') + '…'; };

// templated fallback so the engine is never blank
function fallback() {
  const plan = [], moves = [];
  const levPos = X.xray.positions.find(p => p.lev >= 2);
  if (levPos) { moves.push({ sym: levPos.sym, action: 'Trim', targetPct: Math.min(levPos.w, 3), note: 'cut leverage/decay' }); plan.push(`Keep leveraged ${levPos.sym} (${levPos.lev}x) small and on a tight stop - it decays and amplifies drawdowns.`); }
  if (X.xray.top1.w > 30) { moves.push({ sym: X.xray.top1.sym, action: 'Trim', targetPct: 25, note: 'reduce concentration' }); plan.push(`Trim ${X.xray.top1.sym} (${X.xray.top1.w}%) back toward ~25% to cut single-name risk.`); }
  if (setups[0]) { moves.push({ sym: setups[0].split(':')[0], action: 'Buy', targetPct: 4, note: 'scanner top setup' }); plan.push(`Best fresh setup: ${setups[0]}. Consider a starter (~4% of book) only if it triggers.`); }
  plan.push('Hold a cash buffer (~10%) so you can act on setups without forced selling.');
  plan.push('Respect every stop - capping losers is what lets winners compound toward the target.');
  return { moves, plan, read: `A ~${TARGET}%/month target is aggressive but not impossible in a strong tape; for this book it hinges on cutting concentration/leverage and staying consistent - expect losing months, and size so a bad one (~-${X.risk.badMonthPct}%) doesn't force your hand.` };
}

let out, src = 'auto';
for (const [name, fn] of [['Claude', claude], ['Gemini', gemini]]) {
  if ((name === 'Claude' && !process.env.ANTHROPIC_API_KEY) || (name === 'Gemini' && !process.env.GEMINI_API_KEY)) continue;
  try { out = parseAI(await fn(prompt)); src = name; break; } catch (e) { console.error(name + ' engine failed:', e.message); }
}
if (!out) out = fallback();

const plan = (out.plan || []).slice(0, 6).map(p => trimSent(String(p).replace(/^\s*\d+[.):]\s*/, ''), 340)).filter(Boolean);   // strip any leading "1." the model adds (the <ol> numbers it)
// ---- concrete share + $ sizing per move (target weight -> shares to buy/sell + dollar amount) ----
const hMap = {}; holdings.forEach(h => hMap[h.sym] = { shares: h.shares, price: h.price, value: h.shares * h.price });
const sPrice = {}; (scan?.results || []).forEach(s => { if (s.price > 0) sPrice[s.symbol] = s.price; });
const moves = (out.moves || []).slice(0, 8).map(m => {
  const sym = String(m.sym || '').toUpperCase();
  const cur = hMap[sym] || { shares: 0, value: 0, price: sPrice[sym] || 0 };
  const price = cur.price || sPrice[sym] || 0;
  const tPct = Math.max(0, +m.targetPct || 0);
  const deltaVal = (tPct / 100 * gross) - cur.value;
  const deltaSh = price ? Math.round(deltaVal / price) : 0;
  return { sym, action: String(m.action || '').replace(/[^A-Za-z]/g, '').slice(0, 6) || 'Adj', targetPct: r2(tPct), deltaShares: deltaSh, deltaUsd: Math.round(deltaVal), curShares: r2(cur.shares), note: trimSent(String(m.note || ''), 48) };
}).filter(m => m.sym && (Math.abs(m.deltaShares) >= 1 || /watch/i.test(m.action)));
writeFileSync(join(dir, 'engine.json'), JSON.stringify({ ts: new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' (' + src + ')', epoch: now, v: V, target: TARGET, xray: X.xray, risk: X.risk, goal: X.goal, moves, plan, read: trimSent(out.read || '', 480) }, null, 2));
console.error(`engine written: ${moves.length} moves, ${plan.length} steps via ${src}`);

