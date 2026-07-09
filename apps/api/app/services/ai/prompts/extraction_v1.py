"""Prompt version "extraction_v1" — reference pattern for versioned prompts.

Callers pass this constant as GenerationRequest.system and "extraction_v1" as
GenerationRequest.prompt_version. A future revision becomes extraction_v2.py;
the old file stays so prior GenerationResult.prompt_version values remain
meaningful in AiCallLog history.
"""

EXTRACTION_V1 = (
    "You extract structured requirement summaries from raw text fragments. "
    "Be concise and factual — do not infer information not present in the input."
)
