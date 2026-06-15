from __future__ import annotations

import logging
import time

from fastapi import Depends, FastAPI, Header, HTTPException, status

from app.config import read_settings
from app.image_features import compute_image_stats, decode_image
from app.model_runtime import ClipRuntime
from app.schemas import FeatureOutput, FeatureRequest, FeatureResponse, HealthResponse


logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")
logger = logging.getLogger(__name__)

settings = read_settings()
runtime = ClipRuntime(settings)

app = FastAPI(title="Trip Picks GPU Feature Worker", version="0.1.0")


def require_token(authorization: str | None = Header(default=None)) -> None:
    if not settings.worker_token:
        return

    expected = f"Bearer {settings.worker_token}"

    if authorization != expected:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid worker token",
        )


@app.on_event("startup")
def preload_model() -> None:
    logger.info(
        "worker starting model_id=%s device=%s preload=%s max_assets=%s batch_size=%s",
        settings.model_id,
        runtime.device,
        settings.preload_model_on_startup,
        settings.max_assets,
        settings.batch_size,
    )

    if settings.preload_model_on_startup:
        runtime.load()


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        ok=True,
        model_id=settings.model_id,
        model_loaded=runtime.loaded,
        device=str(runtime.device),
    )


@app.post("/features", response_model=FeatureResponse, dependencies=[Depends(require_token)])
def features(request: FeatureRequest) -> FeatureResponse:
    started = time.perf_counter()

    if len(request.assets) > settings.max_assets:
        raise HTTPException(
            status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
            detail=f"too many assets; max is {settings.max_assets}",
        )

    images = []
    stats_by_photo_id = {}

    for asset in request.assets:
        try:
            image = decode_image(asset.image_base64)
        except Exception as error:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail=f"asset {asset.photo_id} could not be decoded",
            ) from error

        images.append(image)
        stats_by_photo_id[asset.photo_id] = compute_image_stats(image)

    embeddings = runtime.embed_images(images, settings.batch_size) if images else []
    outputs: list[FeatureOutput] = []

    for asset, embedding in zip(request.assets, embeddings, strict=True):
        stats = stats_by_photo_id[asset.photo_id]
        labels = sorted({
            *(asset.labels or []),
            *(asset.model_labels or []),
            *stats.labels,
            "neural_embedding",
        })

        outputs.append(
            FeatureOutput(
                photo_id=asset.photo_id,
                embedding=embedding,
                aesthetic_score=stats.aesthetic_score,
                model_labels=labels,
                model_quality_signals=stats.quality_signals,
                color_profile=stats.color_profile,
            )
        )

    duration_ms = round((time.perf_counter() - started) * 1000)
    logger.info(
        "features completed job_id=%s project_id=%s asset_count=%s duration_ms=%s model_id=%s device=%s",
        request.job_id,
        request.project_id,
        len(request.assets),
        duration_ms,
        settings.model_id,
        runtime.device,
    )

    return FeatureResponse(
        model_provider=runtime.provider,
        model_version=runtime.version,
        features=outputs,
    )
