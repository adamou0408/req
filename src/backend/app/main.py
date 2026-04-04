from __future__ import annotations

import logging
from contextlib import asynccontextmanager
from typing import AsyncIterator

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.core.database import init_db

logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    """Startup / shutdown lifecycle."""
    logger.info("Initialising database …")
    await init_db()
    logger.info("Database ready.")
    yield


def create_app() -> FastAPI:
    application = FastAPI(
        title="MRP Multi-DB Connector API",
        version="0.1.0",
        lifespan=lifespan,
    )

    application.add_middleware(
        CORSMiddleware,
        allow_origins=["*"],
        allow_credentials=True,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ------------------------------------------------------------------
    # Routers – lazy-imported so the app still boots when sub-modules
    # are not yet implemented.
    # ------------------------------------------------------------------
    _include_router(application, "app.api.auth", prefix="/api/auth", tags=["auth"])
    _include_router(application, "app.api.connections", prefix="/api/connections", tags=["connections"])
    _include_router(application, "app.api.schema", prefix="/api/schema", tags=["schema"])
    _include_router(application, "app.api.audit", prefix="/api/audit", tags=["audit"])
    _include_router(application, "app.api.sync", prefix="/api/sync", tags=["sync"])
    _include_router(application, "app.api.mappings", prefix="/api/mappings", tags=["mappings"])
    _include_router(application, "app.api.combos", prefix="/api/combos", tags=["combos"])
    _include_router(application, "app.api.inventory", prefix="/api/inventory", tags=["inventory"])
    _include_router(application, "app.api.procurement", prefix="/api/procurement", tags=["procurement"])
    _include_router(application, "app.api.reports", prefix="/api/reports", tags=["reports"])

    @application.get("/health", tags=["ops"])
    async def health_check() -> dict[str, str]:
        return {"status": "ok"}

    return application


def _include_router(
    application: FastAPI,
    module_path: str,
    *,
    prefix: str,
    tags: list[str],
) -> None:
    """Try to import *module_path*.router and include it; silently skip on ImportError."""
    try:
        import importlib

        mod = importlib.import_module(module_path)
        router = getattr(mod, "router", None)
        if router is not None:
            application.include_router(router, prefix=prefix, tags=tags)
            logger.info("Loaded router %s", module_path)
        else:
            logger.warning("Module %s has no 'router' attribute – skipped", module_path)
    except ImportError:
        logger.warning("Module %s not found – skipped", module_path)
    except Exception:
        logger.exception("Failed to load router from %s", module_path)


app = create_app()
