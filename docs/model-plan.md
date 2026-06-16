# Model Plan

## Principle

Do not train a foundation model. Build a ranking and composition system on top of strong vision embeddings.

## Pipeline

### 1. Ingest

Inputs:

- image file
- thumbnail
- EXIF timestamp
- GPS if available
- dimensions/orientation
- camera/device
- burst/live-photo hints where available

Mobile should send:

- original asset ID
- metadata
- low/mid-resolution analysis image
- optional full-res image only for final export/edit steps

### 2. Technical Quality

Score:

- blur/sharpness
- exposure
- contrast
- face quality
- closed eyes
- awkward crop
- low resolution
- screenshot/document/meme detection

### 3. Duplicate Detection

Use:

- perceptual hashes for obvious duplicates
- embedding distance for near-duplicates
- burst/time proximity to group similar shots

Pick the best one per group unless the group has meaningful variation.

### 4. Embeddings

Use embeddings for:

- visual similarity
- semantic grouping
- aesthetic matching
- user preference learning

Candidates:

- CLIP/SigLIP-style image-text embeddings for semantic understanding
- DINO-style visual features for similarity and clustering

### 5. Moment Clustering

Cluster by:

- time
- GPS/location
- embedding similarity
- people/faces
- scene type

Goal: avoid picking 30 sunset photos and missing dinner, transit, friends, and details.

### 6. Aesthetic Scoring

General score:

- composition
- light
- subject clarity
- color harmony
- social/share suitability

This should not dominate final selection. It should be one feature in a ranker.

### 7. Personal Taste

Train a per-user lightweight ranker over:

- embeddings
- quality score
- scene type
- face count
- color palette
- previous keep/reject/favorite actions

Start with logistic regression or gradient boosted trees. Do not overbuild.

### 8. Feed Aesthetic

Represent the user grid as:

- color palette
- brightness/contrast distribution
- subject mix
- face/landscape/detail ratio
- composition density
- embedding centroid and variance

For candidate photos, score:

- fit with current grid
- novelty without clashing
- carousel compatibility
- crop suitability

### 9. Carousel Composer

Build outputs with constraints:

- `Top 50`: ranked candidate pool for transparency and fallback replacement.
- `Carousel options`: 3 finished editorial options, each with a point of view.
- `Slides`: mix single-photo slides with composed templates such as vertical triptychs, hero-with-details, and detail grids.
- `Feed preview`: best next-feed candidate plus alternates against the user's grid aesthetic.

This is a constrained selection problem, not just sorting by score.

For the refined MVP, story picks, album picks, duplicate cleanup UI, and taste trainer are not top-level product outputs. They can remain internal ranking signals or future features.

## MVP Model Strategy

Server-side first:

- easier to iterate
- stronger models
- no mobile memory limits
- faster experimentation

Move selective pieces on-device later:

- hashing
- thumbnail generation
- obvious duplicate detection
- possibly a compact aesthetic/personal ranker

## Implemented CPU-First Pipeline With Optional GPU Refinement

The current server-side prototype is implemented in `services/api` rather than a separate worker process:

- `POST /analysis/rank`
- `POST /analysis/jobs`
- `POST /analysis/jobs/:jobId/assets`
- `POST /analysis/jobs/:jobId/start`
- `GET /analysis/jobs/:jobId`
- `GET /analysis/jobs/:jobId/result`
- `services/api/src/analysisContracts.ts`
- `services/api/src/analysisJobs.ts`
- `services/api/src/cpuVision.ts`
- `services/api/src/gpuFeatures.ts`
- `services/api/src/modelRanker.ts`
- `services/gpu-worker/README.md`

There are now three model versions:

- `heuristic-curation-v0.1.0` for metadata-only `/analysis/rank`.
- `cpu-vision-curation-v0.1.0` when resized image uploads produce CPU pixel features.
- `gpu-vision-curation-v0.2.0` when an optional GPU endpoint returns embeddings plus zero-shot semantic/template features for CPU-selected candidates.

The CPU path is not a trained neural model yet. It is a cheaper first step that feeds better real-image features into the same ranking/composition layer:

- accepts optional neural embeddings per photo
- accepts optional quality/aesthetic model scores
- falls back to deterministic metadata/label/color features when those model outputs are missing
- computes perceptual hashes for exact/near duplicate grouping
- computes blur/exposure/color features with `sharp`
- computes lightweight `visualEmbedding` vectors from pixel histograms and image grids
- picks a diverse top pool
- composes carousel variations capped at Instagram's 20-slide limit
- prefers horizontal photos for stacked layered templates
- scores feed-fit from palette, brightness, subject mix, crop suitability, and optional feed embeddings

The GPU path is an optional second stage:

- CPU analyzes every uploaded analysis image.
- The API runs a preliminary CPU rank and candidate cap.
- Only the strongest candidates with uploaded assets are sent to `GPU_FEATURES_URL`.
- Returned embeddings, zero-shot semantic tags, template-role scores, aesthetic scores, labels, and quality signals are merged back into the final ranking input.
- GPU failure falls back to CPU results rather than failing the trip.
- `services/gpu-worker` now contains a Dockerized FastAPI/PyTorch/Transformers worker.
- The worker downloads `GPU_MODEL_ID` during Docker build by default, and can also load/download at startup or first request.
- The worker returns CLIP embeddings, CLIP zero-shot semantic tags, template-role scores, and heuristic quality/color/aesthetic signals. A trained aesthetic head and true object detector remain future work.

GPU env controls:

- `GPU_FEATURES_URL`
- `GPU_FEATURES_TOKEN`
- `GPU_CANDIDATE_LIMIT`
- `GPU_BATCH_SIZE`
- `GPU_TIMEOUT_MS`

Next model step:

- Add an async worker/queue instead of synchronous `start`.
- Deploy `services/gpu-worker` to Modal, Runpod, or another GPU HTTPS endpoint and set `GPU_FEATURES_URL` on Render.
- Add a NIMA-style quality/aesthetic head behind the existing GPU feature contract.
- Add a true detector/face-quality model if zero-shot tags are not enough for crop safety and object-level template decisions.
- Add CPU feed-image analysis for imported grid screenshots/recent posts.
- Keep `/analysis/rank` as the composition/ranking layer so the mobile app contract stays stable.
