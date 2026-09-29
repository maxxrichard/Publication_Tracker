(() => {
  "use strict";

  const DATA_URL = "data/publications.json";
  const DAY_MS = 86_400_000;
  const statusOrder = ["Accepted", "Submitted", "In Review", "Revision", "Planned", "On Hold", "Withdrawn", "Rejected"];
  const priorityOrder = ["High", "Medium", "Low", "Archive"];
  const decided = ["Accepted", "Rejected", "Withdrawn"];
  const inReview = ["Submitted", "In Review", "Revision"];
  const statusVar = {
    Accepted: "--green",
    Submitted: "--blue",
    "In Review": "--purple",
    Revision: "--yellow",
    Planned: "--orange",
    "On Hold": "--grey",
    Withdrawn: "--grey",
    Rejected: "--red",
  };
  const priorityVar = { High: "--red", Medium: "--orange", Low: "--blue", Archive: "--grey" };
  const classicPalette = ["#7eb26d", "#eab839", "#6ed0e0", "#ef843c", "#e24d42", "#1f78c1", "#ba43a9", "#705da0", "#508642", "#cca300"];
  const variables = [
    { key: "cycle", label: "cycle", field: "publicationYear" },
    { key: "status", label: "status", field: "status" },
    { key: "type", label: "type", field: "type" },
    { key: "venue", label: "venue", field: "venue" },
  ];
  const rangePresets = [
    { key: "all", label: "All time" },
    { key: "next3", label: "Next 3 months", from: 0, to: 3 },
    { key: "next6", label: "Next 6 months", from: 0, to: 6 },
    { key: "next12", label: "Next 12 months", from: 0, to: 12 },
    { key: "last6", label: "Last 6 months", from: -6, to: 0 },
    { key: "last12", label: "Last 12 months", from: -12, to: 0 },
    { key: "window", label: "Last 12 months to next 6 months", from: -12, to: 6 },
    { key: "year", label: "This year" },
  ];
  const intervals = [["Off", 0], ["30s", 30_000], ["1m", 60_000], ["5m", 300_000], ["15m", 900_000]];

  const state = {
    all: [],
    view: [],
    lastUpdated: "",
    vars: { cycle: "All", status: "All", type: "All", venue: "All" },
    range: { key: "all", from: 0, to: 0 },
    sort: { key: "deadline", dir: 1 },
    charts: {},
    timer: null,
    menuPanel: null,
    hoverPanel: null,
  };

  const $ = (id) => document.getElementById(id);

  /* ---------- helpers ---------- */

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
  }

  const cssVar = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  const statusColor = (status) => cssVar(statusVar[status] || "--grey");

  function alpha(hex, a) {
    const n = parseInt(hex.replace("#", ""), 16);
    return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
  }

  function normalizeRecord(record, index) {
    return {
      id: index,
      publicationYear: Number(record["Publication Year"]) || null,
      venue: String(record.Venue || "").trim(),
      type: String(record.Type || "").trim(),
      deadline: String(record.Deadline || "").trim(),
      paperTitle: String(record["Paper Title"] || "Untitled").trim(),
      status: String(record.Status || "Unknown").trim(),
      targetMonth: String(record["Target Month"] || "").trim(),
      priority: String(record.Priority || "").trim(),
      owner: String(record.Owner || "").trim(),
      nextStep: String(record["Next Step"] || "").trim(),
      paperUrl: String(record["Paper URL"] || "").trim(),
      notes: String(record.Notes || "").trim(),
      lastUpdated: String(record["Last Updated"] || "").trim(),
      raw: record,
    };
  }

  function parseDate(value) {
    if (!value) return null;
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  function today() {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    return date;
  }

  function addMonths(date, months) {
    return new Date(date.getFullYear(), date.getMonth() + months, date.getDate());
  }

  function formatDate(value, options = { month: "short", day: "numeric", year: "numeric" }) {
    const date = value instanceof Date ? value : parseDate(value);
    return date ? new Intl.DateTimeFormat("en-US", options).format(date) : "—";
  }

  function shortMonth(ms) {
    const d = new Date(ms);
    return `${d.toLocaleString("en-US", { month: "short" })} '${String(d.getFullYear()).slice(2)}`;
  }

  function daysFromToday(value) {
    const date = parseDate(value);
    return date ? Math.round((date - today()) / DAY_MS) : null;
  }

  const isUpcoming = (item) => !decided.includes(item.status) && !inReview.includes(item.status) && daysFromToday(item.deadline) >= 0;

  function dayThresholdColor(days) {
    if (days < 30) return cssVar("--red");
    if (days < 60) return cssVar("--orange");
    return cssVar("--green");
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  function countBy(items, key) {
    return items.reduce((acc, item) => {
      const value = item[key] || "Other";
      acc[value] = (acc[value] || 0) + 1;
      return acc;
    }, {});
  }

  const byDeadline = (a, b) => (parseDate(a.deadline)?.getTime() ?? Infinity) - (parseDate(b.deadline)?.getTime() ?? Infinity);

  /* ---------- time range ---------- */

  function resolveRange(key, from, to) {
    const now = today();
    const preset = rangePresets.find((p) => p.key === key);
    if (key === "all") {
      const times = state.all.map((item) => parseDate(item.deadline)?.getTime()).filter(Boolean);
      const min = times.length ? Math.min(...times, now.getTime()) : addMonths(now, -6).getTime();
      const max = times.length ? Math.max(...times, now.getTime()) : addMonths(now, 6).getTime();
      return { key, from: min - 30 * DAY_MS, to: max + 30 * DAY_MS };
    }
    if (key === "year") return { key, from: new Date(now.getFullYear(), 0, 1).getTime(), to: new Date(now.getFullYear(), 11, 31).getTime() };
    if (preset) return { key, from: addMonths(now, preset.from).getTime(), to: addMonths(now, preset.to).getTime() };
    return { key: "custom", from, to };
  }

  function rangeLabel() {
    const preset = rangePresets.find((p) => p.key === state.range.key);
    if (preset) return preset.label;
    return `${formatDate(new Date(state.range.from))} to ${formatDate(new Date(state.range.to))}`;
  }

  function setRange(key, from, to) {
    state.range = resolveRange(key, from, to);
    $("rangeLabel").textContent = rangeLabel();
    render();
  }

  function shiftRange(direction) {
    const span = state.range.to - state.range.from;
    setRange("custom", state.range.from + span * direction, state.range.to + span * direction);
  }

  function zoomOut() {
    const span = state.range.to - state.range.from;
    setRange("custom", state.range.from - span / 2, state.range.to + span / 2);
  }

  /* ---------- url state ---------- */

  function readUrl() {
    const params = new URLSearchParams(location.search);
    variables.forEach((v) => { if (params.has(`var-${v.key}`)) state.vars[v.key] = params.get(`var-${v.key}`); });
    const from = Number(params.get("from"));
    const to = Number(params.get("to"));
    if (params.get("range")) state.range.key = params.get("range");
    else if (from && to) state.range = { key: "custom", from, to };
  }

  function writeUrl() {
    const params = new URLSearchParams();
    variables.forEach((v) => { if (state.vars[v.key] !== "All") params.set(`var-${v.key}`, state.vars[v.key]); });
    if (state.range.key === "custom") {
      params.set("from", String(Math.round(state.range.from)));
      params.set("to", String(Math.round(state.range.to)));
    } else if (state.range.key !== "all") {
      params.set("range", state.range.key);
    }
    const query = params.toString();
    history.replaceState(null, "", query ? `?${query}` : location.pathname);
  }

  /* ---------- data ---------- */

  async function loadData() {
    $("dataError").hidden = true;
    const button = $("refreshBtn");
    button.classList.add("spinning");
    const started = performance.now();
    try {
      const response = await fetch(DATA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.publications)) throw new Error("Invalid publication data");
      state.all = payload.publications.map(normalizeRecord);
      state.lastUpdated = payload.lastUpdated || "";
      $("lastUpdated").textContent = formatDate(state.lastUpdated, { month: "short", day: "numeric", year: "numeric" });
      state.range = resolveRange(state.range.key, state.range.from, state.range.to);
      $("rangeLabel").textContent = rangeLabel();
      renderVariables();
      render();
    } catch (error) {
      console.error(error);
      $("dataError").hidden = false;
    } finally {
      setTimeout(() => button.classList.remove("spinning"), Math.max(0, 500 - (performance.now() - started)));
    }
  }

  function applyView() {
    const { from, to, key } = state.range;
    state.view = state.all.filter((item) => {
      for (const v of variables) {
        if (state.vars[v.key] !== "All" && String(item[v.field]) !== state.vars[v.key]) return false;
      }
      if (key === "all") return true;
      const d = parseDate(item.deadline);
      return d && d.getTime() >= from && d.getTime() <= to;
    });
  }

  function render() {
    applyView();
    writeUrl();
    renderRowTitles();
    renderTable();
    renderCharts();
    renderPriority();
    renderStats();
    renderGauges();
    renderLed();
    renderTiles();
    renderSteps();
    renderTimeline();
  }

  /* ---------- variables ---------- */

  function optionsFor(v) {
    const values = [...new Set(state.all.map((item) => item[v.field]).filter(Boolean))];
    if (v.key === "status") values.sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b));
    else if (v.key === "cycle") values.sort((a, b) => b - a);
    else values.sort();
    return ["All", ...values.map(String)];
  }

  function renderVariables() {
    $("vars").innerHTML = variables.map((v) => `
      <div class="var dropdown">
        <span class="var-label">${v.label}</span>
        <button class="var-value" type="button" data-var="${v.key}" aria-haspopup="listbox">
          <span>${escapeHtml(state.vars[v.key])}</span><svg class="caret"><use href="#i-chevron-down"/></svg>
        </button>
        <div class="menu" data-var-menu="${v.key}" hidden></div>
      </div>`).join("");
  }

  function setVar(key, value) {
    state.vars[key] = value;
    const button = document.querySelector(`[data-var="${key}"] span`);
    if (button) button.textContent = value;
    render();
  }

  function openMenu(menu, html) {
    closeMenus(menu);
    menu.innerHTML = html;
    menu.hidden = !menu.hidden;
  }

  function closeMenus(except) {
    document.querySelectorAll(".menu").forEach((menu) => { if (menu !== except) menu.hidden = true; });
    document.querySelectorAll(".menu-btn[aria-expanded='true']").forEach((b) => b.setAttribute("aria-expanded", "false"));
  }

  /* ---------- row titles ---------- */

  function renderRowTitles() {
    const { cycle, status, venue } = state.vars;
    $("rowTitle1").innerHTML = `Pipeline overview. Selected cycle: 【${escapeHtml(cycle)}】 Status: ${escapeHtml(status)} <span class="row-count">(${state.view.length} of ${state.all.length})</span>`;
    $("rowTitle2").textContent = `Details of pipeline 【${cycle === "All" ? "all cycles" : cycle}: ${venue === "All" ? "all venues" : venue}】`;
  }

  /* ---------- table ---------- */

  const tableColumns = [
    { key: "publicationYear", label: "Cycle", num: true, cell: (i) => escapeHtml(i.publicationYear || "—") },
    { key: "paperTitle", label: "Paper", cell: (i) => `<a href="#" data-open="${i.id}">${escapeHtml(i.paperTitle)}</a>` },
    { key: "venue", label: "Venue", cell: (i) => escapeHtml(i.venue || "—") },
    { key: "type", label: "Type", cell: (i) => escapeHtml(i.type || "—") },
    { key: "deadline", label: "Deadline", cell: (i) => escapeHtml(formatDate(i.deadline)) },
    { key: "status", label: "Status", cell: (i) => `<span class="status-text" style="color:${statusColor(i.status)}">${escapeHtml(i.status)}</span>` },
    { key: "priority", label: "Priority", cell: (i) => escapeHtml(i.priority || "—") },
    { key: "targetMonth", label: "Target", cell: (i) => escapeHtml(i.targetMonth || "—") },
    { key: "nextStep", label: "Next step", cell: (i) => escapeHtml(i.nextStep || "—") },
    { key: "days", label: "Time to deadline", num: true, cell: null },
  ];

  function sortValue(item, key) {
    if (key === "deadline" || key === "days") return parseDate(item.deadline)?.getTime() ?? Infinity;
    if (key === "status") return statusOrder.indexOf(item.status);
    if (key === "priority") return priorityOrder.indexOf(item.priority);
    if (key === "publicationYear") return item.publicationYear || 0;
    return String(item[key] || "").toLowerCase();
  }

  function daysCell(item) {
    const days = daysFromToday(item.deadline);
    if (days === null) return `<td class="num muted">—</td>`;
    if (isUpcoming(item)) {
      const bg = days < 30 ? cssVar("--cell-red") : days < 60 ? cssVar("--cell-orange") : cssVar("--cell-green");
      return `<td class="num cell-bg" style="background:${bg}">${days} days</td>`;
    }
    if (inReview.includes(item.status)) return `<td class="num cell-bg" style="background:${cssVar("--cell-blue")}">in review · ${Math.abs(days)} d</td>`;
    return `<td class="num muted">${days < 0 ? `${Math.abs(days)} days ago` : `${days} days`}</td>`;
  }

  function renderTable() {
    const { key, dir } = state.sort;
    const rows = [...state.view].sort((a, b) => {
      const l = sortValue(a, key);
      const r = sortValue(b, key);
      return (l < r ? -1 : l > r ? 1 : 0) * dir;
    });
    $("pubTable").tHead.innerHTML = `<tr>${tableColumns.map((c) => `
      <th class="${c.num ? "num" : ""}" data-sort="${c.key}">${c.label}${c.key === key ? `<span class="arrow">${dir === 1 ? "↑" : "↓"}</span>` : ""}</th>`).join("")}</tr>`;
    $("pubTable").tBodies[0].innerHTML = rows.length ? rows.map((item) => `
      <tr data-open="${item.id}">${tableColumns.map((c) => (c.cell ? `<td class="${c.num ? "num" : ""}">${c.cell(item)}</td>` : daysCell(item))).join("")}</tr>`).join("")
      : `<tr><td colspan="${tableColumns.length}" class="muted" style="text-align:center;height:80px">No data</td></tr>`;
  }

  /* ---------- charts ---------- */

  function baseOptions(extra = {}) {
    const text = cssVar("--text-2");
    const grid = cssVar("--grid");
    return {
      animation: false,
      maintainAspectRatio: false,
      interaction: { mode: "index", intersect: false },
      plugins: {
        legend: {
          position: "bottom",
          align: "start",
          labels: { color: cssVar("--text"), usePointStyle: true, boxWidth: 14, boxHeight: 4, padding: 10, font: { size: 11 } },
        },
        tooltip: {
          backgroundColor: cssVar("--menu"),
          borderColor: cssVar("--border"),
          borderWidth: 1,
          titleColor: cssVar("--text"),
          bodyColor: cssVar("--text"),
          cornerRadius: 2,
          padding: 8,
          boxPadding: 4,
        },
      },
      scales: {
        x: { ticks: { color: text, font: { size: 11 }, maxRotation: 0 }, grid: { color: grid }, border: { color: grid } },
        y: { ticks: { color: text, font: { size: 11 }, precision: 0 }, grid: { color: grid }, border: { display: false }, beginAtZero: true },
      },
      ...extra,
    };
  }

  function makeChart(id, config) {
    state.charts[id]?.destroy();
    const canvas = $(id);
    const body = canvas.parentElement;
    body.querySelector(".no-data")?.remove();
    const empty = !state.view.length;
    canvas.hidden = empty;
    if (empty) {
      body.insertAdjacentHTML("beforeend", `<div class="no-data">No data</div>`);
      return;
    }
    state.charts[id] = new Chart(canvas, config);
  }

  function statusesInView() {
    return statusOrder.filter((s) => state.view.some((i) => i.status === s));
  }

  function renderCharts() {
    if (typeof Chart === "undefined") return;
    const { from, to } = state.range;
    const statuses = statusesInView();

    // Cumulative deadlines reached, stepped per status.
    makeChart("cumChart", {
      type: "line",
      data: {
        datasets: statuses.map((status) => {
          const times = state.view.filter((i) => i.status === status).map((i) => parseDate(i.deadline)?.getTime()).filter(Boolean).sort((a, b) => a - b);
          const points = [{ x: from, y: 0 }];
          times.forEach((t, idx) => points.push({ x: t, y: idx + 1 }));
          points.push({ x: to, y: times.length });
          const color = statusColor(status);
          return {
            label: status,
            data: points,
            borderColor: color,
            backgroundColor: alpha(color, 0.1),
            fill: "origin",
            stepped: "after",
            borderWidth: 1.5,
            pointRadius: 0,
            pointStyle: "line",
          };
        }),
      },
      options: baseOptions({
        scales: {
          ...baseOptions().scales,
          x: { ...baseOptions().scales.x, type: "linear", min: from, max: to, ticks: { ...baseOptions().scales.x.ticks, maxTicksLimit: 5, callback: (v) => shortMonth(v) } },
        },
        plugins: {
          ...baseOptions().plugins,
          tooltip: { ...baseOptions().plugins.tooltip, callbacks: { title: (ctx) => formatDate(new Date(ctx[0].parsed.x)) } },
        },
      }),
    });

    // Papers per cycle, stacked by status.
    const cycles = [...new Set(state.view.map((i) => i.publicationYear).filter(Boolean))].sort();
    makeChart("cycleChart", {
      type: "bar",
      data: {
        labels: cycles.map(String),
        datasets: statuses.map((status) => ({
          label: status,
          data: cycles.map((c) => state.view.filter((i) => i.publicationYear === c && i.status === status).length),
          backgroundColor: alpha(statusColor(status), 0.8),
          borderColor: statusColor(status),
          borderWidth: 1,
          pointStyle: "rect",
          maxBarThickness: 48,
        })),
      },
      options: baseOptions({
        onClick: (_, elements) => { if (elements[0]) setVar("cycle", String(cycles[elements[0].index])); },
        onHover: (event, elements) => { event.native.target.style.cursor = elements.length ? "pointer" : "default"; },
        scales: { x: { ...baseOptions().scales.x, stacked: true, grid: { display: false } }, y: { ...baseOptions().scales.y, stacked: true } },
      }),
    });

    // Deadlines per month, stacked by status.
    const months = [];
    const cursor = new Date(new Date(from).getFullYear(), new Date(from).getMonth(), 1);
    while (cursor.getTime() <= to && months.length < 48) {
      months.push(new Date(cursor));
      cursor.setMonth(cursor.getMonth() + 1);
    }
    const monthKey = (d) => `${d.getFullYear()}-${d.getMonth()}`;
    makeChart("monthChart", {
      type: "bar",
      data: {
        labels: months.map((m) => shortMonth(m.getTime())),
        datasets: statuses.map((status) => ({
          label: status,
          data: months.map((m) => state.view.filter((i) => i.status === status && parseDate(i.deadline) && monthKey(parseDate(i.deadline)) === monthKey(m)).length),
          backgroundColor: alpha(statusColor(status), 0.8),
          borderColor: statusColor(status),
          borderWidth: 1,
          pointStyle: "rect",
        })),
      },
      options: baseOptions({
        onClick: (_, elements) => {
          if (!elements[0]) return;
          const m = months[elements[0].index];
          setRange("custom", m.getTime(), new Date(m.getFullYear(), m.getMonth() + 1, 0).getTime());
        },
        onHover: (event, elements) => { event.native.target.style.cursor = elements.length ? "pointer" : "default"; },
        scales: {
          x: { ...baseOptions().scales.x, stacked: true, grid: { display: false }, ticks: { ...baseOptions().scales.x.ticks, maxTicksLimit: 6, autoSkip: true } },
          y: { ...baseOptions().scales.y, stacked: true },
        },
      }),
    });

    // Venue distribution.
    const venueCounts = countBy(state.view, "venue");
    const venues = Object.keys(venueCounts).sort((a, b) => venueCounts[b] - venueCounts[a]);
    makeChart("venueChart", {
      type: "doughnut",
      data: {
        labels: venues,
        datasets: [{
          data: venues.map((v) => venueCounts[v]),
          backgroundColor: venues.map((_, i) => classicPalette[i % classicPalette.length]),
          borderColor: cssVar("--panel"),
          borderWidth: 2,
        }],
      },
      options: {
        ...baseOptions(),
        interaction: { mode: "nearest", intersect: true },
        cutout: "55%",
        scales: {},
        onClick: (_, elements) => { if (elements[0]) setVar("venue", venues[elements[0].index]); },
        onHover: (event, elements) => { event.native.target.style.cursor = elements.length ? "pointer" : "default"; },
        plugins: {
          ...baseOptions().plugins,
          legend: { position: "right", labels: { ...baseOptions().plugins.legend.labels, pointStyle: "rect", boxWidth: 10, boxHeight: 10 } },
        },
      },
    });
  }

  /* ---------- bar gauge ---------- */

  function renderPriority() {
    const counts = countBy(state.view, "priority");
    const rows = priorityOrder.filter((p) => counts[p]).concat(Object.keys(counts).filter((p) => !priorityOrder.includes(p)));
    if (!rows.length) {
      $("priorityGauge").innerHTML = `<div class="no-data">No data</div>`;
      return;
    }
    const max = Math.max(...rows.map((p) => counts[p]));
    $("priorityGauge").innerHTML = rows.map((p) => {
      const color = cssVar(priorityVar[p] || "--grey");
      return `
        <div class="bg-row" data-tip-title="${escapeHtml(p)} priority" data-tip-body="${counts[p]} paper${counts[p] === 1 ? "" : "s"}">
          <span class="label">${escapeHtml(p)}</span>
          <span class="bg-track"><span class="bg-fill" style="display:block;width:${(counts[p] / max) * 100}%;background:linear-gradient(90deg, ${alpha(color, 0.35)}, ${color})"></span></span>
          <span class="val" style="color:${color}">${counts[p]}</span>
        </div>`;
    }).join("");
  }

  /* ---------- stats & gauges ---------- */

  function stat(el, value, color, sub) {
    el.innerHTML = `<div class="value" style="color:${color}">${escapeHtml(value)}</div><div class="sub">${escapeHtml(sub)}</div>`;
  }

  function renderStats() {
    const next = state.view.filter(isUpcoming).sort(byDeadline)[0];
    if (next) {
      const days = daysFromToday(next.deadline);
      stat($("statNext"), `${days} days`, dayThresholdColor(days), `${next.venue} · ${next.paperTitle}`);
    } else {
      stat($("statNext"), "—", cssVar("--text-3"), "No open deadlines");
    }
    stat($("statCount"), String(state.view.length), cssVar("--blue"), `of ${state.all.length} total`);
    const synced = parseDate(state.lastUpdated);
    if (synced) {
      const ago = Math.max(0, Math.round((today() - synced) / DAY_MS));
      const color = ago <= 7 ? cssVar("--green") : ago <= 30 ? cssVar("--orange") : cssVar("--red");
      stat($("statSync"), ago === 0 ? "today" : `${ago} day${ago === 1 ? "" : "s"}`, color, formatDate(synced));
    } else {
      stat($("statSync"), "—", cssVar("--text-3"), "unknown");
    }
  }

  function arcPoint(cx, cy, r, deg) {
    const rad = (deg * Math.PI) / 180;
    return [cx + r * Math.cos(rad), cy + r * Math.sin(rad)];
  }

  function arcPath(cx, cy, r, a0, a1) {
    const [x0, y0] = arcPoint(cx, cy, r, a0);
    const [x1, y1] = arcPoint(cx, cy, r, a1);
    return `M${x0.toFixed(2)} ${y0.toFixed(2)} A${r} ${r} 0 ${a1 - a0 > 180 ? 1 : 0} 1 ${x1.toFixed(2)} ${y1.toFixed(2)}`;
  }

  function gauge(el, ratio, thresholds) {
    const start = 150;
    const sweep = 240;
    const cx = 100;
    const cy = 96;
    const color = ratio === null ? cssVar("--text-3") : thresholds.find((t) => ratio <= t.to).color;
    let bands = "";
    let prev = 0;
    thresholds.forEach((t) => {
      bands += `<path d="${arcPath(cx, cy, 86, start + prev * sweep, start + Math.min(t.to, 1) * sweep - 0.5)}" stroke="${t.color}" stroke-width="4" fill="none" stroke-linecap="butt"/>`;
      prev = t.to;
    });
    const value = ratio === null ? "" : `<path d="${arcPath(cx, cy, 72, start, start + Math.max(0.005, ratio) * sweep)}" stroke="${color}" stroke-width="16" fill="none" stroke-linecap="butt"/>`;
    el.innerHTML = `
      <svg viewBox="0 0 200 150" role="img" aria-label="${ratio === null ? "No data" : `${Math.round(ratio * 100)} percent`}">
        ${bands}
        <path d="${arcPath(cx, cy, 72, start, start + sweep)}" stroke="${cssVar("--grid")}" stroke-width="16" fill="none" stroke-linecap="butt"/>
        ${value}
        <text x="${cx}" y="${cy + 10}" text-anchor="middle" font-size="30" font-weight="500" fill="${color}">${ratio === null ? "N/A" : `${Math.round(ratio * 100)}%`}</text>
      </svg>`;
  }

  function renderGauges() {
    const counts = countBy(state.view, "status");
    const outcomes = (counts.Accepted || 0) + (counts.Rejected || 0);
    gauge($("gaugeAccept"), outcomes ? (counts.Accepted || 0) / outcomes : null, [
      { to: 0.3, color: cssVar("--red") },
      { to: 0.6, color: cssVar("--orange") },
      { to: 1, color: cssVar("--green") },
    ]);
    const closed = decided.reduce((sum, s) => sum + (counts[s] || 0), 0);
    gauge($("gaugeDecided"), state.view.length ? closed / state.view.length : null, [
      { to: 0.34, color: cssVar("--orange") },
      { to: 1, color: cssVar("--blue") },
    ]);
  }

  /* ---------- LED gauge ---------- */

  function renderLed() {
    const open = state.view.filter(isUpcoming).sort(byDeadline).slice(0, 7);
    if (!open.length) {
      $("ledGauge").innerHTML = `<div class="no-data">No open deadlines</div>`;
      return;
    }
    const cellColors = Array.from({ length: 20 }, (_, i) => {
      const f = (i + 1) / 20;
      return f <= 0.5 ? cssVar("--green") : f <= 0.75 ? cssVar("--yellow") : f <= 0.9 ? cssVar("--orange") : cssVar("--red");
    });
    $("ledGauge").innerHTML = open.map((item) => {
      const days = daysFromToday(item.deadline);
      const urgency = Math.min(1, Math.max(0.05, 1 - days / 180));
      const lit = Math.ceil(urgency * 20);
      return `
        <div class="led-row" data-open="${item.id}" data-tip-title="${escapeHtml(item.paperTitle)}" data-tip-body="${escapeHtml(`${item.venue} · due ${formatDate(item.deadline)}`)}">
          <span class="label">${escapeHtml(item.paperTitle)}:</span>
          <span class="led-cells">${cellColors.map((c, i) => `<i style="background:${i < lit ? c : alpha(c, 0.16)}"></i>`).join("")}</span>
          <span class="val" style="color:${dayThresholdColor(days)}">${days} d</span>
        </div>`;
    }).join("");
  }

  /* ---------- status tiles ---------- */

  function renderTiles() {
    const counts = countBy(state.view, "status");
    const shown = ["Accepted", "Submitted", "Planned", "Rejected"];
    statusOrder.forEach((s) => { if (counts[s] && !shown.includes(s)) shown.push(s); });
    shown.sort((a, b) => statusOrder.indexOf(a) - statusOrder.indexOf(b));
    $("statusTiles").style.gridTemplateRows = `repeat(${Math.ceil(shown.length / 2)}, 1fr)`;
    $("statusTiles").innerHTML = shown.map((s) => `
      <button type="button" class="tile ${counts[s] ? "" : "dim"}" data-status="${escapeHtml(s)}" style="background-color:${statusColor(s)}">
        <span>${escapeHtml(s)}</span><b>${counts[s] || 0}</b>
      </button>`).join("");
  }

  /* ---------- next steps ---------- */

  function renderSteps() {
    const rows = state.view.filter((i) => i.nextStep && i.status !== "Accepted").sort(byDeadline);
    $("stepsTable").tHead.innerHTML = `<tr><th>Paper</th><th>Next step</th><th class="num">Due</th><th>Owner</th></tr>`;
    $("stepsTable").tBodies[0].innerHTML = rows.length ? rows.map((item) => {
      const days = daysFromToday(item.deadline);
      const due = isUpcoming(item)
        ? `<span style="color:${dayThresholdColor(days)}">${days} d</span>`
        : `<span class="muted">${escapeHtml(item.status.toLowerCase())}</span>`;
      return `<tr data-open="${item.id}"><td><a href="#" data-open="${item.id}">${escapeHtml(item.paperTitle)}</a></td><td>${escapeHtml(item.nextStep)}</td><td class="num">${due}</td><td class="muted">${escapeHtml(item.owner || "unassigned")}</td></tr>`;
    }).join("") : `<tr><td colspan="4" class="muted" style="text-align:center;height:80px">No data</td></tr>`;
  }

  /* ---------- timeline ---------- */

  function renderTimeline() {
    const el = $("timeline");
    const items = state.view.filter((i) => parseDate(i.deadline)).sort(byDeadline);
    if (!items.length) {
      el.style.height = "80px";
      el.innerHTML = `<div class="no-data">No data</div>`;
      return;
    }
    el.style.height = "";
    const width = Math.max(320, el.clientWidth);
    const narrow = width < 560;
    const left = narrow ? 96 : 170;
    const right = narrow ? 16 : 110;
    const top = 26;
    const rowH = 30;
    const height = top + items.length * rowH + 6;
    const { from, to } = state.range;
    const x = (t) => left + ((t - from) / (to - from)) * (width - left - right);
    const now = today().getTime();
    const grid = cssVar("--grid");

    const monthStarts = [];
    const cursor = new Date(new Date(from).getFullYear(), new Date(from).getMonth() + 1, 1);
    while (cursor.getTime() <= to) { monthStarts.push(cursor.getTime()); cursor.setMonth(cursor.getMonth() + 1); }
    const step = Math.max(1, Math.ceil(monthStarts.length / Math.max(2, Math.floor((width - left - right) / 80))));
    const ticks = monthStarts.filter((_, i) => i % step === 0);

    let svg = ticks.map((t) => `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${height}" stroke="${grid}"/><text x="${x(t)}" y="14" text-anchor="middle">${shortMonth(t)}</text>`).join("");

    items.forEach((item, idx) => {
      const y = top + idx * rowH + rowH / 2;
      const t = parseDate(item.deadline).getTime();
      const color = statusColor(item.status);
      const days = daysFromToday(item.deadline);
      let band = "";
      if (isUpcoming(item) && now >= from) {
        band = `<rect x="${x(Math.max(now, from))}" y="${y - 5}" width="${Math.max(0, x(t) - x(Math.max(now, from)))}" height="10" fill="${alpha(color, 0.3)}"/>`;
      } else if (inReview.includes(item.status) && now > t) {
        band = `<line x1="${x(t)}" x2="${x(Math.min(now, to))}" y1="${y}" y2="${y}" stroke="${color}" stroke-dasharray="3 3"/>`;
      }
      const label = narrow ? item.paperTitle : `${item.paperTitle} · ${item.venue}`;
      const note = isUpcoming(item) ? `${days} d left` : inReview.includes(item.status) ? `in review ${Math.abs(days)} d` : item.status;
      svg += `
        <g class="hit" data-open="${item.id}" data-tip-title="${escapeHtml(item.paperTitle)}" data-tip-body="${escapeHtml(`${item.venue} · ${formatDate(item.deadline)} · ${item.status}`)}">
          <rect class="band-bg" x="0" y="${y - rowH / 2}" width="${width}" height="${rowH}" fill="transparent"/>
          <text class="row-label" x="${left - 12}" y="${y + 4}" text-anchor="end">${escapeHtml(label)}</text>
          ${band}
          <circle cx="${x(t)}" cy="${y}" r="5" fill="${color}" stroke="${cssVar("--panel")}" stroke-width="2"/>
          ${narrow ? "" : `<text x="${(inReview.includes(item.status) && now > t && now <= to ? x(now) : x(t)) + 10}" y="${y + 4}">${escapeHtml(note)}</text>`}
        </g>`;
    });

    if (now >= from && now <= to) {
      svg += `<line x1="${x(now)}" x2="${x(now)}" y1="${top - 6}" y2="${height}" stroke="${cssVar("--red")}" stroke-dasharray="4 3"/>
        <rect x="${x(now) - 18}" y="0" width="36" height="18" rx="2" fill="${cssVar("--red")}"/>
        <text x="${x(now)}" y="13" text-anchor="middle" style="fill:#fff;font-weight:600">now</text>`;
    }
    el.innerHTML = `<svg viewBox="0 0 ${width} ${height}" style="height:${height}px">${svg}</svg>`;
  }

  /* ---------- drawer ---------- */

  let drawerItem = null;

  function openDrawer(id, tab = "data") {
    const item = state.all.find((p) => p.id === Number(id));
    if (!item) return;
    drawerItem = item;
    $("drawerTitle").textContent = `Inspect: ${item.paperTitle}`;
    $("drawerSub").textContent = `${item.venue || "—"} · ${item.publicationYear || "—"} cycle · from publications.xlsx`;
    showTab(tab);
    $("backdrop").hidden = false;
    $("drawer").classList.add("open");
    $("drawer").setAttribute("aria-hidden", "false");
    $("drawerClose").focus();
  }

  function showTab(tab) {
    document.querySelectorAll(".tabs button").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
    const item = drawerItem;
    if (tab === "json") {
      $("drawerBody").innerHTML = `<pre>${escapeHtml(JSON.stringify(item.raw, null, 2))}</pre>`;
      return;
    }
    const days = daysFromToday(item.deadline);
    const fields = [
      ["Status", `<span class="status-text" style="color:${statusColor(item.status)}">${escapeHtml(item.status)}</span>`],
      ["Deadline", escapeHtml(formatDate(item.deadline))],
      ["Time to deadline", days === null ? "—" : escapeHtml(days >= 0 ? `${days} days` : `${Math.abs(days)} days ago`)],
      ["Venue", escapeHtml(item.venue || "—")],
      ["Type", escapeHtml(item.type || "—")],
      ["Cycle", escapeHtml(item.publicationYear || "—")],
      ["Priority", escapeHtml(item.priority || "—")],
      ["Internal target", escapeHtml(item.targetMonth || "—")],
      ["Owner", escapeHtml(item.owner || "unassigned")],
      ["Next step", escapeHtml(item.nextStep || "—")],
      ["Notes", escapeHtml(item.notes || "—")],
      ["Last updated", escapeHtml(formatDate(item.lastUpdated))],
    ];
    const url = safeUrl(item.paperUrl);
    $("drawerBody").innerHTML = `
      <table class="kv">${fields.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</table>
      ${url ? `<div class="actions"><a class="btn-primary" href="${escapeHtml(url)}" target="_blank" rel="noreferrer">Open paper</a></div>` : ""}`;
  }

  function closeDrawer() {
    $("drawer").classList.remove("open");
    $("drawer").setAttribute("aria-hidden", "true");
    $("backdrop").hidden = true;
  }

  /* ---------- panel menu ---------- */

  function decoratePanels() {
    document.querySelectorAll(".panel .panel-header").forEach((header) => {
      header.insertAdjacentHTML("beforeend", `<button class="icon-btn menu-btn" type="button" aria-label="Panel menu" aria-expanded="false"><svg><use href="#i-dots"/></svg></button>`);
    });
  }

  function togglePanelView(panel) {
    const active = document.querySelector(".panel.view");
    if (active) {
      active.classList.remove("view");
      document.body.classList.remove("viewing");
      if (active === panel || !panel) { renderTimeline(); return; }
    }
    if (!panel) return;
    panel.classList.add("view");
    document.body.classList.add("viewing");
    renderTimeline();
  }

  function downloadCsv(name) {
    const headers = ["Publication Year", "Venue", "Type", "Deadline", "Paper Title", "Status", "Target Month", "Priority", "Owner", "Next Step", "Paper URL", "Notes", "Last Updated"];
    const quote = (v) => `"${String(v ?? "").replaceAll('"', '""')}"`;
    const csv = [headers.map(quote).join(","), ...state.view.map((item) => headers.map((h) => quote(item.raw[h])).join(","))].join("\n");
    const link = document.createElement("a");
    link.href = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    link.download = `${name}-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    URL.revokeObjectURL(link.href);
  }

  /* ---------- tooltip ---------- */

  function bindTooltip() {
    const tip = $("tooltip");
    document.addEventListener("mousemove", (event) => {
      const target = event.target.closest?.("[data-tip-title]");
      if (!target) { tip.hidden = true; return; }
      tip.replaceChildren();
      const title = document.createElement("b");
      title.textContent = target.dataset.tipTitle;
      const body = document.createElement("span");
      body.textContent = target.dataset.tipBody || "";
      tip.append(title, body);
      tip.hidden = false;
      const x = Math.min(event.clientX + 14, window.innerWidth - tip.offsetWidth - 8);
      const y = Math.min(event.clientY + 14, window.innerHeight - tip.offsetHeight - 8);
      tip.style.left = `${x}px`;
      tip.style.top = `${y}px`;
    });
  }

  /* ---------- theme & chrome ---------- */

  function applyThemeChrome() {
    const dark = document.documentElement.dataset.theme !== "light";
    $("themeIcon").setAttribute("href", dark ? "#i-sun" : "#i-moon");
    document.querySelector('meta[name="theme-color"]').content = dark ? "#111217" : "#f4f5f5";
  }

  function setAutoRefresh(label, ms) {
    clearInterval(state.timer);
    state.timer = ms ? setInterval(loadData, ms) : null;
    $("intervalLabel").textContent = label;
  }

  function bindEvents() {
    $("retryButton").addEventListener("click", loadData);
    $("refreshBtn").addEventListener("click", loadData);
    $("rangePrev").addEventListener("click", () => shiftRange(-1));
    $("rangeNext").addEventListener("click", () => shiftRange(1));
    $("zoomOut").addEventListener("click", zoomOut);

    $("rangeBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu($("rangeMenu"), `<div class="menu-head">Deadline range</div>${rangePresets.map((p) => `<button type="button" data-range="${p.key}" class="${p.key === state.range.key ? "selected" : ""}">${p.label}</button>`).join("")}`);
    });
    $("rangeMenu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-range]");
      if (!button) return;
      closeMenus();
      setRange(button.dataset.range);
    });

    $("intervalBtn").addEventListener("click", (event) => {
      event.stopPropagation();
      openMenu($("intervalMenu"), intervals.map(([label]) => `<button type="button" data-interval="${label}" class="${label === $("intervalLabel").textContent ? "selected" : ""}">${label}</button>`).join(""));
    });
    $("intervalMenu").addEventListener("click", (event) => {
      const button = event.target.closest("[data-interval]");
      if (!button) return;
      closeMenus();
      const [label, ms] = intervals.find(([l]) => l === button.dataset.interval);
      setAutoRefresh(label, ms);
    });

    $("vars").addEventListener("click", (event) => {
      event.stopPropagation();
      const valueButton = event.target.closest("[data-var]");
      if (valueButton) {
        const v = variables.find((x) => x.key === valueButton.dataset.var);
        const menu = document.querySelector(`[data-var-menu="${v.key}"]`);
        openMenu(menu, optionsFor(v).map((o) => `<button type="button" data-set="${escapeHtml(o)}" class="${o === state.vars[v.key] ? "selected" : ""}">${escapeHtml(o)}</button>`).join(""));
        return;
      }
      const option = event.target.closest("[data-set]");
      if (option) {
        const key = option.closest("[data-var-menu]").dataset.varMenu;
        closeMenus();
        setVar(key, option.dataset.set);
      }
    });

    document.querySelectorAll(".row-title").forEach((button) => button.addEventListener("click", () => {
      const row = button.closest(".row");
      row.classList.toggle("collapsed");
      if (!row.classList.contains("collapsed")) renderTimeline();
    }));

    $("pubTable").tHead.addEventListener("click", (event) => {
      const th = event.target.closest("[data-sort]");
      if (!th) return;
      state.sort = state.sort.key === th.dataset.sort ? { key: th.dataset.sort, dir: -state.sort.dir } : { key: th.dataset.sort, dir: 1 };
      renderTable();
    });

    $("statusTiles").addEventListener("click", (event) => {
      const tile = event.target.closest("[data-status]");
      if (tile) setVar("status", state.vars.status === tile.dataset.status ? "All" : tile.dataset.status);
    });

    $("dashboard").addEventListener("click", (event) => {
      const menuButton = event.target.closest(".menu-btn");
      if (menuButton) {
        event.stopPropagation();
        const menu = $("panelMenu");
        const wasOpen = !menu.hidden && state.menuPanel === menuButton.closest(".panel");
        closeMenus();
        if (wasOpen) return;
        state.menuPanel = menuButton.closest(".panel");
        const rect = menuButton.getBoundingClientRect();
        menu.style.position = "fixed";
        menu.style.top = `${rect.bottom + 4}px`;
        menu.style.left = `${Math.min(rect.left, window.innerWidth - 200)}px`;
        menu.hidden = false;
        menuButton.setAttribute("aria-expanded", "true");
        return;
      }
      const open = event.target.closest("[data-open]");
      if (open) {
        event.preventDefault();
        openDrawer(open.dataset.open);
      }
    });

    $("panelMenu").addEventListener("click", (event) => {
      const action = event.target.closest("[data-action]")?.dataset.action;
      const panel = state.menuPanel;
      closeMenus();
      if (!panel) return;
      if (action === "view") togglePanelView(panel);
      if (action === "csv") downloadCsv(panel.dataset.panel || "publications");
    });

    document.addEventListener("click", () => closeMenus());
    document.addEventListener("mouseover", (event) => { state.hoverPanel = event.target.closest?.(".panel") || null; });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") {
        closeMenus();
        if ($("drawer").classList.contains("open")) closeDrawer();
        else togglePanelView(null);
      }
      const typing = /input|textarea|select/i.test(document.activeElement?.tagName || "");
      if (event.key === "v" && !typing && !event.metaKey && !event.ctrlKey && state.hoverPanel) togglePanelView(state.hoverPanel);
    });

    $("drawerClose").addEventListener("click", closeDrawer);
    $("backdrop").addEventListener("click", closeDrawer);
    document.querySelector(".tabs").addEventListener("click", (event) => {
      const tab = event.target.closest("[data-tab]");
      if (tab && drawerItem) showTab(tab.dataset.tab);
    });

    $("themeToggle").addEventListener("click", () => {
      const next = document.documentElement.dataset.theme === "light" ? "dark" : "light";
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem("publication-theme", next); } catch { /* ignore */ }
      applyThemeChrome();
      if (state.all.length) render();
    });

    const star = $("starBtn");
    try { star.classList.toggle("on", localStorage.getItem("publication-star") === "1"); } catch { /* ignore */ }
    star.addEventListener("click", () => {
      star.classList.toggle("on");
      try { localStorage.setItem("publication-star", star.classList.contains("on") ? "1" : "0"); } catch { /* ignore */ }
    });

    let resizeFrame = 0;
    new ResizeObserver(() => {
      cancelAnimationFrame(resizeFrame);
      resizeFrame = requestAnimationFrame(() => { if (state.all.length) renderTimeline(); });
    }).observe($("timeline"));
  }

  function init() {
    readUrl();
    decoratePanels();
    applyThemeChrome();
    bindEvents();
    bindTooltip();
    loadData();
  }

  document.addEventListener("DOMContentLoaded", init);
})();
