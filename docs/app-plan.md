# App Plan

## Refined User Promise

Drop in hundreds or thousands of trip photos. Get finished carousel options and a feed preview without manually sorting every shot.

## Core MVP Features

### 1. Carousel Options

The primary job is to turn a messy trip library into a few finished carousel candidates.

User intent:

- "I went on a trip and have 300-1,000 photos."
- "I do not want to pick each photo myself."
- "Give me the best post options and let me choose one."

Outputs:

- `Top 50` ranked candidate pool for transparency.
- `3 carousel options`, each with a different editorial angle.
- Each carousel option has 10-20 slides, not necessarily 10-20 raw photos.
- Slides can be:
  - single photo
  - vertical triptych: top/middle/bottom stack of three photos
  - hero plus details
  - small detail grid
  - opener/closer title-style image treatment later
- Each option should explain its point of view, for example:
  - `People-first weekend`
  - `Place and atmosphere`
  - `Food, details, and quiet moments`

The product should feel like choosing from finished edits, not reviewing a database of photos.

### 2. Feed Preview

The second job is to help the user choose a photo that will fit their profile grid.

User intent:

- "Which trip photo should be the next feed post?"
- "Will this clash with the aesthetic of my profile?"
- "Show me how it looks in the grid before I post."

Inputs:

- A recent grid screenshot, or
- 9-18 manually selected recent posts.

Outputs:

- Best feed-fit photo.
- 3-8 alternate candidates.
- Preview of the candidate inserted into a 3-column feed grid.
- Reasons: palette fit, brightness/contrast fit, subject mix, crop suitability.
- Simple edit direction, such as warmer, less contrast, brighter, more negative space.

### 3. Saved Trips

Generated trips need to be reviewable later.

MVP behavior:

- Save generated trip projects locally on the device.
- Show a `Saved trips` library.
- Reopen a trip and keep its carousel options, chosen edit, feed source, and export status.
- Treat local storage as the first frontend experience; backend account sync can come later.

This solves the "I generated this, now where did it go?" problem before account/backend work exists.

### 4. Export Package

The user needs a clear path from generated carousel to Instagram.

MVP behavior:

- User picks a carousel variation.
- App opens a full-screen carousel preview modal with two clear handoff paths.
- Path 1: `Use Instagram` for connected-account feed import and guarded publishing.
- Path 2: `Export photos` for saving rendered carousel slides to Camera Roll in order, ideally into a `Trip Picks` album.
- The current implementation uses a local Meta OAuth backend and explicit account/publish eligibility states.
- Always make Camera Roll the reliable fallback, because Instagram import behavior can be inconsistent.
- Personal accounts should route to export/share instead of pretending API publish is available.

The product should frame export as a package of ready slides, not a loose list of source photos.

### 5. Carousel Editing

Users need light control when the generated edit is close but one image is wrong.

MVP behavior:

- While swiping through a generated carousel, user can tap `Replace a photo`.
- App shows the current slide photo slots.
- User selects one slot and replaces it with a candidate from the ranked pool.
- Replacement updates the generated carousel variation and persists in the saved trip.
- This is not full image editing yet; it is photo substitution inside generated slide templates.

### 6. Instagram Feed Import

The product needs an Instagram path, but it should not depend on direct API publishing for every account.

MVP behavior:

- `Use Instagram` imports recent-feed media through the local backend after OAuth.
- Manual fallback remains:
  - grid screenshot
  - selected recent posts
- Feed preview can score against Instagram-imported assets or manual assets.
- Direct publishing stays behind Meta backend account eligibility checks and public rendered media URLs.

## Not Core For MVP

These are useful model signals or future features, but they should not be top-level product modes yet:

- Story picks
- Album 50
- Duplicate cleanup UI
- People/moments browser
- Taste trainer
- Production-grade Instagram hosting/rendering, permission review, and account sync
- Photo editing/filter generation

Duplicate detection, moment clustering, people/scene diversity, and user taste can still power carousel generation internally.

## First-Time User Flow

1. User taps `Build carousel options`.
2. User selects trip photos from camera roll, album, or date range.
3. App shows selected count and confirms analysis-sized copies.
4. Backend/model ranks the set and composes carousel options.
5. App shows 3 carousel options.
6. User opens an option in a full-screen swipe preview.
7. User optionally replaces one image in a generated slide.
8. User chooses one edit.
9. App saves the generated trip locally.
10. User chooses `Use Instagram` or `Export photos`.
11. User optionally opens `Feed preview`.
12. User imports Instagram, provides a grid screenshot, or selects recent posts.
13. App recommends the best next-feed photo and shows the grid preview.

## Main Screens

- Welcome / core promise
- Photo permission explainer
- Trip import
- Analysis progress
- Carousel options dashboard
- Instagram-style carousel preview modal
- Slide photo replacement panel
- Saved trips library
- Instagram/export handoff
- Feed preview
- Settings/privacy

## Monetization Direction

Start with trip-level value before subscriptions:

- Free: sample trip and limited analysis preview.
- Paid trip: one trip up to 1,000 photos with 3 carousel options.
- Feed preview add-on or bundled premium trip tier.

Avoid subscriptions until the trip-level workflow creates obvious value.
