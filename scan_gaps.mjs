// Extended-hours GAP alert for my holdings.
// Flags a holding moving >= THRESH% pre-market / after-hours vs the last regular close.
// Uses Yahoo includePrePost data. Alert-only change detection.
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

const HOLDINGS = process.env.HOLDINGS_JSON
  ? Object.keys(JSON.parse(process.env.HOLDINGS_JSON))
  : ['AAPL', 'MSFT', 'NVDA', 'SPY', 'QQQ']; // example fallback; real list comes from the HOLDINGS_JSON secret
const THRESH = 4; // percent

async function gap(sym) {
  try {
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?includePrePost=true&interval=5m&range=2d`;
    const r = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!r.ok) return null;
    const res = (await r.json()).chart?.result?.[0];
    if (!res) return null;
    const reg = res.meta.regularMarketPrice;
    const q = res.indicators.quote[0];
    let latest = null;
    for (let i = res.timestamp.length - 1; i >= 0; i--) { if (q.close[i] != null) { latest = q.close[i]; break; } }
    if (reg == null || latest == null) return null;
    const pct = (latest - reg) / reg * 100;
    return { sym, reg: +reg.toFixed(2), latest: +latest.toFixed(2), pct: +pct.toFixed(2) };
  } catch (e) { return null; }
}

const results = [];
for (const s of HOLDINGS) { const g = await gap(s); if (g) results.push(g); await new Promise(r => setTimeout(r, 120)); }

const gapped = results.filter(r => Math.abs(r.pct) >= THRESH);
const flagged = gapped.map(r => `${r.sym}:${r.pct >= 0 ? '+' : ''}${r.pct}`);
const stateFile = join(__dir, 'state_gaps.json');
let prev = { flagged: null };
try { if (existsSync(stateFile)) prev = JSON.parse(readFileSync(stateFile, 'utf8')); } catch (e) {}
const firstRun = prev.flagged == null;
const newly = flagged.filter(x => !(prev.flagged || []).includes(x));
const alertWorthy = firstRun ? gapped.length > 0 : newly.length > 0;
try { writeFileSync(stateFile, JSON.stringify({ flagged, ts: Date.now() })); } catch (e) {}

console.log('ALERT: ' + (alertWorthy ? 'yes' : 'no'));
if (newly.length) console.log('CHANGES: newly gapped -> ' + newly.join(', '));
console.log('');
console.log(`HOLDINGS EXTENDED-HOURS GAP CHECK (${results.length} holdings, threshold ${THRESH}%)\n`);
if (!gapped.length) console.log(`No holding moved >= ${THRESH}% in extended hours.`);
for (const r of gapped) console.log(`${r.sym.padEnd(5)} ${r.pct >= 0 ? '+' : ''}${r.pct}%  now ${r.latest}  (regular close ${r.reg})`);
console.log('\nNot financial advice - no orders placed.');
