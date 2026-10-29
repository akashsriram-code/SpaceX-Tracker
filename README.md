# SpaceX Launch Telemetry

A minimalist telemetry-console dashboard for SpaceX launches — mission history,
booster recovery statistics, derived customer breakdown — plus a Starlink tab
covering every Starlink satellite ever launched: versions, altitudes, lifecycle
status, ages, reentries and a live 2D/3D position map. Built for
zero-friction GitHub Pages deployment.

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

### Starlink satellite data

LL2 has **no satellite-level Starlink data** (`/spacecraft`, `/payloads` and
`/payload_flights` return nothing for Starlink), so the Starlink tab has its
own snapshot, built by `scripts/fetch-starlink.mjs` from two sources:

| Source | Gives us | Why |
|---|---|---|
| [GCAT](https://planet4589.org/space/gcat/) (Jonathan McDowell, CC BY 4.0): `currentcat`, `satcat`/`satcat100k`, `psatcat`/`psatcat100k`, `auxcat`, plus his [stats page](https://planet4589.org/space/con/star/stats.html) and status log | Every Starlink ever launched, incl. reentered ones and losses never catalogued; **hardware version** (psatcat `Program`); launch and reentry dates; mass; a Starlink lifecycle flag (Type byte 8: operational / raising / drift / lowering / failed…); latest catalogued orbit | The only free, machine-readable source with a per-satellite version. Its totals reconcile exactly with McDowell's published table, which CI re-checks on every build |
| [CelesTrak GP](https://celestrak.org/NORAD/documentation/gp-data-formats.php) (`GROUP=starlink`, CSV) | Current SGP4 element sets: fresh altitudes, and everything the live map needs | No auth. Always CSV/JSON, never TLE: five-digit catalogue numbers ran out on 2026-07-11 and new Starlinks have six-digit ones |

Rejected: Space-Track (needs a login), N2YO (API key, no redistribution
right), the r/SpaceX API (dead), and third-party trackers (no API or licence;
they all derive from GCAT and CelesTrak anyway).

Both upstreams ask for restraint, and the script is built around it:

- **GCAT** is a one-person site updated about daily (~43 MB of TSV). The
  script contacts it at most every 20 hours, with conditional requests
  (`If-None-Match`), so unchanged files cost a 304.
- **CelesTrak** allows one download of the Starlink group per update (~2 h)
  and firewalls IPs that rack up errors (50 per 2 h). The script makes **one
  request per run, at most every 2 hours, never retried**, and never falls
  back to another CelesTrak file in the same run. On any non-200 it keeps the
  last good copy.
- CI is read-only, so raw downloads, ETags and the last good outputs persist
  between runs in **`actions/cache`** (`.cache/starlink`, git-ignored). If a
  refresh fails, the newest cached good output is published; failing that,
  the committed snapshot.

Outputs, all committed so a build never depends on upstream being up:

| File | Contents | Size |
|---|---|---|
| `public/data/starlink.json` | 13k satellites, columnar and dictionary-encoded, plus `meta` (sources, reference totals, exclusions) | ~2.3 MB / ~340 KB gzip |
| `public/data/starlink-gp.json` | SGP4 elements for ~11k satellites in orbit — loaded only by the map | ~1.3 MB / ~430 KB gzip |
| `public/data/starlink-history.json` | McDowell's daily status log, sampled weekly | ~33 KB |

The fetch script, like `fetch-data.mjs`, is transport only. Version,
lifecycle phase, reentry cause, shell, altitude and age are all derived in
`src/lib/starlink.ts`, so the tab, its charts and its spreadsheet share one
implementation of each rule.

**"Version" means hardware** (v0.9, v1.0, v1.5, v2 Mini, v2 Mini DTC,
v2 Mini Optimized, V3). The "Gen1/Gen2" in SpaceX's FCC filings are licence
authorisations, which don't line up with hardware (some V2 Minis fly in a
Gen1-licensed shell), so the tab never calls a version a "generation".

**Positions on the live map are computed in your browser** with SGP4
(satellite.js, in a Web Worker) from the snapshot's element sets. Accuracy is
about a kilometre at six hours and tens of kilometres after a week, so element
sets more than 7 days old aren't plotted. It is not live telemetry.

---

## Downloading the data

**Download spreadsheet** in the header saves the whole snapshot (every launch
and every field, not the filtered view) as one `.xlsx`. It is built in the
browser from the same snapshot the page is showing, and named after the
snapshot time, e.g. `spacex-launches_2026-09-22_1657Z.xlsx`.

| Sheet | One row per |
|---|---|
| About | item of information: snapshot time, source, attribution, caveats, sheet row counts |
| Launches | launch, newest NET first |
| Boosters | booster flown on a launch (`boosters[]`) |
| Payloads | payload listed for a launch (`payloads[]`) |
| Agencies | mission agency of a launch (`agencies[]`) |
| Links | video or info link of a launch (`vidUrls[]`, then `infoUrls[]`) |
| Columns | column on the data sheets: its type, source and meaning |

- **Launch ID** is the first column of every data sheet and the join key back
  to Launches.
- **All date-times are UTC**, stored as real Excel date-times, so they sort and
  filter as dates.
- **A blank cell means null** (no value upstream), never `FALSE` or `0`.
  Booleans are real `TRUE`/`FALSE`.
- Headers ending in **(derived)**, with an amber fill, are computed by the rules
  in `src/lib/launch.ts`, the same ones the dashboard uses. Everything else is
  Launch Library 2 data as snapshotted.
- Every data sheet has a frozen header row, frozen columns A:B and an autofilter.

**Adding a field to `src/lib/types.ts`?** Map it in `src/lib/export/schema.ts`
as well. `tsc` enforces this: the `*_FIELDS` coverage maps there must name
every field, so the build fails until the new field has a column.

### Starlink satellites workbook

**Download satellites** on the Starlink tab saves every Starlink ever launched
(reentered satellites and launch failures included) as its own `.xlsx`,
separate from the launch workbook, e.g.
`starlink-satellites_2026-10-29_1518Z.xlsx`.

| Sheet | One row per |
|---|---|
| About | item of information: snapshot / GCAT / export times, counts, McDowell's reference totals, exclusions, newest GP epoch, attribution and the CC BY 4.0 "filtered and reformatted" notice, definitions, caveats |
| Satellites | satellite, newest launch first, NORAD first: raw GCAT and CelesTrak GP fields, then amber **(derived)** columns from `src/lib/starlink.ts` (Version, Working, Lifecycle phase, Shell, Mean altitude, Age, linked LL2 launch, …) |
| Versions | hardware version: launched / in orbit / working / operational / reentered |
| Columns | column on the data sheets: its type, source and meaning |

Same conventions as the launch workbook: real UTC dates (GCAT's day-precision
dates shown as `yyyy-mm-dd`), blank = null, frozen header row and columns A:B,
autofilter. *COSPAR launch* and *Linked LL2 launch ID* join back to the launch
workbook. Adding a field to `Satellite`? Map it in
`src/lib/export/starlinkSchema.ts`; the `SATELLITE_FIELDS` map fails `tsc`
until you do. Checked in CI by `npm run verify:starlink-export`.

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
| `npm run verify:export` | Build the spreadsheet export from the snapshot and check it cell by cell (runs in CI) |
| `npm run data:starlink` | Refresh the Starlink snapshot (gated; add `-- --force` to ignore the 20 h / 2 h gates, `-- --offline` to rebuild from `.cache` only) |
| `npm run audit:starlink` | Reconcile the Starlink snapshot against McDowell's published totals, version by version (runs in CI; warns, never fails) |
| `npm run verify:starlink-export` | Build the Starlink spreadsheet and check it cell by cell (runs in CI) |
| `npm run coastlines` | Regenerate `src/assets/coastlines-110m.json` for the map from `world-atlas` (one-off) |
| `npm run deploy` | Manual `gh-pages` publish (CI is preferred) |

Optional: set `LL2_API_TOKEN` for a higher LL2 rate limit. The Starlink
sources need no keys. satellite.js 7 needs Node ≥ 22.13 (CI uses Node 22).

> **Behind a TLS-inspecting corporate proxy?** Node's `fetch` uses its own CA
> bundle and will fail with `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`. On Node ≥
> 22.15, run scripts with `node --use-system-ca …` to trust the OS
> certificate store (`npm run data:starlink` already does). Otherwise export
> your corporate root **and intermediate** CAs to a PEM file and point
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
scripts/fetch-data.mjs     LL2 -> slim JSON snapshot. Transport only, no business logic.
public/data/*.json         Committed snapshot (860 launches, ~1.8 MB raw / ~206 KB gzip).
src/lib/types.ts           Domain model describing the snapshot shape.
src/lib/launch.ts          ALL interpretation: Starlink detection, customer attribution,
                           outcome collapsing, booster labels.
src/lib/stats.ts           Pure aggregation for KPIs and charts.
src/lib/api.ts             Snapshot loading + sessionStorage SWR cache (15-min TTL).
src/lib/export/schema.ts   Spreadsheet columns: field -> header/type, plus types.ts coverage maps.
src/lib/export/workbook.ts Snapshot -> sheets of typed cells. Pure, no spreadsheet library.
src/lib/export/xlsx.ts     Sheets -> .xlsx (write-excel-file). Lazy-loaded on click.
src/hooks/                 useSnapshot (React Query), useCountdown (1 Hz ticker).
src/components/            Header/KPIs, hero countdown, filters, card grid, drawer, analytics.
scripts/verify-export.mjs  Builds the .xlsx and checks it against the snapshot (CI).

scripts/fetch-starlink.mjs GCAT + CelesTrak -> starlink*.json. Transport only, gated, cached.
src/lib/starlink.ts        ALL satellite interpretation: version, lifecycle, reentry cause,
                           shell, altitude, age, launch linking.
src/lib/starlinkStats.ts   Pure aggregation for the Starlink KPIs, charts and tables.
src/lib/starlinkApi.ts     Starlink loaders (only reachable from the lazy Starlink chunk).
src/workers/sgp4.worker.ts SGP4 propagation for the live map, off the main thread.
src/components/Starlink*.tsx, src/components/starlink/   The tab, its table, and the 2D/3D map.
scripts/audit-starlink.mjs Reconciles the snapshot against McDowell's published totals (CI).
```

The split between `fetch-data.mjs` (dumb) and `src/lib/launch.ts` (all rules) is
deliberate: every business rule has exactly one implementation, and changing one
doesn't require re-fetching data.

Recharts is lazy-loaded with the Analytics tab, which keeps the initial bundle at
**~87 KB gzip** instead of ~196 KB. The spreadsheet writer (~26 KB gzip) loads
on demand like Recharts, when the download button is hovered, focused or
clicked.

The Starlink tab adds nothing to first paint. Its code and catalogue load when
the tab is hovered or opened; the map (satellite.js plus the worker) is a
further chunk, and three.js loads only when you switch the map to 3D.

### Known data limitations

These are upstream gaps, surfaced honestly in the UI rather than papered over:

- **Customer attribution is derived.** LL2 has no customer field. It is inferred
  from payload customers when LL2 has them, then Starlink detection, then
  contract-program name patterns (e.g. Crew-N, CRS), then mission agencies (real
  upstream data), then operator name patterns, then "SpaceX (Internal)" when
  SpaceX is the only agency, otherwise "Undisclosed" (see
  `customersOf` in `src/lib/launch.ts`). The UI labels it "derived" everywhere
  it appears.
- **Payload data is sparse** — the current snapshot has 20 payload records
  across 860 launches, none with a mass. The drawer says so explicitly instead
  of rendering blanks, and the spreadsheet's About sheet reports the live count.
- **NET precision varies.** Far-future missions carry `Quarter`/`Year` precision;
  the hero shows the precision label instead of a fake to-the-second countdown.
- **No Reddit links.** LL2 doesn't expose them. Whatever reference links it does
  provide are rendered and labelled by hostname.
- **Starlink versions are derived.** They come from GCAT's per-satellite
  Program field, which is McDowell's classification, not an official SpaceX
  label. v1.5 is never written out upstream; it is inferred from launch
  Groups 2–5.
- **"Active" has several definitions**, so the tab shows three labelled
  counts: *in orbit*, *working* (McDowell: in orbit and not failed), and
  *in operational shell* (on station). Trackers that quote one "active"
  number disagree by hundreds for this reason.
- **Altitudes are mean elements**, hours old (CelesTrak) or days old (GCAT's
  catalogued orbit), not live telemetry. Orbits older than 14 days are
  flagged and left out of altitude charts.
- **Satellites lost before cataloguing have no NORAD id** (e.g. the Feb 2022
  storm batch, the V3s lost on Starship Flight 13). They count in launched
  and reentered totals but can't be tracked.
- **Excluded:** Starship mass simulators, the two "Dodger Dog" test
  articles, deployment hardware, and Starshield (NRO) satellites.

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

Starlink satellite catalogue: data from GCAT (J. McDowell,
[planet4589.org/space/gcat](https://planet4589.org/space/gcat/)), licensed
[CC BY 4.0](https://creativecommons.org/licenses/by/4.0/); filtered and
reformatted. Orbital elements: [CelesTrak](https://celestrak.org/), sourced
from USSPACECOM / 18 SDS via Space-Track.org. Coastlines: Natural Earth
(public domain) via world-atlas. SGP4: satellite.js (MIT), after Vallado et al.
2006, *Revisiting Spacetrack Report #3*.
