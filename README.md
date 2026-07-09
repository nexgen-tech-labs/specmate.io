# specmate.io

AI Spec Layer for Humans and Coding Agents

See [architecture.md](architecture.md) for system design and [CLAUDE.md](CLAUDE.md) for contributor/agent guidance.

## Prerequisites

- Node.js 22+
- pnpm (`corepack enable` will pick up the version pinned in `package.json`)
- Python 3.12+
- [uv](https://docs.astral.sh/uv/) (`brew install uv` or see docs)
- Docker (for running Postgres locally)

## Local setup

### 1. Start a local Postgres

```bash
docker run --name specmate-postgres -e POSTGRES_PASSWORD=postgres -e POSTGRES_DB=specmate -p 5434:5432 -d postgres:16
```

(Uses host port 5434 to avoid clashing with other local projects that bind 5432 — adjust `DATABASE_URL` in both `.env` files if you use a different port.)

### 2. Web app (`apps/web`)

```bash
cp apps/web/.env.example apps/web/.env
# fill in DATABASE_URL (matches the docker command above by default), NEXTAUTH_SECRET, etc.

pnpm install
pnpm --filter=@specmate/web run prisma:generate
pnpm dev
```

Visit http://localhost:3000.

### 3. API backend (`apps/api`)

In a separate terminal:

```bash
cd apps/api
cp .env.example .env
# fill in DATABASE_URL (asyncpg variant) and ANTHROPIC_API_KEY

uv sync
uv run uvicorn app.main:app --reload
```

Visit http://localhost:8000/health — should return `{"status": "ok"}`.

## Running tests

```bash
# from repo root — web + shared packages
pnpm test

# apps/api
cd apps/api && uv run pytest
```

## Linting & typechecking

```bash
pnpm lint
pnpm typecheck

cd apps/api
uv run ruff check .
uv run mypy app
```

## Environment variables & secrets

Every app has a `.env.example` documenting required variables — copy it to `.env` locally and fill in real values. `.env` files are gitignored repo-wide and must never be committed. In staging/production, the same variables are set via Azure Key Vault references or Container App settings — see [infra/README.md](infra/README.md).

## Deployment

CI runs on every PR (`.github/workflows/ci.yml`) and must pass before merge. Deploys (`.github/workflows/deploy.yml`) run on merge to `main`: staging deploys automatically, production requires manual approval. See [infra/README.md](infra/README.md) for the Azure resource setup and OIDC federated credential configuration.
