from decimal import Decimal

from fastapi.testclient import TestClient

from app.main import app
from app.routers.ai_demo import get_ai_adapter
from app.services.ai.adapter import GenerationResult, UsageInfo


class _FakeAdapter:
    async def generate(self, request: object) -> GenerationResult:
        return GenerationResult(
            data={"title": "Ship the feature", "priority": "high"},
            raw_text='{"title": "Ship the feature", "priority": "high"}',
            usage=UsageInfo(
                input_tokens=50,
                output_tokens=10,
                cache_read_tokens=0,
                cache_creation_tokens=0,
            ),
            cost_usd=Decimal("0.000500"),
            latency_ms=123,
            model="claude-opus-4-8",
            prompt_version="extraction_v1",
        )


def test_demo_extract_returns_structured_output_matching_schema() -> None:
    app.dependency_overrides[get_ai_adapter] = lambda: _FakeAdapter()
    client = TestClient(app)
    try:
        response = client.post(
            "/ai/demo-extract",
            json={"text": "We need to ship this by Friday", "workspace_id": "ws_1", "project_id": "proj_1"},
        )
    finally:
        app.dependency_overrides.pop(get_ai_adapter, None)

    assert response.status_code == 200
    body = response.json()
    assert body["title"] == "Ship the feature"
    assert body["priority"] == "high"
    assert body["model"] == "claude-opus-4-8"
    assert body["latency_ms"] == 123
