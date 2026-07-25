// Anchor gate: the dashboard regenerates the buy-scan / holdings / engine / briefing ONLY at 3 anchors a day
// (open ~9:35, midday ~12:35, close ~16:10 ET) and FREEZES in between, so swing recommendations stop churning
// intraday. Prints "is_anchor=true|false" to stdout for the workflow to gate every heavy step on.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const dir = dirname(fileURLToPath(import.meta.url));
const now = Date.now();
const P = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false, weekday: 'short' }).formatToParts(new Date(now));
const g = t => (P.find(p => p.type === t) || {}).value || '';
const wd = g('weekday'), date = `${g('year')}-${g('month')}-${g('day')}`;
const mins = (+g('hour')) * 60 + (+g('minute'));

// ET anchor times: open 9:35, midday 12:35, close 16:10 (after the bell = completed daily bar for tomorrow)
const ANCHORS = [{ k: 'open', m: 9 * 60 + 35 }, { k: 'midday', m: 12 * 60 + 35 }, { k: 'close', m: 16 * 60 + 10 }];
const weekend = wd === 'Sat' || wd === 'Sun';
let slot = null;
if (!weekend) for (const a of ANCHORS) if (mins >= a.m) slot = a.k;   // most recent anchor already passed today
const key = slot ? `${date}-${slot}` : null;

let prev = '';
try { prev = (JSON.parse(readFileSync(join(dir, 'anchor_state.json'), 'utf8')).key) || ''; } catch {}
const force = process.env.EVENT === 'workflow_dispatch' || process.env.FORCE_ANCHOR === '1';   // manual runs always regenerate
const regen = force || (!!key && key !== prev);

if (regen) {
  try { writeFileSync(join(dir, 'anchor_state.json'), JSON.stringify({ key: key || (date + '-manual'), slot: slot || 'manual', ts: now, at: `${g('hour')}:${g('minute')} ET ${wd}` }, null, 2)); } catch (e) { console.error('anchor_state write failed:', e.message); }
}
console.error(`anchor gate: ${g('hour')}:${g('minute')} ET ${wd} | slot=${slot || '(none)'} key=${key} prev=${prev} force=${force} -> ${regen ? 'REGENERATE' : 'FREEZE (skip)'}`);
console.log(`is_anchor=${regen ? 'true' : 'false'}`);
