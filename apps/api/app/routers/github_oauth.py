"""GitHub OAuth authorization-code flow for per-workspace connector auth
(Issue #101) — the wizard's OAuth step. Distinct from Issue #95's user-login
GitHub OAuth (different app registration, different purpose: this
authenticates SpecMate's ACCESS TO A REPO on behalf of a workspace, not a
person's identity)."""

from __future__ import annotations

from datetime import UTC, datetime
from typing import Annotated
from urllib.parse import urlencode

from fastapi import APIRouter, Depends, HTTPException
from fastapi.responses import RedirectResponse
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.ext.asyncio import AsyncSession

from app.core.config import settings
from app.core.db import get_db_session
from app.models import Connection, WizardSession
from app.services.connectors.github_auth import exchange_oauth_code_for_token
from app.services.connectors.types import ConnectorError
from app.services.crypto import encrypt_credentials

router = APIRouter()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


@router.get("/connectors/github/oauth/start")
async def start_github_oauth(wizard_session_id: str) -> RedirectResponse:
    if not settings.github_oauth_app_client_id:
        raise HTTPException(status_code=503, detail="GitHub OAuth App is not configured.")
    params = urlencode(
        {
            "client_id": settings.github_oauth_app_client_id,
            "scope": "repo",
            "state": wizard_session_id,
        }
    )
    return RedirectResponse(f"https://github.com/login/oauth/authorize?{params}")


@router.get("/connectors/github/oauth/callback")
async def github_oauth_callback(
    code: str,
    state: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> RedirectResponse:
    # Task 9: redirects back into the apps/web wizard UI (rather than returning
    # raw JSON) once the token exchange completes, since the wizard shell now
    # exists and needs a real browser navigation to resume. workspaceId/projectId
    # aren't in the callback's own query params (only the wizard_session_id is,
    # via `state`) — they're read off the WizardSession row instead.
    wizard_session = await session.get(WizardSession, state)
    now = _now()
    if not wizard_session or wizard_session.expiresAt < now:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")

    try:
        token = await exchange_oauth_code_for_token(code)
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    encrypted = encrypt_credentials(token)

    existing = (
        await session.execute(
            select(Connection).where(
                Connection.workspaceId == wizard_session.workspaceId,
                Connection.toolKey == "github",
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.authMethod = "OAUTH"
        existing.encryptedCredentials = encrypted
        existing.updatedAt = now
        wizard_session.currentStep = "select_scope"
        await session.commit()
    else:
        # Two concurrent callbacks for the same `state` (e.g. a double-submitted
        # OAuth redirect) can both reach this branch after both seeing no
        # existing row — the @@unique([workspaceId, toolKey]) constraint means
        # only one INSERT wins. Fall back to updating the row the other request
        # just created rather than surfacing an unhandled IntegrityError.
        session.add(
            Connection(
                workspaceId=wizard_session.workspaceId,
                toolKey="github",
                authMethod="OAUTH",
                encryptedCredentials=encrypted,
                createdAt=now,
                updatedAt=now,
            )
        )
        wizard_session.currentStep = "select_scope"
        workspace_id = wizard_session.workspaceId
        try:
            await session.commit()
        except IntegrityError:
            await session.rollback()
            winner = (
                await session.execute(
                    select(Connection).where(
                        Connection.workspaceId == workspace_id,
                        Connection.toolKey == "github",
                    )
                )
            ).scalar_one()
            winner.authMethod = "OAUTH"
            winner.encryptedCredentials = encrypted
            winner.updatedAt = now
            wizard_session = await session.get(WizardSession, state)
            assert wizard_session is not None
            wizard_session.currentStep = "select_scope"
            await session.commit()

    redirect_url = (
        f"{settings.web_base_url}/workspaces/{wizard_session.workspaceId}"
        f"/projects/{wizard_session.projectId}/connect/github?oauth=success"
    )
    return RedirectResponse(redirect_url)
