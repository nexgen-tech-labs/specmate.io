"""WizardSession create/get/update/resume endpoints (Issue #101) — tracks a
user's progress through the connector setup wizard so a browser refresh or
OAuth-redirect round-trip can resume into the right step instead of
restarting."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import WizardSession

router = APIRouter()
SESSION_TTL = timedelta(hours=1)


class WizardSessionResponse(BaseModel):
    id: str
    tool_key: str
    current_step: str
    collected_state: dict[str, object]
    expires_at: str


def _to_response(ws: WizardSession) -> WizardSessionResponse:
    return WizardSessionResponse(
        id=ws.id,
        tool_key=ws.toolKey,
        current_step=ws.currentStep,
        collected_state=ws.collectedState,
        expires_at=ws.expiresAt.isoformat(),
    )


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


class CreateWizardSessionBody(BaseModel):
    tool_key: str


@router.post("/workspaces/{workspace_id}/projects/{project_id}/wizard-sessions")
async def create_wizard_session(
    workspace_id: str,
    project_id: str,
    body: CreateWizardSessionBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    now = _now()
    ws = WizardSession(
        workspaceId=workspace_id,
        projectId=project_id,
        toolKey=body.tool_key,
        currentStep="choose_tool",
        collectedState={},
        createdAt=now,
        expiresAt=now + SESSION_TTL,
    )
    session.add(ws)
    await session.flush()
    await session.commit()
    return _to_response(ws)


@router.get("/wizard-sessions/{wizard_session_id}")
async def get_wizard_session(
    wizard_session_id: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    ws = await session.get(WizardSession, wizard_session_id)
    if not ws or ws.expiresAt < _now():
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")
    return _to_response(ws)


class UpdateWizardSessionBody(BaseModel):
    current_step: str | None = None
    collected_state: dict[str, object] | None = None


@router.patch("/wizard-sessions/{wizard_session_id}")
async def update_wizard_session(
    wizard_session_id: str,
    body: UpdateWizardSessionBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    ws = await session.get(WizardSession, wizard_session_id)
    if not ws or ws.expiresAt < _now():
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")
    if body.current_step is not None:
        ws.currentStep = body.current_step
    if body.collected_state is not None:
        ws.collectedState = body.collected_state
    await session.commit()
    return _to_response(ws)


@router.get("/workspaces/{workspace_id}/projects/{project_id}/wizard-sessions/resume")
async def resume_wizard_session(
    workspace_id: str,
    project_id: str,
    tool_key: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> WizardSessionResponse:
    now = _now()
    ws = (
        (
            await session.execute(
                select(WizardSession)
                .where(
                    WizardSession.workspaceId == workspace_id,
                    WizardSession.projectId == project_id,
                    WizardSession.toolKey == tool_key,
                    WizardSession.expiresAt >= now,
                )
                .order_by(WizardSession.createdAt.desc())
            )
        )
        .scalars()
        .first()
    )
    if not ws:
        raise HTTPException(status_code=404, detail="No active wizard session to resume.")
    return _to_response(ws)
