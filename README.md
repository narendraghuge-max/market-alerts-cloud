# market-alerts-cloud

Always-on market dashboard generator. A GitHub Actions workflow runs the scanner
every 15 minutes **on GitHub's servers** (no personal computer required) and
deploys the resulting `report.html` to a private Vercel URL.

- **Holdings are NOT in this code.** They live in the private `HOLDINGS_JSON`
  GitHub Secret. The values in the source are a harmless example fallback.
- Scanners use free Yahoo Finance data and Node's built-in `fetch` (no deps).
- **Decision-support only — never trades.**

## Secrets required (Settings → Secrets and variables → Actions)
| Secret | What |
|---|---|
| `HOLDINGS_JSON` | Your portfolio as JSON (the `scan_exits.mjs` HOLDINGS object) |
| `VERCEL_TOKEN` | A Vercel access token |
| `VERCEL_ORG_ID` | From your Vercel project's `.vercel/project.json` |
| `VERCEL_PROJECT_ID` | From your Vercel project's `.vercel/project.json` |

Run it manually anytime from the **Actions** tab → *dashboard* → *Run workflow*.
