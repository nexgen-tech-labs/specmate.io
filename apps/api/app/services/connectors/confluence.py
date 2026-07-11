"""Confluence Cloud page connector (Issue #12, stretch) — pulls a page's content as
a Source with section-heading location pointers. Auth: Atlassian email + API token
(shared with the Jira connector). OAuth and a space/page browse picker are deferred
until a per-workspace connection store exists — pages are synced by ID for now."""

from __future__ import annotations

from dataclasses import dataclass
from html.parser import HTMLParser

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError
from app.services.parsing.types import ParsedChunk

_HEADING_TAGS = {"h1": 1, "h2": 2, "h3": 3, "h4": 4, "h5": 5, "h6": 6}
_BLOCK_TAGS = {"p", "li", "td", "th", "pre", "blockquote"}


@dataclass(frozen=True)
class ConfluencePage:
    page_id: str
    title: str
    html: str


class _SectionExtractor(HTMLParser):
    """Walks Confluence storage-format HTML, tracking the heading hierarchy the same
    way the docx parser tracks paragraph heading styles."""

    def __init__(self) -> None:
        super().__init__()
        self.heading_stack: list[str] = []
        self.blocks: list[tuple[str, str]] = []  # (section_path, text)
        self._heading_level: int | None = None
        self._buffer: list[str] = []
        self._in_block = False

    def handle_starttag(self, tag: str, attrs: list[tuple[str, str | None]]) -> None:
        if tag in _HEADING_TAGS:
            self._heading_level = _HEADING_TAGS[tag]
            self._buffer = []
        elif tag in _BLOCK_TAGS:
            self._in_block = True
            self._buffer = []

    def handle_endtag(self, tag: str) -> None:
        text = "".join(self._buffer).strip()
        if tag in _HEADING_TAGS and self._heading_level is not None:
            if text:
                self.heading_stack = self.heading_stack[: self._heading_level - 1]
                self.heading_stack.append(text)
            self._heading_level = None
            self._buffer = []
        elif tag in _BLOCK_TAGS and self._in_block:
            if text:
                self.blocks.append(("/".join(self.heading_stack), text))
            self._in_block = False
            self._buffer = []

    def handle_data(self, data: str) -> None:
        if self._heading_level is not None or self._in_block:
            self._buffer.append(data)


def extract_confluence_chunks(page_title: str, html: str) -> list[ParsedChunk]:
    """Pure extraction: storage-format HTML -> chunks with "{pageTitle}/{heading}"
    pointers (falling back to just the page title above any heading)."""
    extractor = _SectionExtractor()
    extractor.feed(html)

    chunks: list[ParsedChunk] = []
    for order, (heading_path, text) in enumerate(extractor.blocks):
        section = f"{page_title}/{heading_path}" if heading_path else page_title
        chunks.append(ParsedChunk(text=text, section_path=section, order=order))

    if not chunks:
        raise ConnectorError(f"Confluence page '{page_title}' contains no extractable text.")
    return chunks


async def fetch_confluence_page(page_id: str) -> ConfluencePage:
    if not (
        settings.confluence_base_url
        and settings.atlassian_email
        and settings.atlassian_api_token
    ):
        raise ConnectorError(
            "Confluence connector is not configured — set CONFLUENCE_BASE_URL, "
            "ATLASSIAN_EMAIL, and ATLASSIAN_API_TOKEN."
        )

    auth = (settings.atlassian_email, settings.atlassian_api_token)
    async with httpx.AsyncClient(auth=auth, timeout=30) as client:
        try:
            response = await client.get(
                f"{settings.confluence_base_url}/wiki/api/v2/pages/{page_id}",
                params={"body-format": "storage"},
            )
            response.raise_for_status()
        except httpx.HTTPError as exc:
            raise ConnectorError(f"Confluence API request failed: {exc}") from exc

    payload = response.json()
    body = payload.get("body") or {}
    storage = body.get("storage") or {}
    return ConfluencePage(
        page_id=str(payload.get("id", page_id)),
        title=str(payload.get("title") or f"Confluence page {page_id}"),
        html=str(storage.get("value") or ""),
    )
