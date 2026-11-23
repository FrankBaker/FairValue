# Currency Fair Value (PPP) -- static web version

A static, client-side port of the [`Fair_Value_V2`](../Fair_Value_V2) Shiny
app: a purchasing-power-parity (PPP) "fair value" estimate between **any
two** of several major currencies (USD, ZAR, CHF, SGD, GBP, CNY, EUR),
computed entirely in the browser. Built to be hosted for free on GitHub
Pages -- no server, no database, nothing to run except a periodic data
refresh.

For every historical date, the app asks: *if PPP held exactly from that
date onward, what would today's rate be?* A smoothed trend through that
whole ensemble of anchor-date estimates is the headline fair-value line.
See the original R project's `PROPOSAL.md` for a fuller discussion of this
methodology, its limitations, and alternative approaches -- the
methodology here is identical, only the implementation language and
hosting model changed.

## How this differs from the Shiny app

GitHub Pages can only serve static files -- no R, no server-side secrets.
That forces two changes from the R version:

- **Data is a periodically refreshed snapshot, not a live download.** A
  GitHub Actions workflow (`.github/workflows/deploy.yml`) runs on a
  schedule (daily by default), fetches fresh data from the official FRED
  API using an API key stored as a **GitHub secret** (never exposed to
  site visitors), and redeploys the site with an updated
  `data/data.json`. The sidebar shows when that snapshot was generated.
- **No live spot-rate marker.** The R app's "Today (live)" point came from
  Yahoo Finance (via the `yfR` package), which scrapes rather than using a
  stable API -- not something that can run safely or reliably from a
  visitor's browser. The web version shows "Latest close" instead: the
  most recent day in the data snapshot, which is exactly what the R app
  itself already fell back to whenever its Yahoo fetch failed.

Everything else -- the PPP calculation, the two-currency-pair selection,
the real-rate (REER-style) band toggle, the fair-value trend and
uncertainty band -- works the same way.

## Project layout

```
Fair_Value_Web/
  index.html              the whole page's markup
  css/styles.css           styling (light/dark aware)
  js/
    app.js                  DOM wiring: dropdowns, charts, summary panel
    lib/fairvalue.js         pure calculation logic (no DOM) -- port of
                             the R app's R/02_fair_value.R
  data/
    data.json                the FRED data snapshot (generated; see below
                             -- NOT committed with real data until you run
                             the fetch script or the GitHub Action does)
  scripts/
    fetch-data.mjs            downloads FRED data, writes data/data.json
  tests/
    fairvalue.test.mjs        unit tests for js/lib/fairvalue.js (ported
                             from the R app's test-fair_value.R, with
                             several values cross-checked against R's
                             own hand-computed fixtures)
    fetch-data.test.mjs       unit tests for the FRED-fetching logic,
                             against a mocked network (no API key needed)
  .github/workflows/
    deploy.yml                scheduled data refresh + GitHub Pages deploy
  package.json
```

## Running it locally

You need [Node.js](https://nodejs.org/) 18+ (built-in `fetch` and the
built-in test runner are used throughout -- no dependencies to install).

1. Get a free FRED API key at
   [fredaccount.stlouisfed.org/apikeys](https://fredaccount.stlouisfed.org/apikeys).
2. Fetch a real data snapshot:
   ```sh
   FRED_API_KEY=your-key-here npm run fetch-data
   ```
   This writes `data/data.json`. (The repository doesn't ship with a real
   one committed, since it'd just go stale -- see "Keeping data fresh"
   below for how the deployed site gets a current one automatically.)
3. Serve the folder with any static file server -- opening `index.html`
   directly as a `file://` URL will NOT work, because the page fetches
   `data/data.json` and browsers block `fetch()` of local files from
   `file://` pages. For example:
   ```sh
   npx serve .
   # or: python3 -m http.server 8080
   ```
   then open the URL it prints.

### Running the tests

```sh
npm test
```

This runs both test files (`js/lib/fairvalue.js`'s pure logic, and
`scripts/fetch-data.mjs`'s FRED-response handling against a mocked
network) -- fully offline, no API key needed, same suite the GitHub
Actions workflow runs before every deploy.

## Deploying to GitHub Pages

1. Push this folder's contents to a GitHub repository.
2. In the repo, go to **Settings -> Pages**, and under "Build and
   deployment -> Source" choose **GitHub Actions** (not "Deploy from a
   branch" -- the included workflow handles the build itself).
3. Go to **Settings -> Secrets and variables -> Actions -> New repository
   secret**, name it `FRED_API_KEY`, and paste in your key. This is the
   *only* place the key ever lives -- it's injected as an environment
   variable for one step of the workflow run and is never written to any
   file that ends up on the deployed site.
4. Push to `main` (or use the **Actions** tab -> this workflow -> **Run
   workflow** for a manual first run). The workflow fetches fresh data,
   runs the test suite, and deploys -- the Pages URL will be shown in the
   workflow's summary and under Settings -> Pages once it finishes.

## Keeping data fresh

The workflow also runs on a daily schedule (see the `cron` line in
`.github/workflows/deploy.yml` -- edit the time there if you want it more
or less often; FRED's own series update at most once a day, so daily is
already as fresh as it's useful to be). Each scheduled run re-fetches
every currency's data and redeploys automatically -- you don't need to do
anything for the live site to stay current.

If a currency's FRED series has a hiccup on a given run, `fetch-data.mjs`
logs it and carries on with whatever did succeed (as long as at least two
currencies came through, enough to build at least one pair) rather than
failing the whole deploy -- the next scheduled run will likely pick the
missing one back up.

## A note on this port's correctness

`js/lib/fairvalue.js` is a line-by-line port of the R app's
`R/02_fair_value.R`, and `tests/fairvalue.test.mjs` checks it against
several of the *exact same hand-computed numbers* the R app's own test
suite uses (`fv$fair_value[1] == 10.042801811493112` and so on) -- so this
isn't just "looks right," it's been checked against independently-derived
values that both implementations are expected to match exactly. Run
`npm test` yourself any time you change `js/lib/fairvalue.js` before
trusting the result.
