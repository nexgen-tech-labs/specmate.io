"""PDF rendering for snapshot exports (Issue 8.4) and approval reports (Issue 8.5).

Renders exclusively from an already-assembled trace map / report-row dict — never
queries the database — so a snapshot PDF is a pure function of the stored artifact
and stays accurate even if live data has since changed. Layout is deliberately
plain (title, metadata block, tables): legible for a non-technical client
stakeholder, no styling ambitions beyond that.
"""

from __future__ import annotations

import io
from typing import cast

from reportlab.lib import colors
from reportlab.lib.pagesizes import A4
from reportlab.lib.styles import ParagraphStyle, getSampleStyleSheet
from reportlab.lib.units import mm
from reportlab.platypus import Paragraph, SimpleDocTemplate, Spacer, Table, TableStyle

_styles = getSampleStyleSheet()
_BODY = ParagraphStyle("body", parent=_styles["BodyText"], fontSize=8, leading=10)
_H1 = _styles["Title"]
_H2 = _styles["Heading2"]
_META = ParagraphStyle("meta", parent=_styles["BodyText"], fontSize=9, textColor=colors.grey)

_TABLE_STYLE = TableStyle(
    [
        ("BACKGROUND", (0, 0), (-1, 0), colors.HexColor("#1f2a44")),
        ("TEXTCOLOR", (0, 0), (-1, 0), colors.white),
        ("FONTSIZE", (0, 0), (-1, -1), 8),
        ("GRID", (0, 0), (-1, -1), 0.4, colors.HexColor("#c8ccd6")),
        ("VALIGN", (0, 0), (-1, -1), "TOP"),
        ("ROWBACKGROUNDS", (0, 1), (-1, -1), [colors.white, colors.HexColor("#f4f5f8")]),
    ]
)


def _p(text: object) -> Paragraph:
    return Paragraph(str(text) if text is not None else "", _BODY)


def _doc(buffer: io.BytesIO, title: str) -> SimpleDocTemplate:
    return SimpleDocTemplate(
        buffer,
        pagesize=A4,
        title=title,
        leftMargin=14 * mm,
        rightMargin=14 * mm,
        topMargin=14 * mm,
        bottomMargin=14 * mm,
    )


def render_snapshot_pdf(trace_map: dict[str, object]) -> bytes:
    """Full trace-map snapshot: sources, then one row per item with decisions,
    citations, and external keys."""
    project = cast(dict[str, object], trace_map["project"])
    workspace = cast(dict[str, object], trace_map["workspace"])
    counts = cast(dict[str, object], trace_map["counts"])
    sources = cast(list[dict[str, object]], trace_map["sources"])
    items = cast(list[dict[str, object]], trace_map["items"])

    buffer = io.BytesIO()
    story: list[object] = [
        Paragraph(f"SpecMate Trace Snapshot — {project['name']}", _H1),
        Paragraph(
            f"Workspace: {workspace['name']} · Generated: {trace_map['generated_at']} · "
            f"{counts['items']} items · {counts['sources']} sources · "
            f"{counts['published']} published · {counts['decisions']} decisions",
            _META,
        ),
        Spacer(1, 6 * mm),
        Paragraph("Sources", _H2),
        Table(
            [["Name", "Kind", "Status"]]
            + [[_p(s["name"]), _p(s["kind"]), _p(s["status"])] for s in sources],
            colWidths=[100 * mm, 40 * mm, 40 * mm],
            style=_TABLE_STYLE,
            repeatRows=1,
        ),
        Spacer(1, 6 * mm),
        Paragraph("Items — full trace", _H2),
    ]

    rows: list[list[object]] = [["Type", "Title / Status", "Decisions", "Sources", "Published"]]
    for item in items:
        decisions = cast(list[dict[str, object]], item["decisions"])
        citations = cast(list[dict[str, object]], item["citations"])
        published = cast(list[dict[str, object]], item["published"])
        rows.append(
            [
                _p(item["type"]),
                _p(f"{item['title']} [{item['status']}]"),
                _p(
                    "<br/>".join(
                        f"{d['decision']} — {d['actor_name'] or d['actor_email']} ({d['at']})"
                        for d in decisions
                    )
                    or "—"
                ),
                _p(
                    "<br/>".join(
                        f"{c['source_name']} ({c['section_path']})" for c in citations
                    )
                    or "—"
                ),
                _p("<br/>".join(f"{p['tool']} {p['key']}" for p in published) or "—"),
            ]
        )
    story.append(
        Table(rows, colWidths=[16 * mm, 52 * mm, 42 * mm, 42 * mm, 28 * mm], style=_TABLE_STYLE, repeatRows=1)
    )

    _doc(buffer, f"SpecMate Trace Snapshot — {project['name']}").build(story)  # type: ignore[arg-type]
    return buffer.getvalue()


def render_approval_report_pdf(
    rows: list[dict[str, object]],
    project_name: str,
    workspace_name: str,
    generated_at: str,
    date_range: str | None = None,
) -> bytes:
    """Issue 8.5: sign-off document — approved items only, approver + timestamp +
    source citation per row. Workspace-branding placeholder in the header."""
    buffer = io.BytesIO()
    story: list[object] = [
        Paragraph(f"[{workspace_name}]", _META),  # branding placeholder
        Paragraph(f"Approval Report — {project_name}", _H1),
        Paragraph(
            f"Generated: {generated_at}"
            + (f" · Period: {date_range}" if date_range else "")
            + f" · {len(rows)} approved item(s)",
            _META,
        ),
        Spacer(1, 6 * mm),
    ]
    table_rows: list[list[object]] = [
        ["Item", "Type", "Approved by", "Approved at", "Source citation", "Published as"]
    ]
    for row in rows:
        published = cast(list[object], row["published"])
        table_rows.append(
            [
                _p(str(row["title"]) + (" ✓✓" if row["signed_off"] else "")),
                _p(row["type"]),
                _p(row["approver"]),
                _p(row["approved_at"]),
                _p(row["source_citation"]),
                _p(", ".join(str(p) for p in published) or "—"),
            ]
        )
    story.append(
        Table(
            table_rows,
            colWidths=[48 * mm, 16 * mm, 28 * mm, 30 * mm, 40 * mm, 20 * mm],
            style=_TABLE_STYLE,
            repeatRows=1,
        )
    )
    _doc(buffer, f"Approval Report — {project_name}").build(story)  # type: ignore[arg-type]
    return buffer.getvalue()
