# SpaceX Launch Telemetry

A minimalist telemetry-console dashboard for SpaceX launches — mission history,
booster recovery statistics, derived customer breakdown, and dedicated Starlink
tracking. Built for zero-friction GitHub Pages deployment.

**Stack:** Vite · React 18 · TypeScript · Tailwind CSS v4 · React Query ·
Recharts · date-fns · lucide-react

---

## Data source: read this first

The dashboard was originally specced against the **r/SpaceX API**
(`api.spacexdata.com`). That is no longer usable:

- The [`r-spacex/SpaceX-API`](https://github.com/r-spacex/SpaceX-API) repository
  was **archived on 2026-06-06**.
- Its origin now fails the Cloudflare TLS handshake — **every** endpoint returns
  `HTTP 525`, verified from two independent networks.
- Even before the shutdown it had been in maintenance-only mode since 2024 and
  was not ingesting new launches, so its upcoming-launch data was already stale.

This project therefore uses **[Launch Library 2](https://thespacedevs.com/llapi)**
by The Space Devs — which is what SpaceX-API itself synced from, and is actively
maintained.

### Why the data is snapshotted at build time

LL2 allows **15 requests/hour for anonymous clients**. A public dashboard that
fetched LL2 from each visitor's browser would burn that budget in a handful of
page views and then serve errors to everyone else. LL2's own guidance is to run
a scheduled job and serve visitors from your own copy.

So `scripts/fetch-data.mjs` runs in CI, pages through LL2 once (~9 requests for
all 860 SpaceX launches), slims each record, and writes `public/data/*.json`.
The app loads that static file from its own origin:

| | Client-side LL2 fetching | Build-time snapshot (this project) |
|---|---|---|
| Rate limit | Breaks after ~15 views/hr | Never hit at runtime |
| Cold load | Several round-trips | One cached static file |
| API key | Would be exposed in the client | Server-side only, optional |
| LL2 outage | Dashboard breaks | Dashboard keeps working |

The snapshot is **committed to the repo** on purpose, so the site still builds
and deploys if LL2 is unreachable during CI.

The live T-minus countdown ticks entirely client-side off the snapshot's NET
timestamp, so it is genuinely per-second without costing a single request.

---

## Quick start

```bash
npm install
npm run data:dev     # populate public/data from the LL2 dev mirror
npm run dev
```

Scripts:

| Script | What it does |
|---|---|
| `npm run dev` | Vite dev server |
| `npm run build` | Typecheck (`tsc -b`) then production build |
| `npm run preview` | Serve the built `dist/` |
| `npm run data` | Refresh snapshot from **production** LL2 (15 req/hr limit) |
| `npm run data:dev` | Refresh from the LL2 **dev mirror** — generous limits, but a smaller/laggier dataset (~230 launches vs. 860) |
| `npm run typecheck` | Types only |
| `npm run deploy` | Manual `gh-pages` publish (CI is preferred) |

Optional: set `LL2_API_TOKEN` for a higher LL2 rate limit.

> **Behind a TLS-inspecting corporate proxy?** Node's `fetch` uses its own CA
> bundle and will fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. Export your
> corporate root **and intermediate** CAs to a PEM file and point
> `NODE_EXTRA_CA_CERTS` at it. Don't disable TLS verification.

---

## Deployment (GitHub Pages)

`.github/workflows/deploy.yml` handles everything:

1. Pushes to `main` → build + deploy immediately.
2. Cron every 4 hours (`00:17, 04:17 … 20:17 UTC`) → refresh the snapshot and
   redeploy, so launch data stays current.
3. `workflow_dispatch` → manual trigger.

A refresh costs ~9 of LL2's 15 anonymous requests/hour and runs are 4 hours
apart, so each starts with a fresh budget. Set an `LL2_API_TOKEN` secret if you
want to refresh more often than hourly.

Note the countdown is always live regardless of cadence — it ticks client-side
off the snapshot's NET. The schedule only bounds how quickly a *changed* NET
(a scrub or delay) reaches the site.

> GitHub disables scheduled workflows in repositories with no activity for 60
> days. If the data ever looks frozen, check whether the schedule was
> auto-disabled in the Actions tab.

**One-time setup:** repo **Settings → Pages → Build and deployment → Source:
GitHub Actions**.

The base path is derived automatically from `GITHUB_REPOSITORY`, so nothing is
hand-edited when the repo is renamed or forked:

- project site (`<user>.github.io/<repo>/`) → `base: '/<repo>/'`
- user/org site (`<user>.github.io`) → `base: '/'`
- local builds → `base: './'`

Override with `VITE_BASE` if you deploy somewhere unusual.

This is a single-page app with **no client-side router**, so there are no deep
links to 404 on — a Pages SPA fallback isn't needed. Add `public/404.html`
copying `index.html` only if you introduce routing later.

---

## Architecture

```
scripts/fetch-data.mjs   LL2 -> slim JSON snapshot. Transport only, no business logic.
public/data/*.json       Committed snapshot (860 launches, ~1.8 MB raw / ~206 KB gzip).
src/lib/types.ts         Domain model describing the snapshot shape.
src/lib/launch.ts        ALL interpretation: Starlink detection, customer attribution,
                         outcome collapsing, booster labels.
src/lib/stats.ts         Pure aggregation for KPIs and charts.
src/lib/api.ts           Snapshot loading + sessionStorage SWR cache (15-min TTL).
src/hooks/               useSnapshot (React Query), useCountdown (1 Hz ticker).
src/components/          Header/KPIs, hero countdown, filters, card grid, drawer, analytics.
```

The split between `fetch-data.mjs` (dumb) and `src/lib/launch.ts` (all rules) is
deliberate: every business rule has exactly one implementation, and changing one
doesn't require re-fetching data.

Recharts is lazy-loaded with the Analytics tab, which keeps the initial bundle at
**~84 KB gzip** instead of ~196 KB.

### Known data limitations

These are upstream gaps, surfaced honestly in the UI rather than papered over:

- **Customer attribution is derived.** LL2 has no customer field. It is inferred
  from mission agencies first (real upstream data), then mission-name patterns.
  The UI labels it "derived" everywhere it appears.
- **Payload mass/manufacturer is sparse** — populated for only ~16 of 860
  launches. The drawer says so explicitly instead of rendering blanks.
- **NET precision varies.** Far-future missions carry `Quarter`/`Year` precision;
  the hero shows the precision label instead of a fake to-the-second countdown.
- **No Reddit links.** LL2 doesn't expose them. Whatever reference links it does
  provide are rendered and labelled by hostname.

### Guard rails

`fetch-data.mjs` fails the build rather than shipping bad data if:

- fewer than 90% of the upstream-reported launches were retrieved, or
- any record's provider isn't SpaceX.

That second check exists because LL2 is Django-REST-Framework based and
**silently ignores unrecognised query params** — using
`launch_service_provider__id` instead of the correct `lsp__id` returns the
*entire unfiltered* launch list with a plausible count. That shipped 530 records
full of Long March, Soyuz and Electron flights before the assertion caught it.

---

## Licence / attribution

Launch data © [The Space Devs](https://thespacedevs.com/) (Launch Library 2).
Mission patches and imagery belong to their respective owners.
