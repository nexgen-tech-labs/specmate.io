from fastapi import FastAPI

from app.routers import ai_demo, connectors, generation, health, sources

app = FastAPI(title="SpecMate API")

app.include_router(health.router)
app.include_router(ai_demo.router)
app.include_router(sources.router)
app.include_router(connectors.router)
app.include_router(generation.router)
