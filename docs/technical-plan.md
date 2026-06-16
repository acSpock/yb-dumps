# Technical Plan

## Stack Decision

Use Expo React Native with TypeScript.

Reasons:

- Native iOS and Android from one codebase.
- Fast iteration for the first mobile product.
- Expo gives us photo picker, build, and release paths.
- Custom native modules remain possible later for Photos framework edge cases or on-device preprocessing.

## Refined MVP Architecture

The MVP has two user-facing analysis outputs:

1. Generated carousel options from a large trip photo set.
2. Feed preview recommendations against a profile aesthetic.

The mobile experience also needs two product mechanics around those outputs:

- local saved trips so generated work is reviewable later
- export packaging so a chosen carousel can move into Instagram
- Instagram connection/feed import state, with export fallback
- lightweight slide photo replacement inside generated carousel templates

```text
trip-picks-native/
  apps/
    mobile/              # Expo React Native app
  services/
    api/                 # projects, uploads, jobs, results
    model-worker/        # ranking, clustering, carousel composition, feed fit
  packages/
    shared/              # shared schemas/types
  docs/
```

## Mobile App

Current prototype dependencies:

- Expo
- React Native
- TypeScript
- `expo-image-picker`
- `expo-image-manipulator`
- `@react-native-async-storage/async-storage`
- `expo-auth-session`
- `expo-web-browser`
- `expo-linking`
- `expo-secure-store`
- `expo-media-library`
- `expo-sharing`
- `expo-crypto`
- `react-native-web` for browser smoke testing

Current analysis flow:

- `apps/mobile/src/services/analysisApi.ts` tries the CPU analysis job flow first on `EXPO_PUBLIC_API_BASE_URL`.
- Mobile creates max-1024px JPEG analysis copies with `expo-image-manipulator` and uploads those temporary copies to the API.
- Originals stay on the phone.
- The API deletes temporary analysis images after job success or failure.
- The API can optionally send only CPU-filtered candidates to a GPU feature endpoint before final ranking.
- If CPU job creation/start fails, mobile falls back to `POST /analysis/rank`.
- Mobile sends photo metadata, deterministic prototype labels/color signals/quality signals, feed-import assets when available, and ranking options.
- The server returns the app-facing `RankingResult` and mobile persists it into the local saved-trip snapshot.
- `buildRankingResult` remains the local fallback if the deployed API is asleep, unreachable, or returns an error.

Likely next dependencies:

- Expo Router, once screens split out of the single-file prototype.
- `expo-file-system` for staged upload files.
- A performant grid/list library before real 1,000-photo selection views.

## Backend

Keep boring:

- Local Node/TypeScript API scaffold now exists under `services/api`.
- Current service uses a dependency-free Node HTTP server for Meta OAuth, Instagram feed import, and guarded publish calls.
- Current service exposes metadata fallback ranking plus CPU analysis jobs:
  - `POST /analysis/rank`
  - `POST /analysis/jobs`
  - `POST /analysis/jobs/:jobId/assets`
  - `POST /analysis/jobs/:jobId/start`
  - `GET /analysis/jobs/:jobId`
  - `GET /analysis/jobs/:jobId/result`
- Dev token storage is a gitignored JSON file under `services/api/data`.
- Temporary analysis images live under `services/api/data/analysis-jobs` by default and are deleted after completion.
- Optional GPU feature extraction is controlled by:
  - `GPU_FEATURES_URL`
  - `GPU_FEATURES_TOKEN`
  - `GPU_CANDIDATE_LIMIT`
  - `GPU_BATCH_SIZE`
  - `GPU_TIMEOUT_MS`
- Production backend should still move to Postgres, object storage for uploaded/rendered images, and a queue for model jobs.

Core tables:

- users
- projects
- assets
- analysis_jobs
- photo_scores
- carousel_options
- carousel_slides
- feed_profiles
- feed_preview_candidates
- export_jobs later, if rendered slide generation moves server-side

Internal or later tables:

- duplicate_groups
- user_feedback

## Model Worker

Server-side first:

- ingest resized analysis images and metadata
- score technical quality
- detect near duplicates and bursts
- extract embeddings
- cluster moments
- rank a top candidate pool
- compose 3 carousel options with slide templates
- score feed-fit candidates against a grid/profile embedding

Current implementation:

- `services/api/src/analysisContracts.ts` defines the API-side ranking/result contract.
- `services/api/src/cpuVision.ts` implements `sharp`-based CPU feature extraction.
- `services/api/src/gpuFeatures.ts` implements the optional provider-neutral GPU feature client.
- `services/api/src/analysisJobs.ts` implements file-backed MVP analysis jobs.
- `services/api/src/modelRanker.ts` implements `heuristic-curation-v0.1.0`, `cpu-vision-curation-v0.1.0`, and `gpu-vision-curation-v0.2.0`.
- `POST /analysis/rank` accepts metadata, labels, color profiles, optional embeddings, optional quality/aesthetic signals, and optional feed-profile assets.
- The job flow accepts resized JPEG analysis images and enriches photo inputs with `perceptualHash`, `visualEmbedding`, `modelLabels`, and `modelQualitySignals`.
- If `GPU_FEATURES_URL` is configured, the job flow runs a preliminary CPU rank, caps candidates, POSTs candidate analysis images to the GPU endpoint, merges returned embeddings/scores, and then runs final ranking.
- If the GPU endpoint fails, the job logs `analysis.gpu.failed` and continues with CPU features.
- The current ranker/composer is intentionally deterministic:
  - score quality, aesthetics, coverage, and feed fit
  - detect exact/near duplicates from source ids, perceptual hashes, embeddings, and moment/time proximity
  - select a diverse top pool using relevance plus novelty/diversity constraints
  - compose up to 3 carousel variations capped at 20 slides
  - prefer landscape/square photos for stacked `vertical_triptych` templates
- Later real ML should replace feature extraction, not the whole result contract.

## GPU Worker

The optional worker implementation and contract are documented in `services/gpu-worker/README.md`.

Provider recommendation:

- Use Modal or Runpod serverless first.
- Keep the worker stateless.
- Return one feature object per `photoId`.
- Current implementation is a Dockerized FastAPI service using PyTorch + Transformers.
- Default model is `openai/clip-vit-base-patch32`.
- The Docker build preloads model files with `scripts/download_model.py`; startup/first-request loading can also download weights through `from_pretrained`.
- The worker currently returns CLIP embeddings, CLIP zero-shot semantic tags, template-role scores, and heuristic image quality/color/aesthetic signals.
- A dedicated aesthetic/quality head and true object detector are future work.
- Do not host the final ranker/composer in the GPU worker; keep that in `services/api`.

Current limitation:

- The API sends candidate resized images as base64 JSON for simplicity.
- Object storage URLs or signed asset URLs should replace base64 before larger friend/family tests.

The carousel composer should not only sort images. It should select and arrange slides under constraints:

- strong opener
- varied scenes
- people/place/detail balance
- avoid near duplicates unless used intentionally in a template
- enough vertical-friendly images
- at least a few composed multi-photo slides
- landscape-first selection for stacked horizontal strips
- clear closer

## Carousel Slide Model

Slides are generated artifacts:

- `single`: one hero photo
- `vertical_triptych`: three photos stacked vertically
- `hero_with_details`: one large image plus two detail images
- `detail_grid`: four small images

The slide template determines crop hints, preview rendering, and later export composition.

Template-specific selection:

- `vertical_triptych` uses a vertical canvas but horizontal strips, so it should prefer landscape photos first, then square, then portrait.
- `hero_with_details` should prefer a landscape hero image when possible.
- `detail_grid` should prefer landscape or square detail photos before portrait photos.
- User replacement should preserve the template but swap one photo id in the slide.

## Feed Preview Model

The feed profile can come from:

- Instagram-imported recent media
- grid screenshot
- selected recent posts

Score each candidate by:

- palette match
- brightness/contrast match
- composition density
- subject mix
- crop suitability
- novelty without clashing

The UI should show the best candidate inserted into a 3-column grid preview.

## Local Saved Trips

Frontend-first storage behavior:

- Use device-local storage to persist generated `TripProject` snapshots.
- Store chosen carousel variation, feed import source metadata, and export status.
- Treat this as an MVP bridge until backend account sync exists.
- Local image URIs may be fragile over time; backend-backed projects will need uploaded thumbnails or durable local copies.

## Export Handoff

Frontend experience:

- A selected carousel variation becomes an export package.
- Each generated slide should eventually render into an image asset.
- Path 1: `Export for Instagram` by saving rendered slides to Camera Roll in order.
- Path 2: optional Creator/Business API publishing, only when eligibility and rendered public URLs are available.
- Native share sheet / Instagram handoff can sit behind the export path where platform rules allow.
- Camera Roll remains the reliable default because Meta API publishing is not available for everyday personal accounts.

Likely implementation dependencies:

- `expo-media-library` for saving assets/albums.
- `expo-sharing` for share sheet support.
- a view/image rendering strategy for composed slide templates.

## Instagram Integration

Current implementation:

- Global Settings owns optional Creator/Business Instagram connection using the API OAuth start/callback endpoints.
- Store only an anonymous `deviceSessionId` on device; Meta app secrets and tokens stay on `services/api`.
- Support `not_connected`, `connected`, `setup_required`, and `error` connection states.
- Track account type, permissions, publish capability, token expiry, last feed import, and share status.
- Creator API import in feed preview calls `POST /instagram/import-feed`.
- Creator API publishing calls `POST /instagram/publish-carousel`, but the primary carousel modal action is export.
- Direct publish returns honest states: `requires_export`, `render_required`, `setup_required`, `published`, or `failed`.

Backend requirements already scaffolded:

- Meta OAuth/login flow.
- Token storage in a local gitignored dev store.
- Instagram account lookup and eligibility checks.
- Recent media import for feed aesthetic profiling.
- Media container creation/publishing for carousel posts where supported.
- Fallback to export/share sheet for users or accounts that cannot publish directly.

Backend requirements later:

- Token refresh jobs.
- Real user auth and account sync.
- Rendered carousel slide hosting at public HTTPS URLs.
- Permission review and production Meta app configuration.

## Privacy Model

Defaults:

- Upload analysis-sized images, not originals.
- Originals stay local unless export/edit requires them later.
- Delete raw analysis images after job completion unless user opts in.
- Keep embeddings/metadata/results only as needed for the project.
- Make privacy copy explicit before photo permission.

## MVP Milestones

### Milestone 1: Focused App Shell

- Import/select photos.
- Use sample trip.
- Fake analysis progress.
- Render 3 carousel options.
- Render feed preview with best candidate and alternates.
- Save generated trips locally.
- Show Instagram/export handoff UI.
- Show feed import UI with Instagram and manual fallback paths.
- Let user replace one photo inside a generated carousel slide.

### Milestone 2: Real Upload And Jobs

- Create project: still local/mobile-first.
- Register selected assets: still local/mobile-first.
- Generate resized analysis copies: implemented with `expo-image-manipulator`.
- Upload analysis assets: implemented through JSON base64 MVP endpoint; signed URLs/object storage should replace this later.
- Start analysis job: implemented synchronously in API request; queue/worker should replace this later.
- Poll analysis job: endpoint exists, but mobile currently waits for synchronous `start` result.
- Render returned carousel/feed results: implemented through existing `RankingResult`.

### Milestone 3: Ranking And Composition Prototype

- Embeddings.
- Duplicate/burst detection.
- Moment clustering.
- Top 50 candidate pool.
- 3 carousel option composer.

### Milestone 4: Feed Preview

- Grid screenshot or recent-post input.
- Feed aesthetic profile.
- Best candidate selection.
- 3-column grid preview.

### Milestone 5: Export

- Render/export carousel slides.
- Save composed slides to camera roll.
- Share sheet.
