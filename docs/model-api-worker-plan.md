# Model/API Worker Contract

## Status

Partially superseded by the 2026-06-12 product refinement.

The current prototype contract in `apps/mobile/src/types.ts` now centers on:

- `topPicks`: the ranked candidate pool
- `carouselVariations`: finished carousel options with generated slide templates
- `feedPreviewCandidates`: ranked feed-fit photos for grid preview

Older fields in this worker plan that describe story picks, album picks, or feed-fit as a side mode should be treated as historical planning context, not the current MVP interface.

This is the working data contract for local fake prototype data and the later API/model-worker handoff. The goal is to let the mobile app render realistic ranking, duplicate, album, and feed-fit states before the backend exists.

## Assumptions

- One trip is represented as a `project`.
- MVP analysis handles 100-500 photos per project.
- Mobile uploads resized analysis images, not originals.
- Originals stay local unless a later export/edit flow explicitly needs them.
- IDs are strings and stable within a project.
- Scores are numeric `0.0` to `1.0`, where higher is better unless the field name says otherwise.
- Arrays returned for story, carousel, and album picks are already ordered.
- Fake data should use the same object shapes as the future API, with local URIs standing in for uploaded image URLs.

## Shared Enums

```ts
type UploadStatus = "local_only" | "pending" | "uploaded" | "failed";
type JobStatus = "created" | "awaiting_uploads" | "queued" | "running" | "succeeded" | "failed" | "canceled" | "expired";
type JobStage = "ingest" | "quality" | "duplicates" | "embeddings" | "clustering" | "ranking" | "feed_fit" | "complete";
type PickSet = "story" | "carousel" | "album";
type FeedFitLabel = "fits" | "maybe" | "clashes";
type FeedbackAction = "keep" | "reject" | "favorite" | "unset";
```

## Trip Photo

`TripPhoto` is the app-facing asset record. In fake mode, `localUri` and `thumbnailUri` are enough. In backend mode, `analysisImageUrl` is populated after upload or resolved through signed object storage.

| Field | Type | Notes |
| --- | --- | --- |
| `photoId` | string | App/API stable ID for this project photo. |
| `projectId` | string | Trip/project container. |
| `sourceAssetId` | string | Native camera-roll asset ID. Treat as device-local, not globally stable. |
| `localUri` | string? | Local preview URI for prototype and selected device asset. |
| `thumbnailUri` | string? | Local or remote thumbnail for grids. |
| `analysisImageUrl` | string? | Uploaded resized analysis image URL or storage key. |
| `originalFilename` | string? | Best-effort display/debug value. |
| `width` / `height` | number | Pixel dimensions after reading asset metadata. |
| `orientation` | string? | EXIF/native orientation when available. |
| `capturedAt` | string? | ISO timestamp from EXIF or library metadata. |
| `timezone` | string? | Optional IANA timezone if available. |
| `gps` | `{ lat: number; lng: number; accuracyMeters?: number }?` | Optional and privacy-sensitive. |
| `camera` | `{ make?: string; model?: string; lens?: string }?` | Optional EXIF/device metadata. |
| `mediaHints` | object | `{ isScreenshot?: boolean; isLivePhoto?: boolean; isBurst?: boolean; burstId?: string }`. |
| `uploadStatus` | `UploadStatus` | `local_only` for fake prototype data. |
| `userFeedback` | `FeedbackAction` | Latest explicit user action. |

## Ranking Result

`RankingResult` is the main model output. The API should return one latest result per completed analysis job.

| Field | Type | Notes |
| --- | --- | --- |
| `resultId` | string | Stable result ID. |
| `projectId` | string | Parent project. |
| `jobId` | string | Analysis job that generated the result. |
| `modelVersion` | string | Worker/model bundle version. Required for migrations and debugging. |
| `generatedAt` | string | ISO timestamp. |
| `picks` | object | `{ story: RankedPick[]; carousel: RankedPick[]; album: RankedPick[] }`. |
| `photoScores` | `PhotoScore[]` | Per-photo scoring details for detail views and debugging. |
| `duplicateGroups` | `DuplicateGroup[]` | Near-duplicate/burst group output. |
| `feedFitScores` | `FeedFitScore[]` | Empty unless feed aesthetic mode was requested. |
| `warnings` | string[] | Non-fatal issues, such as missing EXIF or too few vertical photos. |

`RankedPick`:

| Field | Type | Notes |
| --- | --- | --- |
| `photoId` | string | Selected photo. |
| `set` | `PickSet` | Story, carousel, or album. |
| `rank` | number | 1-based order inside the set. |
| `finalScore` | number | Constrained selection score. |
| `reasons` | string[] | Short UI-safe reason labels, for example `sharp`, `good light`, `adds variety`. |
| `momentId` | string? | Cluster/moment assignment. |
| `duplicateGroupId` | string? | Present when selected from a duplicate group. |
| `cropHint` | `"vertical" | "square" | "landscape" | "none"` | Suggested output crop direction. |
| `editHint` | string? | Optional lightweight edit guidance, not a generated filter. |

`PhotoScore`:

| Field | Type | Notes |
| --- | --- | --- |
| `photoId` | string | Scored photo. |
| `qualityScore` | number | Blur, exposure, face quality, resolution, and artifact signal. |
| `aestheticScore` | number | Composition, light, subject clarity, and color harmony. |
| `personalTasteScore` | number? | Null/omitted until enough feedback exists. |
| `coverageScore` | number | How useful the photo is for covering moments/people/places. |
| `finalScore` | number | Overall ranker score before set constraints. |
| `sceneLabels` | string[] | Coarse labels like `beach`, `dinner`, `transit`, `detail`. |
| `qualityFlags` | string[] | Negative flags like `blurry`, `closed_eyes`, `screenshot`, `awkward_crop`. |
| `faceCount` | number? | Optional aggregate count. Avoid storing identities in MVP. |

## Duplicate Group

| Field | Type | Notes |
| --- | --- | --- |
| `groupId` | string | Stable group ID. |
| `projectId` | string | Parent project. |
| `photoIds` | string[] | All photos in the group. |
| `representativePhotoId` | string | Best preview image for the group. |
| `bestPhotoId` | string | Worker recommendation to keep. |
| `duplicateType` | `"exact" | "near" | "burst" | "similar"` | Why the photos were grouped. |
| `confidence` | number | Group confidence. |
| `reasonCodes` | string[] | `phash_match`, `embedding_close`, `time_proximity`, `burst_id`, etc. |
| `createdAt` | string | ISO timestamp. |

## Feed Fit Score

Feed fit is computed against a `FeedProfile`, built from a grid screenshot or selected prior posts.

| Field | Type | Notes |
| --- | --- | --- |
| `feedProfileId` | string | Aesthetic profile used for scoring. |
| `projectId` | string | Parent project. |
| `photoId` | string | Candidate trip photo. |
| `fitScore` | number | Overall grid-fit score. |
| `label` | `FeedFitLabel` | UI bucket derived from `fitScore` and clash rules. |
| `paletteMatch` | number | Color palette compatibility. |
| `brightnessMatch` | number | Brightness/contrast compatibility. |
| `compositionMatch` | number | Density, crop, and subject placement compatibility. |
| `subjectMixFit` | number | Fit with current people/place/detail mix. |
| `noveltyScore` | number | Adds variety without clashing. |
| `cropSuitability` | `{ square: number; vertical: number; landscape: number }` | Output-format fit. |
| `reasons` | string[] | Short UI-safe labels. |

## Job Lifecycle

1. `created`: API has a project and declared assets.
2. `awaiting_uploads`: one or more required analysis images are not uploaded yet.
3. `queued`: all required images are uploaded and a worker task is enqueued.
4. `running`: worker is processing stages from ingest through ranking.
5. `succeeded`: result is available and raw analysis images may be deleted according to retention policy.
6. `failed`: no complete result is available. Include `errorCode`, `message`, and retryability.
7. `canceled`: user or system canceled before completion.
8. `expired`: uploads or job sat too long without completion.

`AnalysisJob` fields:

| Field | Type | Notes |
| --- | --- | --- |
| `jobId` | string | Stable job ID. |
| `projectId` | string | Parent project. |
| `status` | `JobStatus` | Current state. |
| `stage` | `JobStage` | Current or last completed stage. |
| `progress` | number | `0.0` to `1.0`, best effort. |
| `assetCount` | number | Declared photo count. |
| `uploadedAssetCount` | number | Analysis images available to worker. |
| `createdAt` / `updatedAt` | string | ISO timestamps. |
| `startedAt` / `completedAt` | string? | Worker timing. |
| `error` | `{ code: string; message: string; retryable: boolean }?` | Present for `failed`. |
| `resultId` | string? | Present after success. |

Fake prototype jobs can be hard-coded as `succeeded`, `stage: "complete"`, and `progress: 1`.

## Endpoint Sketch

These are REST-shaped endpoints for planning only. Shared TypeScript schemas should be added before implementation.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/analysis/rank` | Implemented heuristic-v0 ranking/composition endpoint. Accepts photo metadata/features and optional feed-profile assets; returns the current `RankingResult` shape. |
| `POST` | `/v1/projects` | Create a trip project. |
| `POST` | `/v1/projects/:projectId/assets:bulkCreate` | Register selected photos and receive signed upload targets. |
| `PATCH` | `/v1/projects/:projectId/assets/:photoId` | Update upload status or corrected metadata. |
| `POST` | `/v1/projects/:projectId/analysis-jobs` | Start analysis after required uploads. |
| `GET` | `/v1/analysis-jobs/:jobId` | Poll lifecycle status and progress. |
| `GET` | `/v1/projects/:projectId/results/latest` | Fetch latest completed `RankingResult`. |
| `POST` | `/v1/projects/:projectId/feedback` | Submit keep/reject/favorite actions. |
| `POST` | `/v1/projects/:projectId/feed-profiles` | Create feed profile from screenshot or prior-post assets. |
| `POST` | `/v1/projects/:projectId/feed-fit-jobs` | Score project photos against a feed profile. |

Internal worker queue message:

```ts
type AnalysisJobMessage = {
  jobId: string;
  projectId: string;
  photoIds: string[];
  analysisImageKeys: Record<string, string>;
  feedProfileId?: string;
  requestedOutputs: PickSet[];
  modelVersion?: string;
};
```

## Prototype Fixture Guidance

- Keep fake fixtures deterministic so UI snapshots and demos do not reshuffle.
- Include at least one duplicate group, one rejected-quality photo, and one strong pick that appears in all three sets.
- Include missing optional metadata on some photos to exercise empty states.
- Use `local_only` uploads and `succeeded` jobs until real upload/polling work starts.
- Keep reason strings short enough to display as chips.

## Risks And Open Questions

- Native `sourceAssetId` stability differs across iOS, Android, and library permission modes.
- EXIF, GPS, burst, and live-photo hints may be missing or stripped.
- Privacy policy needs exact retention rules for analysis images, GPS, embeddings, and face-derived signals.
- We need thresholds for `fits`, `maybe`, and `clashes` after seeing real feed-profile behavior.
- Personal taste scoring may be unavailable at first because new users have too little feedback.
- Result migrations need a plan once `modelVersion` changes field meanings or score calibration.
- Failure behavior for partially uploaded or partially processed 500-photo projects needs product decisions.
- Face counts are useful for ranking, but identity recognition should stay out of MVP unless explicitly approved.
