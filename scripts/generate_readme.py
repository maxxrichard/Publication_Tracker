#!/usr/bin/env python3
"""Generate README.md and data/publications.json from data/publications.xlsx (standard library only)."""

from __future__ import annotations

import datetime as dt
import json
import posixpath
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET

ROOT = Path(__file__).resolve().parents[1]
WORKBOOK = ROOT / "data" / "publications.xlsx"
TEMPLATE = ROOT / "README.template.md"
OUTPUT = ROOT / "README.md"
WEB_DATA = ROOT / "data" / "publications.json"
SHEET_NAME = "Publications"

NS = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main"}
REL_NS = {"r": "http://schemas.openxmlformats.org/package/2006/relationships"}
DOC_REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships"

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


def format_date(value: dt.date) -> str:
    return value.strftime("%b %d, %Y").replace(" 0", " ")


def render_summary(records: list[dict[str, object]]) -> str:
    today = dt.date.today()
    statuses = [clean(record.get("Status")) for record in records]
    accepted = statuses.count("Accepted")
    in_review = sum(statuses.count(status) for status in ("Submitted", "In Review", "Revision"))
    planned = sum(statuses.count(status) for status in ("Planned", "On Hold"))
    cycles = sorted({record.get("Publication Year") for record in records if record.get("Publication Year")})
    cycle_span = f"{cycles[0]}–{cycles[-1]}" if len(cycles) > 1 else (str(cycles[0]) if cycles else "—")

    upcoming = sorted(
        (
            record for record in records
            if clean(record.get("Status")) in {"Planned", "On Hold"}
            and isinstance(record.get("Deadline"), dt.date)
            and record["Deadline"] >= today
        ),
        key=lambda record: record["Deadline"],
    )
    next_deadline = (
        f"{clean(upcoming[0].get('Venue'))} · {format_date(upcoming[0]['Deadline'])}" if upcoming else "—"
    )
    latest_update = max(
        (record.get("Last Updated") for record in records if isinstance(record.get("Last Updated"), dt.date)),
        default=today,
    )

    return "\n".join([
        "| Papers tracked | Cycles | Accepted | Under review | In preparation | Next deadline |",
        "|:--:|:--:|:--:|:--:|:--:|:--:|",
        f"| **{len(records)}** | {cycle_span} | **{accepted}** | **{in_review}** | **{planned}** | {next_deadline} |",
        "",
        f"<sub>Snapshot generated from [`data/publications.xlsx`](data/publications.xlsx) · data last updated {format_date(latest_update)}</sub>",
        "",
    ])


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
    marker = "{{SUMMARY}}"
    if template.count(marker) != 1:
        raise SystemExit(f"{TEMPLATE} must contain exactly one {marker} marker")
    WEB_DATA.write_text(export_web_data(records), encoding="utf-8")
    OUTPUT.write_text(template.replace(marker, render_summary(records)), encoding="utf-8")
    print(f"Generated README and web data from {len(records)} publication records")


if __name__ == "__main__":
    main()
