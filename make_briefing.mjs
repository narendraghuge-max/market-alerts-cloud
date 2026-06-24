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

const prompt = `You are my market briefing assistant. Write a SHORT, plain-English briefing for a retail trader - like a smart, honest friend. No jargon, no markdown. Use ONLY the data below; never invent numbers or news.

MY HOLDINGS (status from a mechanical scanner: SELL/TRIM = needs attention, HOLD/NEW = fine; pnlPct is my gain/loss %):
${JSON.stringify(holdings)}

TODAY'S HEADLINES:
${news.join('\n') || '(no fresh headlines)'}

Write exactly these 4 labeled parts, each 1-3 sentences, plain text with a line break between them:
Market today: the overall mood and the simple why (from the headlines).
Your holdings: the 1-3 that need attention (name + gain/loss %), or "all look fine today." Call SPCX a brand-new, very volatile IPO.
Watch: 1-2 things to keep an eye on.
Bottom line: one sentence on what to focus on.
Keep it under 170 words total. Not financial advice.`;

async function gemini(p) {
  const key = process.env.GEMINI_API_KEY;
  if (!key) throw new Error('no GEMINI_API_KEY');
  const model = process.env.GEMINI_MODEL || 'gemini-2.5-flash';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${key}`;
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt) await new Promise(z => setTimeout(z, 1500 * attempt));
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: p }] }], generationConfig: { temperature: 0.4, maxOutputTokens: 700, thinkingConfig: { thinkingBudget: 0 } } }), signal: AbortSignal.timeout(30000) });
      if (r.status === 503 || r.status === 429) { lastErr = new Error('gemini HTTP ' + r.status); continue; }
      if (!r.ok) throw new Error('gemini HTTP ' + r.status + ' ' + (await r.text()).slice(0, 160));
      const t = (await r.json()).candidates?.[0]?.content?.parts?.[0]?.text;
      if (!t) throw new Error('gemini empty response');
      return t.trim();
    } catch (e) { lastErr = e; }
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

let text, src = 'Gemini';
try { text = await gemini(prompt); }
catch (e) { console.error('briefing AI failed, using fallback:', e.message); text = fallback(); src = 'auto-summary'; }

writeFileSync(join(dir, 'briefing.json'), JSON.stringify({ ts: fmtET(Date.now()) + ' (' + src + ')', text }, null, 2));
console.error('briefing.json written via ' + src + ' (' + text.length + ' chars)');
