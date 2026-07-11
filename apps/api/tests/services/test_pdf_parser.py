import io

from reportlab.pdfgen import canvas

import pytest

from app.services.parsing.pdf_parser import PdfParseError, parse_pdf


def _build_pdf(page_texts: list[str | None]) -> bytes:
    """Builds a real multi-page PDF via reportlab. `None` in page_texts produces a
    blank page (nothing drawn) — used to simulate scanned/image-only pages."""
    buf = io.BytesIO()
    c = canvas.Canvas(buf)
    for text in page_texts:
        if text is not None:
            c.drawString(100, 750, text)
        c.showPage()
    c.save()
    return buf.getvalue()


def test_multi_page_pdf_produces_chunks_tagged_with_correct_page_numbers() -> None:
    pdf_bytes = _build_pdf(["Page one text.", "Page two text.", "Page three text."])
    chunks = parse_pdf(pdf_bytes)

    assert [c.section_path for c in chunks] == ["p.1", "p.2", "p.3"]
    assert [c.text for c in chunks] == ["Page one text.", "Page two text.", "Page three text."]
    assert [c.order for c in chunks] == [0, 1, 2]


def test_scanned_image_only_pdf_raises_clear_error_not_silent_empty_result() -> None:
    pdf_bytes = _build_pdf([None, None])
    with pytest.raises(PdfParseError, match="scanned/image-only"):
        parse_pdf(pdf_bytes)


def test_mixed_pdf_skips_blank_pages_but_keeps_correct_page_numbers() -> None:
    pdf_bytes = _build_pdf(["First page text.", None, "Third page text."])
    chunks = parse_pdf(pdf_bytes)

    assert [c.section_path for c in chunks] == ["p.1", "p.3"]
    assert [c.text for c in chunks] == ["First page text.", "Third page text."]
    assert [c.order for c in chunks] == [0, 1]


def test_corrupt_file_raises_pdf_parse_error() -> None:
    with pytest.raises(PdfParseError):
        parse_pdf(b"this is not a valid pdf file at all")
