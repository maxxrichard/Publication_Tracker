#!/usr/bin/env python3
"""Generate README.md from data/publications.xlsx without third-party packages."""

from __future__ import annotations

import datetime as dt
import json
import posixpath
import re
import zipfile
from collections import Counter
from pathlib import Path
from xml.etree import ElementTree as ET
from xml.sax.saxutils import escape as xml_escape

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "data" / "publications.xlsx"
TEMPLATE = ROOT / "README.template.md"
OUTPUT = ROOT / "README.md"
DASHBOARD = ROOT / "assets" / "publication-dashboard.svg"
WEB_DATA = ROOT / "data" / "publications.json"
SHEET_NAME = "Publications"

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

STATUS_ORDER = ["Accepted", "Submitted", "In Review", "Revision", "Planned", "On Hold", "Withdrawn", "Rejected"]
STATUS_COLORS = {
    "Accepted": ("#34D399", "#062E25"),
    "Submitted": ("#60A5FA", "#102A56"),
    "In Review": ("#A78BFA", "#2E1F57"),
    "Revision": ("#FBBF24", "#4A3107"),
    "Planned": ("#F59E0B", "#432607"),
    "On Hold": ("#94A3B8", "#263244"),
    "Withdrawn": ("#94A3B8", "#263244"),
    "Rejected": ("#FB7185", "#4C1720"),
}


def column_index(cell_ref: str) -> int:
    letters = re.match(r"[A-Z]+", cell_ref).group(0)
    value = 0
    for char in letters:
        value = value * 26 + ord(char) - 64
    return value - 1


def excel_date(value: str) -> dt.date:
    return dt.date(1899, 12, 30) + dt.timedelta(days=int(float(value)))


def load_rows(path: Path, sheet_name: str) -> list[dict[str, object]]:
    with zipfile.ZipFile(path) as archive:
        shared_strings: list[str] = []
        if "xl/sharedStrings.xml" in archive.namelist():
            root = ET.fromstring(archive.read("xl/sharedStrings.xml"))
            for item in root.findall("m:si", NS):
                shared_strings.append("".join(node.text or "" for node in item.iterfind(".//m:t", NS)))

        workbook = ET.fromstring(archive.read("xl/workbook.xml"))
        relationship_id = None
        for sheet in workbook.findall("m:sheets/m:sheet", NS):
            if sheet.attrib.get("name") == sheet_name:
                relationship_id = sheet.attrib.get(f"{{{DOC_REL}}}id")
                break
        if relationship_id is None:
            raise ValueError(f"Worksheet {sheet_name!r} was not found in {path}")

        relationships = ET.fromstring(archive.read("xl/_rels/workbook.xml.rels"))
        target = None
        for rel in relationships.findall("r:Relationship", REL_NS):
            if rel.attrib.get("Id") == relationship_id:
                target = rel.attrib["Target"]
                break
        if target is None:
            raise ValueError(f"Worksheet relationship {relationship_id!r} was not found")
        normalized_target = target.lstrip("/")
        sheet_path = (
            normalized_target
            if normalized_target.startswith("xl/")
            else posixpath.normpath(posixpath.join("xl", normalized_target))
        )
        sheet_xml = ET.fromstring(archive.read(sheet_path))

        grid: list[list[object]] = []
        for row in sheet_xml.findall("m:sheetData/m:row", NS):
            values: list[object] = []
            for cell in row.findall("m:c", NS):
                index = column_index(cell.attrib["r"])
                while len(values) <= index:
                    values.append("")
                cell_type = cell.attrib.get("t")
                raw = cell.findtext("m:v", default="", namespaces=NS)
                if cell_type == "s" and raw:
                    value: object = shared_strings[int(raw)]
                elif cell_type == "inlineStr":
                    value = "".join(node.text or "" for node in cell.iterfind(".//m:t", NS))
                elif cell_type == "b":
                    value = raw == "1"
                else:
                    value = raw
                values[index] = value
            grid.append(values)

    if not grid:
        return []
    headers = [str(value).strip() for value in grid[0]]
    records: list[dict[str, object]] = []
    for values in grid[1:]:
        values.extend([""] * (len(headers) - len(values)))
        record = dict(zip(headers, values))
        if not any(str(value).strip() for value in record.values()):
            continue
        for key in ("Deadline", "Last Updated"):
            if record.get(key):
                record[key] = excel_date(str(record[key]))
        year = record.get("Publication Year")
        if year:
            record["Publication Year"] = int(float(str(year)))
        records.append(record)
    return records


def clean(value: object) -> str:
    return str(value or "").strip().replace("|", "\\|").replace("\n", "<br>")


def deadline_label(record: dict[str, object], today: dt.date) -> str:
    deadline = record.get("Deadline")
    if not isinstance(deadline, dt.date):
        return "—"
    label = deadline.strftime("%b %d, %Y").replace(" 0", " ")
    status = clean(record.get("Status"))
    if status in {"Accepted", "Submitted", "In Review", "Revision"}:
        return label
    delta = (deadline - today).days
    if delta > 0:
        return f"{label}<br><sub>{delta} days left</sub>"
    if delta == 0:
        return f"{label}<br><sub>due today</sub>"
    return f"{label}<br><sub>{abs(delta)} days overdue</sub>"


def status_badge(status: object) -> str:
    value = clean(status)
    return f"**{value or 'Unknown'}**"


def svg_text(value: object) -> str:
    return xml_escape(str(value or ""), {'"': "&quot;"})


def truncate(value: object, length: int) -> str:
    text = str(value or "").strip()
    return text if len(text) <= length else text[: length - 1].rstrip() + "…"


def render_dashboard(records: list[dict[str, object]]) -> str:
    today = dt.date.today()
    counts = Counter(clean(record.get("Status")) for record in records)
    active = [record for record in records if clean(record.get("Status")) not in {"Accepted", "Rejected", "Withdrawn"}]
    active.sort(key=lambda record: record.get("Deadline") or dt.date.max)
    accepted = [record for record in records if clean(record.get("Status")) == "Accepted"]
    planned = [record for record in active if clean(record.get("Status")) == "Planned" and isinstance(record.get("Deadline"), dt.date)]
    next_deadline = min(planned, key=lambda record: record["Deadline"], default=None)
    years = sorted({int(record["Publication Year"]) for record in records})
    year_span = str(years[0]) if len(years) == 1 else f"{years[0]}–{years[-1]}"
    latest_update = max((record.get("Last Updated") for record in records if isinstance(record.get("Last Updated"), dt.date)), default=today)

    metric_data = [
        ("TOTAL PAPERS", len(records), "Across all publication cycles", "#E2E8F0"),
        ("ACCEPTED", counts["Accepted"], "Published or camera-ready", "#34D399"),
        ("SUBMITTED", counts["Submitted"], "Awaiting the review cycle", "#60A5FA"),
        ("PLANNED", counts["Planned"], "In the writing pipeline", "#F59E0B"),
    ]

    metric_cards = []
    for index, (label, value, note, color) in enumerate(metric_data):
        x = 48 + index * 276
        metric_cards.append(f"""
        <g>
          <rect x="{x}" y="154" width="252" height="132" rx="18" fill="#111C2F" stroke="#26344C"/>
          <rect x="{x}" y="154" width="5" height="132" rx="2.5" fill="{color}"/>
          <text x="{x + 24}" y="187" class="label">{label}</text>
          <text x="{x + 24}" y="242" class="metric">{value}</text>
          <text x="{x + 82}" y="239" class="muted">{svg_text(note)}</text>
        </g>""")

    pipeline_rows = []
    row_y = 394
    for index, record in enumerate(active[:5]):
        y = row_y + index * 57
        status = clean(record.get("Status")) or "Unknown"
        color, pill_fill = STATUS_COLORS.get(status, ("#CBD5E1", "#273449"))
        deadline = record.get("Deadline")
        deadline_text = deadline.strftime("%b %d").replace(" 0", " ") if isinstance(deadline, dt.date) else "TBD"
        target = clean(record.get("Target Month"))
        meta = f"{deadline_text} deadline" + (f"  ·  {target} target" if target else "")
        pipeline_rows.append(f"""
        <g>
          <line x1="72" y1="{y + 45}" x2="740" y2="{y + 45}" stroke="#223048"/>
          <circle cx="80" cy="{y + 20}" r="5" fill="{color}"/>
          <text x="98" y="{y + 17}" class="row-title">{svg_text(record.get('Venue'))}</text>
          <text x="178" y="{y + 17}" class="row-paper">{svg_text(truncate(record.get('Paper Title'), 22))}</text>
          <text x="178" y="{y + 37}" class="row-meta">{svg_text(meta)}</text>
          <rect x="618" y="{y + 5}" width="112" height="28" rx="14" fill="{pill_fill}" stroke="{color}" stroke-opacity=".45"/>
          <text x="674" y="{y + 24}" text-anchor="middle" class="pill" fill="{color}">{svg_text(status.upper())}</text>
        </g>""")

    if next_deadline:
        deadline = next_deadline["Deadline"]
        days_left = (deadline - today).days
        urgency = f"{days_left} DAYS LEFT" if days_left >= 0 else f"{abs(days_left)} DAYS OVERDUE"
        next_block = f"""
          <text x="824" y="383" class="label">NEXT DEADLINE</text>
          <text x="824" y="428" class="next-venue">{svg_text(next_deadline.get('Venue'))}</text>
          <text x="824" y="457" class="next-paper">{svg_text(truncate(next_deadline.get('Paper Title'), 26))}</text>
          <text x="824" y="503" class="date">{deadline.strftime('%b %d, %Y').replace(' 0', ' ')}</text>
          <rect x="1000" y="477" width="128" height="32" rx="16" fill="#432607" stroke="#B76808"/>
          <text x="1064" y="498" text-anchor="middle" class="pill" fill="#FBBF24">{urgency}</text>"""
    else:
        next_block = """
          <text x="824" y="383" class="label">NEXT DEADLINE</text>
          <text x="824" y="445" class="next-paper">No planned deadlines</text>"""

    total = max(len(records), 1)
    accepted_width = round(288 * counts["Accepted"] / total)
    submitted_width = round(288 * counts["Submitted"] / total)
    planned_width = max(0, 288 - accepted_width - submitted_width)
    submitted_x = 824 + accepted_width
    planned_x = submitted_x + submitted_width
    accepted_titles = "  ·  ".join(truncate(record.get("Paper Title"), 12) for record in accepted)

    return f"""<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="760" viewBox="0 0 1200 760" role="img" aria-labelledby="title description">
  <title id="title">Publication pipeline dashboard</title>
  <desc id="description">{len(records)} papers: {counts['Accepted']} accepted, {counts['Submitted']} submitted, and {counts['Planned']} planned. The next planned deadline is {svg_text(next_deadline.get('Venue') if next_deadline else 'not scheduled')}.</desc>
  <defs>
    <linearGradient id="background" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0A1222"/>
      <stop offset="1" stop-color="#0D1729"/>
    </linearGradient>
    <radialGradient id="glow" cx="0" cy="0" r="1" gradientTransform="translate(1020 40) rotate(135) scale(430)">
      <stop stop-color="#2563EB" stop-opacity=".22"/>
      <stop offset="1" stop-color="#2563EB" stop-opacity="0"/>
    </radialGradient>
    <pattern id="grid" width="32" height="32" patternUnits="userSpaceOnUse">
      <path d="M32 0H0V32" fill="none" stroke="#8BA3C7" stroke-opacity=".035"/>
    </pattern>
    <style>
      text {{ font-family: Inter, ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }}
      .eyebrow {{ fill:#7DD3FC; font-size:12px; font-weight:700; letter-spacing:2px; }}
      .title {{ fill:#F8FAFC; font-size:38px; font-weight:720; letter-spacing:-1px; }}
      .subtitle {{ fill:#94A3B8; font-size:15px; }}
      .label {{ fill:#94A3B8; font-size:11px; font-weight:700; letter-spacing:1.3px; }}
      .metric {{ fill:#F8FAFC; font-size:48px; font-weight:750; font-variant-numeric:tabular-nums; }}
      .muted {{ fill:#718096; font-size:12px; }}
      .section {{ fill:#E2E8F0; font-size:17px; font-weight:700; }}
      .row-title {{ fill:#CBD5E1; font-size:14px; font-weight:700; }}
      .row-paper {{ fill:#F8FAFC; font-size:15px; font-weight:650; }}
      .row-meta {{ fill:#718096; font-size:11px; }}
      .pill {{ font-size:10px; font-weight:750; letter-spacing:.7px; }}
      .next-venue {{ fill:#F8FAFC; font-size:32px; font-weight:760; }}
      .next-paper {{ fill:#CBD5E1; font-size:16px; font-weight:600; }}
      .date {{ fill:#F8FAFC; font-size:18px; font-weight:700; font-variant-numeric:tabular-nums; }}
      .legend {{ fill:#94A3B8; font-size:11px; }}
      .legend-value {{ fill:#E2E8F0; font-size:12px; font-weight:700; }}
      .footer {{ fill:#64748B; font-size:11px; }}
    </style>
  </defs>
  <rect width="1200" height="760" rx="28" fill="url(#background)"/>
  <rect width="1200" height="760" rx="28" fill="url(#glow)"/>
  <rect width="1200" height="760" rx="28" fill="url(#grid)"/>
  <rect x="48" y="44" width="48" height="48" rx="14" fill="#172554" stroke="#3B82F6" stroke-opacity=".7"/>
  <path d="M61 77V67l8-8 7 7 8-10" fill="none" stroke="#7DD3FC" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
  <circle cx="61" cy="77" r="2.5" fill="#7DD3FC"/><circle cx="69" cy="59" r="2.5" fill="#7DD3FC"/><circle cx="76" cy="66" r="2.5" fill="#7DD3FC"/><circle cx="84" cy="56" r="2.5" fill="#7DD3FC"/>
  <text x="116" y="59" class="eyebrow">RESEARCH OPERATIONS</text>
  <text x="116" y="91" class="title">Publication pipeline</text>
  <text x="116" y="119" class="subtitle">{year_span} portfolio · synchronized from Excel · updated {latest_update.strftime('%b %d, %Y').replace(' 0', ' ')}</text>
  <rect x="1011" y="56" width="141" height="34" rx="17" fill="#0D2B25" stroke="#1D6B58"/>
  <circle cx="1031" cy="73" r="5" fill="#34D399"/>
  <text x="1044" y="77" class="pill" fill="#6EE7B7">TRACKER ACTIVE</text>
  {''.join(metric_cards)}
  <rect x="48" y="318" width="720" height="394" rx="20" fill="#101A2C" stroke="#26344C"/>
  <text x="72" y="357" class="section">Active pipeline</text>
  <text x="740" y="357" text-anchor="end" class="muted">{len(active)} papers in motion</text>
  {''.join(pipeline_rows)}
  <rect x="792" y="318" width="360" height="220" rx="20" fill="#101A2C" stroke="#26344C"/>
  {next_block}
  <rect x="792" y="558" width="360" height="154" rx="20" fill="#101A2C" stroke="#26344C"/>
  <text x="824" y="593" class="section">Portfolio mix</text>
  <rect x="824" y="614" width="288" height="12" rx="6" fill="#1E293B"/>
  <rect x="824" y="614" width="{accepted_width}" height="12" rx="6" fill="#34D399"/>
  <rect x="{submitted_x}" y="614" width="{submitted_width}" height="12" fill="#60A5FA"/>
  <rect x="{planned_x}" y="614" width="{planned_width}" height="12" rx="6" fill="#F59E0B"/>
  <circle cx="830" cy="654" r="4" fill="#34D399"/><text x="842" y="658" class="legend">Accepted</text><text x="900" y="658" class="legend-value">{counts['Accepted']}</text>
  <circle cx="941" cy="654" r="4" fill="#60A5FA"/><text x="953" y="658" class="legend">Submitted</text><text x="1021" y="658" class="legend-value">{counts['Submitted']}</text>
  <circle cx="1061" cy="654" r="4" fill="#F59E0B"/><text x="1073" y="658" class="legend">Planned</text><text x="1124" y="658" class="legend-value">{counts['Planned']}</text>
  <text x="824" y="688" class="footer">Accepted: {svg_text(truncate(accepted_titles, 52))}</text>
</svg>
"""


def render_tracker(records: list[dict[str, object]]) -> str:
    today = dt.date.today()
    active = [record for record in records if clean(record.get("Status")) not in {"Accepted", "Rejected", "Withdrawn"}]
    accepted = [record for record in records if clean(record.get("Status")) == "Accepted"]
    active.sort(key=lambda record: record.get("Deadline") or dt.date.max)
    accepted.sort(key=lambda record: record.get("Deadline") or dt.date.max, reverse=True)
    latest_update = max((record.get("Last Updated") for record in records if isinstance(record.get("Last Updated"), dt.date)), default=today)

    lines = [
        "## Active pipeline",
        "",
        "| Cycle | Venue | Paper | Deadline | Status | Target | Priority | Next step |",
        "|:--:|:--|:--|:--|:--|:--:|:--:|:--|",
    ]
    for record in active:
        target = clean(record.get("Target Month")) or "—"
        priority = clean(record.get("Priority")) or "—"
        paper = clean(record.get("Paper Title")) or "Untitled"
        url = clean(record.get("Paper URL"))
        if url:
            paper = f"[{paper}]({url})"
        lines.append(
            "| {year} | {venue} | **{paper}** | {deadline} | {status} | {target} | {priority} | {next_step} |".format(
                year=record.get("Publication Year") or "—",
                venue=clean(record.get("Venue")) or "—",
                deadline=deadline_label(record, today),
                paper=paper,
                status=status_badge(record.get("Status")),
                target=target,
                priority=priority,
                next_step=clean(record.get("Next Step")) or "—",
            )
        )

    lines.extend([
        "",
        "## Accepted publications",
        "",
        "| Cycle | Venue | Paper | Deadline |",
        "|:--:|:--|:--|:--|",
    ])
    for record in accepted:
        paper = clean(record.get("Paper Title")) or "Untitled"
        url = clean(record.get("Paper URL"))
        if url:
            paper = f"[{paper}]({url})"
        lines.append(f"| {record.get('Publication Year') or '—'} | {clean(record.get('Venue')) or '—'} | **{paper}** | {deadline_label(record, today)} |")
    lines.extend([
        "",
        f"<sub>Data updated **{latest_update.strftime('%B %d, %Y').replace(' 0', ' ')}** · generated from [`data/publications.xlsx`](data/publications.xlsx)</sub>",
        "",
    ])
    return "\n".join(lines)


def export_web_data(records: list[dict[str, object]]) -> str:
    serialized = []
    for record in records:
        serialized.append({
            key: value.isoformat() if isinstance(value, dt.date) else value
            for key, value in record.items()
        })
    latest_update = max(
        (record.get("Last Updated") for record in records if isinstance(record.get("Last Updated"), dt.date)),
        default=dt.date.today(),
    )
    payload = {
        "source": "data/publications.xlsx",
        "sheet": SHEET_NAME,
        "lastUpdated": latest_update.isoformat(),
        "publications": serialized,
    }
    return json.dumps(payload, indent=2, ensure_ascii=False) + "\n"


def main() -> None:
    records = load_rows(WORKBOOK, SHEET_NAME)
    if not records:
        raise SystemExit(f"No publication rows found in {WORKBOOK}")
    template = TEMPLATE.read_text(encoding="utf-8")
    marker = "{{TRACKER}}"
    if template.count(marker) != 1:
        raise SystemExit(f"{TEMPLATE} must contain exactly one {marker} marker")
    DASHBOARD.parent.mkdir(parents=True, exist_ok=True)
    DASHBOARD.write_text(render_dashboard(records), encoding="utf-8")
    WEB_DATA.write_text(export_web_data(records), encoding="utf-8")
    OUTPUT.write_text(template.replace(marker, render_tracker(records)), encoding="utf-8")
    print(f"Generated README, SVG dashboard, and web data from {len(records)} publication records")


if __name__ == "__main__":
    main()
