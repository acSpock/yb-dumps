# Trip Picks Running Memory Log

This file is the handoff source for future Trip Picks threads. Keep it current when architecture, product scope, or implementation boundaries change.

## 2026-06-13 - Drag-Range Trip Photo Picker

### Product/Architecture Decision

- The system image picker is too slow for large trip dumps because users must tap every photo individually.
- Trip import now starts with a custom camera-roll picker backed by `expo-media-library`.
- The native system picker remains as a fallback for web, unavailable MediaLibrary states, or platform edge cases.
- Selection should support large contiguous time-frame batches: tap individual photos, long-press and drag across nearby photos to range-select, load more recent assets, or quickly select the newest 100 loaded photos.

### Implementation Done

- Added `TripPhotoPickerModal` in `apps/mobile/App.tsx`.
- `Choose trip photos` now opens the custom picker when MediaLibrary is available.
- The picker loads photos newest-first in pages of 180, tracks selected order, supports tap toggle, long-press drag range selection, `Newest 100`, `Clear`, `Load more`, and `System picker`.
- Confirming selected assets reuses the existing `createProjectFromPickedAssets` flow.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- Browser automation was unavailable in this Codex session, and direct curl to the existing Expo server did not connect despite the process listening on `8081`; manual phone verification is still needed for gesture feel.

## 2026-06-13 - Same-Scene Variant Suppression

### Product/Architecture Decision

- Photos of the same subject from slightly different angles should generally compete with each other, not both appear in a generated carousel.
- Repeating visually similar frames is acceptable only when a future template explicitly uses repetition as an artistic/comparison device.
- Metadata-only fallback should not aggressively collapse unrelated lookalikes. The stricter same-scene suppression requires model-backed embeddings or CPU visual embeddings.

### Implementation Done

- Added a `same_scene_variant` duplicate reason in `services/api/src/modelRanker.ts`.
- Same-scene grouping now requires model-backed visual evidence plus similar palette, matching orientation, overlapping scene labels, and sufficient visual similarity.
- Tightened duplicate similarity logic so metadata-only photos still use source asset, exact hash, or same-moment/time burst signals rather than broad visual similarity.

### Validation

- Calibrated against the two provided screenshots: current CPU features saw hash distance 4 and visual cosine 0.998, which should group those frames when CPU analysis is active.
- Added API tests for CPU-backed same-scene grouping and for avoiding metadata-only over-grouping.
- `npm test` passes in `services/api` with 18 tests.

## 2026-06-13 - CPU-First Real Image Analysis Pipeline

### Product/Architecture Decision

- CPU-first on Render is the current model path. GPU/Modal remains a later upgrade if latency or embedding quality is not enough.
- Mobile uploads resized max-1024px JPEG analysis copies, not originals. Original selected photos stay on the phone.
- Uploaded analysis images are temporary and deleted after job completion or failure.
- The current `/analysis/rank` composer remains the final ranking/composition layer and metadata-only fallback.
- The first CPU model slice prioritizes duplicate removal, best-frame quality selection, carousel variety, and feed-fit color/profile signals.
- Heavy ONNX/Transformers embeddings are intentionally deferred. The implemented hook is `visualEmbedding`, backed today by lightweight pixel-derived vectors.

### Implementation Done

- Added `expo-image-manipulator` to `apps/mobile`.
- Added `sharp` to `services/api`.
- Added `services/api/src/cpuVision.ts`:
  - decodes resized images
  - computes dHash-style perceptual hashes
  - scores brightness, contrast, saturation, warmth, sharpness, exposure, noise, and center bias
  - produces lightweight 32-dimensional visual embeddings
  - emits model labels such as `landscape`, `portrait`, `warm`, `bright`, `low_light`, `colorful`, `high_contrast`, and `soft_focus`
- Added file-backed analysis jobs in `services/api/src/analysisJobs.ts`.
- Added API endpoints:
  - `POST /analysis/jobs`
  - `POST /analysis/jobs/:jobId/assets`
  - `POST /analysis/jobs/:jobId/start`
  - `GET /analysis/jobs/:jobId`
  - `GET /analysis/jobs/:jobId/result`
- Expanded analysis contracts with `perceptualHash`, `visualEmbedding`, `modelLabels`, and `modelQualitySignals`.
- Updated `services/api/src/modelRanker.ts`:
  - returns `cpu-vision-curation-v0.1.0` when CPU features are present
  - uses `visualEmbedding` before metadata fallback embeddings
  - uses perceptual hashes for exact/near duplicate grouping
  - merges model quality signals into quality scoring and flags
- Updated `apps/mobile/src/services/analysisApi.ts` so normal generation tries:
  - CPU analysis job with resized image uploads
  - server metadata `/analysis/rank` fallback
  - local `buildRankingResult` fallback
- Updated analysis progress copy in `apps/mobile/App.tsx` to explain resized analysis copies and CPU vision honestly.

### Validation

- `npm run typecheck` passes in `services/api`.
- `npm run typecheck` passes in `apps/mobile`.
- `npm test` passes in `services/api` outside the sandbox, where localhost binding is allowed.
- Tests cover CPU hash/embedding generation, sharpness/contrast response, perceptual-hash duplicate grouping, model version switching, job upload/start/result flow, and temporary image cleanup.

### Known Gaps

- `/analysis/jobs/:jobId/start` currently runs CPU analysis synchronously inside the request. A real queue/worker should replace this when jobs become large.
- Feed profile assets still mostly use metadata-derived features; uploading grid screenshots/recent-post image copies for CPU feed profiling is the next obvious quality step.
- The lightweight `visualEmbedding` is not a neural embedding. ONNX/Transformers.js can be added later behind the same contract.
- Render free CPU can be slow for hundreds of images, but this path is cheaper and good enough for friend/family MVP testing.

## 2026-06-13 - Carousel Composer Source-Asset Deduping

### Product/Architecture Decision

- Multi-photo templates must not repeat the same underlying image inside one slide.
- Until real pixel embeddings/perceptual hashes are available, the ranker treats matching `sourceAssetId` values as exact duplicates.
- Mobile sends a hashed local source key when Expo does not provide a stable camera-roll asset id, so repeated local URIs can still be deduped without sending raw file paths.
- Composer selection now avoids reusing the same visual identity across a carousel variation and within each multi-photo slide.

### Implementation Done

- `services/api/src/modelRanker.ts` now groups matching `sourceAssetId` photos as exact duplicate groups.
- Template selection and single-slide fill now track `visualIdentityKey`, based on duplicate group or source asset.
- `apps/mobile/src/services/analysisApi.ts` hashes local URI metadata into a stable fallback source id when needed.
- Local fallback carousel generation also avoids repeating the same visual source in one slide.

### Validation

- Added an API regression test for repeated source assets appearing as different photo ids.
- `npm run typecheck` passes in `services/api`.
- `npm run typecheck` passes in `apps/mobile`.
- `npm test` passes in `services/api` outside the sandbox, where localhost binding is allowed.

## 2026-06-13 - Mobile Analysis Integrated With Backend Ranker

### Product/Architecture Decision

- The mobile MVP should exercise the real backend ranking contract during normal carousel generation.
- Keep the local fake ranker as a resilience fallback so UI work remains unblocked if Render is asleep, offline, or the analysis endpoint errors.
- Mobile sends metadata-derived labels, color profile signals, quality signals, optional feed-import assets, and ranking options to `POST /analysis/rank`.
- The backend remains responsible for top-pick selection, carousel composition, duplicate grouping, and feed-preview candidate scoring.

### Implementation Done

- Added `apps/mobile/src/services/analysisApi.ts`.
- Updated the `Generate carousel options` workflow in `apps/mobile/App.tsx` to:
  - mark the trip analysis job as running
  - show a backend-ranking step in the progress UI
  - call `${EXPO_PUBLIC_API_BASE_URL}/analysis/rank`
  - replace the project result with the backend `RankingResult`
  - persist the generated result to local saved trips
  - fall back to `buildRankingResult` with an honest workflow message if the API call fails
- Local mobile env points at the live Render API with `EXPO_PUBLIC_API_BASE_URL=https://yb-dumps-api.onrender.com`.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- A direct live Render `POST /analysis/rank` smoke test returned `200` and produced 3 carousel variations.

## 2026-06-13 - Server-Side Ranking And Composition Prototype

### Product/Architecture Decision

- Build a server-side curation engine first, not a custom foundation model.
- The current server endpoint is `POST /analysis/rank` in `services/api`.
- The endpoint returns the app-facing `RankingResult` shape: top picks, carousel variations, photo scores, duplicate groups, feed-preview candidates, and warnings.
- Real neural models should feed this ranker with embeddings and quality/aesthetic scores later; the ranker/composer remains the constrained selection layer.

### Implementation Done

- Added `services/api/src/analysisContracts.ts` with API-side analysis request/result types.
- Added `services/api/src/modelRanker.ts` as `heuristic-curation-v0.1.0`.
- The ranker:
  - scores quality, aesthetics, coverage, and feed fit
  - accepts optional embeddings and model scores but works from metadata/labels/colors
  - detects near-duplicate/burst groups
  - picks a diverse top pool with relevance plus novelty constraints
  - composes up to 3 carousel variations capped at 20 slides
  - prefers landscape/square photos for stacked `vertical_triptych` templates
  - scores feed-fit against manual or imported feed-profile assets
- Added `POST /analysis/rank` to the API server.

### Validation

- `npm run typecheck` passes in `services/api`.
- `npm test` passes in `services/api` with localhost-bind approval.
- Tests cover duplicate winner selection, carousel slide limit, landscape preference for stacked templates, feed-fit scoring, and the HTTP endpoint.

## 2026-06-13 - Render API Live For Local Mobile Testing

### Deployment Decision

- The MVP Instagram API backend is live at `https://yb-dumps-api.onrender.com`.
- `GET /health` returns `{"ok":true,"metaConfigured":true}`, confirming the Render service is reachable and Meta env vars are configured.
- Local Expo testing should use `apps/mobile/.env` with `EXPO_PUBLIC_API_BASE_URL=https://yb-dumps-api.onrender.com`.
- Because Expo injects `EXPO_PUBLIC_*` values at bundle time, restart Expo with cache clear after changing this value.
- The app can now test the optional Settings -> Creator/Business API connection against the live Render OAuth start URL instead of a localhost API.

### Mobile OAuth UX Fix

- Settings now displays the active API base URL so stale localhost bundles are obvious.
- Native iOS/Android Creator/Business API connection now closes the Settings modal, opens the Render OAuth URL with `WebBrowser.openBrowserAsync`, and listens for the `instagram-callback` deep link to refresh connection status.
- Web keeps the Expo auth-session flow.
- Settings exposes an `Open API login` fallback after the first connect attempt if the native browser does not appear.

### Meta Professional Account Product Correction

- Live testing showed Meta prompts personal users to convert to a professional account when using the current Instagram API scopes.
- Product decision: everyday personal accounts should not connect OAuth or convert accounts just to use Trip Picks.
- Primary user flow is now `Export for Instagram` plus Camera Roll/share sheet and manual feed import by grid screenshot or selected recent posts.
- Meta OAuth remains only an optional Creator/Business API path for eligible users and future beta testing.
- Carousel modal no longer routes the normal Instagram action into Meta OAuth; it exports for Instagram instead.

## 2026-06-13 - GitHub Repo Consolidated At Parent Root

### Repo Decision

- The deployable project should live in the parent `trip-picks-native` Git repo, not inside `apps/mobile`.
- `apps/mobile` was originally its own Expo-generated Git repo, which caused Git to stage it as an embedded repository/gitlink when adding the parent repo.
- The nested `apps/mobile/.git` metadata was backed up to `/tmp/trip-picks-mobile-git-backup-20260613142357/.git`.
- The parent repo now tracks actual mobile app files, docs, and `services/api` so Render can deploy the backend with `Root Directory: services/api`.
- Added a root `.gitignore` for editor files, env files, dependency folders, generated output, and logs.

## 2026-06-13 - Real Instagram OAuth Boundary, Settings, And Publishing Guards

### Product Decisions

- Instagram is now a first-class workflow, but personal accounts still use export/share as the reliable posting path.
- Direct API publishing must be gated behind Meta OAuth, publish permissions, professional-account eligibility, and public HTTPS media URLs.
- Settings owns Instagram connection so users can connect before choosing a carousel.
- The app must show honest states:
  - `setup_required` when Meta env vars are missing
  - `requires_export` for personal accounts
  - `render_required` when carousel slides are not rendered/hosted for Meta
  - `published` only after the backend publish call succeeds
- No real app user auth yet. A secure anonymous `deviceSessionId` links the phone to the local API connection during the MVP.

### Implementation Done

- Added Expo SDK 54-compatible auth/export packages:
  - `expo-auth-session`
  - `expo-web-browser`
  - `expo-secure-store`
  - `expo-linking`
  - `expo-sharing`
  - `expo-media-library`
  - `expo-crypto`
- Added native permission/plugin config for add-to-photo-library export and secure storage.
- Added a floating top-right Settings button and Settings modal in `apps/mobile/App.tsx`.
- Replaced simulated Instagram handlers with backend-backed calls:
  - status refresh
  - OAuth launch through `WebBrowser.openAuthSessionAsync`
  - disconnect
  - feed import
  - guarded carousel publish
- Added `apps/mobile/src/services/instagramApi.ts` as the mobile API client.
- Expanded Instagram types in `apps/mobile/src/types.ts` with:
  - account type
  - connection id/account id
  - permissions
  - publish capability
  - token/feed import metadata
  - publish result states
- Scaffolded `services/api` as a dependency-free Node/TypeScript local API:
  - `GET /health`
  - `GET /auth/instagram/start`
  - `GET /auth/instagram/callback`
  - `GET /instagram/status`
  - `POST /instagram/disconnect`
  - `POST /instagram/import-feed`
  - `POST /instagram/publish-carousel`
- Backend stores dev Instagram tokens in `services/api/data/instagram-store.json`, which is gitignored.
- Mobile reads `EXPO_PUBLIC_API_BASE_URL`; web can use `http://localhost:8787`, but Expo Go on a phone needs the Mac LAN IP or a tunnel URL.
- Backend secrets live in `services/api/.env`, with `services/api/.env.example` documenting:
  - `PORT`
  - `API_PUBLIC_URL`
  - `META_APP_ID`
  - `META_APP_SECRET`
  - `META_REDIRECT_URI`
  - `INSTAGRAM_SCOPES`
- Backend publishing code creates child media containers, creates a carousel container, then publishes it when an eligible professional account and public media URLs are available.
- Export fallback now attempts to save selected local source photos to Recents and open the native share sheet. Rendered slide export is still a future slice.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- `npm run typecheck` passes in `services/api`.
- `npm test` passes in `services/api` with localhost-bind approval:
  - OAuth state round trip
  - invalid OAuth state signature
  - expired OAuth state
  - setup-required status without Meta env vars
  - disconnected publish guard
  - professional-account publish delegation with public media URL

### Known Gaps

- Live OAuth requires a Meta developer app, configured redirect URI, and test Instagram account.
- API publishing also needs rendered carousel slide files hosted at public HTTPS URLs; local phone URIs cannot be sent to Meta.
- Export currently saves source photos used in the chosen edit, not fully rendered composed carousel slides.
- `services/api` is outside the current `apps/mobile` Git repo boundary because the project parent folder is not a Git repo.

## 2026-06-12 - Saved Trips, Export Package, And Feed Import UI

### Product Decisions

- Generated carousel options need a clear exit path:
  - render/save carousel slides to Camera Roll in order
  - put them in a `Trip Picks` album later
  - offer native share sheet / Instagram handoff as a secondary path
  - keep Camera Roll as the reliable Instagram fallback
- Generated work needs to be reviewable later, so the MVP needs a local saved-trip library before backend account sync.
- Feed import for MVP should avoid Instagram API dependency:
  - fastest path: import a grid screenshot
  - cleaner path: manually select 9-18 recent posts
- Backend/model work can come later; current goal is the mobile UX skeleton and state model.

### Implementation Done

- Installed `@react-native-async-storage/async-storage`.
- Added local saved trip persistence under key `trip-picks:saved-trips:v1`.
- Added a `Saved trips` library screen.
- Generated trips auto-save after analysis.
- Opening a saved trip restores carousel options and feed preview state.
- Choosing a carousel variation updates the saved project snapshot.
- Added `Export package` panel for the selected carousel:
  - render slides
  - save to Camera Roll
  - share to Instagram
- Added simulated export status: `draft`, `saved`, `share ready`.
- Added feed import UI:
  - `Import grid screenshot`
  - `Select recent posts`
  - imported feed source preview/status
- Added feed import/export fields to `TripProject` in `apps/mobile/src/types.ts`.
- Updated `docs/app-plan.md` and `docs/technical-plan.md`.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- Expo web bundle on `localhost:8081` returns `200`.
- Headless Chrome smoke test confirmed:
  - export panel is visible
  - `Save slides` shows Camera Roll workflow feedback
  - saved trip library contains `Santa Lucia Weekend`
  - reopening saved trip works
  - feed import controls render

## 2026-06-12 - Product Scope Refined To Carousel Options And Feed Preview

### Product Decisions

- Core MVP is now two user-facing features only:
  - generated carousel options from a large trip photo set
  - feed preview / best next-feed photo against the user's grid aesthetic
- The main carousel job is not just ranking photos. It should create 2-3 finished carousel variations the user can choose from.
- Carousel variations can include composed slides, not only raw photos:
  - single photo
  - vertical triptych
  - hero with details
  - detail grid
- The user should feel like they are choosing from finished edits instead of manually selecting every image.
- The product should support the mental model of a large trip dump, roughly hundreds to 1,000 photos.
- Story picks, album mode, duplicate cleanup UI, people/moments browsing, and taste trainer are no longer core MVP modes. They can remain internal model signals or future features.

### Architecture And Contract Changes

- `apps/mobile/src/types.ts` now centers `RankingResult` around:
  - `topPicks`
  - `carouselVariations`
  - `feedPreviewCandidates`
- Added `CarouselVariation`, `CarouselSlide`, and `CarouselSlideTemplate`.
- Fake data in `apps/mobile/src/data/sampleProject.ts` now creates 3 carousel options:
  - `The Complete Trip`
  - `People And Energy`
  - `Atmosphere And Details`
- Sample trip now presents as a 1,000-photo trip while keeping a smaller deterministic preview set for the prototype.

### Implementation Done

- Replaced the broad results UI with two result tabs:
  - `Carousel options`
  - `Feed preview`
- Updated welcome/import/analysis copy to focus on the refined product.
- Added generated slide previews for single-photo, vertical-triptych, hero-with-details, and detail-grid templates.
- Feed preview now shows the selected candidate inserted into a 3-column profile grid.
- Updated `README.md`, `docs/app-plan.md`, `docs/technical-plan.md`, and `docs/model-plan.md`.
- Marked older worker docs as partially superseded where they still describe the larger MVP.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- Existing Expo server on port `8081` returned `200` for web HTML and bundle.
- Headless Chrome completed: `Use sample trip` -> `Generate carousel options` -> `Feed preview`.
- Smoke test confirmed the refined promise, 1,000-photo import language, carousel options, slide-template language, and feed-preview screen.

## 2026-06-12 - Expo MVP Scaffold And Fake Ranking Prototype

### Product Decisions

- Product name remains `Trip Picks`.
- MVP promise remains: select trip photos, then return `Story 10`, `Carousel 12`, `Album 50`, duplicate groups, taste feedback, and a feed-fit score.
- First prototype must work without backend/model services, so it supports both real image-picker selection and a deterministic sample trip.
- Copy should avoid implying live Instagram integration. Feed fit is currently a mock grid profile, not an Instagram API connection.
- Duplicate cleanup language stays non-destructive: `Recommended keeper` and `Not selected`, not delete-focused language.
- Privacy copy says the MVP shell works with smaller analysis copies and does not upload originals.

### Architecture Decisions

- Chosen app stack: Expo + React Native + TypeScript under `apps/mobile/`.
- Generated app currently uses Expo SDK `~56.0.11`, React `19.2.3`, React Native `0.85.3`, React Native Web `^0.21.2`, and TypeScript `~6.0.3`.
- Installed `expo-image-picker` for library selection and `react-dom`, `react-native-web`, `@expo/metro-runtime` for browser smoke testing. `app.json` includes Trip Picks app metadata and native photo-library permission copy.
- Navigation is intentionally lightweight state-driven inside `App.tsx` for the first prototype. Worker plan recommends Expo Router groups later: onboarding, app, and project result routes.
- Shared app-facing contracts live in `apps/mobile/src/types.ts`, matching the future API/model-worker shape from `docs/model-api-worker-plan.md`.
- Fake project/result generation lives in `apps/mobile/src/data/sampleProject.ts`. Real picked photos and sample photos both flow through `buildRankingResult`.
- Result data contract includes `TripPhoto`, `AnalysisJob`, `RankingResult`, `RankedPick`, `PhotoScore`, `DuplicateGroup`, and `FeedFitScore`.

### Implementation Done

- Scaffolded `apps/mobile` with Expo blank TypeScript template.
- Added `npm run typecheck`.
- Built the native prototype screen flow:
  - welcome/value screen
  - import/photo permission explainer
  - Expo ImagePicker photo selection
  - sample trip fallback
  - deterministic analysis progress screen
  - results dashboard
  - story picks
  - carousel planner
  - album grouped by moment
  - duplicate groups
  - feed-fit buckets
  - local taste-trainer feedback counts
- Verified `npm run typecheck` passes.
- Started Expo dev server successfully on port `8081`.
- Verified web HTML and JS bundle return `200`.
- Used headless Chrome DevTools to load the web app, click `Use sample trip`, click `Analyze trip`, wait for analysis, and confirm the results dashboard contains `Ready to review`, `Story 10`, and `Feed Fit`.
- Worker agent `Carver` wrote `docs/app-worker-plan.md` with route/screen/state guidance.
- Worker agent `Ampere` wrote `docs/model-api-worker-plan.md` with fake-data and future API/model contracts.

### Known Gaps

- No backend, upload API, signed URL flow, queue, Postgres schema, or model worker exists yet.
- No Expo Router yet; current app uses in-memory state so the MVP can move quickly.
- No persistent local storage for selected projects or feedback.
- No native share/export implementation yet.
- Feed fit is deterministic fake scoring against a mock profile.
- Sample images use remote Picsum URLs, so sample thumbnails need network access.
- The parent folder is not a Git repository. Expo's generator created an `apps/mobile/.git` folder.
- `npm audit --omit=dev` reports 10 moderate vulnerabilities through Expo's `uuid` dependency chain. `npm audit fix --force` would downgrade Expo to `46.0.21`, so do not force-fix this in the MVP scaffold.

### Next Build Slice

1. Add Expo Router and split `App.tsx` into route-backed screens.
2. Add local persistence for the latest project and taste feedback.
3. Add real thumbnail resizing/compression before any upload work.
4. Start `packages/shared` with schemas that mirror `apps/mobile/src/types.ts`.
5. Scaffold `services/api` with project/assets/job endpoints.

## 2026-06-12 - Expo Go Phone Compatibility Fix

### Problem

- iPhone Expo Go showed `Project is incompatible with this version of Expo Go`.
- The project was scaffolded on Expo SDK 56, while the public App Store Expo Go app did not support that SDK in this testing path.
- Expo Go TestFlight is not a viable default path because it requires an Expo-provided invite code.

### Decision

- Downgraded the prototype to Expo SDK 55 so it can run in the public Expo Go app.
- Kept the app in Expo Go mode for fast frontend/mobile UX testing.
- Deferred development builds/EAS until native-only modules or production-like testing require them.

### Implementation Done

- Changed `apps/mobile` dependencies to Expo SDK 55 compatible versions:
  - `expo@~55.0.26`
  - `react-native@0.83.6`
  - `react@19.2.0`
  - `@expo/metro-runtime@~55.0.11`
  - `expo-image-picker@~55.0.20`
  - `expo-status-bar@~55.0.6`
  - `typescript@~5.9.2`
- Ran `npx expo install --fix` and `npx expo install --check`.
- Restarted Metro with a cleared cache on port `8081`.
- Current phone URL shown by Metro: `exp://192.168.4.21:8081`.
- Fixed a thumbnail-strip React key warning risk by including the photo position in the key.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- `npx expo install --check` reports dependencies are up to date.
- `curl -I http://localhost:8081` returns `200`.
- Web bundle request returns `200`.
- In-app browser reload shows `Trip Picks` and `Use sample trip` with no console errors.
- Smoke click-through completed `Use sample trip` -> `Generate carousel options` and rendered `Carousel options` / `Feed preview` with no console errors.

### Phone Testing Instructions

1. Install/update Expo Go from the normal iOS App Store, not TestFlight.
2. Fully quit Expo Go if it has the old incompatible screen open.
3. Scan the fresh QR from the restarted Metro server.
4. If Expo Go still opens the old `exp://...` project, tap `Go Home`, then rescan.
5. Keep the phone and Mac on the same Wi-Fi network. The current LAN URL is `exp://192.168.4.21:8081`.

## 2026-06-13 - Expo Go Baseline Moved To SDK 54

### Problem

- SDK 55 still may be too new for the Expo Go version available on the test iPhone.
- The fastest unblock remains keeping the prototype inside Expo Go instead of moving to EAS development builds.

### Decision

- Downgraded the prototype one more line to Expo SDK 54.
- Treat SDK 54 as the current phone-testing baseline until the test device proves a newer Expo Go build works.
- Keep the app feature work frontend-only and Expo Go-compatible for now.

### Implementation Done

- Changed `apps/mobile` dependencies to Expo SDK 54 compatible versions:
  - `expo@~54.0.35`
  - `react-native@0.81.5`
  - `react@19.1.0`
  - `react-dom@19.1.0`
  - `@expo/metro-runtime@~6.1.2`
  - `expo-image-picker@~17.0.11`
  - `expo-status-bar@~3.0.9`
  - `@types/react@~19.1.10`
- Ran `npx expo install expo@~54.0.35`, `npx expo install --fix`, and `npx expo install --check`.
- Restarted Metro with a cleared cache on port `8081`.
- Current phone URL shown by Metro: `exp://192.168.4.21:8081`.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- `npx expo install --check` reports dependencies are up to date.
- `curl -I http://localhost:8081` returns `200`.
- Web bundle request returns `200`.
- In-app browser reload shows `Trip Picks` and `Use sample trip`.
- Smoke click-through completed `Use sample trip` -> `Generate carousel options` and rendered `Carousel options`, `Feed preview`, and `Package for Instagram` with no console errors.

### Phone Testing Instructions

1. Fully quit Expo Go on the phone.
2. Tap `Go Home` if Expo Go opens the old incompatible project screen.
3. Scan the fresh QR from the SDK 54 Metro server.
4. Confirm the phone opens `exp://192.168.4.21:8081`.
5. Keep phone and Mac on the same Wi-Fi network.

## 2026-06-13 - Instagram-Style Carousel Preview Modal

### Product Decision

- Carousel options should behave more like Instagram: tap an edit, open a full-screen preview, then swipe horizontally through the generated slides.
- The results page should no longer show the selected carousel's full slide breakdown inline below the option rows.
- Selection and export actions belong inside the preview modal because that is where the user decides whether the edit works.

### Implementation Done

- Replaced inline selected-carousel detail rendering with `CarouselPreviewModal` in `apps/mobile/App.tsx`.
- Option cards now open the modal instead of switching an inline detail panel.
- Added a horizontally paged `ScrollView` inside the modal for swipeable generated slides.
- Added slide dots, slide title/note/template copy, dark Instagram-like preview styling, and a compact action bar.
- Added modal actions:
  - `Use this edit` / `Keep edit`
  - `Save slides`
  - `Share`
  - `Start another trip`
- Updated export status handling so modal save/share actions apply to the variation being previewed, not just the previously selected variation.
- Extracted shared `SlideArtwork` rendering so small previews and modal previews use the same composed-slide template logic.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- Local Metro remains on Expo SDK 54 and serves `http://localhost:8081`.
- Headless Chrome CDP smoke test completed:
  - loaded Trip Picks
  - clicked `Use sample trip`
  - clicked `Generate carousel options`
  - confirmed the option cards show `Tap to preview and swipe`
  - confirmed the old inline `Package for Instagram` panel is not shown before opening a modal
  - opened `The Complete Trip` in the modal
  - confirmed modal actions `Save slides` and `Share`
  - clicked `Share` and saw modal export status update to `share ready`
  - opened `People And Energy`
  - clicked `Use this edit`
  - confirmed `People And Energy` became the chosen edit

## 2026-06-13 - Instagram Flow, Export Fallback, Slide Replacement, Template Orientation

### Product Decisions

- Instagram should be presented as a first-class path, but the MVP must keep `Export photos` as the reliable fallback.
- The prototype should not pretend it can directly publish to every Instagram account. Real direct publishing needs Meta OAuth, permissions, account eligibility checks, and backend publishing.
- Feed preview can start from `Use Instagram`, a grid screenshot, or selected recent posts.
- Carousel preview should support replacing one image in a generated slide without turning into a full photo editor.
- Stacked horizontal templates should prefer landscape images, because portrait images are weaker inside horizontal strips.

### Implementation Done

- Added Instagram state types in `apps/mobile/src/types.ts`:
  - `InstagramConnectionState`
  - `InstagramConnectionStatus`
  - `InstagramShareStatus`
  - `FeedImportMode` now includes `instagram`
- Added frontend Instagram handlers in `apps/mobile/App.tsx`:
  - `Use Instagram` in feed preview simulates connecting `@trip_picks_demo` and importing recent feed assets.
  - `Use Instagram` in the carousel modal marks the previewed edit as `post_ready`.
  - `Export photos` marks the previewed edit as saved for Camera Roll export.
- Added slide photo replacement in the carousel modal:
  - `Replace a photo`
  - select a slot in the active slide
  - choose a replacement from the ranked candidate pool
  - persist the changed slide photo ids into the saved `TripProject`
- Updated carousel generation in `apps/mobile/src/data/sampleProject.ts`:
  - `vertical_triptych`, `hero_with_details`, and `detail_grid` prefer landscape/square candidates over portrait candidates.
  - vertical triptych copy now describes landscape frames in horizontal strips.
  - sample thumbnail dimensions now preserve landscape orientation for landscape sample photos.
- Updated `docs/app-plan.md` and `docs/technical-plan.md` with Instagram/export/replacement/template-orientation planning.

### Validation

- `npm run typecheck` passes in `apps/mobile`.
- `curl -I http://localhost:8081` returns `200`.
- Web bundle request returns `200`.
- Headless Chrome CDP smoke test completed:
  - loaded Trip Picks
  - clicked `Use sample trip`
  - clicked `Generate carousel options`
  - opened `Feed preview`
  - clicked `Use Instagram`
  - confirmed Instagram feed import status
  - returned to `Carousel options`
  - opened `The Complete Trip`
  - confirmed modal contains `Use Instagram`, `Export photos`, and `Replace a photo`
  - clicked `Use Instagram` and confirmed `post ready`
  - clicked `Export photos` and confirmed export status `saved`
  - opened replacement panel
  - replaced one slide image from candidate pool
  - confirmed workflow message `Replaced a slide image`
