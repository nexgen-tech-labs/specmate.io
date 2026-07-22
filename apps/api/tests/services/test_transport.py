"""ConnectorTransport implementations (Issue 11.1): DirectCloudTransport forwards
method/url/auth/headers/json/params to httpx unchanged; AgentRelayTransport is a
proven-shape stub that always raises until Epic 11 builds the real relay."""

from __future__ import annotations

from functools import partial

import httpx
import pytest

from app.services.connectors.transport import AgentRelayTransport, DirectCloudTransport


async def test_direct_cloud_transport_forwards_request_details(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    seen: dict[str, object] = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["method"] = request.method
        seen["url"] = str(request.url)
        seen["headers"] = dict(request.headers)
        seen["body"] = request.content
        return httpx.Response(201, json={"ok": True})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST",
        "https://example.atlassian.net/rest/api/3/issue",
        auth=("user@example.com", "token"),
        headers={"X-Custom": "1"},
        json={"fields": {"summary": "Test"}},
        params={"foo": "bar"},
        timeout=15,
    )

    assert response.status_code == 201
    assert response.json() == {"ok": True}
    assert seen["method"] == "POST"
    assert "foo=bar" in str(seen["url"])
    assert seen["headers"]["x-custom"] == "1"  # type: ignore[index]
    assert b"summary" in seen["body"]  # type: ignore[operator]


async def test_agent_relay_transport_is_a_non_functional_stub() -> None:
    transport = AgentRelayTransport(agent_endpoint="https://agent.internal:9443")

    with pytest.raises(NotImplementedError, match="11.2"):
        await transport.request("GET", "https://example.com/whatever")
