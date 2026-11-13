# Privacy Policy — Vercel Usage Tracker & Badge

**Last updated:** July 26, 2026

Vercel Usage Tracker & Badge (“the extension”) is an unofficial, independent open-source Chrome extension. It is not affiliated with, endorsed by, or sponsored by Vercel Inc.

## What the extension does

The extension shows your Vercel plan usage in the Chrome toolbar and popup by reading the same dashboard APIs that power vercel.com (for example usage and billing pages) using your existing signed-in browser session.

## Data the extension accesses

On your device only, the extension may:

- Detect whether a Vercel session cookie is present on `vercel.com` (for example `_v-session`) so it can tell if you are signed in
- Call `vercel.com` APIs with your browser session to load usage, credit, budget, and related billing-cycle data
- Store a local cache of that usage state in `chrome.storage` so the badge and popup can update quickly

## What we do **not** do

- We do **not** collect, sell, or transfer your data to the developer or any third party
- We do **not** operate analytics, tracking, advertising, or telemetry servers for this extension
- We do **not** ask you to paste API tokens or passwords into the extension
- We do **not** send your cookies, usage numbers, or account data to any server other than `vercel.com` as part of the normal signed-in dashboard requests your browser already makes

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
