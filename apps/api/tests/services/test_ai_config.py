from app.services.ai.config import DEFAULT_MODEL, TASK_MODELS, get_task_model


def test_known_task_returns_configured_model() -> None:
    config = get_task_model("extraction")
    assert config.model == DEFAULT_MODEL
    assert config.effort == "low"


def test_structuring_uses_higher_effort_than_extraction() -> None:
    extraction = get_task_model("extraction")
    structuring = get_task_model("structuring")
    assert extraction.effort == "low"
    assert structuring.effort == "high"
    assert structuring.max_tokens > extraction.max_tokens


def test_unknown_task_falls_back_to_default_config() -> None:
    config = get_task_model("some-task-nobody-registered")
    assert config.model == DEFAULT_MODEL
    assert config.effort == "high"


def test_task_models_registry_is_not_empty() -> None:
    assert "extraction" in TASK_MODELS
    assert "structuring" in TASK_MODELS
