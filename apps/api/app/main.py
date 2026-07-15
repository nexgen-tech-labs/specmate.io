from fastapi import FastAPI

from app.routers import (
    ai_demo,
    billing,
    connectors,
    generation,
    health,
    publish,
    publish_ado,
    publish_github,
    reports,
    sources,
)

app = FastAPI(title="SpecMate API")

app.include_router(health.router)
app.include_router(ai_demo.router)
app.include_router(sources.router)
app.include_router(connectors.router)
app.include_router(generation.router)
app.include_router(publish.router)
app.include_router(publish_ado.router)
app.include_router(publish_github.router)
app.include_router(reports.router)
app.include_router(billing.router)
