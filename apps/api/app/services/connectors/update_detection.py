"""Update-vs-create detection for publishing (Issue 9.4): when a DraftItem being
published is a targeted-regeneration revision (Issue 9.2 — revisionOfId chain) of
an item that's already published, this resolves to the existing PublishedItem row
so the router updates the external issue in place instead of creating a duplicate."""

from __future__ import annotations

from dataclasses import dataclass

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.models import DraftItem, PublishedItem, PublishTarget


@dataclass(frozen=True)
class ExistingPublication:
    published_item_id: str
    external_key: str
    external_url: str


async def find_existing_publication(
    session: AsyncSession, item: DraftItem, tool: PublishTarget
) -> ExistingPublication | None:
    """Walks the revisionOfId chain (there's at most one hop today, but this walks
    to be safe against future multi-hop revision chains) looking for a still-active
    PublishedItem on the same tool. Returns None for a genuinely new item."""
    seen: set[str] = set()
    current_id = item.revisionOfId
    while current_id and current_id not in seen:
        seen.add(current_id)
        published = (
            await session.execute(
                select(PublishedItem).where(
                    PublishedItem.draftItemId == current_id,
                    PublishedItem.targetTool == tool,
                    PublishedItem.deletedAt.is_(None),
                )
            )
        ).scalar_one_or_none()
        if published is not None:
            return ExistingPublication(
                published_item_id=published.id,
                external_key=published.externalKey,
                external_url=published.externalUrl,
            )
        previous = await session.get(DraftItem, current_id)
        current_id = previous.revisionOfId if previous else None
    return None
