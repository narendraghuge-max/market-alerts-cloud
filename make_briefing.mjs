// Cloud AI briefing (free, Google Gemini). Reads holdings status + headlines and writes
// briefing.json that the dashboard renders. Runs in GitHub Actions every cycle -
// independent of any personal computer or the Claude app. Decision-support only.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const dir = dirname(fileURLToPath(import.meta.url));
const fmtET = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' });
const read = f => { try { return JSON.parse(readFileSync(join(dir, f), 'utf8')); } catch { return null; } };

const exits = read('exits.json');           // from: node scan_exits.mjs --json
const headlines = read('headlines.json') || [];
const holdings = (exits?.results || []).map(r => ({ sym: r.sym, status: r.status, price: r.price, pnlPct: r.pnlPct, stop: r.stop, note: r.note }));
const news = headlines.slice(0, 8).map(h => '- ' + h.headline);

const prompt = `You are my personal market briefing analyst. I am a retail trader, concentrated ~90% in tech/chip names and I trade on MARGIN, so drawdowns hurt extra and risk management matters. Write like a sharp, honest friend who knows my book - plain English, no jargon, no markdown. Use ONLY the data below; never invent numbers or news, and say "unconfirmed" if unsure.

Think about which headlines actually matter FOR MY SPECIFIC HOLDINGS (don't just summarize the news) and connect the dots: if a headline affects chips, tech, AI, rates, or the broad market, say what it means for the relevant position.

MY HOLDINGS (status from a mechanical scanner: SELL/TRIM = needs attention, HOLD/NEW = fine; pnlPct is my gain/loss %):
${JSON.stringify(holdings)}

TODAY'S HEADLINES:
${news.join('\n') || '(no fresh headlines)'}

Write exactly these 4 labeled parts, plain text with a blank line between them:
Market today: the mood and the real driver (1-2 sentences), tied to what moves MY kind of names.
Your holdings: the 1-3 positions that need attention (name + gain/loss % + the specific concern), or "all look fine today." Call SPCX a brand-new, very volatile IPO. Note that margin amplifies any drop.
Watch: 1-2 concrete things (a level, an event, a sector) to keep an eye on next.
Bottom line: one sharp sentence on what to focus on right now.
Keep it tight - under 180 words. Decision-support only, not financial advice.`;

let BRIEF_MODEL = '';
async function gemini(p) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  // Prefer 2.5 Pro (+ thinking) for quality; fall back to Flash if Pro is unavailable/overloaded.
  // think: -1 = dynamic thinking, 0 = off. maxOut must cover thinking + the answer or it truncates.
  const MODELS = process.env.GEMINI_MODEL
    ? [{ name: process.env.GEMINI_MODEL, think: -1, maxOut: 4000 }]
    : [
        { name: 'gemini-2.5-pro', think: -1, maxOut: 4000 },
        { name: 'gemini-2.5-flash', think: -1, maxOut: 4000 },
        { name: 'gemini-2.5-flash-lite', think: 0, maxOut: 800 },
        { name: 'gemini-2.0-flash-lite', think: 0, maxOut: 800 },
      ];
  let lastErr;
  for (const m of MODELS) {
    const body = JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0.5, maxOutputTokens: m.maxOut, thinkingConfig: { thinkingBudget: m.think } } });
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt) await new Promise(z => setTimeout(z, 1500));
      try {
        const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${m.name}:generateContent?key=${key}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body, signal: AbortSignal.timeout(45000) });
        if (r.status === 503 || r.status === 429) { lastErr = new Error(m.name + ' HTTP ' + r.status); continue; }       // retry same, then next model
        if (!r.ok) { lastErr = new Error(m.name + ' HTTP ' + r.status + ' ' + (await r.text()).slice(0, 100)); break; }  // try next model
        const t = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text;
        if (!t) { lastErr = new Error(m.name + ' empty response'); break; }
        BRIEF_MODEL = m.name;
        console.error('briefing model: ' + m.name);
        return t.trim();
      } catch (e) { lastErr = e; }
    }
  }
  throw lastErr || new Error('gemini failed');
}

// templated fallback so the briefing is never blank/stale if the model is unavailable
function fallback() {
  const att = holdings.filter(h => h.status === 'SELL' || h.status === 'TRIM');
  return [
    'Market today: ' + (news[0] ? news[0].replace(/^- /, '') : 'Quiet - no major headlines right now.'),
    'Your holdings: ' + (att.length ? att.map(h => `${h.sym} (${h.status}, ${h.pnlPct >= 0 ? '+' : ''}${h.pnlPct}%)`).join(', ') + ' need a look.' : 'all look fine today.'),
    'Bottom line: ' + (att.length ? 'Review the flagged positions and respect your stops.' : 'Nothing urgent - hold steady and watch the news.'),
  ].join('\n');
}

let text, src = 'auto-summary';
try { text = await gemini(prompt); src = BRIEF_MODEL || 'Gemini'; }
catch (e) { console.error('briefing AI failed, using fallback:', e.message); text = fallback(); }

writeFileSync(join(dir, 'briefing.json'), JSON.stringify({ ts: fmtET(Date.now()) + ' (' + src + ')', text }, null, 2));
console.error('briefing.json written via ' + src + ' (' + text.length + ' chars)');
