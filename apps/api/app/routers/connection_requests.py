"""ConnectionRequest permission-mismatch fallback flow (Issue #101). When a
workspace admin's own credentials can't reach a tool project/repo (GitHub
OAuth consent denial, or env-configured discovery returning zero accessible
projects for Jira/ADO), this lets them generate a shareable link for the
tool's actual admin to grant access — without that tool admin needing a
SpecMate account of their own.

The GET /connection-requests/{token} and POST /connection-requests/{token}/complete
endpoints are deliberately unauthenticated: the whole point of this flow is
that the person completing it (a Jira/ADO/GitHub admin) may not have a
SpecMate login at all. The token itself, not a session, is the credential —
this is intentional, not a missing auth check."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated
from uuid import uuid4

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import ConnectionRequest

router = APIRouter()
REQUEST_TTL = timedelta(days=7)

_INSTRUCTIONS = {
    "jira": "Ask your Jira admin to grant SpecMate's configured service account access to this project.",
    "ado": "Ask your Azure DevOps admin to grant SpecMate's configured service account access to this project.",
    "github": "Ask a repository or organization admin to complete GitHub authorization for SpecMate.",
}


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class CreateConnectionRequestBody(BaseModel):
    tool_key: str
    requested_by_user_id: str


class ConnectionRequestResponse(BaseModel):
    id: str
    tool_key: str
    token: str
    status: str
    instructions: str
    expires_at: str


def _to_response(cr: ConnectionRequest) -> ConnectionRequestResponse:
    return ConnectionRequestResponse(
        id=cr.id,
        tool_key=cr.toolKey,
        token=cr.token,
        status=cr.status,
        instructions=_INSTRUCTIONS.get(cr.toolKey, "Contact your tool administrator for access."),
        expires_at=cr.expiresAt.isoformat(),
    )


@router.post("/workspaces/{workspace_id}/connection-requests")
async def create_connection_request(
    workspace_id: str,
    body: CreateConnectionRequestBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConnectionRequestResponse:
    now = _now()
    cr = ConnectionRequest(
        workspaceId=workspace_id,
        toolKey=body.tool_key,
        requestedByUserId=body.requested_by_user_id,
        token=uuid4().hex,
        status="SENT",
        createdAt=now,
        expiresAt=now + REQUEST_TTL,
    )
    session.add(cr)
    await session.commit()
    return _to_response(cr)


@router.get("/connection-requests/{token}")
async def get_connection_request(
    token: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConnectionRequestResponse:
    cr = (
        await session.execute(select(ConnectionRequest).where(ConnectionRequest.token == token))
    ).scalar_one_or_none()
    if not cr:
        raise HTTPException(status_code=404, detail="Request not found.")
    if cr.expiresAt < _now() and cr.status == "SENT":
        cr.status = "EXPIRED"
        await session.commit()
    return _to_response(cr)


@router.post("/connection-requests/{token}/complete")
async def complete_connection_request(
    token: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ConnectionRequestResponse:
    cr = (
        await session.execute(select(ConnectionRequest).where(ConnectionRequest.token == token))
    ).scalar_one_or_none()
    if not cr:
        raise HTTPException(status_code=404, detail="Request not found.")
    if cr.expiresAt < _now() and cr.status == "SENT":
        cr.status = "EXPIRED"
    if cr.status != "SENT":
        await session.commit()
        raise HTTPException(status_code=409, detail=f"Request is already {cr.status.lower()}.")
    cr.status = "COMPLETED"
    await session.commit()
    return _to_response(cr)


@router.get("/workspaces/{workspace_id}/connection-requests")
async def list_connection_requests(
    workspace_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> list[ConnectionRequestResponse]:
    rows = (
        (
            await session.execute(
                select(ConnectionRequest)
                .where(ConnectionRequest.workspaceId == workspace_id)
                .order_by(ConnectionRequest.createdAt.desc())
            )
        )
        .scalars()
        .all()
    )
    return [_to_response(r) for r in rows]
