from fastapi import FastAPI

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
    publish,
    publish_ado,
    publish_github,
    reports,
    sources,
    wizard_sessions,
)

app = FastAPI(title="SpecMate API")

install_rate_limit_middleware(app)

app.include_router(health.router)
app.include_router(ai_demo.router)
app.include_router(sources.router)
app.include_router(connectors.router)
app.include_router(github_oauth.router)
app.include_router(jira_oauth.router)
app.include_router(wizard_sessions.router)
app.include_router(connection_requests.router)
app.include_router(generation.router)
app.include_router(publish.router)
app.include_router(publish_ado.router)
app.include_router(publish_github.router)
app.include_router(flag_removed.router)
app.include_router(drift.router)
app.include_router(reports.router)
app.include_router(billing.router)
