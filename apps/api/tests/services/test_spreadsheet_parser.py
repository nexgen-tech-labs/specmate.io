import io

import pytest
from openpyxl import Workbook

from app.services.parsing.spreadsheet_parser import SpreadsheetParseError, parse_csv, parse_xlsx


def _build_xlsx(sheets: dict[str, list[list[object]]]) -> bytes:
    wb = Workbook()
    default = wb.active
    assert default is not None
    for i, (title, rows) in enumerate(sheets.items()):
        ws = default if i == 0 else wb.create_sheet()
        ws.title = title
        for row in rows:
            ws.append(row)
    buf = io.BytesIO()
    wb.save(buf)
    return buf.getvalue()


def test_multi_sheet_xlsx_tags_rows_with_sheet_name_and_real_row_number() -> None:
    xlsx = _build_xlsx(
        {
            "Backlog": [
                ["Feature", "Priority"],
                ["Login", "High"],
                ["Payments", "Medium"],
            ],
            "Risks": [
                ["Risk", "Severity"],
                ["Vendor lock-in", "Low"],
            ],
        }
    )
    chunks = parse_xlsx(xlsx)

    assert [c.section_path for c in chunks] == ["Backlog/r.2", "Backlog/r.3", "Risks/r.2"]
    assert chunks[0].text == "Feature: Login | Priority: High"
    assert chunks[2].text == "Risk: Vendor lock-in | Severity: Low"
    assert [c.order for c in chunks] == [0, 1, 2]


def test_xlsx_empty_rows_are_skipped_but_row_numbers_stay_real() -> None:
    xlsx = _build_xlsx(
        {
            "Sheet1": [
                ["Feature"],
                ["Login"],
                [None],
                ["Payments"],
            ]
        }
    )
    chunks = parse_xlsx(xlsx)
    assert [c.section_path for c in chunks] == ["Sheet1/r.2", "Sheet1/r.4"]


def test_csv_with_inconsistent_column_counts_does_not_crash() -> None:
    csv_bytes = b"Feature,Priority\nLogin,High,ExtraCell\nPayments\nReports,Low\n"
    chunks = parse_csv(csv_bytes)

    assert [c.section_path for c in chunks] == ["r.2", "r.3", "r.4"]
    assert chunks[0].text == "Feature: Login | Priority: High | ExtraCell"
    assert chunks[1].text == "Feature: Payments"


def test_csv_empty_rows_are_skipped() -> None:
    csv_bytes = b"Feature,Priority\nLogin,High\n\n,,\nReports,Low\n"
    chunks = parse_csv(csv_bytes)
    assert [c.section_path for c in chunks] == ["r.2", "r.5"]


def test_csv_without_header_mode_keeps_all_rows() -> None:
    csv_bytes = b"Login,High\nPayments,Medium\n"
    chunks = parse_csv(csv_bytes, has_header=False)
    assert [c.section_path for c in chunks] == ["r.1", "r.2"]
    assert chunks[0].text == "Login | High"


def test_csv_with_utf8_bom_is_decoded_cleanly() -> None:
    csv_bytes = "﻿Feature,Priority\nLogin,High\n".encode()
    chunks = parse_csv(csv_bytes)
    assert chunks[0].text == "Feature: Login | Priority: High"


def test_corrupt_xlsx_raises_spreadsheet_parse_error() -> None:
    with pytest.raises(SpreadsheetParseError):
        parse_xlsx(b"not an xlsx file")


def test_empty_workbook_raises_not_silent_empty_result() -> None:
    xlsx = _build_xlsx({"Sheet1": []})
    with pytest.raises(SpreadsheetParseError):
        parse_xlsx(xlsx)


def test_empty_csv_raises_not_silent_empty_result() -> None:
    with pytest.raises(SpreadsheetParseError):
        parse_csv(b"\n\n")
