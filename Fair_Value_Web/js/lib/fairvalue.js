// ---------------------------------------------------------------------
// js/lib/fairvalue.js
//
// Pure calculation logic -- no DOM, no fetch, no Shiny. This is a direct
// port of the R app's R/02_fair_value.R (relative-PPP fair value via
// differential inflation) plus a generalized version of its
// build_currency_series() merge-and-forward-fill step, extended to work
// from the normalized "currency per USD" + inflation series that
// scripts/fetch-data.mjs bakes into data/data.json (so this module never
// needs to know which raw FRED tickers anything came from, or which way
// any of them happen to be quoted -- that's all resolved before this
// file ever sees the data).
//
// METHODOLOGY (relative PPP via differential inflation), in brief:
//
// For every historical date t we ask: "if purchasing-power parity held
// exactly from t onward, what would today's rate be?" -- by taking the
// *actual* rate on date t and compounding it forward by the realised
// differential inflation between t and today. That gives one "today's
// fair value, implied by anchoring at t" estimate per historical date,
// i.e. an entire ensemble of independent estimates rather than a single,
// arbitrarily-chosen base year.
//
// A log-linear trend fitted through that ensemble is a robust "consensus"
// fair-value estimate: it isn't hostage to whichever one day you happened
// to pick as your anchor. See the original project's PROPOSAL.md for a
// fuller discussion of this choice and its limitations.
//
// Every function here is pure and is exercised by hand-computed fixtures
// in tests/fairvalue.test.mjs (ported from the R app's
// tests/testthat/test-fair_value.R) -- run `node --test` before trusting
// a change to this file.
// ---------------------------------------------------------------------

const MS_PER_DAY = 86400000;

/** ISO "YYYY-MM-DD" -> days since the Unix epoch (UTC, no DST issues). */
function dayNumber(isoDate) {
  return Date.parse(isoDate + "T00:00:00Z") / MS_PER_DAY;
}

/** The sorted union of every date appearing in any of the given {dates,
 * values} series. ISO date strings sort correctly as plain strings. */
export function unionDates(seriesList) {
  const set = new Set();
  for (const s of seriesList) {
    for (const d of s.dates) set.add(d);
  }
  return Array.from(set).sort();
}

/** Carry the *previous* known value of (dates, values) forward onto
 * `axis` (a sorted superset of dates) -- the standard "last observation
 * carried forward" convention, matching the R app's
 * zoo::na.locf(..., fromLast = FALSE). Positions on `axis` before the
 * series' first observation get `null` (there's nothing to carry
 * forward from), exactly like na.locf's inability to fill leading NAs.
 * Both `dates` and `axis` must already be sorted ascending. */
export function forwardFillOnAxis(dates, values, axis) {
  const out = new Array(axis.length).fill(null);
  let lastIdx = -1;
  let j = 0;
  for (let i = 0; i < axis.length; i++) {
    while (j < dates.length && dates[j] <= axis[i]) {
      lastIdx = j;
      j++;
    }
    out[i] = lastIdx >= 0 ? values[lastIdx] : null;
  }
  return out;
}

/** Build the merged {dates, rate, domesticInfl, foreignInfl} series for
 * an arbitrary base/quote currency pair -- "`baseCcy` per 1 unit of
 * `quoteCcy`", the same convention the R app used throughout (its
 * "ZAR/EUR" meant Rand per Euro). `data` is the parsed data/data.json:
 * `data.currencies[CODE] = { name, infl: {dates,values}, perUsd:
 * {dates,values} | undefined }` (perUsd is absent for USD, the implicit
 * numeraire, always exactly 1 USD per USD).
 *
 * This is the JS equivalent of the R app's build_currency_series(): an
 * outer join of every series onto their combined calendar, forward-filled,
 * with leading rows dropped until every one of rate/domesticInfl/
 * foreignInfl has a real value (na.omit). */
export function buildPairSeries(baseCcy, quoteCcy, data) {
  const base = data.currencies[baseCcy];
  const quote = data.currencies[quoteCcy];
  if (!base) throw new Error(`Unknown currency: ${baseCcy}`);
  if (!quote) throw new Error(`Unknown currency: ${quoteCcy}`);

  const basePerUsd = baseCcy === "USD" ? null : base.perUsd;
  const quotePerUsd = quoteCcy === "USD" ? null : quote.perUsd;

  const axisSeries = [base.infl, quote.infl];
  if (basePerUsd) axisSeries.push(basePerUsd);
  if (quotePerUsd) axisSeries.push(quotePerUsd);
  const axis = unionDates(axisSeries);

  const baseVals = basePerUsd
    ? forwardFillOnAxis(basePerUsd.dates, basePerUsd.values, axis)
    : axis.map(() => 1);
  const quoteVals = quotePerUsd
    ? forwardFillOnAxis(quotePerUsd.dates, quotePerUsd.values, axis)
    : axis.map(() => 1);
  const domVals = forwardFillOnAxis(base.infl.dates, base.infl.values, axis);
  const forVals = forwardFillOnAxis(quote.infl.dates, quote.infl.values, axis);

  const dates = [];
  const rate = [];
  const domesticInfl = [];
  const foreignInfl = [];
  for (let i = 0; i < axis.length; i++) {
    if (baseVals[i] == null || quoteVals[i] == null || domVals[i] == null || forVals[i] == null) {
      continue; // na.omit: skip until every leg has a real value
    }
    dates.push(axis[i]);
    rate.push(baseVals[i] / quoteVals[i]);
    domesticInfl.push(domVals[i]);
    foreignInfl.push(forVals[i]);
  }
  return { dates, rate, domesticInfl, foreignInfl };
}

/** Convert each row's annual (%) inflation differential into that row's
 * share of a full year, based on how many calendar days actually elapsed
 * since the previous observation -- exact regardless of how many
 * observations a given year happens to have. */
export function differentialInflation(dates, domesticPct, foreignPct) {
  const out = new Array(dates.length);
  let prevDay = null;
  for (let i = 0; i < dates.length; i++) {
    const day = dayNumber(dates[i]);
    const elapsedDays = prevDay == null ? 0 : day - prevDay;
    out[i] = ((domesticPct[i] - foreignPct[i]) / 100) * (elapsedDays / 365.25);
    prevDay = day;
  }
  return out;
}

/** For every date t in `merged`, the fair value "as of today" implied by
 * PPP holding exactly from t onward: the actual rate at t, compounded
 * forward by the realised inflation differential from t through to the
 * most recent date in the data. */
export function impliedFairValue(merged) {
  const { dates, rate, domesticInfl, foreignInfl } = merged;
  const diffInfl = differentialInflation(dates, domesticInfl, foreignInfl);
  const n = diffInfl.length;

  // "Remaining" cumulative differential inflation from t through to the
  // last date, for every t at once (rev(cumsum(rev(x))) in R).
  const remaining = new Array(n);
  let acc = 0;
  for (let i = n - 1; i >= 0; i--) {
    acc += diffInfl[i];
    remaining[i] = acc;
  }

  const fairValue = new Array(n);
  for (let i = 0; i < n; i++) fairValue[i] = rate[i] * Math.exp(remaining[i]);

  return { dates, rate, fairValue };
}

/** Simple OLS regression of log(values) on the dates' numeric day index,
 * returned on the original (exponentiated) scale -- equivalent to
 * R's `exp(predict(lm(log(values) ~ as.numeric(dates))))`. */
export function fitTrend(dates, values) {
  const n = dates.length;
  const x = dates.map(dayNumber);
  const y = values.map(Math.log);

  let meanX = 0, meanY = 0;
  for (let i = 0; i < n; i++) { meanX += x[i]; meanY += y[i]; }
  meanX /= n; meanY /= n;

  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) {
    const dx = x[i] - meanX;
    sxy += dx * (y[i] - meanY);
    sxx += dx * dx;
  }
  const slope = sxy / sxx;
  const intercept = meanY - slope * meanX;

  return x.map((xi) => Math.exp(intercept + slope * xi));
}

/** R's default (type 7) quantile: linear interpolation between order
 * statistics. `arr` need not be pre-sorted. */
export function quantile(arr, p) {
  const sorted = [...arr].sort((a, b) => a - b);
  const n = sorted.length;
  const h = (n - 1) * p;
  const lo = Math.floor(h);
  const hi = Math.ceil(h);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (h - lo) * (sorted[hi] - sorted[lo]);
}

export function median(arr) {
  return quantile(arr, 0.5);
}

/** A real (inflation-adjusted) exchange rate index, benchmarked against
 * its own historical range -- the bilateral "REER-style band" view: it
 * strips the accumulated inflation differential back out of the actual
 * rate (so the result would be flat if PPP held exactly) and asks
 * whether *today's* real rate is unusually far from where it's *itself*
 * historically sat. No assumption about a trend, unlike
 * impliedFairValue()/fitTrend() above. */
export function realRateBand(merged, probs = [0.1, 0.9]) {
  const { dates, rate, domesticInfl, foreignInfl } = merged;
  const diffInfl = differentialInflation(dates, domesticInfl, foreignInfl);
  const n = diffInfl.length;

  const cumulativeFromStart = new Array(n);
  let acc = 0;
  for (let i = 0; i < n; i++) {
    acc += diffInfl[i];
    cumulativeFromStart[i] = acc;
  }

  const realRate = rate.map((r, i) => r * Math.exp(-cumulativeFromStart[i]));

  return {
    dates,
    realRate,
    realRateMedian: median(realRate),
    realRateLower: quantile(realRate, probs[0]),
    realRateUpper: quantile(realRate, probs[1]),
  };
}

/** Full fair-value analysis for one currency pair, from `startDate`
 * through to the most recent available date. `startDate`/`endDate` are
 * ISO "YYYY-MM-DD" strings. `startDate` truncates the data used for
 * *both* the calculation and the trend fit; `endDate`, if supplied,
 * additionally trims what's returned for *display* only. */
export function fairValueAnalysis(merged, startDate, endDate = null) {
  const datesAll = merged.dates;
  if (datesAll.length === 0) {
    throw new Error("No data is available for this currency pair.");
  }
  if (startDate < datesAll[0] || startDate > datesAll[datesAll.length - 1]) {
    throw new Error(
      `Start date is outside the available data range (${datesAll[0]} to ${datesAll[datesAll.length - 1]}).`
    );
  }

  const startIdx = datesAll.findIndex((d) => d >= startDate);
  if (startIdx < 0) {
    throw new Error(
      `Start date is outside the available data range (${datesAll[0]} to ${datesAll[datesAll.length - 1]}).`
    );
  }

  const windowed = {
    dates: merged.dates.slice(startIdx),
    rate: merged.rate.slice(startIdx),
    domesticInfl: merged.domesticInfl.slice(startIdx),
    foreignInfl: merged.foreignInfl.slice(startIdx),
  };
  if (windowed.dates.length < 30) {
    throw new Error("Fewer than 30 observations after the selected start date -- pick an earlier start date.");
  }

  const fv = impliedFairValue(windowed);
  const actualTrend = fitTrend(fv.dates, fv.rate);
  const fairValueTrend = fitTrend(fv.dates, fv.fairValue);
  const anomaly = fv.fairValue.map((v, i) => v - fairValueTrend[i]);

  const real = realRateBand(windowed);

  // An honest uncertainty band around the trend: the 10th-90th percentile
  // spread of the raw anchor-implied estimates (`anomaly`) around their
  // own trend -- the whole point of anchoring at *every* historical date
  // rather than just one.
  const lowerQ = quantile(anomaly, 0.1);
  const upperQ = quantile(anomaly, 0.9);
  const fairValueLower = fairValueTrend.map((v) => v + lowerQ);
  const fairValueUpper = fairValueTrend.map((v) => v + upperQ);

  // % change in the trend-implied fair value from the start of the window
  // to today. A POSITIVE number means the PPP-implied fair value has
  // risen since startDate, i.e. Currency 1 has *depreciated* against
  // Currency 2 over the window; negative means it has *appreciated*.
  const pppChangePct = 100 * (1 - fairValueTrend[0] / fairValueTrend[fairValueTrend.length - 1]);

  let data = {
    date: fv.dates,
    rate: fv.rate,
    fairValue: fv.fairValue,
    actualTrend,
    fairValueTrend,
    anomaly,
    realRate: real.realRate,
    realRateMedian: real.realRateMedian,
    realRateLower: real.realRateLower,
    realRateUpper: real.realRateUpper,
    fairValueLower,
    fairValueUpper,
  };

  if (endDate) {
    const keepIdx = [];
    for (let i = 0; i < data.date.length; i++) {
      if (data.date[i] <= endDate) keepIdx.push(i);
    }
    const trimmed = {};
    for (const key of Object.keys(data)) {
      trimmed[key] = Array.isArray(data[key]) ? keepIdx.map((i) => data[key][i]) : data[key];
    }
    data = trimmed;
  }

  return { data, pppChangePct, anomalyBand: [lowerQ, upperQ], startDate };
}
