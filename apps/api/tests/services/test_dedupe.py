from app.services.parsing.dedupe import dedupe_chunks
from app.services.parsing.types import ParsedChunk


def _chunk(text: str, path: str, order: int) -> ParsedChunk:
    return ParsedChunk(text=text, section_path=path, order=order)


def test_exact_duplicates_within_a_source_are_dropped() -> None:
    chunks = [
        _chunk("Company Confidential", "#header", 0),
        _chunk("Real requirement.", "p.1", 1),
        _chunk("Company Confidential", "#footer", 2),
    ]
    deduped = dedupe_chunks(chunks)
    assert [c.text for c in deduped] == ["Company Confidential", "Real requirement."]


def test_dedup_is_whitespace_and_case_insensitive() -> None:
    chunks = [
        _chunk("The system  shall support refunds.", "p.1", 0),
        _chunk("the system shall support REFUNDS.", "p.5", 1),
    ]
    assert len(dedupe_chunks(chunks)) == 1


def test_order_is_renumbered_contiguously_and_first_occurrence_kept() -> None:
    chunks = [
        _chunk("A", "p.1", 0),
        _chunk("A", "p.2", 1),
        _chunk("B", "p.3", 2),
    ]
    deduped = dedupe_chunks(chunks)
    assert [(c.text, c.section_path, c.order) for c in deduped] == [
        ("A", "p.1", 0),
        ("B", "p.3", 1),
    ]
