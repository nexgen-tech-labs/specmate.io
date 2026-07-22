"""ConnectorTransport implementations (Issue 11.1): DirectCloudTransport forwards
method/url/auth/headers/json/params to httpx unchanged; AgentRelayTransport is a
proven-shape stub that always raises until Epic 11 builds the real relay."""

from __future__ import annotations

import time
from functools import partial

import httpx
import pytest

import app.services.connectors.transport as transport_module
from app.services.connectors.transport import (
    JIRA_POLICY,
    AgentRelayTransport,
    DirectCloudTransport,
)


@pytest.fixture(autouse=True)
def _reset_pacing_state() -> None:
    transport_module._last_dispatch.clear()


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
        target="jira",
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
        await transport.request("GET", "https://example.com/whatever", target="jira")


async def test_direct_cloud_transport_retries_on_429_then_succeeds(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(201, json={"ok": True})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST", "https://example.atlassian.net/rest/api/3/issue", target="jira"
    )

    assert response.status_code == 201
    assert call_count == 2


async def test_direct_cloud_transport_gives_up_after_max_attempts_and_returns_final_response(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(429, headers={"Retry-After": "0"})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST", "https://example.atlassian.net/rest/api/3/issue", target="jira"
    )

    # Gives up after the policy's max attempts and returns the LAST failed
    # response (not raising) -- the caller's existing status-code branching
    # (unchanged from before this refactor) is what turns this into a
    # PublishOutcome(ok=False, ...).
    assert response.status_code == 429
    assert call_count == JIRA_POLICY.max_attempts


async def test_direct_cloud_transport_treats_github_403_with_zero_remaining_as_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(
                403,
                headers={"X-RateLimit-Remaining": "0", "Retry-After": "0"},
                text="API rate limit exceeded",
            )
        return httpx.Response(201, json={"number": 42, "html_url": "https://x"})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST", "https://api.github.com/repos/o/r/issues", target="github"
    )

    assert response.status_code == 201
    assert call_count == 2


async def test_direct_cloud_transport_does_not_treat_generic_github_403_as_rate_limited(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """A 403 without X-RateLimit-Remaining: 0 (e.g. a real permissions error) is
    NOT retried -- tightens the pre-refactor inconsistency where GitHub's update
    path treated *any* 403 as transient."""
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        return httpx.Response(403, text="Resource not accessible by integration")

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "PATCH", "https://api.github.com/repos/o/r/issues/1", target="github"
    )

    assert response.status_code == 403
    assert call_count == 1  # not retried -- permanent error, surfaced immediately


async def test_direct_cloud_transport_calls_on_rate_limited_once_per_retry(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count <= 2:
            return httpx.Response(429, headers={"Retry-After": "0"})
        return httpx.Response(200, json={})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    incidents: list[tuple[int, float]] = []

    async def on_rate_limited(status_code: int, wait_seconds: float) -> None:
        incidents.append((status_code, wait_seconds))

    transport = DirectCloudTransport()
    response = await transport.request(
        "GET",
        "https://example.atlassian.net/x",
        target="jira",
        on_rate_limited=on_rate_limited,
    )

    assert response.status_code == 200
    assert len(incidents) == 2
    assert all(status == 429 for status, _wait in incidents)


async def test_direct_cloud_transport_falls_back_to_computed_backoff_on_http_date_retry_after(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """RFC 9110 permits `Retry-After` as either delay-seconds or an HTTP-date.
    An HTTP-date (e.g. from a gateway/CDN in front of Jira/ADO/GitHub) must not
    crash the retry loop -- it should fall back to the computed backoff, same
    as when the header is absent entirely."""
    call_count = 0

    def handler(request: httpx.Request) -> httpx.Response:
        nonlocal call_count
        call_count += 1
        if call_count == 1:
            return httpx.Response(
                429, headers={"Retry-After": "Wed, 21 Oct 2026 07:28:00 GMT"}
            )
        return httpx.Response(201, json={"ok": True})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    response = await transport.request(
        "POST", "https://example.atlassian.net/rest/api/3/issue", target="jira"
    )

    assert response.status_code == 201
    assert call_count == 2


async def test_direct_cloud_transport_paces_requests_to_the_same_target(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Two back-to-back requests to the same target are spaced at least the
    target's configured minimum interval apart."""

    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={})

    mock_transport = httpx.MockTransport(handler)
    monkeypatch.setattr(
        httpx, "AsyncClient", partial(httpx.AsyncClient, transport=mock_transport)
    )

    transport = DirectCloudTransport()
    start = time.monotonic()
    await transport.request("GET", "https://x/a", target="jira")
    await transport.request("GET", "https://x/a", target="jira")
    elapsed = time.monotonic() - start

    assert elapsed >= JIRA_POLICY.min_interval_seconds
