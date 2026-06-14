# Trip Picks GPU Feature Worker Contract

This folder documents the optional second-stage GPU worker used by `services/api`.

The worker is not required for the MVP to run. If `GPU_FEATURES_URL` is unset, the API uses CPU-only analysis. When configured, the API sends only CPU-filtered candidate images to this endpoint.

## API Request

`POST /features`

Headers:

- `content-type: application/json`
- `authorization: Bearer <GPU_FEATURES_TOKEN>` when configured

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
  "modelProvider": "modal-siglip-aesthetic-v0",
  "modelVersion": "siglip-dino-aesthetic-v0.1.0",
  "features": [
    {
      "photoId": "photo-1",
      "embedding": [0.01, 0.02],
      "aestheticScore": 0.88,
      "modelLabels": ["landscape", "editorial"],
      "modelQualitySignals": {
        "sharpness": 0.91,
        "exposure": 0.84,
        "subjectCentered": 0.72
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

## API Environment

Configure these in `services/api`:

- `GPU_FEATURES_URL`: worker HTTPS endpoint.
- `GPU_FEATURES_TOKEN`: optional bearer token.
- `GPU_CANDIDATE_LIMIT`: max CPU-selected photos sent to GPU, default `240`.
- `GPU_BATCH_SIZE`: assets per HTTP call, default `24`.
- `GPU_TIMEOUT_MS`: timeout per batch, default `120000`.

## First Worker Recommendation

Use Modal or Runpod serverless first. The worker should:

- decode JPEG analysis copies
- batch inference on GPU
- produce CLIP/SigLIP or DINO-style embeddings
- optionally run an aesthetic/quality head
- return one feature object per `photoId`

Keep the worker stateless. The API owns job state, cleanup, final ranking, and carousel composition.
