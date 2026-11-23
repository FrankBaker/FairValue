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

import { buildPairSeries, fairValueAnalysis } from "./lib/fairvalue.js";

const COLOURS = {
  actual: "#d62728",
  fairValue: "#1f77b4",
  latest: "#2ca02c",
  real: "#9467bd",
};

let DATA = null;

const el = {
  baseCurrency: document.getElementById("baseCurrency"),
  quoteCurrency: document.getElementById("quoteCurrency"),
  startDate: document.getElementById("startDate"),
  windowFrom: document.getElementById("windowFrom"),
  windowTo: document.getElementById("windowTo"),
  showRealRateBand: document.getElementById("showRealRateBand"),
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

function renderFairValuePlot(dat, pairLabel, showRealRateBand) {
  const traces = [
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
    },
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
    },
  ];

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

function renderAnomalyPlot(dat, pairLabel) {
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
    showlegend: false,
    margin: { t: 20, b: 40, l: 60, r: 30 },
    font: { size: 13 },
  };

  Plotly.newPlot("anomalyPlot", traces, layout, { responsive: true, displaylogo: false });
}

function renderSummary(dat, pairLabel, baseCode, pppChangePct, showRealRateBand) {
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

  el.summary.innerHTML = html;
}

function recompute() {
  if (!DATA) return;
  clearError();

  const baseCcy = el.baseCurrency.value;
  const quoteCcy = el.quoteCurrency.value;

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

    renderFairValuePlot(windowed, pairLabel, showRealRateBand);
    renderAnomalyPlot(windowed, pairLabel);
    renderSummary(windowed, pairLabel, baseCcy, result.pppChangePct, showRealRateBand);
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

  const generated = new Date(DATA.generatedAt);
  el.dataFreshness.textContent = `Data snapshot generated ${generated.toLocaleString()}.`;

  attachListeners();
  recompute();
}

init();
