"""Jira OAuth 3LO authorization-code flow for per-workspace connector auth
(fast-follow to Issue #101) — the wizard's Jira OAuth step. Mirrors
github_oauth.py's shape; the two real differences are (1) Jira access tokens
expire and need a stored refresh token, so encryptedCredentials holds a JSON
blob {access_token, refresh_token, expires_at} rather than a bare token
string, and (2) Jira has no fixed API host — the accessible-resources lookup
after token exchange discovers the cloudId gateway URL, stored in
Connection.scope rather than assumed from user input.

Open infrastructure question (not resolved here): Atlassian calls the Jira
OAuth redirect_uri directly, which needs this API's own externally-reachable
URL (settings.api_base_url_external). specmate-api's Container App ingress is
currently internal-only, unlike GitHub's OAuth flow, whose redirect_uri is
configured once in the GitHub OAuth App's settings and never sent by SpecMate
at request time. Before this ships to production, confirm with the user
whether to (a) make specmate-api's ingress external, or (b) route the Jira
OAuth callback through apps/web's already-external ingress via a proxy route
instead. settings.api_base_url_external defaults to http://localhost:8000 for
local dev, which is sufficient for this router's code and tests."""

from __future__ import annotations

import json
import time
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
from app.services.connectors.jira_auth import (
    discover_accessible_jira_sites,
    exchange_oauth_code_for_tokens,
)
from app.services.connectors.types import ConnectorError
from app.services.crypto import encrypt_credentials

router = APIRouter()

_JIRA_OAUTH_SCOPES = "read:jira-work write:jira-work offline_access"


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _jira_redirect_uri() -> str:
    # Atlassian calls this URL directly (unlike GitHub, whose redirect_uri is
    # configured once in the GitHub OAuth App's settings and never sent by
    # SpecMate) — needs this API's own externally-reachable URL. Must match
    # exactly between /start (sent as an authorize-URL param) and /callback
    # (passed to exchange_oauth_code_for_tokens), or Atlassian rejects the
    # exchange with a redirect_uri mismatch error.
    return settings.api_base_url_external + "/connectors/jira/oauth/callback"


@router.get("/connectors/jira/oauth/start")
async def start_jira_oauth(wizard_session_id: str) -> RedirectResponse:
    if not settings.jira_oauth_app_client_id:
        raise HTTPException(status_code=503, detail="Jira OAuth App is not configured.")
    params = urlencode(
        {
            "audience": "api.atlassian.com",
            "client_id": settings.jira_oauth_app_client_id,
            "scope": _JIRA_OAUTH_SCOPES,
            "redirect_uri": _jira_redirect_uri(),
            "state": wizard_session_id,
            "response_type": "code",
            "prompt": "consent",
        }
    )
    return RedirectResponse(f"https://auth.atlassian.com/authorize?{params}")


@router.get("/connectors/jira/oauth/callback")
async def jira_oauth_callback(
    code: str,
    state: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> RedirectResponse:
    wizard_session = await session.get(WizardSession, state)
    now = _now()
    if not wizard_session or wizard_session.expiresAt < now:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")

    try:
        tokens = await exchange_oauth_code_for_tokens(code, _jira_redirect_uri())
        sites = await discover_accessible_jira_sites(tokens.access_token)
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    # Auto-select the first accessible site — most users have exactly one
    # Jira Cloud site; a proper multi-site picker is an explicit fast-follow
    # (confirmed with the user during design, not guessed at here).
    cloud_id = sites[0].cloud_id

    credentials_json = json.dumps(
        {
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "expires_at": time.time() + tokens.expires_in,
        }
    )
    encrypted = encrypt_credentials(credentials_json)
    scope: dict[str, object] = {"cloud_id": cloud_id, "cloud_url": sites[0].url}

    existing = (
        await session.execute(
            select(Connection).where(
                Connection.workspaceId == wizard_session.workspaceId,
                Connection.toolKey == "jira",
            )
        )
    ).scalar_one_or_none()
    if existing:
        existing.authMethod = "OAUTH"
        existing.encryptedCredentials = encrypted
        existing.scope = scope
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
                toolKey="jira",
                authMethod="OAUTH",
                encryptedCredentials=encrypted,
                scope=scope,
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
                        Connection.toolKey == "jira",
                    )
                )
            ).scalar_one()
            winner.authMethod = "OAUTH"
            winner.encryptedCredentials = encrypted
            winner.scope = scope
            winner.updatedAt = now
            wizard_session = await session.get(WizardSession, state)
            assert wizard_session is not None
            wizard_session.currentStep = "select_scope"
            await session.commit()

    redirect_url = (
        f"{settings.web_base_url}/workspaces/{wizard_session.workspaceId}"
        f"/projects/{wizard_session.projectId}/connect/jira?oauth=success"
    )
    return RedirectResponse(redirect_url)
