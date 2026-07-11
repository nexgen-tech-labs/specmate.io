"""Item type taxonomy + strict JSON schemas (Issue 3.2).

These schemas are enforced on every generation call via structured output
(app.services.ai) — malformed items are rejected at the API boundary, never
persisted. The canonical definitions live here (generation owns enforcement);
`packages/types/src/draft-items.ts` hand-mirrors the shapes for frontend
rendering, same cross-language mirror convention as Prisma <-> SQLAlchemy.
"""

from __future__ import annotations

_CHUNK_IDS = {
    "type": "array",
    "items": {"type": "string"},
    "description": "IDs of the raw requirement chunks this item was derived from.",
}

# Per-type payload field definitions (Issue 3.2's taxonomy). Title/description are
# top-level on DraftItem; these are the type-specific extras stored in payload.
ITEM_PAYLOAD_FIELDS: dict[str, dict[str, object]] = {
    "EPIC": {"business_value": {"type": "string"}},
    "STORY": {},
    "TASK": {},
    "SUBTASK": {},
    "ACCEPTANCE_CRITERIA": {"statement": {"type": "string"}},
    "TEST": {
        "steps": {"type": "array", "items": {"type": "string"}},
        "expected_result": {"type": "string"},
    },
    "DEPENDENCY": {
        "dependency_type": {"type": "string", "enum": ["blocks", "blocked-by", "external"]},
    },
    "ASSUMPTION": {"confidence": {"type": "string", "enum": ["low", "medium", "high"]}},
    "QUESTION": {"needed_to_resolve": {"type": "string"}},
    "RISK": {"severity": {"type": "string", "enum": ["low", "medium", "high"]}},
    "NFR": {
        "category": {
            "type": "string",
            "enum": [
                "performance",
                "security",
                "availability",
                "scalability",
                "compliance",
                "usability",
                "other",
            ],
        },
        "threshold": {"type": "string"},
    },
}

# Union of every type-specific payload field, all optional — the structured-output
# API rejects open-ended objects (additionalProperties: true), so the "extra" object
# enumerates the full taxonomy explicitly. Irrelevant fields are simply omitted/null.
# (The structured-output validator also rejects ["type","null"] unions mixed with
# enums, so optional-ness is expressed by omission/empty string, not null.)
_EXTRA_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "business_value": {"type": "string"},
        "statement": {"type": "string"},
        "steps": {"type": "array", "items": {"type": "string"}},
        "expected_result": {"type": "string"},
        "dependency_type": {"type": "string", "enum": ["blocks", "blocked-by", "external"]},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "needed_to_resolve": {"type": "string"},
        "severity": {"type": "string", "enum": ["low", "medium", "high"]},
        "category": {"type": "string"},
        "threshold": {"type": "string"},
    },
    "additionalProperties": False,
}

SUPPORTING_TYPES = [
    "ACCEPTANCE_CRITERIA",
    "TEST",
    "RISK",
    "NFR",
    "DEPENDENCY",
    "ASSUMPTION",
    "QUESTION",
]

CLUSTER_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "clusters": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "theme": {"type": "string"},
                    "chunk_ids": _CHUNK_IDS,
                },
                "required": ["theme", "chunk_ids"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["clusters"],
    "additionalProperties": False,
}

EPICS_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "epics": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "business_value": {"type": "string"},
                    "source_chunk_ids": _CHUNK_IDS,
                },
                "required": ["title", "description", "business_value", "source_chunk_ids"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["epics"],
    "additionalProperties": False,
}

STORIES_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "stories": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "User-story format."},
                    "description": {"type": "string"},
                    "epic_index": {
                        "type": "integer",
                        "description": "Index into the provided epic list; -1 if no clear parent.",
                    },
                    "source_chunk_ids": _CHUNK_IDS,
                    "tasks": {
                        "type": "array",
                        "items": {
                            "type": "object",
                            "properties": {
                                "title": {"type": "string"},
                                "description": {"type": "string"},
                            },
                            "required": ["title", "description"],
                            "additionalProperties": False,
                        },
                    },
                },
                "required": ["title", "description", "epic_index", "source_chunk_ids", "tasks"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["stories"],
    "additionalProperties": False,
}

SUPPORTING_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "items": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "type": {"type": "string", "enum": SUPPORTING_TYPES},
                    "story_index": {
                        "type": "integer",
                        "description": "Index into the provided story list; -1 for project-level items.",
                    },
                    "title": {"type": "string"},
                    "description": {"type": "string"},
                    "extra": _EXTRA_SCHEMA,
                    "source_chunk_ids": _CHUNK_IDS,
                },
                "required": ["type", "story_index", "title", "description", "source_chunk_ids"],
                "additionalProperties": False,
            },
        }
    },
    "required": ["items"],
    "additionalProperties": False,
}

SCORING_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "scores": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "item_index": {"type": "integer"},
                    "completeness": {"type": "integer", "description": "0-100"},
                    "clarity": {"type": "integer", "description": "0-100"},
                    "testability": {"type": "integer", "description": "0-100"},
                    "specificity": {"type": "integer", "description": "0-100"},
                    "rationale": {
                        "type": "string",
                        "description": "Short human-readable note on what's weak or missing.",
                    },
                    "gap_question": {
                        "type": "string",
                        "description": "When source material was insufficient: one specific, "
                        "answerable question that would resolve the gap. Empty string otherwise.",
                    },
                },
                "required": [
                    "item_index",
                    "completeness",
                    "clarity",
                    "testability",
                    "specificity",
                    "rationale",
                    "gap_question",
                ],
                "additionalProperties": False,
            },
        }
    },
    "required": ["scores"],
    "additionalProperties": False,
}

REGENERATE_SCHEMA: dict[str, object] = {
    "type": "object",
    "properties": {
        "title": {"type": "string"},
        "description": {"type": "string"},
        "extra": _EXTRA_SCHEMA,
    },
    "required": ["title", "description"],
    "additionalProperties": False,
}
