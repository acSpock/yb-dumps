from __future__ import annotations

import logging
import threading

from PIL import Image
import torch
from transformers import CLIPImageProcessor, CLIPModel, CLIPTokenizer

from app.config import Settings


logger = logging.getLogger(__name__)


def _device_for(setting: str) -> torch.device:
    requested = setting.strip().lower()

    if requested != "auto":
        return torch.device(requested)

    if torch.cuda.is_available():
        return torch.device("cuda")

    if hasattr(torch.backends, "mps") and torch.backends.mps.is_available():
        return torch.device("mps")

    return torch.device("cpu")


def _dtype_for(setting: str, device: torch.device) -> torch.dtype:
    requested = setting.strip().lower()

    if requested == "float16":
        return torch.float16

    if requested == "bfloat16":
        return torch.bfloat16

    if requested == "float32":
        return torch.float32

    return torch.float16 if device.type == "cuda" else torch.float32


class ClipRuntime:
    def __init__(self, settings: Settings) -> None:
        self.settings = settings
        self.device = _device_for(settings.model_device)
        self.dtype = _dtype_for(settings.model_dtype, self.device)
        self._image_processor: CLIPImageProcessor | None = None
        self._text_tokenizer: CLIPTokenizer | None = None
        self._model: CLIPModel | None = None
        self._lock = threading.Lock()
        self._text_feature_cache: dict[tuple[str, ...], torch.Tensor] = {}

    @property
    def loaded(self) -> bool:
        return self._model is not None and self._image_processor is not None and self._text_tokenizer is not None

    @property
    def provider(self) -> str:
        return "trip-picks-gpu-worker"

    @property
    def version(self) -> str:
        model_slug = self.settings.model_id.replace("/", "--")
        return f"{model_slug}-image-embedding-zero-shot-v0.2.0"

    def load(self) -> None:
        if self.loaded:
            return

        with self._lock:
            if self.loaded:
                return

            logger.info(
                "loading model model_id=%s device=%s dtype=%s cache_dir=%s",
                self.settings.model_id,
                self.device,
                self.dtype,
                self.settings.model_cache_dir,
            )
            self._image_processor = CLIPImageProcessor.from_pretrained(
                self.settings.model_id,
                cache_dir=self.settings.model_cache_dir,
            )
            self._text_tokenizer = CLIPTokenizer.from_pretrained(
                self.settings.model_id,
                cache_dir=self.settings.model_cache_dir,
            )
            model = CLIPModel.from_pretrained(
                self.settings.model_id,
                cache_dir=self.settings.model_cache_dir,
            )
            model.eval()
            model.to(device=self.device, dtype=self.dtype)
            self._model = model
            logger.info("model loaded model_id=%s device=%s", self.settings.model_id, self.device)

    def embed_images(self, images: list[Image.Image], batch_size: int) -> list[list[float]]:
        self.load()

        if not self._image_processor or not self._model:
            raise RuntimeError("model failed to load")

        embeddings: list[list[float]] = []
        safe_batch_size = max(1, batch_size)

        for index in range(0, len(images), safe_batch_size):
            batch = images[index:index + safe_batch_size]
            inputs = self._image_processor(images=batch, return_tensors="pt")
            pixel_values = inputs["pixel_values"].to(device=self.device, dtype=self.dtype)

            with torch.inference_mode():
                features = self._model.get_image_features(pixel_values=pixel_values)
                features = torch.nn.functional.normalize(features, p=2, dim=-1)

            embeddings.extend([
                [round(float(value), 6) for value in row]
                for row in features.detach().cpu().tolist()
            ])

        return embeddings

    def _text_features(self, prompts: list[str]) -> torch.Tensor:
        self.load()

        if not self._text_tokenizer or not self._model:
            raise RuntimeError("model failed to load")

        cache_key = tuple(prompts)
        cached = self._text_feature_cache.get(cache_key)

        if cached is not None:
            return cached

        inputs = self._text_tokenizer(
            prompts,
            padding=True,
            return_tensors="pt",
            truncation=True,
        )
        inputs = {key: value.to(device=self.device) for key, value in inputs.items()}

        with torch.inference_mode():
            features = self._model.get_text_features(**inputs)
            features = torch.nn.functional.normalize(features, p=2, dim=-1)

        self._text_feature_cache[cache_key] = features
        return features

    def zero_shot_scores(
        self,
        image_embeddings: list[list[float]],
        prompts: list[str],
    ) -> list[list[float]]:
        if not image_embeddings:
            return []

        text_features = self._text_features(prompts)
        image_features = torch.tensor(
            image_embeddings,
            device=self.device,
            dtype=text_features.dtype,
        )
        image_features = torch.nn.functional.normalize(image_features, p=2, dim=-1)

        with torch.inference_mode():
            logits = image_features @ text_features.T
            probabilities = torch.softmax(logits * 100.0, dim=-1)

        return [
            [round(float(value), 6) for value in row]
            for row in probabilities.detach().cpu().tolist()
        ]
