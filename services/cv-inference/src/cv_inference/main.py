"""cv-inference: consumes uploaded proctoring frames, analyses them on Triton and posts the results
to proctoring-svc. Exposes /healthz and /readyz for Kubernetes."""

from __future__ import annotations

import asyncio
import logging
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager

from fastapi import FastAPI, Response

log = logging.getLogger('cv_inference')


def create_app(ready: asyncio.Event) -> FastAPI:
    """Probes: alive while the process runs; ready once Triton answered."""

    app = FastAPI(title='Atlas cv-inference', docs_url=None, redoc_url=None, openapi_url=None)

    @app.get('/healthz')
    async def healthz() -> dict[str, str]:
        return {'status': 'ok'}

    @app.get('/readyz')
    async def readyz(response: Response) -> dict[str, str]:
        if not ready.is_set():
            response.status_code = 503
            return {'status': 'starting'}
        return {'status': 'ready'}

    return app


def main() -> None:  # pragma: no cover - process wiring
    import os

    import boto3
    import httpx
    import uvicorn
    from atlas_platform.auth import ClientCredentialsTokenProvider
    from atlas_platform.logs import configure_logging

    from cv_inference.application.analyser import Analyser
    from cv_inference.config import Config
    from cv_inference.domain.cascade import Cascade
    from cv_inference.infrastructure.adapters import (
        ProctoringResults,
        PyAvDecoder,
        S3Storage,
        run_consumer,
    )
    from cv_inference.infrastructure.triton import TritonModels

    settings = Config.from_env(os.environ)
    level = {
        'debug': logging.DEBUG,
        'info': logging.INFO,
        'warn': logging.WARNING,
        'error': logging.ERROR,
    }
    configure_logging('cv-inference', level[settings.log_level])
    ready = asyncio.Event()

    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        http = httpx.AsyncClient()
        tokens = ClientCredentialsTokenProvider(
            token_url=settings.token_url,
            client_id=settings.client_id,
            client_secret=settings.client_secret,
            scopes=['proctoring:inference'],
            http=http,
        )
        models = TritonModels(settings.triton_url, settings.versions)
        s3 = (
            boto3.client('s3', endpoint_url=settings.s3_endpoint)
            if settings.s3_endpoint
            else boto3.client('s3')
        )
        analyser = Analyser(
            S3Storage(s3, settings.bucket),
            Cascade(models),
            ProctoringResults(settings.proctoring_url, tokens, http),
            PyAvDecoder(),
        )
        if await models.client.is_server_ready():
            ready.set()
        task = asyncio.create_task(run_consumer(analyser, settings.kafka_brokers))
        try:
            yield
        finally:
            task.cancel()
            await http.aclose()

    app = create_app(ready)
    app.router.lifespan_context = lifespan
    uvicorn.run(app, host='0.0.0.0', port=settings.port, log_config=None)  # noqa: S104


if __name__ == '__main__':  # pragma: no cover
    main()
