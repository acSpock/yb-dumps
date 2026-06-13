# App Worker Plan

## Status

Superseded by the 2026-06-12 product refinement in `docs/app-plan.md` and `docs/memory-log.md`.

The current MVP is only:

- generated carousel options from a large trip photo set
- feed preview / best next-feed photo

Story picks, album picks, duplicate cleanup UI, people/moments browsing, and taste trainer are future/internal features, not core MVP screens.

## Scope

Plan the Expo MVP navigation and screen flows for `apps/mobile/` without implementing package or app code. This plan assumes the first app milestone uses fake local analysis results while preserving the route and state shapes needed for later upload/job integration.

## Navigation Shape

Use Expo Router with three route groups:

- `/(onboarding)`: first-run education, auth placeholder, photo permission.
- `/(app)`: trip import, progress, results, trainer, feed fit, export.
- `/project/[projectId]`: project-specific result tabs and detail views.

Initial MVP can keep auth as a mock/signed-out placeholder, but the route should exist so Sign in with Apple can replace it without changing the first-run flow.

Primary navigation flow:

1. Welcome
2. Auth placeholder
3. Photo permission explainer
4. Trip import
5. Analyze progress
6. Results dashboard
7. Result detail tabs: Story, Carousel, Album, Duplicates, People/Moments
8. Swipe trainer
9. Feed fit
10. Export/share
11. Settings/privacy

## Expected Screens

### Welcome

Purpose: explain the promise in one screen and start the trip-post flow.

States:

- first launch
- returning user with recent project
- loading stored session/project

Primary CTA: `Plan a trip post`

Secondary CTA: `View last trip` when a fake or saved project exists.

### Auth Placeholder

Purpose: reserve the future Sign in with Apple step while avoiding real auth for the fake-data MVP.

States:

- mock signed out
- mock signed in
- future auth error

Primary CTA: `Continue`

Copy constraint: do not imply Instagram or Apple integration is live until implemented.

### Photo Permission Explainer

Purpose: explain why photo access is needed before the native permission prompt.

States:

- permission unknown
- permission granted
- permission limited
- permission denied

Primary CTA: `Choose photos`

Denied-state CTA: `Open Settings`

Copy constraint: be explicit that analysis images are smaller working copies and originals are not uploaded in the MVP shell.

### Trip Import

Purpose: select 100-500 candidate photos from camera roll, an album, or a date range.

States:

- empty selection
- loading local thumbnails
- selected photos grid
- selection limit warning
- permission-limited recovery

Primary CTA: `Analyze trip`

Fake-data behavior: allow a `Use sample trip` path so workers can build screens before native photo selection is complete.

### Analyze Progress

Purpose: show thumbnail preparation, fake upload, fake model analysis, and result composition.

States:

- preparing thumbnails
- uploading analysis copies
- finding duplicates
- ranking picks
- composing sets
- complete
- retryable failure

Progress should be deterministic in fake mode and finish within a short, testable interval.

### Results Dashboard

Purpose: summarize the generated outputs and route into each result set.

Cards/sections:

- `Story 10`
- `Carousel 12`
- `Album 50`
- `Duplicates`
- `Feed Fit`
- `Taste Trainer`

States:

- no results yet
- results ready
- user feedback changed rankings
- export ready

Each card should show count, confidence/fit label, and one thumbnail strip.

### Story Picks

Purpose: review the 10 vertical-friendly, high-impact picks.

States:

- default ranked list
- photo detail preview
- keep/reject feedback applied
- reordered picks

Expected actions: keep, reject, favorite, replace, export.

### Carousel Planner

Purpose: review and reorder the 12-photo Instagram carousel sequence.

States:

- generated order
- drag/reorder mode
- crop guidance visible
- feedback changed order

Each item should carry a role label such as `Opener`, `Place`, `People`, `Detail`, or `Closer`.

### Album Picks

Purpose: scan the broader 50-photo keepsake set.

States:

- grouped by moment
- grid view
- moment detail
- keep/reject feedback applied

Use moment headers from fake metadata: arrival, scenery, meals, people, details, night, departure.

### Duplicates

Purpose: show near-duplicate groups and the recommended keeper.

States:

- duplicate groups available
- no duplicates found
- group detail
- keeper changed

Copy constraint: avoid destructive language. Use `Recommended keeper` and `Not selected` instead of `delete`.

### People And Moments

Purpose: show best shots by person and trip segment.

States:

- detected people placeholder
- moments grouped by time/location
- privacy-friendly no-face-copy fallback

Fake data should use neutral labels like `Person A`, `Person B`, and `Beach afternoon`.

### Swipe Trainer

Purpose: collect taste feedback and update fake ranking state.

States:

- calibration queue
- card swiped keep/reject/favorite/too similar
- queue complete
- updated results available

Actions: keep, reject, favorite, too similar, more like this.

### Feed Fit

Purpose: score trip photos against a mock grid screenshot or selected previous posts.

States:

- no grid source
- mock grid loaded
- scoring
- fits/maybe/clashes tabs
- photo detail with reason and crop guidance

Copy examples: `Fits your warmer, low-contrast grid`, `Maybe: strong shot, busier than your recent posts`, `Clashes: darker and more saturated`.

### Export/Share

Purpose: confirm set, order, and destination.

States:

- choose set
- export preview
- saving to camera roll placeholder
- share sheet placeholder
- success
- failure

MVP can stop at a simulated success screen if native saving/share is not implemented yet.

### Settings/Privacy

Purpose: expose privacy defaults and future account controls.

States:

- mock account
- privacy summary
- clear local sample data
- future delete account placeholder

## Fake-Data Assumptions

- Use one bundled or generated sample project with 120-160 photo records.
- Each fake asset should include `id`, `uri`, `width`, `height`, `createdAt`, `momentId`, `peopleIds`, `qualityScore`, `aestheticScore`, `isDuplicateCandidate`, and result membership flags.
- Result sets:
  - `story`: 10 assets
  - `carousel`: 12 ordered assets with role labels
  - `album`: 50 assets grouped by moment
  - `duplicates`: 6-10 groups with one recommended keeper
  - `feedFit`: `fits`, `maybe`, and `clashes` buckets
- Feedback actions should mutate local fake state enough to show changed labels, counts, and replacement suggestions.
- Fake analysis should use timed steps, not a permanently instant transition, so progress and retry states are testable.
- Do not require backend, auth, upload URLs, model worker, Instagram API, or full camera-roll export for the first screen-flow pass.

## UX Copy Constraints

- Keep copy short, concrete, and product-led: `Story 10`, `Carousel 12`, `Album 50`.
- Do not promise automatic posting, Instagram API access, real ML analysis, or deletion from camera roll in the MVP shell.
- Use privacy-forward language before permissions and upload-like progress states.
- Avoid shaming photo quality. Prefer `Not selected`, `Try a different crop`, or `Too similar to another pick`.
- Keep result explanations useful but brief: one reason per photo is enough for MVP.
- Preserve user control in all risky flows: review before export, no destructive duplicate cleanup.

## Open Questions

- Should the first app shell require any real Sign in with Apple setup, or should auth remain a visual placeholder until backend work starts?
- Should fake sample photos be bundled assets, generated placeholders, or remote static URLs?
- Should the first import path prioritize native picker selection or the sample-trip path for fastest UI validation?
- Is Feed Fit part of the first demo path, or should it be reachable but labeled as a later MVP mode?
- Do we want bottom tabs after results, or should results stay project-scoped with top tabs/segmented controls?

## Recommended First Implementation Order

1. Build route skeleton and onboarding/import/progress/results happy path with sample data.
2. Add result detail screens for Story, Carousel, Album, and Duplicates.
3. Add local feedback state and Swipe Trainer mutations.
4. Add Feed Fit mock scoring screen.
5. Add Export/Share simulated success flow and Settings/Privacy.
6. Replace sample import/progress with real photo picker and local thumbnail generation.
