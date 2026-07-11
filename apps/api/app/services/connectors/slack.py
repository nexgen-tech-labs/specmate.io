"""Slack channel connector (Issue #13, stretch — Slack chosen over Teams for v1).
Pulls a channel's message history as a Source with {channel, author, timestamp}
location pointers. Auth: bot token (SLACK_BOT_TOKEN). OAuth and a channel picker
are deferred — channels are synced by ID for now.

Noise filtering: bot messages (bot_id), system messages (any subtype, e.g. joins/
renames), and messages with no text (reactions-only) are excluded by default."""

from __future__ import annotations

from datetime import UTC, datetime

import httpx

from app.core.config import settings
from app.services.connectors.types import ConnectorError
from app.services.parsing.types import ParsedChunk

_PAGE_SIZE = 200


def _format_ts(slack_ts: str) -> str:
    """Slack ts is epoch-seconds with a suffix ("1728412800.000100") -> ISO minute."""
    try:
        moment = datetime.fromtimestamp(float(slack_ts), tz=UTC)
        return moment.strftime("%Y-%m-%d %H:%M")
    except (ValueError, OverflowError):
        return slack_ts


def filter_and_chunk_messages(
    messages: list[dict[str, object]], channel_label: str
) -> list[ParsedChunk]:
    """Pure filtering/chunking: one chunk per human message, oldest first, pointer
    "#{channel}@{timestamp}", text "{author}: {message}"."""
    ordered = sorted(messages, key=lambda m: str(m.get("ts", "")))
    chunks: list[ParsedChunk] = []
    order = 0
    for message in ordered:
        if message.get("bot_id") or message.get("subtype"):
            continue
        text = str(message.get("text") or "").strip()
        if not text:
            continue
        author = str(message.get("user") or "unknown")
        ts = _format_ts(str(message.get("ts", "")))
        chunks.append(
            ParsedChunk(
                text=f"{author}: {text}",
                section_path=f"#{channel_label}@{ts}",
                order=order,
            )
        )
        order += 1

    if not chunks:
        raise ConnectorError(
            f"Channel '{channel_label}' contains no human messages to extract."
        )
    return chunks


async def fetch_slack_messages(channel_id: str) -> list[dict[str, object]]:
    if not settings.slack_bot_token:
        raise ConnectorError("Slack connector is not configured — set SLACK_BOT_TOKEN.")

    headers = {"Authorization": f"Bearer {settings.slack_bot_token}"}
    messages: list[dict[str, object]] = []
    cursor: str | None = None

    async with httpx.AsyncClient(headers=headers, timeout=30) as client:
        while True:
            params: dict[str, str | int] = {"channel": channel_id, "limit": _PAGE_SIZE}
            if cursor:
                params["cursor"] = cursor
            try:
                response = await client.get(
                    "https://slack.com/api/conversations.history", params=params
                )
                response.raise_for_status()
            except httpx.HTTPError as exc:
                raise ConnectorError(f"Slack API request failed: {exc}") from exc

            payload = response.json()
            if not payload.get("ok"):
                raise ConnectorError(f"Slack API error: {payload.get('error', 'unknown')}")

            messages.extend(payload.get("messages", []))
            cursor = (payload.get("response_metadata") or {}).get("next_cursor")
            if not cursor:
                break

    return messages
