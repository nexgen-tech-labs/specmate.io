from fastapi import FastAPI

from app.routers import ai_demo, health

app = FastAPI(title="SpecMate API")

app.include_router(health.router)
app.include_router(ai_demo.router)
