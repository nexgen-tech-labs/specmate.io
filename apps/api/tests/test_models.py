import pytest
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine

from app.core.config import settings
from app.models import DraftItem, PublishedItem, RawRequirement, Source, TraceLink, Workspace


@pytest.mark.asyncio
async def test_models_reflect_existing_tables() -> None:
    """Structural check against the real Postgres instance migrated by Prisma.

    Requires local Postgres running with the Prisma migration applied
    (see README.md) — asserts the SQLAlchemy models can query every table
    the schema defines, i.e. models.py hasn't drifted from schema.prisma.
    """
    engine = create_async_engine(settings.database_url)
    async with AsyncSession(engine) as session:
        for model in (Workspace, Source, RawRequirement, DraftItem, PublishedItem, TraceLink):
            result = await session.execute(select(model).limit(1))
            result.first()
    await engine.dispose()
