import pytest

from app.services.parsing.text_parser import TextParseError, parse_text

TRANSCRIPT = b"""[00:00:05] Priya: Welcome everyone, let's review the payment requirements.
[00:01:12] Marcus: Customers need to pay invoices with saved cards.
This should also cover bank transfers.
[00:03:45] Priya: Agreed. We also need refund handling.
"""


def test_transcript_chunks_are_tagged_with_nearest_preceding_timestamp() -> None:
    chunks = parse_text(TRANSCRIPT)

    assert [c.section_path for c in chunks] == ["00:00:05", "00:01:12", "00:03:45"]
    # The continuation line (no timestamp) folds into the preceding chunk.
    assert "bank transfers" in chunks[1].text
    assert [c.order for c in chunks] == [0, 1, 2]


def test_transcript_with_dash_separator_format_is_detected() -> None:
    text = b"00:05 - First point.\n01:12 - Second point.\n02:45 - Third point.\n"
    chunks = parse_text(text)
    assert [c.section_path for c in chunks] == ["00:05", "01:12", "02:45"]


def test_plain_text_parses_into_paragraph_numbered_chunks() -> None:
    text = b"First paragraph line one.\nStill first paragraph.\n\nSecond paragraph.\n\n\nThird.\n"
    chunks = parse_text(text)

    assert [c.section_path for c in chunks] == ["p.1", "p.2", "p.3"]
    assert chunks[0].text == "First paragraph line one.\nStill first paragraph."
    assert chunks[1].text == "Second paragraph."


def test_prose_mentioning_a_time_once_stays_in_paragraph_mode() -> None:
    text = b"The meeting at 10:30 covered many topics.\n\nSecond paragraph here."
    chunks = parse_text(text)
    assert [c.section_path for c in chunks] == ["p.1", "p.2"]


def test_chunking_never_splits_a_sentence() -> None:
    # Chunk boundaries are timestamps or blank lines only — a multi-sentence
    # paragraph stays whole.
    text = b"Sentence one. Sentence two. Sentence three.\n\nNext paragraph."
    chunks = parse_text(text)
    assert chunks[0].text == "Sentence one. Sentence two. Sentence three."


def test_empty_file_raises_not_silent_empty_result() -> None:
    with pytest.raises(TextParseError):
        parse_text(b"   \n  \n")
