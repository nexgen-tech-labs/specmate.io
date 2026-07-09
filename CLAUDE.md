# CLAUDE.md

Guidance for Claude Code (and any contributor) working in this repo.

## What this is

SpecMate — AI Spec Layer for Humans and Coding Agents. Ingests raw requirement sources (docs, transcripts, backlogs), uses AI to generate structured epics/stories/tasks/ACs, and publishes them to Jira/ADO/GitHub with full traceability.

## Tech stack

- **Frontend**: Next.js 14+ (App Router), TypeScript, Tailwind CSS
- **Backend**: Python + FastAPI (`apps/api`) — handles document parsing, the AI pipeline, and connector sync jobs
- **Database**: Azure Postgres Flexible Server (single instance, shared by both services). `apps/web` accesses it via Prisma; `apps/api` via SQLAlchemy/asyncpg. The Postgres schema is the contract between the two — keep it in sync manually since there's no shared ORM across TS/Python.
- **Auth**: Auth.js (NextAuth), self-hosted
- **Monorepo**: pnpm workspaces + Turborepo for the TS side (`apps/web`, `packages/*`). `apps/api` is Python, managed separately with `uv`, but lives in the same repo.
- **Async jobs**: long-running work (parsing, AI generation, connector sync) is tracked as rows in a Postgres job table (status: queued/running/done/failed) — no message broker.
- **Deployment**: Azure Container Apps (one app per service), Azure Postgres Flexible Server, Azure Key Vault for secrets, Azure Container Registry for images.
- **CI/CD**: GitHub Actions. Deploys use OIDC federated credentials + Azure Managed Identity — no long-lived Azure secrets stored in GitHub.

## Repo layout

```
apps/web/            Next.js frontend
apps/api/             FastAPI backend
packages/types/        Shared TS types
packages/connector-*/   Connector workspaces (Jira, ADO, GitHub)
infra/                Bicep IaC for Azure resources
.github/workflows/    CI + deploy pipelines
```

## Dev commands

```
pnpm install && pnpm dev     # runs apps/web (Next.js dev server)
pnpm test                    # runs tests across web + packages
pnpm lint / pnpm typecheck

cd apps/api
uv sync
uvicorn app.main:app --reload   # runs the FastAPI backend
pytest                          # runs API tests
```

Both services need `.env` files — copy `.env.example` in each app directory and fill in local values. Never commit `.env` files.

## Rules that apply to every change in this repo

1. **Tests from the start.** New features ship with unit tests at minimum; smoke/sanity tests for anything touching an external boundary (parsers, connectors, AI calls, DB).
2. **Test locally before deploying.** Every feature must run and be verified locally (`pnpm dev` / `uvicorn --reload`) before it goes to Azure.
3. **Secrets never live in code or git.** They go in Azure Key Vault (production) or Container App settings (staging), and locally in gitignored `.env` files. `.env*` and any `.sh` script containing credentials must never be committed.
4. **Deployment target is Azure**, using free credits — Container Apps + Azure Postgres. Don't introduce other cloud providers or paid managed services without checking first.
5. **CI/CD uses OIDC federated credentials + Managed Identity.** Never add a long-lived Azure client secret to GitHub Actions.
6. **When in doubt, ask.** Architectural decisions, new dependencies, or anything touching cost/billing should be confirmed before implementing.
7. Prefer using existing Agents/Skills over ad hoc scripting where one fits the task.

## Architecture reference

See [architecture.md](architecture.md) for the fuller system breakdown (components, data flow, deployment topology).
