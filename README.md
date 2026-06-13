# Trip Picks Native

Native mobile app concept for turning messy trip photo libraries into curated, shareable sets.

Working product name: **Trip Picks**.

## Product Thesis

People do not only need photo cleanup. They need help making a trip look curated.

The refined MVP should answer:

- From hundreds or thousands of trip photos, which shots should anchor the post?
- What are 2-3 finished carousel options I can choose from?
- Which slides should be single photos versus composed multi-photo templates?
- Which trip photo best fits my existing profile grid aesthetic?
- What crop/edit direction makes the selected post feel intentional?

## Recommended Stack

Use **Expo + React Native + TypeScript** first.

Why:

- One app codebase can ship to iOS and Android.
- Expo gives us photo library/image picker APIs, app builds, TestFlight path, and native-module escape hatches.
- React Native/TypeScript is faster for us than learning SwiftUI and Kotlin separately.
- We can still add native iOS modules later for Core ML, Photos framework edge cases, or high-performance image work.

Do not start with SwiftUI-only unless we intentionally give up Android for the first year.

Do not start with Flutter unless we want to adopt Dart and a separate ecosystem. Flutter is viable, but Expo/RN is the lower-friction path for this team.

## Initial Architecture

Mobile app:

- Expo React Native app
- Local photo selection and preview
- Local thumbnail generation
- Upload compressed working images for analysis
- Review generated carousel options
- Preview best feed-fit photo in a grid

Backend:

- Auth and user projects
- Signed upload URLs
- Async analysis jobs
- Photo metadata store
- Ranking results, carousel options, and feed preview candidates

Model service:

- Duplicate/near-duplicate detection
- Technical quality scoring
- Embedding extraction
- Moment clustering
- Carousel composition with slide templates
- Feed aesthetic matching

## MVP Scope

1. Import/select a large trip photo set from camera roll.
2. Analyze up to roughly 1,000 photos for the first paid trip workflow.
3. Return a `Top 50` candidate pool for transparency.
4. Generate 3 finished carousel options with 10-20 slides each.
5. Support composed carousel slides such as vertical triptychs, hero-plus-details, and detail grids.
6. Provide feed preview from a grid screenshot or manually selected recent posts.
7. Make export/share the primary Instagram handoff for personal accounts.
8. Keep Meta OAuth as an optional Creator/Business account path only.

## Non-Goals For MVP

- Promising direct Instagram publishing for personal accounts.
- Fully on-device ML.
- Photo editing/filter generation.
- Training a foundation model.
- Perfect handling of 10,000-photo libraries.
- Story picks, album mode, duplicate cleanup UI, and taste trainer as top-level product modes.

## Current Project State

This folder now contains product/technical planning docs and the first Expo mobile prototype under:

```text
apps/mobile/
```

The running handoff log for future threads is:

```text
docs/memory-log.md
```

The first local Instagram API scaffold now lives under:

```text
services/api/
```

The first server-side analysis endpoint also lives there:

```text
POST /analysis/rank
```

It accepts project photos plus optional feed-profile assets and returns top picks, carousel variations, duplicate groups, photo scores, and feed-preview candidates. The current engine is a deterministic heuristic ranker that can consume future neural embeddings and aesthetic/quality signals.
