"""Org-level connector authorization endpoints (Onboarding Flow redesign):
"authorize a tool once at the organization, every workspace picks its own
board/repo" — the org-scoped analogue of wizard_sessions.py + the
test_connection/scope-discovery endpoint in connectors.py."""

from __future__ import annotations

from datetime import UTC, datetime, timedelta
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel
from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.db import get_db_session
from app.models import OrgWizardSession
from app.services.connectors.registry import CONNECTOR_REGISTRY
from app.services.connectors.types import ConnectorError

router = APIRouter()
SESSION_TTL = timedelta(hours=1)


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


# ---------- Resumable org wizard progress (mirrors wizard_sessions.py) ----------


class OrgWizardSessionResponse(BaseModel):
    id: str
    tool_key: str
    current_step: str
    collected_state: dict[str, object]
    expires_at: str


def _to_response(ws: OrgWizardSession) -> OrgWizardSessionResponse:
    return OrgWizardSessionResponse(
        id=ws.id,
        tool_key=ws.toolKey,
        current_step=ws.currentStep,
        collected_state=ws.collectedState,
        expires_at=ws.expiresAt.isoformat(),
    )


class CreateOrgWizardSessionBody(BaseModel):
    tool_key: str


@router.post("/organizations/{organization_id}/wizard-sessions")
async def create_org_wizard_session(
    organization_id: str,
    body: CreateOrgWizardSessionBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> OrgWizardSessionResponse:
    now = _now()
    ws = OrgWizardSession(
        organizationId=organization_id,
        toolKey=body.tool_key,
        currentStep="authenticate",
        collectedState={},
        createdAt=now,
        expiresAt=now + SESSION_TTL,
    )
    session.add(ws)
    await session.flush()
    await session.commit()
    return _to_response(ws)


@router.get("/organizations/{organization_id}/wizard-sessions/resume")
async def resume_org_wizard_session(
    organization_id: str,
    tool_key: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> OrgWizardSessionResponse:
    now = _now()
    ws = (
        (
            await session.execute(
                select(OrgWizardSession)
                .where(
                    OrgWizardSession.organizationId == organization_id,
                    OrgWizardSession.toolKey == tool_key,
                    OrgWizardSession.expiresAt >= now,
                )
                .order_by(OrgWizardSession.createdAt.desc())
            )
        )
        .scalars()
        .first()
    )
    if not ws:
        raise HTTPException(status_code=404, detail="No active org wizard session to resume.")
    return _to_response(ws)


class UpdateOrgWizardSessionBody(BaseModel):
    current_step: str | None = None
    collected_state: dict[str, object] | None = None


@router.patch("/org-wizard-sessions/{org_wizard_session_id}")
async def update_org_wizard_session(
    org_wizard_session_id: str,
    body: UpdateOrgWizardSessionBody,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> OrgWizardSessionResponse:
    ws = await session.get(OrgWizardSession, org_wizard_session_id)
    if not ws or ws.expiresAt < _now():
        raise HTTPException(status_code=404, detail="Org wizard session not found or expired.")
    if body.current_step is not None:
        ws.currentStep = body.current_step
    if body.collected_state is not None:
        ws.collectedState = body.collected_state
    await session.commit()
    return _to_response(ws)


# ---------- Scope discovery for the org-level connection (pick a board/repo) ----------


class ScopeOptionResponse(BaseModel):
    id: str
    label: str


class ScopeOptionsResponse(BaseModel):
    scope_options: list[ScopeOptionResponse]


_ORG_LEVEL_TOOLS = {"jira", "github"}


async def _resolve_org_connection(session: AsyncSession, tool_key: str, organization_id: str) -> object:
    """Org-level connection resolution — mirrors connectors.py's
    _resolve_connection. Caller must have already checked tool_key is in
    _ORG_LEVEL_TOOLS (ADO has no org-level Connection support yet, same gap
    as its workspace-level PAT-only auth)."""
    if tool_key == "jira":
        from app.services.connectors.jira_auth import resolve_jira_connection

        return await resolve_jira_connection(session, organization_id=organization_id)
    from app.services.connectors.github_auth import resolve_github_connection

    return await resolve_github_connection(session, organization_id=organization_id)


@router.get("/organizations/{organization_id}/connectors/{tool_key}/scope-options")
async def get_org_connector_scope_options(
    organization_id: str,
    tool_key: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> ScopeOptionsResponse:
    connector = CONNECTOR_REGISTRY.get(tool_key)
    if connector is None:
        raise HTTPException(status_code=404, detail=f"Unknown connector '{tool_key}'.")
    if tool_key not in _ORG_LEVEL_TOOLS:
        raise HTTPException(
            status_code=404, detail=f"'{tool_key}' has no org-level connector authorization."
        )

    try:
        connection = await _resolve_org_connection(session, tool_key, organization_id)
        result = await connector.discovery_fn(connection)
    except ConnectorError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 — surfaced as a clean 502, not a raw crash
        raise HTTPException(status_code=502, detail=f"Scope discovery failed: {exc}") from exc

    return ScopeOptionsResponse(
        scope_options=[
            ScopeOptionResponse(id=o.id, label=o.label) for o in result.scope_options
        ]
    )
