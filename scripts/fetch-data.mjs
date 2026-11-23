#!/usr/bin/env node
// ---------------------------------------------------------------------
// scripts/fetch-data.mjs
//
// Downloads every currency's FX series (against USD) and inflation
// series from the official FRED API, normalizes each FX series into a
// consistent "currency units per 1 USD" orientation (undoing FRED's
// EUR/GBP quote-direction quirk -- see CURRENCY_SOURCES below), and
// writes the result to data/data.json for the static site to read.
//
// This is the one place in the whole project that needs network access
// or an API key -- the key is read from the FRED_API_KEY environment
// variable and is NEVER written into data.json or any other file that
// ends up in the deployed site, so it's safe to run this in CI with the
// key as a GitHub Actions secret (see .github/workflows/deploy.yml) and
// never expose it to site visitors.
//
// Usage:
//   FRED_API_KEY=your-key-here node scripts/fetch-data.mjs
//
// Get a free key at https://fredaccount.stlouisfed.org/apikeys.
// ---------------------------------------------------------------------

import { writeFile, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUTPUT_PATH = join(__dirname, "..", "data", "data.json");

// Per-currency metadata -- the direct JS equivalent of the R app's
// R/01_currencies.R CURRENCY_INFO. FRED's DEX** tickers are quoted
// "foreign currency per USD" *except* DEXUSUK and DEXUSEU, which (by
// long-standing market convention) are quoted "USD per GBP" / "USD per
// EUR" -- `invert: true` marks those two so every currency ends up
// normalized into the SAME orientation ("this currency's units per 1
// USD") in the output JSON, regardless of which way its own raw FRED
// ticker happens to be quoted. The static site's JS never has to know
// about this quirk at all -- it only ever sees already-normalized data.
//
// USD itself has no FRED ticker: it's the implicit numeraire, always
// exactly 1 USD per USD.
// intTicker: a short-term (3-month interbank) interest rate series, used
// for the UIP (uncovered interest rate parity) overlay -- the market's
// own interest-rate-implied expectation of currency depreciation. These
// are OECD Main Economic Indicators series as carried by FRED; they
// exist for six of our seven currencies. Singapore is the one gap: FRED
// has no equivalent clean short-term interbank/policy rate series for
// SGD, so intTicker is left null there and the UIP overlay is simply
// unavailable for any pair involving SGD (the UI disables that checkbox
// when either selected currency lacks interest-rate data).
export const CURRENCY_SOURCES = {
  USD: { fredTicker: null, invert: false, inflTicker: "FPCPITOTLZGUSA", intTicker: "IR3TIB01USM156N", name: "United States" },
  ZAR: { fredTicker: "DEXSFUS", invert: false, inflTicker: "FPCPITOTLZGZAF", intTicker: "IR3TIB01ZAM156N", name: "South Africa" },
  CHF: { fredTicker: "DEXSZUS", invert: false, inflTicker: "CPALTT01CHA657N", intTicker: "IR3TIB01CHM156N", name: "Switzerland" },
  SGD: { fredTicker: "DEXSIUS", invert: false, inflTicker: "FPCPITOTLZGSGP", intTicker: null, name: "Singapore" },
  GBP: { fredTicker: "DEXUSUK", invert: true, inflTicker: "FPCPITOTLZGGBR", intTicker: "IR3TIB01GBM156N", name: "United Kingdom" },
  CNY: { fredTicker: "DEXCHUS", invert: false, inflTicker: "FPCPITOTLZGCHN", intTicker: "IR3TIB01CNM156N", name: "China" },
  EUR: { fredTicker: "DEXUSEU", invert: true, inflTicker: "FPCPITOTLZGEMU", intTicker: "IR3TIB01EZM156N", name: "the Euro area" },
};

// A single global commodity price index, used for the (currency-agnostic)
// terms-of-trade/commodity-price overlay. A country-specific
// terms-of-trade series would be more precise for a commodity exporter
// like South Africa, but doesn't generalize across all seven currencies
// -- this is the same reason the original CTOT overlay was dropped when
// this app was generalized from a ZAR-only tool. One global series,
// fetched once (not per currency), is a rougher but honestly-generalizable
// stand-in: useful context for commodity-sensitive pairs, less so for
// pairs between two reserve currencies.
const COMMODITY_TICKER = "PALLFNFINDEXM";

const FRED_API_BASE = "https://api.stlouisfed.org/fred/series/observations";
const FETCH_ATTEMPTS = 3;
const RETRY_DELAY_MS = 1500;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Fetch one FRED series as a sparse {dates, values} pair -- missing
 * observations (FRED's "." placeholder) are dropped entirely rather than
 * kept as null, matching the sparse "only real observations" shape
 * js/lib/fairvalue.js's forwardFillOnAxis() expects. A few retries with a
 * short pause, same as the R app's fetch_fred_series(), for ordinary
 * transient network hiccups. */
export async function fetchFredSeries(seriesId, apiKey) {
  const url = `${FRED_API_BASE}?series_id=${encodeURIComponent(seriesId)}&api_key=${encodeURIComponent(apiKey)}&file_type=json`;

  let lastError;
  for (let attempt = 1; attempt <= FETCH_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(url);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} ${res.statusText}`);
      }
      const json = await res.json();
      if (!Array.isArray(json.observations)) {
        throw new Error("Unexpected response shape (no 'observations' array)");
      }
      const dates = [];
      const values = [];
      for (const obs of json.observations) {
        if (obs.value === "." || obs.value == null || obs.value === "") continue; // FRED's missing-value marker
        const v = Number(obs.value);
        if (!Number.isFinite(v)) continue;
        dates.push(obs.date);
        values.push(v);
      }
      if (dates.length === 0) {
        throw new Error("empty series returned");
      }
      return { dates, values };
    } catch (err) {
      lastError = err;
      if (attempt < FETCH_ATTEMPTS) await sleep(RETRY_DELAY_MS);
    }
  }
  throw new Error(`Could not fetch FRED series ${seriesId}: ${lastError?.message ?? lastError}`);
}

async function main() {
  const apiKey = process.env.FRED_API_KEY;
  if (!apiKey) {
    console.error(
      "FRED_API_KEY is not set. Get a free key at https://fredaccount.stlouisfed.org/apikeys, " +
        "then run: FRED_API_KEY=your-key-here npm run fetch-data"
    );
    process.exit(1);
  }

  const currencies = {};
  const failures = [];

  for (const [code, info] of Object.entries(CURRENCY_SOURCES)) {
    console.log(`Fetching ${code} (${info.name})...`);
    const entry = { name: info.name };

    try {
      entry.infl = await fetchFredSeries(info.inflTicker, apiKey);
    } catch (err) {
      failures.push(`${code} inflation (${info.inflTicker}): ${err.message}`);
      continue;
    }

    if (info.fredTicker) {
      try {
        const raw = await fetchFredSeries(info.fredTicker, apiKey);
        entry.perUsd = info.invert
          ? { dates: raw.dates, values: raw.values.map((v) => 1 / v) }
          : raw;
      } catch (err) {
        failures.push(`${code} FX rate (${info.fredTicker}): ${err.message}`);
        continue;
      }
    }

    // Interest-rate data is optional, unlike inflation/FX above: a
    // missing or failed intTicker just means the UIP overlay is
    // unavailable for this currency, not that the currency itself is
    // unusable -- so a failure here is logged but never skips the
    // currency entirely.
    if (info.intTicker) {
      try {
        entry.interest = await fetchFredSeries(info.intTicker, apiKey);
      } catch (err) {
        failures.push(`${code} interest rate (${info.intTicker}): ${err.message}`);
      }
    }

    currencies[code] = entry;
  }

  if (failures.length > 0) {
    console.error("Some series failed to download:\n  " + failures.join("\n  "));
    // Only fail the whole run if we ended up with fewer than two usable
    // currencies -- can't build any pair at all with just one. A single
    // currency's hiccup shouldn't block publishing the rest; the site's
    // dropdowns simply won't offer that currency this run, and the next
    // scheduled refresh will likely pick it back up.
    if (Object.keys(currencies).length < 2) {
      throw new Error("Too few currencies downloaded successfully to publish a usable site.");
    }
  }

  let commodity;
  try {
    commodity = await fetchFredSeries(COMMODITY_TICKER, apiKey);
  } catch (err) {
    // Non-fatal: the commodity overlay just becomes unavailable this run
    // (the UI's checkbox for it is hidden/disabled when the field is
    // absent) -- it shouldn't block deploying everything else.
    console.error(`Commodity index (${COMMODITY_TICKER}) failed to download: ${err.message}`);
  }

  const output = {
    generatedAt: new Date().toISOString(),
    currencies,
    ...(commodity ? { commodity } : {}),
  };

  await mkdir(dirname(OUTPUT_PATH), { recursive: true });
  await writeFile(OUTPUT_PATH, JSON.stringify(output));
  console.log(`Wrote ${OUTPUT_PATH} with ${Object.keys(currencies).length} currencies.`);
}

// Only run main() when this file is executed directly (`node
// scripts/fetch-data.mjs`), not when it's imported -- e.g. by
// tests/fetch-data.test.mjs, which exercises fetchFredSeries() and the
// invert logic against a mocked `fetch` without ever touching the
// network or needing a real API key.
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error(err.stack || err.message || err);
    process.exit(1);
  });
}
