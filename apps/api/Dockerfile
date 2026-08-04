# syntax=docker/dockerfile:1
FROM python:3.12-slim AS base
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
# uv's cache defaults to $HOME/.cache/uv at *runtime* (not just during the build
# below) — `useradd --system` gives apiuser no writable home directory, so
# `uv run` at container startup fails with "Permission denied" trying to create
# it. Pin the cache to a directory we create and own explicitly instead of
# relying on apiuser having a usable $HOME.
ENV UV_CACHE_DIR=/app/.uv-cache
COPY --from=ghcr.io/astral-sh/uv:latest /uv /uvx /bin/

WORKDIR /app

COPY pyproject.toml uv.lock* ./
RUN uv sync --no-dev --no-install-project

COPY app ./app

RUN useradd --system --uid 1001 apiuser \
    && mkdir -p "$UV_CACHE_DIR" \
    && chown -R apiuser /app
USER apiuser

EXPOSE 8000
# --no-sync: the image already has the exact locked dependency set from the
# `uv sync --no-dev` build step above — without this flag, `uv run` re-checks
# the environment against pyproject.toml/uv.lock on every container start and,
# since `--no-install-project` left the project itself "not installed",
# resolves that as drift and re-syncs, silently pulling in the (much larger)
# dev dependency group at runtime. `--no-sync` runs the already-baked-in
# environment as-is instead.
CMD ["uv", "run", "--no-sync", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
