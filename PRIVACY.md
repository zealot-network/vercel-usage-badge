# Privacy Policy — Vercel Usage Tracker & Badge

**Last updated:** November 13, 2026

Vercel Usage Tracker & Badge (“the extension”) is an unofficial, independent open-source Chrome extension. It is not affiliated with, endorsed by, or sponsored by Vercel Inc.

## What the extension does

The extension shows your Vercel plan usage in the Chrome toolbar and popup by reading the same dashboard APIs that power vercel.com (for example usage and billing pages) using your existing signed-in browser session.

## Data the extension accesses

On your device only, the extension may:

- Detect whether a Vercel session cookie is present on `vercel.com` (for example `_v-session`) so it can tell if you are signed in
- Call `vercel.com` APIs with your browser session to load usage, credit, budget, and related billing-cycle data
- Store a local cache of that usage state in `chrome.storage` so the badge and popup can update quickly

### What is stored on your device

The local cache holds only what the badge and popup display:

- Your Vercel team's id, URL slug, and name, and its plan tier
- Billing figures for the current cycle: included credit, on-demand charges, your on-demand budget, spend totals, and per-service spend amounts
- Your AI Gateway prepaid credit balance
- Usage meters such as CDN requests and data transfer, with their plan limits
- Billing-cycle start and end dates, the time of the last refresh, and the last error message, if any

This data never leaves your browser. It is removed when you uninstall the extension or clear the extension's storage. The extension does not store your session cookie, password, or any payment card details.

## What we do **not** do

- We do **not** collect, sell, or transfer your data to the developer or any third party
- We do **not** operate analytics, tracking, advertising, or telemetry servers for this extension
- We do **not** ask you to paste API tokens or passwords into the extension
- We do **not** send your cookies, usage numbers, or account data to any server other than `vercel.com` as part of the normal signed-in dashboard requests your browser already makes

## Limited Use

The use of information received from Vercel's dashboard APIs complies with the [Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq), including the Limited Use requirements:

- **Allowed use** — the data is used only to provide the extension's single purpose: showing your Vercel usage and spend in the Chrome toolbar and popup
- **Allowed transfer** — the data is not transferred to anyone. It stays in your browser and is sent to no server, including the developer's
- **No advertising** — the data is never used or transferred for personalized, retargeted, or interest-based advertising
- **No human access** — no person, including the developer, can read your data, because it never leaves your device

## Permissions

- **storage** — local cache of usage state on your device
- **cookies** — detect a Vercel session on `vercel.com`
- **alarms** — refresh usage periodically in the background
- **host permission for `https://vercel.com/*`** — call Vercel dashboard APIs with your session

## Contact

Questions or concerns: open an issue at  
https://github.com/zealot-network/vercel-usage-badge/issues

Source code:  
https://github.com/zealot-network/vercel-usage-badge
