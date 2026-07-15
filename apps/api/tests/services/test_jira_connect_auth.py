"""Issue 10.2: Connect JWT (2-Legged JWT) signing for outgoing Jira requests
via ConnectJwtConnection, and the QSH canonicalization it depends on. Verified
cross-checked against the same request signed by the Node-side
@atlassian/atlassian-jwt library (the source of truth for both implementations)."""

from __future__ import annotations

import time

import httpx
import jwt as pyjwt
import pytest

from app.services.connectors.jira_auth import (
    ConnectJwtAuth,
    ConnectJwtConnection,
    _query_string_hash,
)


def test_query_string_hash_matches_known_atlassian_jwt_js_output() -> None:
    """Cross-check against a real value produced by @atlassian/atlassian-jwt's
    createQueryStringHash for the exact same request (computed once via `node`
    against the installed package — see apps/web/src/lib/atlassian-connect.ts,
    which uses the same library on the other side of this integration)."""
    qsh = _query_string_hash(
        "POST", "http://localhost/api/atlassian-connect/uninstalled?jwt=x"
    )
    assert qsh == "ae97b179044675b0e81c7dc3a887dfb4b1483d2aef47b7892b79ecbba6f18b68"


def test_query_string_hash_excludes_the_jwt_param_itself() -> None:
    """The jwt query param can't be part of its own hash (chicken-and-egg) —
    Atlassian's spec explicitly excludes it from the canonical request."""
    with_jwt = _query_string_hash("GET", "http://x/y?a=1&jwt=abc")
    without_jwt = _query_string_hash("GET", "http://x/y?a=1")
    assert with_jwt == without_jwt


def test_query_string_hash_is_order_independent() -> None:
    a = _query_string_hash("GET", "http://x/y?b=2&a=1")
    b = _query_string_hash("GET", "http://x/y?a=1&b=2")
    assert a == b


def test_connect_jwt_auth_signs_with_valid_qsh_and_short_expiry() -> None:
    auth = ConnectJwtAuth(client_key="client-1", shared_secret="the-secret")
    request = httpx.Request("GET", "https://acme.atlassian.net/rest/api/3/myself")

    flow = auth.auth_flow(request)
    signed_request = next(flow)

    header = signed_request.headers["Authorization"]
    assert header.startswith("JWT ")
    token = header.removeprefix("JWT ")

    decoded = pyjwt.decode(token, "the-secret", algorithms=["HS256"])
    assert decoded["iss"] == "client-1"
    assert decoded["qsh"] == _query_string_hash("GET", str(request.url))
    assert decoded["exp"] - decoded["iat"] == 180
    assert decoded["iat"] <= int(time.time())


def test_connect_jwt_auth_rejects_tampering_with_a_different_secret() -> None:
    auth = ConnectJwtAuth(client_key="client-1", shared_secret="the-secret")
    request = httpx.Request("GET", "https://acme.atlassian.net/rest/api/3/myself")
    signed_request = next(auth.auth_flow(request))
    token = signed_request.headers["Authorization"].removeprefix("JWT ")

    with pytest.raises(pyjwt.InvalidSignatureError):
        pyjwt.decode(token, "wrong-secret", algorithms=["HS256"])


def test_connect_jwt_connection_exposes_the_protocol_shape() -> None:
    connection = ConnectJwtConnection(
        client_key="client-1", shared_secret="s", url="https://acme.atlassian.net"
    )
    assert connection.base_url() == "https://acme.atlassian.net"
    assert connection.api_version() == "3"
    assert isinstance(connection.auth(), httpx.Auth)
