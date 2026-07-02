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
const V = 8;                                   // engine prompt/schema version (bump to force one regen)
const TARGET = +(process.env.TARGET_MONTHLY || 2.5);   // realistic monthly return target, %
const read = f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };
const r2 = n => Math.round(n * 100) / 100;
const money = n => '$' + Math.round(n).toLocaleString('en-US');

// ---- refresh cadence: quant + $/share/price sizing recompute EVERY run (~15 min);
// the AI plan/decisions are gated (~30 min) and cached in engine_ai.json, then re-priced on fresh data each run ----
const prevAI = read('engine_ai.json');

const exits = read('exits.json');
const scan = read('scan.json');
const holdings = (exits?.results || []).filter(h => h.price > 0 && h.shares > 0);
if (!holdings.length) { console.error('no holdings data - skipping engine'); process.exit(0); }
const meta = exits?.meta || (read('portfolio.json') || {})._meta || {};    // real {equity, marginUsed, totalValue} — from HOLDINGS_JSON _meta (cloud) or local portfolio.json

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

// ---- Projected return (INFORMATION ONLY): a long-run market-return assumption + the book's own volatility ----
const BASE_ANNUAL = +(process.env.BASE_ANNUAL || 10);                 // modeling assumption for expected market return, %/yr
const annualVolPct = portMoVol * Math.sqrt(12) * 100;

// ---- RISK MODES: three alternative postures the user can toggle on the dashboard (conservative de-risks; aggressive leans into leverage) ----
const MODES = [
  { key: 'conservative', label: 'Conservative', target: +(process.env.TARGET_CONSERVATIVE || 1.5), betaMult: 0.6, volMult: 0.55,
    posture: 'CAPITAL PRESERVATION. Cut ALL leveraged ETFs (SOXL/SPAL/TQQQ etc.) to zero or tiny. Favor income (QQQI) + broad index (SPY/QQQ) + only top-quality names. Cap any single name <=20%, any sector <=45%. Hold a large cash buffer (~15-20%). Tight stops. Steady, low-drawdown.' },
  { key: 'balanced', label: 'Balanced', target: +(process.env.TARGET_MONTHLY || 2.5), betaMult: 1.0, volMult: 1.0,
    posture: 'RISK-FIRST GROWTH. Trim leverage to small (<=5%) and reduce concentration toward ~25%. Blend broad index + quality tech + a little leverage. Cash buffer ~10%. Keep total adds <= total trims + buffer.' },
  { key: 'aggressive', label: 'Aggressive Growth', target: +(process.env.TARGET_AGGRESSIVE || 4), betaMult: 1.5, volMult: 1.7,
    posture: 'STRETCH GROWTH - you MAY use and even ADD leveraged ETFs (3x SOXL, 2x SPAL, TQQQ) and concentrate in the highest-scoring scanner setups; smaller cash buffer (~5%); wider but STRICT stops. This raises BOTH upside AND drawdown, leveraged ETFs decay/rebalance daily, and it can lose a lot fast - only with strict stop discipline.' },
  { key: 'income', label: 'Income', target: +(process.env.TARGET_INCOME || 1), betaMult: 0.8, volMult: 0.45,
    posture: 'PARK CASH FOR YIELD. Rotate into income / covered-call ETFs (QQQI, JEPQ, JEPI, SPYI) + some broad index for steady MONTHLY DISTRIBUTIONS; cut leverage and high-beta single names to near zero. Keep a cash buffer. Prioritize low drawdown + reliable income over growth. Note: distributions are variable (not guaranteed) and NAV can still fall in a selloff - this is cash-like income, not a savings account.' },
];
const modeGoal = (t, volMult) => { const moVol = portMoVol * volMult; return { monthly: t, annual: Math.round((Math.pow(1 + t / 100, 12) - 1) * 100), moVolPct: r2(moVol * 100), moSharpe: r2((t / 100) / (moVol || 0.001)) }; };
const modeProj = (betaMult, volMult) => { const ba = r2(BASE_ANNUAL * betaMult), av = r2(annualVolPct * volMult); return { baseAnnual: ba, baseMonthly: r2((Math.pow(1 + ba / 100, 1 / 12) - 1) * 100), annualVol: av, goodYr: Math.round(ba + av), badYr: Math.round(ba - av) }; };

// ---- move sizing helpers: target weight -> shares/$/entry-stop-TP prices (recomputed every run on fresh data), shared across all modes ----
const hMap = {}; holdings.forEach(h => hMap[h.sym] = { shares: h.shares, price: h.price, value: h.shares * h.price });
const sPrice = {}, scanLvl = {}; (scan?.results || []).forEach(s => { if (s.price > 0) sPrice[s.symbol] = s.price; if (s.levels) scanLvl[s.symbol] = s.levels; });
const holdLvl = {}; holdings.forEach(h => holdLvl[h.sym] = { price: h.price, stop: h.stop, tps: [h.tp1, h.tp2, h.tp3].filter(v => v != null) });
const sizeMoves = raw => (raw || []).slice(0, 8).map(m => {
  const sym = String(m.sym || '').toUpperCase();
  const cur = hMap[sym] || { shares: 0, value: 0, price: sPrice[sym] || 0 };
  const price = cur.price || sPrice[sym] || 0;
  const tPct = Math.max(0, +m.targetPct || 0);
  const deltaVal = (tPct / 100 * gross) - cur.value;
  const deltaSh = price ? Math.round(deltaVal / price) : 0;
  const buying = /add|buy|watch/i.test(m.action), sl = scanLvl[sym], hl = holdLvl[sym];
  const at = buying ? (sl?.entry1 ?? hl?.price ?? price) : (hl?.price ?? price);
  const stop = buying ? (sl?.stop ?? hl?.stop ?? null) : (hl?.stop ?? null);
  const tps = buying ? (sl ? [sl.tp1, sl.tp2, sl.tp3].filter(v => v != null) : (hl?.tps || [])) : [];
  return { sym, action: String(m.action || '').replace(/[^A-Za-z]/g, '').slice(0, 6) || 'Adj', targetPct: r2(tPct), deltaShares: deltaSh, deltaUsd: Math.round(deltaVal), curShares: r2(cur.shares), at: at ? r2(at) : null, stop: stop != null ? r2(stop) : null, tps: tps.slice(0, 3).map(r2), note: trimSent(String(m.note || ''), 38) };
}).filter(m => m.sym && (Math.abs(m.deltaShares) >= 1 || /watch/i.test(m.action)));
const cleanRaw = raw => (raw || []).slice(0, 8).map(m => ({ sym: String(m.sym || '').toUpperCase(), action: String(m.action || '').replace(/[^A-Za-z]/g, '').slice(0, 6) || 'Adj', targetPct: r2(Math.max(0, +m.targetPct || 0)), note: trimSent(String(m.note || ''), 38) }));
const cleanPlan = arr => (arr || []).slice(0, 6).map(p => trimSent(String(p).replace(/^\s*\d+[.):]\s*/, ''), 340)).filter(Boolean);

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

// ---- AI action plan: THREE modes (conservative / balanced / aggressive) in ONE call ----
const modeSpec = MODES.map(m => `- "${m.key}" (${m.label}, target ~${m.target}%/mo): ${m.posture}`).join('\n');
const prompt = `You are my portfolio risk manager & allocation strategist. Decision-support, NOT advice, NOT a guarantee - plain English, no jargon.
I'm a retail trader on MARGIN, ~90% tech/chip-concentrated. Give me THREE alternative plans for the SAME current book - one per risk mode below. Use ONLY the data below; never invent numbers.

MY CURRENT ALLOCATION (% of book): ${X.xray.positions.map(p => `${p.sym} ${p.w}% (${p.sector}${p.lev > 1 ? ', ' + p.lev + 'x' : ''}, ${p.pnlPct >= 0 ? '+' : ''}${p.pnlPct}%)`).join('; ')}
SECTOR MIX: ${X.xray.sectors.map(s => `${s.sector} ${s.w}%`).join(', ')}
RISK NOW: true leverage ~${X.xray.trueLev}x vs equity; expected ~1-month swing ±${X.risk.moSwingPct}%, a bad (2-sigma) month ~-${X.risk.badMonthPct}%; if every stop hit I lose ${money(X.risk.allStopsLoss)} (${X.risk.allStopsPct}% of equity). FLAGS: ${X.risk.flags.join(' | ') || 'none major'}
HOLDINGS FLAGGED BY MY EXIT-SCANNER: ${attention.join(', ') || 'none - all holding up'}
SCANNER'S BEST RISK/REWARD LONG SETUPS RIGHT NOW: ${setups.join(' | ') || '(none strong)'}

THE THREE MODES (make the plans genuinely DIFFERENT - conservative de-risks hardest, aggressive leans into leverage/concentration):
${modeSpec}

Return ONLY valid JSON (no markdown), EXACTLY this shape (all three keys required):
{"conservative":{"moves":[{"sym":"...","action":"Sell|Trim|Add|Buy|Watch","targetPct":<number>,"note":"<=7 words why"}],"plan":["...","..."],"read":"..."},"balanced":{"moves":[...],"plan":[...],"read":"..."},"aggressive":{"moves":[...],"plan":[...],"read":"..."},"income":{"moves":[...],"plan":[...],"read":"..."}}
For EACH mode:
- moves = 3-7 concrete moves matching THAT mode's posture. action = Sell (exit fully), Trim (reduce), Add (increase), Buy (start NEW), Watch (conditional add only if it triggers). targetPct = % of my book this name should be AFTER the move (0 to exit; Buy/Watch = intended size %). ONLY use tickers from my holdings or the scanner setups above.
- plan = the SAME moves as 4-6 short plain-English sentences (the "why"), appropriate to the mode.
- read = 2-3 HONEST sentences on that mode's realistic ~target%/mo outlook AND its risk. For aggressive, stress the bigger drawdown + leverage decay. Never promise a return.
Decision-support / educational only. Never guarantee outcomes.`;

async function claude(p) {
  const key = process.env.ANTHROPIC_API_KEY; if (!key) throw new Error('no ANTHROPIC_API_KEY');
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6', max_tokens: 3500, messages: [{ role: 'user', content: p }] }), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error('claude HTTP ' + r.status);
  const t = ((await r.json()).content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!t) throw new Error('claude empty'); return t;
}
async function gemini(p) {
  const key = process.env.GEMINI_API_KEY; if (!key) throw new Error('no GEMINI_API_KEY');
  for (const m of ['gemini-2.5-flash', 'gemini-2.5-flash-lite']) {
    try {
      const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m + ':generateContent?key=' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0.5, maxOutputTokens: 4000, thinkingConfig: { thinkingBudget: 0 }, responseMimeType: 'application/json' } }), signal: AbortSignal.timeout(45000) });
      if (!r.ok) continue;
      const t = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text; if (t) return t.trim();
    } catch {}
  }
  throw new Error('gemini failed');
}
function parseAI(raw) { const s = raw.indexOf('{'), e = raw.lastIndexOf('}'); return JSON.parse(raw.slice(s, e + 1)); }
const trimSent = (s, max) => { s = String(s).trim(); if (s.length <= max) return s; const cut = s.slice(0, max); const lp = cut.lastIndexOf('. '); return lp > max * 0.5 ? cut.slice(0, lp + 1) : cut.replace(/\s+\S*$/, '') + '…'; };

// templated fallback so the engine is never blank — produces all three modes
function fallbackAll() {
  const lev = X.xray.positions.filter(p => p.lev >= 2);
  const top1 = X.xray.top1;
  const setupSym = setups[0] ? setups[0].split(':')[0] : null;
  const conservative = { moves: [], plan: [], read: '' }, balanced = { moves: [], plan: [], read: '' }, aggressive = { moves: [], plan: [], read: '' };
  // conservative: exit leverage, trim concentration hard, lean income + cash
  lev.forEach(p => conservative.moves.push({ sym: p.sym, action: 'Sell', targetPct: 0, note: 'no leverage' }));
  if (top1.w > 20) conservative.moves.push({ sym: top1.sym, action: 'Trim', targetPct: 20, note: 'cap single name' });
  conservative.plan = [lev.length ? `Exit leveraged ETFs (${lev.map(p => p.sym).join(', ')}) - they decay and can gap against you.` : 'No leveraged ETFs to cut - good.', top1.w > 20 ? `Trim ${top1.sym} (${top1.w}%) to ~20% to cap single-name risk.` : 'Keep any single name under ~20%.', 'Lean on income (QQQI) + broad index; hold a 15-20% cash buffer.', 'Use tight stops - the goal is small, steady gains and shallow drawdowns.'];
  conservative.read = `A ~${MODES[0].target}%/mo steady target is realistic for a de-risked book; expect calmer swings but you give up some upside in strong tapes. Preservation first.`;
  // balanced: risk-first trim leverage small + reduce concentration + a starter
  lev.forEach(p => balanced.moves.push({ sym: p.sym, action: 'Trim', targetPct: Math.min(p.w, 3), note: 'cut leverage/decay' }));
  if (top1.w > 30) balanced.moves.push({ sym: top1.sym, action: 'Trim', targetPct: 25, note: 'reduce concentration' });
  if (setupSym) balanced.moves.push({ sym: setupSym, action: 'Buy', targetPct: 4, note: 'scanner top setup' });
  balanced.plan = [lev.length ? 'Keep leveraged ETFs small (<=3%) and on tight stops - they decay and amplify drawdowns.' : 'No leverage to trim.', top1.w > 30 ? `Trim ${top1.sym} (${top1.w}%) toward ~25% to cut single-name risk.` : 'Hold single names near ~25% max.', setupSym ? `Best fresh setup: ${setups[0]}. A starter (~4%) only if it triggers.` : 'No compelling new setup - hold and watch.', 'Hold a ~10% cash buffer and respect every stop.'];
  balanced.read = `A ~${MODES[1].target}%/mo target is aggressive but not impossible in a strong tape; hinges on cutting concentration/leverage + consistency. Expect losing months - size so a bad one (~-${X.risk.badMonthPct}%) doesn't force your hand.`;
  // aggressive: keep/add leverage + concentrate in the top scanner setup
  lev.forEach(p => aggressive.moves.push({ sym: p.sym, action: 'Add', targetPct: Math.max(p.w, 6), note: 'lean into momentum' }));
  if (setupSym) aggressive.moves.push({ sym: setupSym, action: 'Buy', targetPct: 6, note: 'high-conviction setup' });
  if (!lev.length && setups[1]) aggressive.moves.push({ sym: setups[1].split(':')[0], action: 'Buy', targetPct: 5, note: 'second setup' });
  aggressive.plan = [lev.length ? `Lean into leveraged ETFs (${lev.map(p => p.sym).join(', ')}) toward ~6% each - but hold a STRICT stop; they decay and can drop hard fast.` : 'Consider a small leveraged sleeve (SOXL/TQQQ) with a strict stop for extra beta.', setupSym ? `Press the strongest scanner setup: ${setups[0]} (~6%).` : 'Concentrate in the highest-scoring setups as they appear.', 'Run a small (~5%) cash buffer - stay invested for the upside.', 'Wider but STRICT stops. This mode can lose a lot fast - discipline is everything.'];
  aggressive.read = `A ~${MODES[2].target}%/mo stretch target needs leverage + a strong tape + tight discipline; the same leverage means a bad month can run past -${Math.round(X.risk.badMonthPct * MODES[2].volMult)}%. Higher upside AND higher risk of a deep drawdown - not a promise.`;
  // income: park cash in covered-call / distribution ETFs for steady monthly yield
  const income = { moves: [], plan: [], read: '' };
  const isInc = s => /^(QQQI|JEPQ|JEPI|SPYI)$/.test(s);
  lev.forEach(p => income.moves.push({ sym: p.sym, action: 'Sell', targetPct: 0, note: 'too volatile to park' }));
  const inc = X.xray.positions.find(p => isInc(p.sym));
  if (inc) income.moves.push({ sym: inc.sym, action: 'Add', targetPct: Math.max(inc.w, 30), note: 'income anchor' });
  if (top1.w > 25 && !isInc(top1.sym)) income.moves.push({ sym: top1.sym, action: 'Trim', targetPct: 20, note: 'cut single-name risk' });
  income.plan = [lev.length ? `Exit leveraged ETFs (${lev.map(p => p.sym).join(', ')}) - too volatile for parked cash.` : 'No leverage to cut.', inc ? `Build ${inc.sym} toward ~30% as your monthly-distribution anchor.` : 'Rotate into covered-call income ETFs (QQQI/JEPQ/JEPI) for steady monthly distributions.', 'Keep the rest in broad index + a cash buffer; the distributions pay you monthly.', 'Low-drawdown income park - but NAV can still dip and distributions vary (not a savings account).'];
  income.read = `Covered-call ETFs (QQQI/JEPQ/JEPI/SPYI) can distribute ~${MODES[3].target}%/mo (~${Math.round((Math.pow(1 + MODES[3].target / 100, 12) - 1) * 100)}%/yr) as steady income, but they cap upside and NAV can fall in a selloff. Good for parking cash for yield, not for growth; distributions are variable, not guaranteed.`;
  return { conservative, balanced, aggressive, income };
}

// ---- AI decisions PER MODE: gated ~30 min, cached in engine_ai.json (raw), reused & re-priced between regens ----
let aiModes, aiEpoch, aiSrc;
const modeKeys = MODES.map(m => m.key);
if (prevAI && prevAI.aiEpoch && (now - prevAI.aiEpoch) < GATE_MS && prevAI.v === V && prevAI.modes && modeKeys.every(k => prevAI.modes[k] && Array.isArray(prevAI.modes[k].moves))) {
  aiModes = prevAI.modes; aiEpoch = prevAI.aiEpoch;
  aiSrc = (prevAI.src || 'AI').replace(/ · cached.*$/, '') + ' · cached ' + Math.round((now - prevAI.aiEpoch) / 60000) + 'm';
  console.error('engine AI ' + Math.round((now - prevAI.aiEpoch) / 60000) + ' min old - reusing decisions, re-pricing on fresh data');
} else {
  let out, src = 'auto';
  for (const [name, fn] of [['Claude', claude], ['Gemini', gemini]]) {
    if ((name === 'Claude' && !process.env.ANTHROPIC_API_KEY) || (name === 'Gemini' && !process.env.GEMINI_API_KEY)) continue;
    try { out = parseAI(await fn(prompt)); src = name; break; } catch (e) { console.error(name + ' engine failed:', e.message); }
  }
  const fb = fallbackAll();
  if (!out) { out = fb; src = 'auto'; }
  aiModes = {};
  for (const k of modeKeys) {
    const mo = out[k] || {};
    let moves = cleanRaw(mo.moves), plan = cleanPlan(mo.plan), read = trimSent(mo.read || '', 480);
    if (!moves.length) { moves = cleanRaw(fb[k].moves); if (!plan.length) plan = cleanPlan(fb[k].plan); if (!read) read = trimSent(fb[k].read, 480); }   // guard a missing/empty mode
    aiModes[k] = { moves, plan, read };
  }
  aiEpoch = now; aiSrc = src;
  writeFileSync(join(dir, 'engine_ai.json'), JSON.stringify({ aiTs: new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' (' + src + ')', aiEpoch, v: V, src, modes: aiModes }, null, 2));
  console.error('engine AI regenerated via ' + src);
}

// ---- build each mode's sized+priced moves + goal + projection (recomputed every run on fresh prices) ----
const modes = {};
for (const m of MODES) {
  const raw = aiModes[m.key];
  modes[m.key] = { label: m.label, target: m.target, moves: sizeMoves(raw.moves), plan: raw.plan, read: raw.read, goal: modeGoal(m.target, m.volMult), proj: modeProj(m.betaMult, m.volMult) };
}
writeFileSync(join(dir, 'engine.json'), JSON.stringify({ ts: new Date(now).toLocaleString('en-US', { timeZone: 'America/New_York' }) + ' (' + aiSrc + ')', epoch: now, aiEpoch, v: V, defaultMode: 'balanced', target: MODES[1].target, xray: X.xray, risk: X.risk, modes }, null, 2));
console.error(`engine written: modes [${MODES.map(m => m.key + ':' + modes[m.key].moves.length).join(', ')}] (${aiSrc})`);

