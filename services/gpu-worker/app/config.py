from functools import lru_cache
import os

from pydantic import BaseModel


class Settings(BaseModel):
    batch_size: int = 24
    max_assets: int = 256
    model_cache_dir: str = "/models/huggingface"
    model_device: str = "auto"
    model_dtype: str = "auto"
    model_id: str = "openai/clip-vit-base-patch32"
    preload_model_on_startup: bool = True
    worker_token: str | None = None


def _bool_env(name: str, default: bool) -> bool:
    value = os.getenv(name)

    if value is None:
        return default

    return value.strip().lower() in {"1", "true", "yes", "y", "on"}


def _int_env(name: str, default: int) -> int:
    value = os.getenv(name)

    if value is None:
        return default

    try:
        return int(value)
    except ValueError:
        return default


@lru_cache
def read_settings() -> Settings:
    return Settings(
        batch_size=max(1, _int_env("GPU_BATCH_SIZE", 24)),
        max_assets=max(1, _int_env("GPU_MAX_ASSETS", 256)),
        model_cache_dir=os.getenv("GPU_MODEL_CACHE_DIR", "/models/huggingface"),
        model_device=os.getenv("GPU_MODEL_DEVICE", "auto"),
        model_dtype=os.getenv("GPU_MODEL_DTYPE", "auto"),
        model_id=os.getenv("GPU_MODEL_ID", "openai/clip-vit-base-patch32"),
        preload_model_on_startup=_bool_env("GPU_PRELOAD_MODEL_ON_STARTUP", True),
        worker_token=os.getenv("GPU_WORKER_TOKEN"),
    )
