from fastapi import FastAPI
from starlette.middleware.cors import CORSMiddleware

from app.core.config import settings
from app.core.rate_limit import install_rate_limit_middleware
from app.routers import (
    ai_demo,
    billing,
    connection_requests,
    connectors,
    drift,
    flag_removed,
    generation,
    github_oauth,
    health,
    jira_oauth,
    org_connectors,
    publish,
    publish_ado,
    publish_github,
    reports,
    sources,
    wizard_sessions,
)

app = FastAPI(title="SpecMate API")

# apps/api's ingress is internal-only (see architecture.md) — apps/web's
# server is the only current caller, so this isn't load-bearing for the
# existing browser flows today, but WEB_BASE_URL is the one browser origin
# any future direct/public API access should ever be allowed from.
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.web_base_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

install_rate_limit_middleware(app)

app.include_router(health.router)
app.include_router(ai_demo.router)
app.include_router(sources.router)
app.include_router(connectors.router)
app.include_router(github_oauth.router)
app.include_router(jira_oauth.router)
app.include_router(wizard_sessions.router)
app.include_router(org_connectors.router)
app.include_router(connection_requests.router)
app.include_router(generation.router)
app.include_router(publish.router)
app.include_router(publish_ado.router)
app.include_router(publish_github.router)
app.include_router(flag_removed.router)
app.include_router(drift.router)
app.include_router(reports.router)
app.include_router(billing.router)
