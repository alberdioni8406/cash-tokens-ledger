# CashTokens Ledger

A live directory and radar for every CashToken category minted on Bitcoin Cash — supply, holders, live UTXOs, genesis facts, and metadata, sourced from [TokenStork](https://tokenstork.com) and [Paytaca's BCMR indexer](https://bcmr.paytaca.com). No backend database, no accounts, read-only.

## Why this isn't a single static HTML file

Both TokenStork and Paytaca BCMR are read-only public APIs, but neither sends an `Access-Control-Allow-Origin` header — so a browser calling them directly with `fetch()` gets blocked by CORS, even though the exact same request works fine from a server or from curl. That's why the project has a `/api` folder: five small Vercel serverless functions that make the request server-side (where CORS doesn't apply) and re-serve the JSON with permissive CORS headers of their own. The static front-end only ever talks to its own `/api/*` routes, never to tokenstork.com or bcmr.paytaca.com directly.

## Project structure

```
index.html          — markup only
style.css            — design system (dark theme default, light theme via [data-theme="light"])
app.js               — all client-side logic: fetching, caching, table, detail panel, charts
api/
  tokens.js          — proxies GET tokenstork.com/api/tokens (list + pagination)
  token-detail.js    — proxies GET tokenstork.com/api/tokens/{id}/{holders|nfts|history}
  bcmr.js            — proxies GET bcmr.paytaca.com/api/tokens/{id}
  latest-block.js    — proxies GET bcmr.paytaca.com/api/status/latest-block/
  icon-proxy.js      — fetches token icons server-side; blocks private/loopback/link-local hosts
vercel.json          — CORS header on /api/* (Vercel auto-detects the .js files under api/ as Node functions; no runtime config needed)
package.json         — minimal metadata (no dependencies; uses native fetch)
```

## Running locally

```bash
npm install -g vercel   # if you don't already have the CLI
vercel dev
```

`vercel dev` serves both the static files and the `/api` functions on one port, so relative fetches like `/api/tokens` resolve correctly. Opening `index.html` directly from disk (`file://`) will **not** work — the `/api` routes need a server.

## Deploying

```bash
vercel        # first deploy, follow the prompts
vercel --prod # promote to production
```

No environment variables or secrets are required — every upstream API used here is free and keyless.

## Features

- **Explorer** — sortable, searchable, filterable token table, paginated against TokenStork's real `offset`/`limit` (the directory is ~19,000+ categories, too large to hold client-side)
- **Token detail panel** — genesis facts, supply/holder/UTXO/NFT metrics, top holders (when TokenStork exposes them for that category), NFT instances, explorer links — styled as a torn ledger receipt
- **Leaderboards** — top by holders, top by live UTXOs, recently updated, ranked from a pooled sample of pages
- **Watchlist** — star any token; persisted in `localStorage`; filter the table to watchlist-only
- **CSV export** — exports whatever's currently visible in the table (respects active filters/search)
- **Light/dark theme toggle** — persisted in `localStorage`
- **Aggressive caching** — list pages (2–5 min), token detail (15 min), latest block (30s), all in `localStorage` + an in-memory layer, so navigating feels instant and a manual refresh clears everything

## Known data limitations

- TokenStork's holder/NFT/history endpoints don't return data for every category — the UI says so plainly rather than guessing.
- Header "new tokens" and type-breakdown stats are computed from a sampled pool of a few hundred tokens (not all ~19k), and are marked with `~` where estimated.
- Token descriptions and icons are supplied by each token's issuer and are not vetted for accuracy by TokenStork, BCMR, or this dashboard.

## Why token icons load through `/api/icon-proxy`

A token's `icon` URL comes from its issuer, not from us — it's untrusted input. Loading it directly in an `<img>` tag would let an issuer point it at a private/local network address (e.g. `http://192.168.1.1/...`), which makes the *visitor's* browser probe their own LAN — this is exactly what triggers Chrome's newer "wants to access other apps and services on this device" (Local Network Access) prompt. Every icon is instead fetched server-side through `api/icon-proxy.js`, which rejects loopback, private (RFC1918), and link-local hosts — including after redirects — before ever returning image bytes to the browser.

