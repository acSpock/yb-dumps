from pydantic import BaseModel, ConfigDict, Field


class ApiModel(BaseModel):
    model_config = ConfigDict(populate_by_name=True)


class FeatureAssetInput(ApiModel):
    photo_id: str = Field(alias="photoId")
    width: int | None = None
    height: int | None = None
    mime_type: str | None = Field(default=None, alias="mimeType")
    image_base64: str = Field(alias="imageBase64")
    labels: list[str] | None = None
    model_labels: list[str] | None = Field(default=None, alias="modelLabels")
    captured_at: str | None = Field(default=None, alias="capturedAt")


class FeatureRequest(ApiModel):
    job_id: str = Field(alias="jobId")
    project_id: str = Field(alias="projectId")
    assets: list[FeatureAssetInput]


class ColorProfile(ApiModel):
    brightness: float
    contrast: float
    saturation: float
    warmth: float


class QualitySignals(ApiModel):
    sharpness: float
    exposure: float
    noise: float
    subject_centered: float = Field(alias="subjectCentered")
    contrast: float


class FeatureOutput(ApiModel):
    photo_id: str = Field(alias="photoId")
    embedding: list[float]
    aesthetic_score: float = Field(alias="aestheticScore")
    model_labels: list[str] = Field(alias="modelLabels")
    model_quality_signals: QualitySignals = Field(alias="modelQualitySignals")
    color_profile: ColorProfile = Field(alias="colorProfile")


class FeatureResponse(ApiModel):
    model_provider: str = Field(alias="modelProvider")
    model_version: str = Field(alias="modelVersion")
    features: list[FeatureOutput]


class HealthResponse(ApiModel):
    ok: bool
    model_id: str = Field(alias="modelId")
    model_loaded: bool = Field(alias="modelLoaded")
    device: str
