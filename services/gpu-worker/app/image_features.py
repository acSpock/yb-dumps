from __future__ import annotations

import base64
from dataclasses import dataclass
from io import BytesIO
import re

import numpy as np
from PIL import Image, ImageOps

from app.schemas import ColorProfile, QualitySignals


DATA_URL_RE = re.compile(r"^data:[^;]+;base64,", re.IGNORECASE)


@dataclass(frozen=True)
class ImageStats:
    aesthetic_score: float
    color_profile: ColorProfile
    labels: list[str]
    quality_signals: QualitySignals


def clamp(value: float, minimum: float = 0.0, maximum: float = 1.0) -> float:
    return max(minimum, min(maximum, value))


def round_feature(value: float) -> float:
    return round(clamp(float(value)), 4)


def decode_image(image_base64: str) -> Image.Image:
    clean_base64 = DATA_URL_RE.sub("", image_base64.strip())
    image_bytes = base64.b64decode(clean_base64, validate=True)
    image = Image.open(BytesIO(image_bytes))
    image = ImageOps.exif_transpose(image)
    return image.convert("RGB")


def _luma(rgb: np.ndarray) -> np.ndarray:
    return (
        rgb[:, :, 0] * 0.2126
        + rgb[:, :, 1] * 0.7152
        + rgb[:, :, 2] * 0.0722
    )


def _saturation(rgb: np.ndarray) -> np.ndarray:
    max_channel = np.max(rgb, axis=2)
    min_channel = np.min(rgb, axis=2)
    return np.divide(
        max_channel - min_channel,
        np.maximum(max_channel, 0.0001),
        out=np.zeros_like(max_channel),
        where=max_channel > 0,
    )


def compute_image_stats(image: Image.Image) -> ImageStats:
    resized = image.resize((128, 128))
    rgb = np.asarray(resized, dtype=np.float32) / 255.0
    luma = _luma(rgb)
    saturation = _saturation(rgb)

    brightness = float(np.mean(luma))
    contrast = clamp(float(np.std(luma)) * 3.2)
    saturation_score = clamp(float(np.mean(saturation)) * 1.2)
    warmth = clamp(0.5 + (float(np.mean(rgb[:, :, 0])) - float(np.mean(rgb[:, :, 2]))) * 0.8)

    dx = np.abs(np.diff(luma, axis=1))
    dy = np.abs(np.diff(luma, axis=0))
    gradient = float((np.mean(dx) + np.mean(dy)) / 2.0)
    sharpness = clamp(gradient * 7.5 + contrast * 0.28)
    clipped = float(np.mean((luma <= 0.03) | (luma >= 0.97)))
    exposure = clamp((1 - abs(brightness - 0.56) * 1.6) * 0.72 + (1 - clipped * 5) * 0.28)
    noise = clamp(max(0.0, gradient * 6.5 - contrast * 0.9))

    height, width = luma.shape
    center = luma[
        int(height * 0.28): int(height * 0.72),
        int(width * 0.28): int(width * 0.72),
    ]
    center_brightness = float(np.mean(center)) if center.size else brightness
    subject_centered = clamp(0.62 + abs(center_brightness - brightness) * 1.8)

    color_harmony = float(np.mean([
        1 - abs(saturation_score - 0.54) * 1.1,
        1 - abs(contrast - 0.5) * 1.2,
        1 - abs(warmth - 0.56) * 0.7,
    ]))
    aesthetic_score = sharpness * 0.36 + exposure * 0.27 + color_harmony * 0.27 + subject_centered * 0.1

    labels = set()
    aspect_ratio = image.width / max(image.height, 1)
    labels.add("landscape" if aspect_ratio > 1.12 else "portrait" if aspect_ratio < 0.88 else "square")

    if brightness < 0.34:
        labels.add("low_light")
    elif brightness > 0.76:
        labels.add("bright")

    if saturation_score > 0.64:
        labels.add("colorful")

    if warmth > 0.62:
        labels.add("warm")
    elif warmth < 0.4:
        labels.add("cool")

    if contrast > 0.58:
        labels.add("high_contrast")

    if sharpness < 0.42:
        labels.add("soft_focus")

    return ImageStats(
        aesthetic_score=round_feature(aesthetic_score),
        color_profile=ColorProfile(
            brightness=round_feature(brightness),
            contrast=round_feature(contrast),
            saturation=round_feature(saturation_score),
            warmth=round_feature(warmth),
        ),
        labels=sorted(labels),
        quality_signals=QualitySignals(
            contrast=round_feature(contrast),
            exposure=round_feature(exposure),
            noise=round_feature(noise),
            sharpness=round_feature(sharpness),
            subjectCentered=round_feature(subject_centered),
        ),
    )
