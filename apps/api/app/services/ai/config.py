"""Per-task model selection. Swapping which model handles a task is an edit
here, not a call-site change — this is what satisfies Issue #1.4's
"swapping the underlying model requires a config change" acceptance criterion.
"""

from __future__ import annotations

from typing import Literal

from pydantic import BaseModel

Effort = Literal["low", "medium", "high", "xhigh", "max"]

DEFAULT_MODEL = "claude-opus-4-8"


class TaskModelConfig(BaseModel):
    model: str = DEFAULT_MODEL
    effort: Effort = "high"
    max_tokens: int = 4096


TASK_MODELS: dict[str, TaskModelConfig] = {
    "extraction": TaskModelConfig(model=DEFAULT_MODEL, effort="low", max_tokens=4096),
    "structuring": TaskModelConfig(model=DEFAULT_MODEL, effort="high", max_tokens=8192),
}

DEFAULT_TASK_MODEL = TaskModelConfig()


def get_task_model(task: str) -> TaskModelConfig:
    return TASK_MODELS.get(task, DEFAULT_TASK_MODEL)
