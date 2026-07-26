# Vercel Usage Badge

A Chrome extension that puts your Vercel usage in your browser toolbar.

> **Unofficial.** This is an independent open-source project. It is not affiliated with, endorsed by, or sponsored by Vercel Inc. "Vercel" is a trademark of Vercel Inc., used here only to describe what the extension does.

The badge shows the worst of your meaningful usage signals at a glance — included credit burn, on-demand charges/budget, and included usage meters. Click it for a Vercel-styled breakdown that mirrors the dashboard usage card.

## Features

**Included credit & on-demand**
- Dashboard-style split bar: Included Credit vs On-Demand Charges
- On-demand budget vs charges when Spend Management is configured
- Over-budget state is flagged

**This cycle**
- Line-item spend list (Build CPU Minutes, Observability, Fluid, …)

**Included usage**
- Edge Requests and Fast Data Transfer vs plan allotments (when exposed)
- Badge color escalates on the worst signal

**AI Gateway**
- Prepaid AI Gateway credit balance (when available)

**Subscription tier**
- Plan pill: Hobby, Pro, Enterprise

**Error handling**
- If your Vercel session has expired or you aren't signed in, the popup guides you to the dashboard and back with a one-click Refresh

## Install

### From source (developer mode)

1. Clone this repo
2. Visit `chrome://extensions`
3. Toggle **Developer mode** on (top right)
4. Click **Load unpacked** → select this folder
5. Sign in at [vercel.com/dashboard](https://vercel.com/dashboard). The badge populates within a few seconds.

## How it works

The extension reads Vercel's own dashboard APIs — the same data the web usage and billing pages use — to show your real utilization numbers.

- `background.js` — service worker, single source of truth. Polls every 3 minutes plus on-demand.
- `popup.html` / `popup.js` — the UI. Renders meter bars, credit card, on-demand budget, plan pill, and reset countdown.

Primary endpoints (cookie session on `vercel.com`):

- `GET /api/www/user` — default team
- `GET /api/teams` — plan, billing period, included thresholds
- `GET /api/v1/budgets` — on-demand spend management
- `GET /api/v2/usage?type=requests` — included meter totals
- `GET /api/v1/billing/charges` — FOCUS JSONL spend totals (cached 15 minutes)

Auth uses your existing `_v-session` cookie on `vercel.com`. No token pasting required — just stay signed in to the dashboard in Chrome.

## Permissions

- `storage` — persists usage state between browser restarts
- `cookies` — detects whether a Vercel session cookie is present
- `alarms` — periodic background refresh every 3 minutes
- `host_permissions: ["https://vercel.com/*"]` — required to call Vercel's API on your behalf

**No data leaves your browser.** No third-party servers. No analytics. No tracking.

## Design

Popup UI follows [Vercel](https://vercel.com) brand standards from the All Brand Standards DB and the live dashboard usage card:

| Token | Hex | Use |
|---|---|---|
| Background | `#FFFFFF` / `#FAFAFA` | Popup / surfaces |
| Text | `#000000` / `#666666` | Primary / secondary |
| Borders | `#E5E5E5` | Cards, rows |
| Accent | `#0070F3` | Included credit segment, CTAs |
| On-demand | `#8B5CF6` | On-demand charges segment (dashboard card) |
| Toolbar icon | `#000000` / `#FFFFFF` / `#0070F3` | Disc, triangle, ring |
| Severity | `#15803D` / `#B45309` / `#B91C1C` | Live `%` badge overlay |

Typography: Inter. Store listing assets live in `../store-assets/`.

## Development

There's no build step. Edit the files in place and reload the extension at `chrome://extensions` (↻ icon on the extension card).

To package for the Chrome Web Store:

```bash
zip -r ../vercel-usage-badge.zip . -x "*.DS_Store" -x "__MACOSX/*" -x ".git/*"
```

## Smoke test

1. Load unpacked as above
2. Open [vercel.com/dashboard](https://vercel.com/dashboard) and confirm you're signed in
3. Click the extension icon → **Refresh**
4. Confirm the badge shows a percentage and the popup shows:
   - Plan pill
   - Reset date + countdown
   - Included usage meters (when available)
   - Included credit + on-demand budget

## License

MIT — see [LICENSE](LICENSE).

Framework adapted from [cursor-usage-badge](https://github.com/zealot-network/cursor-usage-badge) and [claude-usage-badge](https://github.com/zealot-network/claude-usage-badge).
