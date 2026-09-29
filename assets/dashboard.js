(() => {
  "use strict";

  const DATA_URL = "data/publications.json";
  const DAY_MS = 86_400_000;
  const statusOrder = ["Accepted", "Submitted", "In Review", "Revision", "Planned", "On Hold", "Withdrawn", "Rejected"];
  const priorityOrder = ["High", "Medium", "Low", "Archive"];
  const statusColors = {
    Accepted: "var(--success)",
    Submitted: "var(--primary)",
    "In Review": "var(--purple)",
    Revision: "var(--purple)",
    Planned: "var(--warning)",
    "On Hold": "var(--text-muted)",
    Withdrawn: "var(--text-muted)",
    Rejected: "var(--danger)",
  };

  const state = {
    publications: [],
    filtered: [],
    filters: { search: "", status: "", cycle: "", type: "" },
    sort: { key: "deadline", direction: "asc" },
  };

  const elements = {};

  function byId(id) { return document.getElementById(id); }

  function cacheElements() {
    [
      "lastUpdated", "dataError", "retryButton", "totalCount", "acceptedCount", "submittedCount",
      "plannedCount", "acceptedShare", "cycleRange", "nextDeadlineState", "nextDeadline",
      "portfolioTotal", "statusBars", "statusLegend", "resultSummary", "clearFilters",
      "searchInput", "statusFilter", "cycleFilter", "typeFilter", "publicationRows",
      "publicationCards", "emptyState", "emptyReset", "themeToggle", "publicationDialog",
      "closeDialog", "dialogDone", "dialogEyebrow", "dialogTitle", "dialogStatus", "dialogDetails",
      "dialogNotes", "dialogPaperLink",
    ].forEach((id) => { elements[id] = byId(id); });
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replaceAll("&", "&amp;")
      .replaceAll("<", "&lt;")
      .replaceAll(">", "&gt;")
      .replaceAll('"', "&quot;")
      .replaceAll("'", "&#039;");
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

  function formatDate(value, options = { month: "short", day: "numeric", year: "numeric" }) {
    const date = parseDate(value);
    return date ? new Intl.DateTimeFormat("en-US", options).format(date) : "Not scheduled";
  }

  function daysFromToday(value) {
    const date = parseDate(value);
    return date ? Math.ceil((date - today()) / DAY_MS) : null;
  }

  function deadlineContext(publication) {
    const days = daysFromToday(publication.deadline);
    if (days === null) return "No date";
    if (["Accepted", "Submitted", "In Review", "Revision"].includes(publication.status)) return publication.status;
    if (days > 1) return `${days} days left`;
    if (days === 1) return "1 day left";
    if (days === 0) return "Due today";
    if (days === -1) return "1 day overdue";
    return `${Math.abs(days)} days overdue`;
  }

  function slug(value) {
    return String(value || "unknown").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  }

  function statusPill(status) {
    return `<span class="status-pill status-${slug(status)}">${escapeHtml(status)}</span>`;
  }

  function priorityPill(priority) {
    const value = priority || "Not set";
    return `<span class="priority-pill priority-${slug(value)}">${escapeHtml(value)}</span>`;
  }

  function safeUrl(value) {
    try {
      const url = new URL(value);
      return ["http:", "https:"].includes(url.protocol) ? url.href : "";
    } catch {
      return "";
    }
  }

  async function loadData() {
    elements.dataError.hidden = true;
    try {
      const response = await fetch(DATA_URL, { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!Array.isArray(payload.publications)) throw new Error("Invalid publication data");
      state.publications = payload.publications.map(normalizeRecord);
      elements.lastUpdated.textContent = formatDate(payload.lastUpdated, { month: "long", day: "numeric", year: "numeric" });
      populateFilters();
      renderMetrics();
      renderInsights();
      applyFilters();
    } catch (error) {
      console.error(error);
      elements.dataError.hidden = false;
      elements.resultSummary.textContent = "Publication data is unavailable.";
      elements.publicationRows.innerHTML = "";
      elements.publicationCards.innerHTML = "";
    }
  }

  function populateSelect(select, values) {
    const first = select.options[0];
    select.replaceChildren(first);
    values.forEach((value) => {
      const option = document.createElement("option");
      option.value = String(value);
      option.textContent = String(value);
      select.append(option);
    });
  }

  function populateFilters() {
    const statuses = statusOrder.filter((status) => state.publications.some((item) => item.status === status));
    const extraStatuses = [...new Set(state.publications.map((item) => item.status))].filter((status) => !statuses.includes(status)).sort();
    const cycles = [...new Set(state.publications.map((item) => item.publicationYear).filter(Boolean))].sort((a, b) => b - a);
    const types = [...new Set(state.publications.map((item) => item.type).filter(Boolean))].sort();
    populateSelect(elements.statusFilter, [...statuses, ...extraStatuses]);
    populateSelect(elements.cycleFilter, cycles);
    populateSelect(elements.typeFilter, types);
  }

  function renderMetrics() {
    const counts = countStatuses(state.publications);
    const total = state.publications.length;
    const years = [...new Set(state.publications.map((item) => item.publicationYear).filter(Boolean))].sort();
    elements.totalCount.textContent = String(total);
    elements.acceptedCount.textContent = String(counts.Accepted || 0);
    elements.submittedCount.textContent = String(counts.Submitted || 0);
    elements.plannedCount.textContent = String(counts.Planned || 0);
    elements.acceptedShare.textContent = total ? `${Math.round(((counts.Accepted || 0) / total) * 100)}% of the portfolio` : "No publications yet";
    elements.cycleRange.textContent = years.length > 1 ? `${years[0]}–${years.at(-1)} publication cycles` : years.length ? `${years[0]} publication cycle` : "Across all cycles";
  }

  function countStatuses(items) {
    return items.reduce((counts, item) => {
      counts[item.status] = (counts[item.status] || 0) + 1;
      return counts;
    }, {});
  }

  function renderInsights() {
    renderNextDeadline();
    renderStatusDistribution();
  }

  function renderNextDeadline() {
    const upcoming = state.publications
      .filter((item) => !["Accepted", "Rejected", "Withdrawn"].includes(item.status) && daysFromToday(item.deadline) >= 0)
      .sort((a, b) => parseDate(a.deadline) - parseDate(b.deadline));
    const next = upcoming[0];
    if (!next) {
      elements.nextDeadlineState.textContent = "All clear";
      elements.nextDeadline.innerHTML = `<div><p class="deadline-venue">Pipeline</p><h3 class="deadline-title">No upcoming deadlines</h3><p class="deadline-meta">Add a future deadline in the Excel workbook.</p></div>`;
      return;
    }
    const days = daysFromToday(next.deadline);
    elements.nextDeadlineState.textContent = next.priority ? `${next.priority} priority` : "Upcoming";
    elements.nextDeadline.innerHTML = `
      <div>
        <p class="deadline-venue">${escapeHtml(next.venue)} · ${escapeHtml(next.publicationYear || "")}</p>
        <h3 class="deadline-title">${escapeHtml(next.paperTitle)}</h3>
        <p class="deadline-meta"><strong>${escapeHtml(formatDate(next.deadline))}</strong>${next.targetMonth ? ` · Internal target: ${escapeHtml(next.targetMonth)}` : ""}</p>
      </div>
      <div class="countdown" aria-label="${days} days until deadline"><strong>${days}</strong><span>${days === 1 ? "day left" : "days left"}</span></div>`;
  }

  function renderStatusDistribution() {
    const counts = countStatuses(state.publications);
    const total = state.publications.length || 1;
    const statuses = statusOrder.filter((status) => counts[status]);
    const extras = Object.keys(counts).filter((status) => !statuses.includes(status));
    const visibleStatuses = [...statuses, ...extras];
    elements.portfolioTotal.textContent = `${state.publications.length} ${state.publications.length === 1 ? "paper" : "papers"}`;
    elements.statusBars.innerHTML = visibleStatuses.map((status) => {
      const share = (counts[status] / total) * 100;
      return `<span class="status-bar" style="flex-basis:${share}%;background:${statusColors[status] || "var(--text-muted)"}" title="${escapeHtml(status)}: ${counts[status]}"></span>`;
    }).join("");
    elements.statusBars.setAttribute("aria-label", visibleStatuses.map((status) => `${status}: ${counts[status]}`).join(", "));
    elements.statusLegend.innerHTML = visibleStatuses.map((status) => `
      <div class="legend-item">
        <span class="legend-label"><i class="legend-dot" style="--legend-color:${statusColors[status] || "var(--text-muted)"}"></i>${escapeHtml(status)}</span>
        <strong>${counts[status]}</strong>
      </div>`).join("");
  }

  function readFilters() {
    state.filters.search = elements.searchInput.value.trim().toLowerCase();
    state.filters.status = elements.statusFilter.value;
    state.filters.cycle = elements.cycleFilter.value;
    state.filters.type = elements.typeFilter.value;
  }

  function applyFilters() {
    readFilters();
    const { search, status, cycle, type } = state.filters;
    state.filtered = state.publications.filter((item) => {
      const searchable = [item.paperTitle, item.venue, item.type, item.status, item.owner, item.nextStep, item.notes].join(" ").toLowerCase();
      return (!search || searchable.includes(search))
        && (!status || item.status === status)
        && (!cycle || String(item.publicationYear) === cycle)
        && (!type || item.type === type);
    });
    sortFiltered();
    renderPublications();
    const filtersActive = Boolean(search || status || cycle || type);
    elements.clearFilters.hidden = !filtersActive;
    elements.resultSummary.textContent = filtersActive
      ? `Showing ${state.filtered.length} of ${state.publications.length} papers`
      : `${state.publications.length} papers across the full research pipeline`;
  }

  function sortFiltered() {
    const { key, direction } = state.sort;
    const factor = direction === "asc" ? 1 : -1;
    const priorityIndex = (value) => {
      const index = priorityOrder.indexOf(value);
      return index === -1 ? priorityOrder.length : index;
    };
    state.filtered.sort((a, b) => {
      let left = a[key];
      let right = b[key];
      if (key === "deadline") {
        left = parseDate(left)?.getTime() ?? Number.MAX_SAFE_INTEGER;
        right = parseDate(right)?.getTime() ?? Number.MAX_SAFE_INTEGER;
      } else if (key === "status") {
        left = statusOrder.indexOf(left);
        right = statusOrder.indexOf(right);
      } else if (key === "priority") {
        left = priorityIndex(left);
        right = priorityIndex(right);
      } else {
        left = String(left || "").toLowerCase();
        right = String(right || "").toLowerCase();
      }
      return (left < right ? -1 : left > right ? 1 : 0) * factor;
    });
  }

  function renderPublications() {
    elements.publicationRows.innerHTML = state.filtered.map((item) => `
      <tr tabindex="0" data-publication-id="${item.id}" aria-label="View details for ${escapeHtml(item.paperTitle)}">
        <td class="paper-cell"><strong>${escapeHtml(item.paperTitle)}</strong><span>${escapeHtml(item.type || "Publication")} · ${escapeHtml(item.publicationYear || "No cycle")}</span></td>
        <td>${escapeHtml(item.venue || "Not set")}</td>
        <td class="deadline-cell"><strong>${escapeHtml(formatDate(item.deadline, { month: "short", day: "numeric", year: "numeric" }))}</strong><span>${escapeHtml(deadlineContext(item))}</span></td>
        <td>${statusPill(item.status)}</td>
        <td>${escapeHtml(item.targetMonth || "—")}</td>
        <td>${priorityPill(item.priority)}</td>
        <td>${escapeHtml(item.nextStep || "Not set")}</td>
        <td><span class="row-action" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none"><path d="m9 18 6-6-6-6"/></svg></span></td>
      </tr>`).join("");

    elements.publicationCards.innerHTML = state.filtered.map((item) => `
      <article class="publication-card" tabindex="0" data-publication-id="${item.id}" aria-label="View details for ${escapeHtml(item.paperTitle)}">
        <div class="publication-card-top"><div><h3>${escapeHtml(item.paperTitle)}</h3><p class="card-venue">${escapeHtml(item.venue || "No venue")} · ${escapeHtml(item.publicationYear || "No cycle")}</p></div>${statusPill(item.status)}</div>
        <div class="publication-card-meta">
          <div><span>Deadline</span><strong>${escapeHtml(formatDate(item.deadline, { month: "short", day: "numeric", year: "numeric" }))}</strong></div>
          <div><span>Priority</span><strong>${escapeHtml(item.priority || "Not set")}</strong></div>
          <div><span>Target</span><strong>${escapeHtml(item.targetMonth || "—")}</strong></div>
          <div><span>Next step</span><strong>${escapeHtml(item.nextStep || "Not set")}</strong></div>
        </div>
      </article>`).join("");

    const isEmpty = state.filtered.length === 0;
    elements.emptyState.hidden = !isEmpty;
    document.querySelector(".table-wrap").hidden = isEmpty;
    elements.publicationCards.hidden = isEmpty;
  }

  function clearFilters() {
    elements.searchInput.value = "";
    elements.statusFilter.value = "";
    elements.cycleFilter.value = "";
    elements.typeFilter.value = "";
    applyFilters();
    elements.searchInput.focus();
  }

  function updateSort(key) {
    if (state.sort.key === key) {
      state.sort.direction = state.sort.direction === "asc" ? "desc" : "asc";
    } else {
      state.sort = { key, direction: "asc" };
    }
    document.querySelectorAll("th[data-sort]").forEach((header) => {
      const active = header.dataset.sort === state.sort.key;
      header.setAttribute("aria-sort", active ? (state.sort.direction === "asc" ? "ascending" : "descending") : "none");
      header.querySelector("span").textContent = active ? (state.sort.direction === "asc" ? "↑" : "↓") : "";
    });
    sortFiltered();
    renderPublications();
  }

  function openPublication(id) {
    const item = state.publications.find((publication) => publication.id === Number(id));
    if (!item) return;
    elements.dialogEyebrow.textContent = `${item.venue || "Publication"} · ${item.publicationYear || "No cycle"}`;
    elements.dialogTitle.textContent = item.paperTitle;
    elements.dialogStatus.innerHTML = statusPill(item.status);
    const details = [
      ["Deadline", formatDate(item.deadline)],
      ["Deadline state", deadlineContext(item)],
      ["Type", item.type || "Not set"],
      ["Target month", item.targetMonth || "Not set"],
      ["Priority", item.priority || "Not set"],
      ["Owner", item.owner || "Unassigned"],
      ["Next step", item.nextStep || "Not set"],
      ["Last updated", formatDate(item.lastUpdated)],
      ["Data source", "Excel workbook"],
    ];
    elements.dialogDetails.innerHTML = details.map(([label, value]) => `<div class="detail-item"><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join("");
    elements.dialogNotes.textContent = item.notes || "No notes added.";
    const paperUrl = safeUrl(item.paperUrl);
    elements.dialogPaperLink.hidden = !paperUrl;
    if (paperUrl) elements.dialogPaperLink.href = paperUrl;
    elements.publicationDialog.showModal();
  }

  function closePublication() {
    elements.publicationDialog.close();
  }

  function toggleTheme() {
    const next = document.documentElement.dataset.theme === "dark" ? "light" : "dark";
    document.documentElement.dataset.theme = next;
    localStorage.setItem("publication-theme", next);
    document.querySelector('meta[name="theme-color"]').content = next === "dark" ? "#08111f" : "#f4f7fb";
    elements.themeToggle.setAttribute("aria-label", `Switch to ${next === "dark" ? "light" : "dark"} theme`);
  }

  function handlePublicationActivation(event) {
    const target = event.target.closest("[data-publication-id]");
    if (!target) return;
    if (event.type === "keydown" && !["Enter", " "].includes(event.key)) return;
    if (event.type === "keydown") event.preventDefault();
    openPublication(target.dataset.publicationId);
  }

  function bindEvents() {
    elements.retryButton.addEventListener("click", loadData);
    elements.searchInput.addEventListener("input", applyFilters);
    [elements.statusFilter, elements.cycleFilter, elements.typeFilter].forEach((select) => select.addEventListener("change", applyFilters));
    elements.clearFilters.addEventListener("click", clearFilters);
    elements.emptyReset.addEventListener("click", clearFilters);
    elements.themeToggle.addEventListener("click", toggleTheme);
    document.querySelectorAll("th[data-sort] button").forEach((button) => button.addEventListener("click", () => updateSort(button.closest("th").dataset.sort)));
    elements.publicationRows.addEventListener("click", handlePublicationActivation);
    elements.publicationRows.addEventListener("keydown", handlePublicationActivation);
    elements.publicationCards.addEventListener("click", handlePublicationActivation);
    elements.publicationCards.addEventListener("keydown", handlePublicationActivation);
    elements.closeDialog.addEventListener("click", closePublication);
    elements.dialogDone.addEventListener("click", closePublication);
    elements.publicationDialog.addEventListener("click", (event) => {
      if (event.target === elements.publicationDialog) closePublication();
    });
  }

  function init() {
    cacheElements();
    bindEvents();
    const current = document.documentElement.dataset.theme;
    document.querySelector('meta[name="theme-color"]').content = current === "dark" ? "#08111f" : "#f4f7fb";
    elements.themeToggle.setAttribute("aria-label", `Switch to ${current === "dark" ? "light" : "dark"} theme`);
    loadData();
  }

  document.addEventListener("DOMContentLoaded", init);
})();

