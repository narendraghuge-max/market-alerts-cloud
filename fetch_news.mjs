// Free market-news fetcher (no API key). Pulls headlines from public RSS feeds
// and writes events.json in the format the dashboard's "Market events" section
// already understands: [{ ts, epoch, headline, detail }]. Runs in the cloud cron
// before scan_smc.mjs so the dashboard always shows fresh, always-on headlines.
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
const __dir = dirname(fileURLToPath(import.meta.url));

const FEEDS = [
  { src: 'CNBC',        url: 'https://www.cnbc.com/id/100003114/device/rss/rss.html' },
  { src: 'CNBC Markets',url: 'https://www.cnbc.com/id/20910258/device/rss/rss.html' },
  { src: 'MarketWatch', url: 'https://feeds.marketwatch.com/marketwatch/topstories/' },
];

const strip = s => (s || '')
  .replace(/<!\[CDATA\[|\]\]>/g, '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&#39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

function parseItems(xml, src) {
  const out = [];
  const items = xml.match(/<item[\s\S]*?<\/item>/gi) || [];
  for (const it of items) {
    const title = strip((it.match(/<title>([\s\S]*?)<\/title>/i) || [])[1]);
    const desc = strip((it.match(/<description>([\s\S]*?)<\/description>/i) || [])[1]);
    const pub = strip((it.match(/<pubDate>([\s\S]*?)<\/pubDate>/i) || [])[1]);
    const epoch = Date.parse(pub) || null;
    if (title && epoch) out.push({ src, title, desc, epoch });
  }
  return out;
}

const fmtET = ms => new Date(ms).toLocaleString('en-US', { timeZone: 'America/New_York' });

const all = [];
for (const f of FEEDS) {
  try {
    const r = await fetch(f.url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(15000) });
    if (!r.ok) { console.error(`feed ${f.src} -> HTTP ${r.status}`); continue; }
    const items = parseItems(await r.text(), f.src);
    all.push(...items);
    console.error(`feed ${f.src} -> ${items.length} items`);
  } catch (e) { console.error(`feed ${f.src} failed: ${e.message}`); }
}

// de-dupe by headline, keep newest, cap to a reasonable number
const seen = new Set();
const events = all
  .sort((a, b) => b.epoch - a.epoch)
  .filter(e => { const k = e.title.toLowerCase().slice(0, 60); if (seen.has(k)) return false; seen.add(k); return true; })
  .slice(0, 12)
  .map(e => ({
    ts: fmtET(e.epoch),
    epoch: e.epoch,
    headline: e.title,
    detail: `Source: ${e.src}.` + (e.desc ? ` ${e.desc.slice(0, 280)}` : '') + ' (headline feed — not analyzed; decision-support only)',
  }));

writeFileSync(join(__dir, 'events.json'), JSON.stringify(events, null, 2));
console.error(`wrote ${events.length} headlines to events.json`);
