// ---------------------------------------------------------------------
// js/app.js
//
// UI glue: loads data/data.json, wires up the controls, and renders the
// two Plotly charts plus the summary panel -- the browser-side
// equivalent of the Shiny app's R/03_ui.R + R/04_server.R. All the real
// calculation happens in js/lib/fairvalue.js, which has its own test
// suite (tests/fairvalue.test.mjs) and no dependency on this file or the
// DOM at all.
// ---------------------------------------------------------------------

import {
  buildPairSeries,
  fairValueAnalysis,
  buildInterestRateSeries,
  uipTrendAnalysis,
} from "./lib/fairvalue.js";

const COLOURS = {
  actual: "#d62728",
  fairValue: "#1f77b4",
  latest: "#2ca02c",
  real: "#9467bd",
  uip: "#ff7f0e",
  commodity: "#8c564b",
};

let DATA = null;

const el = {
  baseCurrency: document.getElementById("baseCurrency"),
  quoteCurrency: document.getElementById("quoteCurrency"),
  startDate: document.getElementById("startDate"),
  windowFrom: document.getElementById("windowFrom"),
  windowTo: document.getElementById("windowTo"),
  showRealRateBand: document.getElementById("showRealRateBand"),
  showUncertaintyBand: document.getElementById("showUncertaintyBand"),
  showUip: document.getElementById("showUip"),
  uipUnavailableNote: document.getElementById("uipUnavailableNote"),
  showCommodity: document.getElementById("showCommodity"),
  dataFreshness: document.getElementById("dataFreshness"),
  errorBanner: document.getElementById("errorBanner"),
  fairValueSubtitle: document.getElementById("fairValueSubtitle"),
  anomalySubtitle: document.getElementById("anomalySubtitle"),
  summary: document.getElementById("summary"),
};

function showError(message) {
  el.errorBanner.textContent = message;
  el.errorBanner.hidden = false;
}

function clearError() {
  el.errorBanner.hidden = true;
  el.errorBanner.textContent = "";
}

function populateCurrencyChoices() {
  const codes = Object.keys(DATA.currencies);
  const optionsHtml = codes
    .map((code) => `<option value="${code}">${code} — ${DATA.currencies[code].name}</option>`)
    .join("");
  el.baseCurrency.innerHTML = optionsHtml;
  el.quoteCurrency.innerHTML = optionsHtml;

  el.baseCurrency.value = codes.includes("ZAR") ? "ZAR" : codes[0];
  el.quoteCurrency.value = codes.includes("USD") ? "USD" : codes[Math.min(1, codes.length - 1)];
}

/** True when both currencies in the pair have interest-rate data, i.e.
 * the UIP overlay can actually be computed -- false for any pair
 * involving SGD, since FRED has no comparable short-term rate series for
 * Singapore (see scripts/fetch-data.mjs). */
function uipAvailableForPair(baseCcy, quoteCcy) {
  return Boolean(DATA.currencies[baseCcy]?.interest) && Boolean(DATA.currencies[quoteCcy]?.interest);
}

/** Keeps the UIP checkbox in sync with whether the *currently selected*
 * pair actually supports it -- disables it and shows the "(not available
 * for this pair)" note rather than letting the user tick a box that can
 * never do anything for this pair. */
function updateUipAvailability() {
  const available = uipAvailableForPair(el.baseCurrency.value, el.quoteCurrency.value);
  el.showUip.disabled = !available;
  el.uipUnavailableNote.hidden = available;
  if (!available) el.showUip.checked = false;
}

function setDefaultWindow() {
  const today = new Date();
  const fifteenYearsAgo = new Date(today);
  fifteenYearsAgo.setFullYear(fifteenYearsAgo.getFullYear() - 15);
  const toIso = today.toISOString().slice(0, 10);
  const fromIso = fifteenYearsAgo.toISOString().slice(0, 10);

  el.windowFrom.value = fromIso;
  el.windowTo.value = toIso;
  el.startDate.max = toIso;
  el.windowFrom.max = toIso;
  el.windowTo.max = toIso;
}

function formatDate(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString(undefined, { day: "2-digit", month: "short", year: "numeric" });
}

function fmt(n, digits = 4) {
  return Number(n).toFixed(digits);
}

/** Trim the full analysis.data to [windowFrom, windowTo] for display --
 * mirrors the R app's `windowed` reactive (a display-only trim; it never
 * changes the underlying start-date-to-today calculation). */
function windowData(data, fromIso, toIso) {
  const keepIdx = [];
  for (let i = 0; i < data.date.length; i++) {
    if (data.date[i] >= fromIso && data.date[i] <= toIso) keepIdx.push(i);
  }
  const out = {};
  for (const key of Object.keys(data)) {
    out[key] = Array.isArray(data[key]) ? keepIdx.map((i) => data[key][i]) : data[key];
  }
  return out;
}

function renderFairValuePlot(dat, pairLabel, showRealRateBand, showUncertaintyBand, uipWindowed) {
  const traces = [];

  if (showUncertaintyBand) {
    traces.push(
      {
        name: "band",
        x: dat.date,
        y: dat.fairValueUpper,
        mode: "lines",
        line: { width: 0 },
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        name: "band",
        x: dat.date,
        y: dat.fairValueLower,
        mode: "lines",
        line: { width: 0 },
        fill: "tonexty",
        fillcolor: "rgba(31,119,180,0.12)",
        hoverinfo: "skip",
        showlegend: false,
      }
    );
  }

  traces.push(
    {
      name: "Actual",
      x: dat.date,
      y: dat.rate,
      mode: "lines",
      line: { color: COLOURS.actual, width: 1.5 },
      opacity: 0.6,
    },
    {
      name: "Fair value",
      x: dat.date,
      y: dat.fairValue,
      mode: "lines",
      line: { color: COLOURS.fairValue, width: 1.5 },
      opacity: 0.35,
    },
    {
      name: "Actual (trend)",
      x: dat.date,
      y: dat.actualTrend,
      mode: "lines",
      line: { color: COLOURS.actual, width: 3 },
    },
    {
      name: "Fair value (trend)",
      x: dat.date,
      y: dat.fairValueTrend,
      mode: "lines",
      line: { color: COLOURS.fairValue, width: 3, dash: "dash" },
    },
    {
      name: "Latest close",
      x: [dat.date[dat.date.length - 1]],
      y: [dat.rate[dat.rate.length - 1]],
      mode: "markers",
      marker: { color: COLOURS.latest, size: 9 },
    }
  );

  if (showRealRateBand) {
    traces.push(
      {
        name: "real-band",
        x: dat.date,
        y: dat.date.map(() => dat.realRateUpper),
        mode: "lines",
        line: { width: 0 },
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        name: "real-band",
        x: dat.date,
        y: dat.date.map(() => dat.realRateLower),
        mode: "lines",
        line: { width: 0 },
        fill: "tonexty",
        fillcolor: "rgba(148,103,189,0.10)",
        hoverinfo: "skip",
        showlegend: false,
      },
      {
        name: "Real rate (REER-style)",
        x: dat.date,
        y: dat.realRate,
        mode: "lines",
        line: { color: COLOURS.real, width: 1.5, dash: "dot" },
      }
    );
  }

  if (uipWindowed) {
    traces.push({
      name: "UIP (interest-rate) trend",
      x: uipWindowed.date,
      y: uipWindowed.uipTrend,
      mode: "lines",
      line: { color: COLOURS.uip, width: 3, dash: "dashdot" },
    });
  }

  const layout = {
    title: { text: pairLabel },
    xaxis: { title: "" },
    yaxis: { title: pairLabel },
    legend: { orientation: "h", x: 0.5, xanchor: "center", y: -0.2 },
    margin: { t: 50, b: 40, l: 60, r: 30 },
    font: { size: 13 },
  };

  Plotly.newPlot("fairValuePlot", traces, layout, { responsive: true, displaylogo: false });
}

function renderAnomalyPlot(dat, pairLabel, commodityWindowed) {
  const lastIdx = dat.date.length - 1;
  const traces = [
    {
      x: [dat.date[0], dat.date[lastIdx]],
      y: [0, 0],
      mode: "lines",
      line: { color: "#999", width: 1 },
      hoverinfo: "skip",
      showlegend: false,
    },
    {
      name: "Deviation",
      x: dat.date,
      y: dat.anomaly,
      mode: "lines",
      line: { color: COLOURS.fairValue, width: 1.5 },
    },
    {
      name: "Latest",
      x: [dat.date[lastIdx]],
      y: [dat.anomaly[lastIdx]],
      mode: "markers",
      marker: { color: COLOURS.latest, size: 9 },
    },
  ];

  const layout = {
    xaxis: { title: "" },
    yaxis: { title: `${pairLabel} deviation` },
    showlegend: Boolean(commodityWindowed),
    margin: { t: 20, b: 40, l: 60, r: commodityWindowed ? 60 : 30 },
    font: { size: 13 },
  };

  if (commodityWindowed) {
    traces.push({
      name: "Global commodity price index",
      x: commodityWindowed.dates,
      y: commodityWindowed.values,
      mode: "lines",
      line: { color: COLOURS.commodity, width: 1.5, dash: "dot" },
      yaxis: "y2",
    });
    layout.yaxis2 = {
      title: "Commodity index",
      overlaying: "y",
      side: "right",
      showgrid: false,
    };
    layout.legend = { orientation: "h", x: 0.5, xanchor: "center", y: -0.2 };
  }

  Plotly.newPlot("anomalyPlot", traces, layout, { responsive: true, displaylogo: false });
}

function renderSummary(dat, pairLabel, baseCode, pppChangePct, showRealRateBand, uipWindowed) {
  const lastIdx = dat.date.length - 1;
  const live = dat.rate[lastIdx];
  const trend = dat.fairValueTrend[lastIdx];
  const deviationPct = 100 * (live / trend - 1);
  const direction = deviationPct > 0 ? "weaker" : "stronger";
  const pppDirection = pppChangePct > 0 ? "depreciated" : "appreciated";

  let html = `
    <h3>${pairLabel} as of ${formatDate(dat.date[lastIdx])}</h3>
    <p><strong>Latest close:</strong> ${fmt(live)}</p>
    <p><strong>Fair-value trend estimate:</strong> ${fmt(trend)}</p>
    <p><strong>Deviation from fair value:</strong> ${deviationPct >= 0 ? "+" : ""}${fmt(deviationPct, 1)}%
       &mdash; ${baseCode} looks ${direction} than the model's fair-value estimate.</p>
    <p><strong>Since the PPP start date:</strong> the model's fair-value trend has ${pppDirection}
       by ${fmt(Math.abs(pppChangePct), 1)}% versus ${baseCode}.</p>
    <p><strong>How confident is this?</strong> picking a different historical anchor date would
       typically have put today's fair value estimate somewhere between ${fmt(dat.fairValueLower[lastIdx])}
       and ${fmt(dat.fairValueUpper[lastIdx])} (the shaded band on the chart) &mdash; treat the trend
       line as the centre of a range, not a precise number.</p>
  `;

  if (showRealRateBand) {
    const realLive = live * (dat.realRate[lastIdx] / dat.rate[lastIdx]);
    const within = realLive >= dat.realRateLower && realLive <= dat.realRateUpper;
    html += `
      <p><strong>Real-rate (REER-style) check:</strong> over this window, the inflation-adjusted rate
         has typically sat between ${fmt(dat.realRateLower)} and ${fmt(dat.realRateUpper)}; today's real
         rate (${fmt(realLive)}) is ${within ? "inside" : "outside"} that historical range.</p>
    `;
  }

  if (uipWindowed && uipWindowed.uipTrend.length > 0) {
    const uipLastIdx = uipWindowed.uipTrend.length - 1;
    const uipTrendLive = uipWindowed.uipTrend[uipLastIdx];
    const uipDeviationPct = 100 * (live / uipTrendLive - 1);
    const uipDirection = uipDeviationPct > 0 ? "weaker" : "stronger";
    html += `
      <p><strong>UIP (interest-rate-implied) check:</strong> the interest-rate-differential trend puts
         today's implied rate at ${fmt(uipTrendLive)} &mdash; ${baseCode} looks ${uipDirection} than
         this independent, inflation-free signal suggests, a useful cross-check against the PPP estimate
         above.</p>
    `;
  }

  el.summary.innerHTML = html;
}

/** Trim a plain {dates, values} series (e.g. the commodity index) to
 * [fromIso, toIso] for display -- the same display-only windowing idea
 * as windowData() above, just for a series that isn't shaped like
 * fairValueAnalysis()'s output. */
function windowSimpleSeries(series, fromIso, toIso) {
  const dates = [];
  const values = [];
  for (let i = 0; i < series.dates.length; i++) {
    if (series.dates[i] >= fromIso && series.dates[i] <= toIso) {
      dates.push(series.dates[i]);
      values.push(series.values[i]);
    }
  }
  return { dates, values };
}

function recompute() {
  if (!DATA) return;
  clearError();

  const baseCcy = el.baseCurrency.value;
  const quoteCcy = el.quoteCurrency.value;

  updateUipAvailability();

  if (baseCcy === quoteCcy) {
    showError("Pick two different currencies to compare.");
    Plotly.purge("fairValuePlot");
    Plotly.purge("anomalyPlot");
    el.summary.innerHTML = "";
    el.fairValueSubtitle.textContent = "";
    el.anomalySubtitle.textContent = "";
    return;
  }

  const pairLabel = `${baseCcy}/${quoteCcy}`;
  const showRealRateBand = el.showRealRateBand.checked;
  const showUncertaintyBand = el.showUncertaintyBand.checked;

  try {
    const merged = buildPairSeries(baseCcy, quoteCcy, DATA);
    const result = fairValueAnalysis(merged, el.startDate.value);
    const windowed = windowData(result.data, el.windowFrom.value, el.windowTo.value);

    if (windowed.date.length === 0) {
      showError("No data in the selected chart window.");
      return;
    }

    const baseName = DATA.currencies[baseCcy].name;
    const quoteName = DATA.currencies[quoteCcy].name;
    const subtitle = `${baseName} vs. ${quoteName} inflation, PPP start date: ${formatDate(result.startDate)}`;
    el.fairValueSubtitle.textContent = subtitle;
    el.anomalySubtitle.textContent = `${pairLabel} deviation from its own fair-value trend`;

    // UIP is computed and rendered independently of the PPP calculation
    // above: a UIP-specific failure (e.g. too few interest-rate
    // observations after this particular start date) should never block
    // showing the PPP chart, so its own try/catch just silently drops
    // the UIP trace rather than raising the shared error banner.
    let uipWindowed = null;
    if (el.showUip.checked && !el.showUip.disabled) {
      try {
        const uipMerged = buildInterestRateSeries(baseCcy, quoteCcy, DATA);
        const uipResult = uipTrendAnalysis(uipMerged, el.startDate.value);
        const w = windowData(uipResult.data, el.windowFrom.value, el.windowTo.value);
        if (w.date.length > 0) uipWindowed = w;
      } catch {
        uipWindowed = null;
      }
    }

    let commodityWindowed = null;
    if (el.showCommodity.checked && DATA.commodity) {
      const w = windowSimpleSeries(DATA.commodity, el.windowFrom.value, el.windowTo.value);
      if (w.dates.length > 0) commodityWindowed = w;
    }

    renderFairValuePlot(windowed, pairLabel, showRealRateBand, showUncertaintyBand, uipWindowed);
    renderAnomalyPlot(windowed, pairLabel, commodityWindowed);
    renderSummary(windowed, pairLabel, baseCcy, result.pppChangePct, showRealRateBand, uipWindowed);
  } catch (err) {
    showError(err.message || String(err));
    Plotly.purge("fairValuePlot");
    Plotly.purge("anomalyPlot");
    el.summary.innerHTML = "";
  }
}

function attachListeners() {
  for (const input of [
    el.baseCurrency,
    el.quoteCurrency,
    el.startDate,
    el.windowFrom,
    el.windowTo,
    el.showRealRateBand,
    el.showUncertaintyBand,
    el.showUip,
    el.showCommodity,
  ]) {
    input.addEventListener("change", recompute);
  }
}

async function init() {
  try {
    const res = await fetch("data/data.json");
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    DATA = await res.json();
  } catch (err) {
    showError(
      "Could not load data/data.json. If you're running this locally, serve the folder with a " +
        "local web server (fetch() of a local file won't work from a plain file:// URL) -- see README.md."
    );
    return;
  }

  populateCurrencyChoices();
  setDefaultWindow();
  updateUipAvailability();

  if (!DATA.commodity) {
    el.showCommodity.disabled = true;
    el.showCommodity.title = "Unavailable: this run's commodity-index fetch failed or hasn't run yet.";
  }

  const generated = new Date(DATA.generatedAt);
  el.dataFreshness.textContent = `Data snapshot generated ${generated.toLocaleString()}.`;

  attachListeners();
  recompute();
}

init();
