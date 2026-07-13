from fastapi import FastAPI

from app.routers import ai_demo, connectors, generation, health, publish, publish_ado, publish_github, sources

app = FastAPI(title="SpecMate API")

app.include_router(health.router)
app.include_router(ai_demo.router)
app.include_router(sources.router)
app.include_router(connectors.router)
app.include_router(generation.router)
app.include_router(publish.router)
app.include_router(publish_ado.router)
app.include_router(publish_github.router)
