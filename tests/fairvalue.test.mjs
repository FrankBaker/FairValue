// ---------------------------------------------------------------------
// tests/fairvalue.test.mjs
//
// Ported from the R app's tests/testthat/test-fair_value.R. Every
// expected number below is either hand-computed independently (matching
// the R fixtures exactly, so this also cross-checks the JS port against
// the original R implementation) or follows directly from the stated
// mathematical property (e.g. monotonicity) -- not derived by running
// this same code.
//
// Run with: node --test tests/
// ---------------------------------------------------------------------

import { test } from "node:test";
import assert from "node:assert/strict";
import {
  unionDates,
  forwardFillOnAxis,
  buildPairSeries,
  differentialInflation,
  impliedFairValue,
  fitTrend,
  quantile,
  median,
  realRateBand,
  fairValueAnalysis,
} from "../js/lib/fairvalue.js";

function closeTo(actual, expected, tolerance = 1e-9, msg = "") {
  assert.ok(
    Math.abs(actual - expected) <= tolerance,
    `${msg} expected ${expected}, got ${actual} (diff ${Math.abs(actual - expected)})`
  );
}

function dateSeq(startIso, n) {
  const start = Date.parse(startIso + "T00:00:00Z");
  const out = [];
  for (let i = 0; i < n; i++) {
    out.push(new Date(start + i * 86400000).toISOString().slice(0, 10));
  }
  return out;
}

test("differentialInflation prorates by elapsed calendar days, not a fixed day count", () => {
  const dates = dateSeq("2020-01-01", 4);
  const dom = [6, 6, 6, 6];
  const forn = [2, 2, 2, 2];
  const out = differentialInflation(dates, dom, forn);

  closeTo(out[0], 0);
  closeTo(out[1], 0.04 * (1 / 365.25));
  closeTo(out[2], 0.04 * (1 / 365.25));

  // A 3-day gap should carry 3x the daily contribution of a 1-day gap.
  const gapped = differentialInflation(["2020-01-01", "2020-01-04"], [6, 6], [2, 2]);
  closeTo(gapped[1], 0.04 * (3 / 365.25));
});

test("impliedFairValue matches a hand-computed constant-differential fixture", () => {
  const dates = dateSeq("2020-01-01", 40);
  const merged = {
    dates,
    rate: dates.map(() => 10),
    domesticInfl: dates.map(() => 6),
    foreignInfl: dates.map(() => 2),
  };

  const fv = impliedFairValue(merged);

  closeTo(fv.fairValue[0], 10.042801811493112, 1e-9);
  closeTo(fv.fairValue[10], 10.03290823855275, 1e-9);
  // The last date's "remaining" compounding window is just that day's own
  // contribution (not exactly zero) -- fairValue converges to, but isn't
  // exactly equal to, today's actual rate.
  closeTo(fv.fairValue[39], 10.001095200283658, 1e-9);

  // With domestic inflation > foreign inflation, anchoring further in the
  // past implies a *higher* fair value for today -- i.e. the series is
  // non-increasing as dates approach the present.
  for (let i = 1; i < fv.fairValue.length; i++) {
    assert.ok(fv.fairValue[i] - fv.fairValue[i - 1] <= 1e-9, `fairValue should be non-increasing at index ${i}`);
  }
});

test("realRateBand matches a hand-computed constant-differential fixture", () => {
  const dates = dateSeq("2020-01-01", 40);
  const merged = {
    dates,
    rate: dates.map(() => 10),
    domesticInfl: dates.map(() => 6),
    foreignInfl: dates.map(() => 2),
  };

  const real = realRateBand(merged);

  // The real rate always starts exactly at the actual rate on day one --
  // there's no accumulated differential yet to strip out.
  closeTo(real.realRate[0], 10, 1e-9);
  closeTo(real.realRate[10], 9.989054591324555, 1e-9);
  closeTo(real.realRate[39], 9.957380607228423, 1e-9);

  // With domestic inflation > foreign inflation, the real rate *falls*
  // over time as the accumulated differential is stripped back out --
  // the mirror image of impliedFairValue(), which rises.
  for (let i = 1; i < real.realRate.length; i++) {
    assert.ok(real.realRate[i] - real.realRate[i - 1] <= 1e-9, `realRate should be non-increasing at index ${i}`);
  }

  closeTo(real.realRateLower, quantile(real.realRate, 0.1), 1e-12);
  closeTo(real.realRateUpper, quantile(real.realRate, 0.9), 1e-12);
});

test("fairValueAnalysis attaches the real-rate band to its output", () => {
  const dates = dateSeq("2020-01-01", 40);
  const merged = {
    dates,
    rate: dates.map(() => 10),
    domesticInfl: dates.map(() => 6),
    foreignInfl: dates.map(() => 2),
  };

  const result = fairValueAnalysis(merged, "2020-01-01");
  assert.ok("realRate" in result.data);
  assert.ok("realRateMedian" in result.data);
  assert.ok("realRateLower" in result.data);
  assert.ok("realRateUpper" in result.data);
  closeTo(result.data.realRate[0], 10, 1e-9);
});

test("forwardFillOnAxis forward-fills gaps (not backward)", () => {
  // Sparse representation of a series with real observations at days
  // 0, 2 and 4 only (days 1 and 3 have no new print, matching the R
  // app's rate_raw = c(10, NA, 12, NA, 14)).
  const axis = dateSeq("2020-01-01", 5);
  const dates = [axis[0], axis[2], axis[4]];
  const values = [10, 12, 14];

  const out = forwardFillOnAxis(dates, values, axis);

  // Forward-fill: day 1 should take day 0's value (10), and day 3 should
  // take day 2's value (12) -- NOT the next value, which is what the
  // original app's na.locf(fromLast = TRUE) bug would have produced.
  assert.deepEqual(out, [10, 10, 12, 12, 14]);
});

test("buildPairSeries drops leading rows before data is complete, and keeps inflation prints dated off the FX calendar", () => {
  // FOO's inflation print is dated 2020-01-01, which never coincides with
  // any of FOO's or BAR's own FX observation dates -- a naive "left join
  // keyed on the FX calendar" would silently drop it; the union-based
  // merge here must not. BAR is held constant at 1 per USD so the merged
  // `rate` equals FOO's own per-USD values directly, which makes the
  // fixture easy to check by eye.
  const data = {
    currencies: {
      FOO: {
        name: "Foo",
        infl: { dates: ["2020-01-01"], values: [5] },
        perUsd: { dates: ["2020-01-02", "2020-01-06", "2020-01-08"], values: [10, 12, 14] },
      },
      BAR: {
        name: "Bar",
        infl: { dates: ["2020-01-01"], values: [2] },
        perUsd: { dates: ["2020-01-02", "2020-01-06", "2020-01-08"], values: [1, 1, 1] },
      },
    },
  };

  const merged = buildPairSeries("FOO", "BAR", data);

  // The 2020-01-01 row itself is dropped (no FX observation yet to
  // divide), but its inflation values must have propagated onto every
  // row from 01-02 onward.
  assert.deepEqual(merged.dates, ["2020-01-02", "2020-01-06", "2020-01-08"]);
  assert.deepEqual(merged.rate, [10, 12, 14]);
  assert.ok(merged.domesticInfl.every((v) => v === 5));
  assert.ok(merged.foreignInfl.every((v) => v === 2));
});

test("buildPairSeries treats USD as an implicit numeraire (no perUsd needed)", () => {
  const data = {
    currencies: {
      FOO: {
        name: "Foo",
        infl: { dates: ["2020-01-01"], values: [5] },
        perUsd: { dates: ["2020-01-01", "2020-01-02"], values: [18.5, 18.6] },
      },
      USD: {
        name: "United States",
        infl: { dates: ["2020-01-01"], values: [2] },
        // no perUsd entry -- USD is the numeraire
      },
    },
  };

  const merged = buildPairSeries("FOO", "USD", data);
  assert.deepEqual(merged.rate, [18.5, 18.6]);
});

test("quantile() matches R's default (type 7) interpolation on a known fixture", () => {
  // R: quantile(1:10, probs = c(0.1, 0.9)) == c(1.9, 9.1)
  const arr = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10];
  closeTo(quantile(arr, 0.1), 1.9, 1e-12);
  closeTo(quantile(arr, 0.9), 9.1, 1e-12);
  closeTo(median(arr), 5.5, 1e-12);
});

test("fitTrend recovers an exact log-linear trend without noise", () => {
  // y = 10 * 1.01^t exactly -- fitTrend should recover it almost exactly
  // (small floating-point error only, no sampling noise to average out).
  const dates = dateSeq("2020-01-01", 50);
  const values = dates.map((_, i) => 10 * Math.pow(1.01, i));
  const trend = fitTrend(dates, values);
  for (let i = 0; i < values.length; i++) {
    closeTo(trend[i], values[i], 1e-6, `at index ${i}`);
  }
});

test("fairValueAnalysis rejects an out-of-range start date with a clear message", () => {
  const dates = dateSeq("2020-01-01", 40);
  const merged = {
    dates,
    rate: dates.map(() => 10),
    domesticInfl: dates.map(() => 6),
    foreignInfl: dates.map(() => 2),
  };

  assert.throws(() => fairValueAnalysis(merged, "2010-01-01"), /outside the available data range/);
  assert.throws(() => fairValueAnalysis(merged, "2020-03-01"), /outside the available data range/);
});

test("fairValueAnalysis rejects a start date too close to the end", () => {
  const dates = dateSeq("2020-01-01", 40);
  const merged = {
    dates,
    rate: dates.map(() => 10),
    domesticInfl: dates.map(() => 6),
    foreignInfl: dates.map(() => 2),
  };

  assert.throws(() => fairValueAnalysis(merged, "2020-02-05"), /Fewer than 30 observations/);
});

test("fairValueAnalysis's endDate trims display data without changing the trend fit", () => {
  const dates = dateSeq("2020-01-01", 40);
  const merged = {
    dates,
    rate: dates.map(() => 10),
    domesticInfl: dates.map(() => 6),
    foreignInfl: dates.map(() => 2),
  };

  const full = fairValueAnalysis(merged, "2020-01-01");
  const trimmed = fairValueAnalysis(merged, "2020-01-01", "2020-01-10");

  assert.equal(trimmed.data.date.length, 10);
  closeTo(trimmed.pppChangePct, full.pppChangePct, 1e-12);
  for (let i = 0; i < 10; i++) {
    closeTo(trimmed.data.fairValueTrend[i], full.data.fairValueTrend[i], 1e-9, `at index ${i}`);
  }
});

test("unionDates returns a sorted, deduplicated union", () => {
  const u = unionDates([
    { dates: ["2020-01-03", "2020-01-01"] },
    { dates: ["2020-01-02", "2020-01-01"] },
  ]);
  assert.deepEqual(u, ["2020-01-01", "2020-01-02", "2020-01-03"]);
});
