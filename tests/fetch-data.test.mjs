// ---------------------------------------------------------------------
// tests/fetch-data.test.mjs
//
// Exercises scripts/fetch-data.mjs's fetchFredSeries() against a mocked
// global `fetch` -- no network access, no real API key needed. This is
// the function most exposed to FRED's actual response quirks (the "."
// missing-value marker, transient failures), so it's worth testing even
// though the full fetch-data.mjs run itself can only be exercised for
// real in CI (see .github/workflows/deploy.yml), where real network
// access and a real FRED_API_KEY secret are both available.
// ---------------------------------------------------------------------

import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { fetchFredSeries } from "../scripts/fetch-data.mjs";

let originalFetch;
before(() => {
  originalFetch = global.fetch;
});
after(() => {
  global.fetch = originalFetch;
});

function fredResponse(observations) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    json: async () => ({ observations }),
  };
}

test("fetchFredSeries drops FRED's '.' missing-value marker rather than keeping it as a gap", async () => {
  global.fetch = async () =>
    fredResponse([
      { date: "2020-01-01", value: "10.5" },
      { date: "2020-01-02", value: "." },
      { date: "2020-01-03", value: "11.0" },
    ]);

  const result = await fetchFredSeries("FAKE", "key");
  assert.deepEqual(result.dates, ["2020-01-01", "2020-01-03"]);
  assert.deepEqual(result.values, [10.5, 11.0]);
});

test("fetchFredSeries retries on a transient failure and succeeds", async () => {
  let calls = 0;
  global.fetch = async () => {
    calls++;
    if (calls < 2) throw new Error("simulated network blip");
    return fredResponse([{ date: "2020-01-01", value: "1.23" }]);
  };

  const result = await fetchFredSeries("FAKE", "key");
  assert.equal(calls, 2);
  assert.deepEqual(result.values, [1.23]);
});

test("fetchFredSeries throws a clear, series-naming error after exhausting retries", async () => {
  global.fetch = async () => {
    throw new Error("still down");
  };

  await assert.rejects(() => fetchFredSeries("DEXFAKE", "key"), /DEXFAKE/);
});

test("fetchFredSeries treats an HTTP error status as a failure worth retrying/reporting", async () => {
  global.fetch = async () => ({ ok: false, status: 429, statusText: "Too Many Requests" });

  await assert.rejects(() => fetchFredSeries("FAKE", "key"), /FAKE/);
});

test("fetchFredSeries rejects an all-missing series with a clear error rather than returning empty arrays", async () => {
  global.fetch = async () => fredResponse([{ date: "2020-01-01", value: "." }]);

  await assert.rejects(() => fetchFredSeries("FAKE", "key"), /FAKE/);
});
