"""Azure DevOps delegated OAuth authorization-code flow for per-workspace
connector auth (Issue 10.4) — the wizard's ADO OAuth step. Mirrors
jira_oauth.py's shape closely: ADO delegated tokens expire and need a stored
refresh token, so encryptedCredentials holds a JSON blob {access_token,
refresh_token, expires_at} rather than a bare token string. Unlike Jira, ADO
has no per-tenant "accessible resources" discovery step — the organization is
already fixed by ADO_ORG_URL (this connector targets one ops-configured ADO
organization, same as the existing PAT/app-only paths), so Connection.scope
just carries that org_url for resolve_ado_connection to read back."""

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
from app.models import Connection, OrgWizardSession, WizardSession
from app.services.connectors.ado_auth import (
    ADO_DELEGATED_SCOPES,
    exchange_ado_oauth_code_for_tokens,
)
from app.services.connectors.types import ConnectorError
from app.services.crypto import encrypt_credentials

router = APIRouter()


def _now() -> datetime:
    return datetime.now(UTC).replace(tzinfo=None)


def _ado_redirect_uri() -> str:
    # Microsoft Entra calls this URL directly (same reasoning as Jira's
    # redirect_uri, see jira_oauth.py) — must match exactly between /start and
    # /callback, or the token exchange is rejected with a redirect_uri mismatch.
    return settings.api_base_url_external + "/connectors/ado/oauth/callback"


@router.get("/connectors/ado/oauth/start")
async def start_ado_oauth(
    wizard_session_id: str | None = None, org_wizard_session_id: str | None = None
) -> RedirectResponse:
    if (wizard_session_id is None) == (org_wizard_session_id is None):
        raise HTTPException(
            status_code=400, detail="Pass exactly one of wizard_session_id or org_wizard_session_id."
        )
    if not (settings.azure_ad_client_id and settings.azure_ad_tenant_id):
        raise HTTPException(status_code=503, detail="Azure AD app is not configured.")
    state = wizard_session_id if wizard_session_id is not None else org_wizard_session_id
    params = urlencode(
        {
            "client_id": settings.azure_ad_client_id,
            "scope": ADO_DELEGATED_SCOPES,
            "redirect_uri": _ado_redirect_uri(),
            "state": state,
            "response_type": "code",
            "prompt": "consent",
        }
    )
    authorize_url = (
        f"https://login.microsoftonline.com/{settings.azure_ad_tenant_id}/oauth2/v2.0/authorize"
    )
    return RedirectResponse(f"{authorize_url}?{params}")


async def _upsert_connection(
    session: AsyncSession,
    *,
    workspace_id: str | None,
    organization_id: str | None,
    encrypted: bytes,
    scope: dict[str, object],
    now: datetime,
) -> None:
    """Shared upsert-by-unique-constraint logic for both workspace- and
    org-scoped ADO Connections — mirrors jira_oauth.py's equivalent."""
    scope_column = Connection.workspaceId if workspace_id is not None else Connection.organizationId
    scope_id = workspace_id if workspace_id is not None else organization_id

    existing = (
        await session.execute(
            select(Connection).where(scope_column == scope_id, Connection.toolKey == "ado")
        )
    ).scalar_one_or_none()
    if existing:
        existing.authMethod = "OAUTH"
        existing.encryptedCredentials = encrypted
        existing.scope = scope
        existing.updatedAt = now
        await session.commit()
        return

    # Two concurrent callbacks for the same `state` can both reach this
    # branch after both seeing no existing row — the unique constraint means
    # only one INSERT wins. Fall back to updating the row the other request
    # just created rather than surfacing an unhandled IntegrityError.
    session.add(
        Connection(
            workspaceId=workspace_id,
            organizationId=organization_id,
            toolKey="ado",
            authMethod="OAUTH",
            encryptedCredentials=encrypted,
            scope=scope,
            createdAt=now,
            updatedAt=now,
        )
    )
    try:
        await session.commit()
    except IntegrityError:
        await session.rollback()
        winner = (
            await session.execute(
                select(Connection).where(scope_column == scope_id, Connection.toolKey == "ado")
            )
        ).scalar_one()
        winner.authMethod = "OAUTH"
        winner.encryptedCredentials = encrypted
        winner.scope = scope
        winner.updatedAt = now
        await session.commit()


@router.get("/connectors/ado/oauth/callback")
async def ado_oauth_callback(
    code: str,
    state: str,
    session: Annotated[AsyncSession, Depends(get_db_session)],
) -> RedirectResponse:
    now = _now()
    wizard_session = await session.get(WizardSession, state)
    org_wizard_session = None if wizard_session else await session.get(OrgWizardSession, state)

    if wizard_session and wizard_session.expiresAt < now:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")
    if org_wizard_session and org_wizard_session.expiresAt < now:
        raise HTTPException(status_code=404, detail="Org wizard session not found or expired.")
    if not wizard_session and not org_wizard_session:
        raise HTTPException(status_code=404, detail="Wizard session not found or expired.")

    if not settings.ado_org_url:
        raise HTTPException(status_code=503, detail="ADO connection is not configured — set ADO_ORG_URL.")

    try:
        tokens = await exchange_ado_oauth_code_for_tokens(code, _ado_redirect_uri())
    except ConnectorError as exc:
        raise HTTPException(status_code=502, detail=str(exc)) from exc

    credentials_json = json.dumps(
        {
            "access_token": tokens.access_token,
            "refresh_token": tokens.refresh_token,
            "expires_at": time.time() + tokens.expires_in,
        }
    )
    encrypted = encrypt_credentials(credentials_json)
    scope: dict[str, object] = {"org_url": settings.ado_org_url}

    if wizard_session:
        await _upsert_connection(
            session,
            workspace_id=wizard_session.workspaceId,
            organization_id=None,
            encrypted=encrypted,
            scope=scope,
            now=now,
        )
        wizard_session = await session.get(WizardSession, state)
        assert wizard_session is not None
        wizard_session.currentStep = "select_scope"
        await session.commit()
        redirect_url = (
            f"{settings.web_base_url}/workspaces/{wizard_session.workspaceId}"
            f"/projects/{wizard_session.projectId}/connect/ado?oauth=success"
        )
        return RedirectResponse(redirect_url)

    assert org_wizard_session is not None
    await _upsert_connection(
        session,
        workspace_id=None,
        organization_id=org_wizard_session.organizationId,
        encrypted=encrypted,
        scope=scope,
        now=now,
    )
    org_wizard_session = await session.get(OrgWizardSession, state)
    assert org_wizard_session is not None
    org_wizard_session.currentStep = "confirm"
    await session.commit()
    redirect_url = (
        f"{settings.web_base_url}/organizations/{org_wizard_session.organizationId}"
        f"/connect/ado?oauth=success"
    )
    return RedirectResponse(redirect_url)
