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
export const CURRENCY_SOURCES = {
  USD: { fredTicker: null, invert: false, inflTicker: "FPCPITOTLZGUSA", name: "United States" },
  ZAR: { fredTicker: "DEXSFUS", invert: false, inflTicker: "FPCPITOTLZGZAF", name: "South Africa" },
  CHF: { fredTicker: "DEXSZUS", invert: false, inflTicker: "CPALTT01CHA657N", name: "Switzerland" },
  SGD: { fredTicker: "DEXSIUS", invert: false, inflTicker: "FPCPITOTLZGSGP", name: "Singapore" },
  GBP: { fredTicker: "DEXUSUK", invert: true, inflTicker: "FPCPITOTLZGGBR", name: "United Kingdom" },
  CNY: { fredTicker: "DEXCHUS", invert: false, inflTicker: "FPCPITOTLZGCHN", name: "China" },
  EUR: { fredTicker: "DEXUSEU", invert: true, inflTicker: "FPCPITOTLZGEMU", name: "the Euro area" },
};

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

  const output = {
    generatedAt: new Date().toISOString(),
    currencies,
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
