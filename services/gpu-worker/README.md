# Trip Picks GPU Feature Worker

This is the optional second-stage worker for the Trip Picks analysis pipeline.

`services/api` still owns uploads, job state, CPU filtering, final ranking, and cleanup. This worker only receives CPU-selected candidate images and returns neural image embeddings plus quality/color signals.

If the API has no `GPU_FEATURES_URL`, the product continues to run CPU-only.

## What It Runs

- FastAPI HTTP service.
- PyTorch + Transformers.
- Default model: `openai/clip-vit-base-patch32`.
- CUDA automatically when available, CPU otherwise.
- CLIP image embeddings for each candidate image.
- Heuristic quality/color/aesthetic signals from pixel stats.

The aesthetic score is not a trained NIMA-style aesthetic head yet. It is a useful bridge score until we add a dedicated aesthetic model.

## Model Download Behavior

Yes, the worker downloads model files.

There are two paths:

1. Docker image build preload:
   - `Dockerfile` runs `python scripts/download_model.py` by default.
   - This downloads `GPU_MODEL_ID` into `GPU_MODEL_CACHE_DIR`.
   - The deployed image starts faster because weights are already cached.

2. Runtime fallback:
   - On startup, `GPU_PRELOAD_MODEL_ON_STARTUP=true` calls `from_pretrained`.
   - If the model was not baked into the image, Transformers downloads it into the cache.
   - If startup preload is disabled, the first `/features` request lazily loads/downloads the model.

For friend/family testing, prefer build preload so the first real trip does not wait on a model download.

## Environment

Worker env:

```bash
GPU_WORKER_TOKEN=change-me
GPU_MODEL_ID=openai/clip-vit-base-patch32
GPU_MODEL_CACHE_DIR=/models/huggingface
GPU_MODEL_DEVICE=auto
GPU_MODEL_DTYPE=auto
GPU_BATCH_SIZE=24
GPU_MAX_ASSETS=256
GPU_PRELOAD_MODEL_ON_STARTUP=true
PORT=8080
```

API env on Render:

```bash
GPU_FEATURES_URL=https://your-gpu-worker.example.com/features
GPU_FEATURES_TOKEN=change-me
GPU_CANDIDATE_LIMIT=240
GPU_BATCH_SIZE=24
GPU_TIMEOUT_MS=120000
```

`GPU_FEATURES_TOKEN` in the API must match `GPU_WORKER_TOKEN` in this worker.

These are not vendor-issued tokens. Generate one random shared secret yourself and put the same value in both places:

```bash
openssl rand -hex 32
```

Do not commit this token to Git.

## GHCR Image Build

The repo includes `.github/workflows/gpu-worker-image.yml`.

On every push that changes `services/gpu-worker/**`, GitHub Actions builds and pushes:

```bash
ghcr.io/acspock/yb-dumps-gpu-worker:latest
ghcr.io/acspock/yb-dumps-gpu-worker:sha-<commit>
```

The workflow preloads model weights into the image by default. You can also run the workflow manually and set `preload_model=false` if the build image gets too large or the model download is timing out.

Runpod needs to be able to pull the image. If the GHCR package is private, either make the package public or add GHCR registry credentials in Runpod.

## Local Docker

Build:

```bash
docker build -t trip-picks-gpu-worker services/gpu-worker
```

Run:

```bash
docker run --rm -p 8080:8080 \
  -e GPU_WORKER_TOKEN=dev-token \
  trip-picks-gpu-worker
```

Health check:

```bash
curl http://localhost:8080/health
```

## API Request

`POST /features`

Headers:

- `content-type: application/json`
- `authorization: Bearer <GPU_WORKER_TOKEN>` when configured

Body:

```json
{
  "jobId": "analysis-job-id",
  "projectId": "trip-project-id",
  "assets": [
    {
      "photoId": "photo-1",
      "width": 1024,
      "height": 768,
      "mimeType": "image/jpeg",
      "imageBase64": "...",
      "labels": ["place", "landscape"],
      "modelLabels": ["warm"]
    }
  ]
}
```

## API Response

```json
{
  "modelProvider": "trip-picks-gpu-worker",
  "modelVersion": "openai--clip-vit-base-patch32-image-embedding-v0.1.0",
  "features": [
    {
      "photoId": "photo-1",
      "embedding": [0.01, 0.02],
      "aestheticScore": 0.88,
      "modelLabels": ["landscape", "neural_embedding", "warm"],
      "modelQualitySignals": {
        "sharpness": 0.91,
        "exposure": 0.84,
        "noise": 0.12,
        "subjectCentered": 0.72,
        "contrast": 0.61
      },
      "colorProfile": {
        "brightness": 0.58,
        "contrast": 0.61,
        "saturation": 0.55,
        "warmth": 0.63
      }
    }
  ]
}
```

## Deploy Notes

Use a GPU service that can deploy a Docker image and expose HTTPS:

- Runpod serverless endpoint or pod.
- Modal web endpoint using the same app code/image.
- Any GPU VM with Docker and HTTPS routing.

The current API sends candidate images as base64 JSON. That is acceptable for a first deployment because only CPU-filtered candidates are sent. For heavier friend/family usage, move candidate images to object storage and send signed URLs instead.
