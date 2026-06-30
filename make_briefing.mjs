// Cloud AI: writes briefing.json + analyzed events.json in ONE LLM call
// (Claude preferred, Gemini fallback, templated last resort). Gated to refresh at
// most every ~28 min via briefing.json's epoch — briefing.json + events.json are
// committed so they persist between GitHub Actions runs (prices still refresh every
// 15 min; this AI layer every ~30). Independent of any computer/app. Not financial advice.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dir = dirname(fileURLToPath(import.meta.url));
const fmtET = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' });
const read = f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };
const now = Date.now();
const GATE_MS = 28 * 60 * 1000;

// --- refresh gate: keep the existing briefing if it's still fresh ---
const prev = read('briefing.json');
const prevEvents = read('events.json') || [];
const haveSchema = prev?.v === 2 && Array.isArray(prev?.plays) && (prevEvents.length === 0 || ('rec' in prevEvents[0])); // force one regen when the briefing/events schema or prompt version changes
if (prev && prev.epoch && (now - prev.epoch) < GATE_MS && haveSchema) {
  console.error('briefing ' + Math.round((now - prev.epoch) / 60000) + ' min old - still fresh, skipping regen');
  process.exit(0);
}

const exits = read('exits.json');
const headlines = read('headlines.json') || [];
const holdings = (exits?.results || []).map(r => ({ sym: r.sym, status: r.status, price: r.price, pnlPct: r.pnlPct, stop: r.stop, note: r.note }));
const news = headlines.slice(0, 10).map((h, i) => (i + 1) + '. ' + h.headline);

// Universe-wide buy-scan snapshot (runs only here, i.e. only when we're regenerating the briefing)
// so trade ideas can point to the strongest NEW setups across ~100 names, not just my holdings.
let setupsText = '(scan unavailable)';
try {
  const { execFileSync } = await import('node:child_process');
  const raw = execFileSync('node', ['scan_smc.mjs', '--json'], { cwd: dir, env: process.env, timeout: 90000, maxBuffer: 48 * 1024 * 1024 }).toString();
  const scan = JSON.parse(raw.slice(raw.indexOf('{'), raw.lastIndexOf('}') + 1));
  const setups = (scan.results || [])
    .filter(r => r.score != null && !r.illiquid)
    .sort((a, b) => b.score - a.score).slice(0, 12)
    .map(r => `${r.symbol}: ${r.action} score ${r.score}/12 ${r.direction}; price ${r.price}, entry ${r.levels?.entry1}-${r.levels?.entry2}, stop ${r.levels?.stop}, targets ${r.levels?.tp1}/${r.levels?.tp2}/${r.levels?.tp3}, R ${r.levels?.rr}`);
  if (setups.length) setupsText = setups.join('\n');
  console.error(`scan snapshot: ${setups.length} setups for the briefing`);
} catch (e) { console.error('scan snapshot failed (briefing falls back to news+holdings):', e.message); }

const prompt = `You are my personal market analyst. I'm a retail trader, ~90% concentrated in tech/chip names, trading on MARGIN (drawdowns hurt extra). Write like a sharp, honest friend who knows my book - plain English, no jargon. Use ONLY the data below; never invent numbers or news.

MY HOLDINGS (scanner status: SELL/TRIM = needs attention, HOLD/NEW = fine; pnlPct = my gain/loss %):
${JSON.stringify(holdings)}

TODAY'S HEADLINES:
${news.join('\n') || '(none)'}

MY SCANNER'S BEST SETUPS RIGHT NOW (mechanical SMC scan across ~100 liquid tech/chip/AI/space/energy names; score out of 12, higher = stronger; this is your MAIN source for NEW-BUY ideas beyond what I already own):
${setupsText}

Return ONLY valid JSON (no markdown, no code fences), exactly this shape:
{"briefing":"...","plays":["...","..."],"events":[{"headline":"...","detail":"...","signal":"...","rec":"..."}]}

briefing = 4 labeled parts separated by blank lines, under 180 words total:
Market today: the mood + the real driver, tied to what moves MY kind of names.
Your holdings: the 1-3 positions needing attention (name + gain/loss % + the specific concern), or "all look fine today." Call SPCX a brand-new, very volatile IPO; note margin amplifies drops.
Watch: 1-2 concrete things to watch next.
Bottom line: one sharp sentence on what to focus on.

plays = 1-3 concrete, prioritized trade ideas for ME today, each a short actionable sentence. For new buys, PREFER the highest-scoring names from MY SCANNER'S BEST SETUPS above (these can be tickers I do NOT own - that's good; use their scanner entry/stop). Also fine: a trim/stop to respect on a holding, or "No new trades - hold and watch." Concrete but hedged - ideas to consider, NOT advice, never guaranteed.

events = the 2-4 MOST MATERIAL headlines for MY portfolio (skip personal-finance/fluff). For each:
- headline = short clean title
- detail = 2-3 sentences on what it means for the market AND specifically for my holdings/sectors
- signal = ONE of: "New buy","Add","Watch","Trim","Avoid","No action" - the forward-looking trade stance this event suggests for me
- rec = 1-2 sentences: IF this event points to a potential new buy or add, prefer a high-scoring name from MY SCANNER'S BEST SETUPS above (or a holding) and give the ticker + its entry/stop level; otherwise say plainly why there's no new action. Be concrete but hedge - ideas to consider, never promises, never guaranteed.
If nothing is material, use [].
Decision-support / educational only, NOT financial advice. Never guarantee returns.`;

let BRIEF_MODEL = '';
async function gemini(p) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  const MODELS = process.env.GEMINI_MODEL
    ? [{ name: process.env.GEMINI_MODEL, think: -1, maxOut: 4000 }]
    : [{ name: 'gemini-2.5-pro', think: -1, maxOut: 4000 }, { name: 'gemini-2.5-flash', think: -1, maxOut: 4000 }, { name: 'gemini-2.5-flash-lite', think: 0, maxOut: 1200 }];
  let lastErr;
  for (const m of MODELS) {
    const body = JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0.5, maxOutputTokens: m.maxOut, thinkingConfig: { thinkingBudget: m.think }, responseMimeType: 'application/json' } });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise(z => setTimeout(z, 1500));
      try {
        const r = await fetch('https://generativelanguage.googleapis.com/v1beta/models/' + m.name + ':generateContent?key=' + key, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(45000) });
        if (r.status === 503 || r.status === 429) { lastErr = new Error(m.name + ' HTTP ' + r.status); continue; }
        if (!r.ok) { lastErr = new Error(m.name + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100)); break; }
        const t = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text;
        if (!t) { lastErr = new Error(m.name + ' empty'); break; }
        BRIEF_MODEL = m.name; console.error('AI model: ' + m.name); return t.trim();
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('gemini failed');
}

let CLAUDE_MODEL = '';
async function claude(p) {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error('no ANTHROPIC_API_KEY');
  const model = process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6';
  const r = await fetch('https://api.anthropic.com/v1/messages', { method: 'POST', headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, body: JSON.stringify({ model, max_tokens: 1500, messages: [{ role: 'user', content: p }] }), signal: AbortSignal.timeout(45000) });
  if (!r.ok) throw new Error('claude HTTP ' + r.status + ' ' + (await r.text()).slice(0, 150));
  const t = ((await r.json()).content || []).filter(c => c.type === 'text').map(c => c.text).join('').trim();
  if (!t) throw new Error('claude empty response');
  CLAUDE_MODEL = model; console.error('AI model: ' + model); return t;
}

function parseAI(raw) {
  const s = raw.indexOf('{'), e = raw.lastIndexOf('}');
  if (s < 0 || e <= s) throw new Error('no JSON object in response');
  const obj = JSON.parse(raw.slice(s, e + 1));
  if (!obj.briefing) throw new Error('JSON missing briefing');
  if (!Array.isArray(obj.events)) obj.events = [];
  return obj;
}

// templated fallback so the dashboard is never blank/stale if every model fails
function fallbackObj() {
  const att = holdings.filter(h => h.status === 'SELL' || h.status === 'TRIM');
  const briefing = [
    'Market today: ' + (headlines[0] ? headlines[0].headline : 'Quiet - no major headlines right now.'),
    'Your holdings: ' + (att.length ? att.map(h => h.sym + ' (' + h.status + ', ' + (h.pnlPct >= 0 ? '+' : '') + h.pnlPct + '%)').join(', ') + ' need a look.' : 'all look fine today.'),
    'Bottom line: ' + (att.length ? 'Review the flagged positions and respect your stops.' : 'Nothing urgent - hold steady and watch the news.'),
  ].join('\n');
  const events = headlines.slice(0, 4).map(h => ({ headline: h.headline, detail: (h.detail || '').replace(/\s*\(headline feed[^)]*\)\s*/, '').trim() }));
  return { briefing, events };
}

let obj, src = 'auto-summary';
const providers = [];
if (process.env.ANTHROPIC_API_KEY) providers.push(['Claude', claude, () => CLAUDE_MODEL]);
if (process.env.GEMINI_API_KEY) providers.push(['Gemini', gemini, () => BRIEF_MODEL]);
for (const [name, fn, tag] of providers) {
  try { obj = parseAI(await fn(prompt)); src = tag() || name; break; }
  catch (e) { console.error(name + ' briefing failed:', e.message); }
}
if (!obj) { obj = fallbackObj(); src = 'auto-summary'; }

const plays = Array.isArray(obj.plays) ? obj.plays.slice(0, 3).map(p => String(p).slice(0, 200)).filter(Boolean) : [];
writeFileSync(join(dir, 'briefing.json'), JSON.stringify({ ts: fmtET(now) + ' (' + src + ')', epoch: now, text: obj.briefing, plays, v: 2 }, null, 2));
const events = (obj.events || []).slice(0, 6).map(e => ({ ts: fmtET(now), epoch: now, headline: String(e.headline || '').slice(0, 200), detail: String(e.detail || '').slice(0, 600), signal: String(e.signal || '').slice(0, 24), rec: String(e.rec || '').slice(0, 400) }));
writeFileSync(join(dir, 'events.json'), JSON.stringify(events, null, 2));
console.error('wrote briefing + ' + events.length + ' analyzed events via ' + src);
