import {
  AnalysisJob,
  CarouselSlideTemplate,
  CarouselVariation,
  CropHint,
  DuplicateGroup,
  FeedPreviewCandidate,
  FeedFitLabel,
  PhotoScore,
  PickedAssetInput,
  PickSet,
  RankedPick,
  RankingResult,
  TripMoment,
  TripPhoto,
  TripProject,
} from '../types';

const PROJECT_ID = 'sample-santa-lucia';
const GENERATED_AT = '2026-06-12T18:30:00.000Z';

const moments: TripMoment[] = [
  { momentId: 'arrival', label: 'Arrival', subtitle: 'Airport, hotel, first walk' },
  { momentId: 'coast', label: 'Coast', subtitle: 'Bright water and wide frames' },
  { momentId: 'market', label: 'Market', subtitle: 'Food, texture, small details' },
  { momentId: 'friends', label: 'Friends', subtitle: 'People-first trip memories' },
  { momentId: 'golden-hour', label: 'Golden hour', subtitle: 'Warm light and openers' },
  { momentId: 'night', label: 'Night', subtitle: 'Dinner, signs, late moments' },
  { momentId: 'departure', label: 'Departure', subtitle: 'Last looks and closers' },
];

const sceneByMoment: Record<string, string[]> = {
  arrival: ['transit', 'city', 'context'],
  coast: ['beach', 'landscape', 'sun'],
  market: ['food', 'detail', 'color'],
  friends: ['people', 'portrait', 'group'],
  'golden-hour': ['light', 'opener', 'place'],
  night: ['dinner', 'night', 'mood'],
  departure: ['closer', 'travel', 'memory'],
};

const editHints = [
  'Lift shadows slightly',
  'Keep the warmer cast',
  'Try a square crop',
  'Leave extra negative space',
  'Reduce contrast a touch',
  'Use as-is',
];

const carouselRoles = [
  'Opener',
  'Place',
  'People',
  'Detail',
  'Texture',
  'Food',
  'Motion',
  'Quiet beat',
  'Wide scene',
  'Favorite',
  'Callback',
  'Closer',
];

const variationDefinitions = [
  {
    label: 'The Complete Trip',
    thesis: 'A balanced edit with place, people, food, details, and a clean closer.',
    reasons: ['best overall coverage', 'varied scenes', 'safe first post'],
  },
  {
    label: 'People And Energy',
    thesis: 'More friends, motion, and candid moments for a livelier post.',
    reasons: ['people-forward', 'strong expressions', 'social feel'],
  },
  {
    label: 'Atmosphere And Details',
    thesis: 'A quieter carousel with scenery, textures, meals, and negative space.',
    reasons: ['aesthetic-led', 'feed-friendly palette', 'detail rich'],
  },
];

const slideTemplates: CarouselSlideTemplate[] = [
  'single',
  'vertical_triptych',
  'hero_with_details',
  'single',
  'detail_grid',
  'single',
  'vertical_triptych',
  'single',
  'hero_with_details',
  'single',
];

function clampScore(value: number) {
  return Math.max(0.05, Math.min(0.99, Number(value.toFixed(2))));
}

function scoreSeed(index: number, offset: number) {
  const raw = Math.sin((index + 1) * (offset + 3.71)) * 10000;
  return raw - Math.floor(raw);
}

function scoreFor(index: number) {
  const qualityScore = clampScore(0.52 + scoreSeed(index, 1) * 0.42);
  const aestheticScore = clampScore(0.5 + scoreSeed(index, 4) * 0.45);
  const coverageScore = clampScore(0.54 + scoreSeed(index, 8) * 0.4);
  const finalScore = clampScore(qualityScore * 0.34 + aestheticScore * 0.38 + coverageScore * 0.28);

  return { qualityScore, aestheticScore, coverageScore, finalScore };
}

function cropHintFor(photo: TripPhoto): CropHint {
  if (photo.height > photo.width * 1.18) {
    return 'vertical';
  }

  if (photo.width > photo.height * 1.18) {
    return 'landscape';
  }

  return 'square';
}

function orientationRankForTemplate(photo: TripPhoto, template: CarouselSlideTemplate) {
  const cropHint = cropHintFor(photo);

  if (template === 'vertical_triptych') {
    return cropHint === 'landscape' ? 0 : cropHint === 'square' ? 1 : 2;
  }

  if (template === 'hero_with_details' || template === 'detail_grid') {
    return cropHint === 'landscape' ? 0 : cropHint === 'square' ? 1 : 2;
  }

  return 0;
}

function cropHintForTemplate(template: CarouselSlideTemplate, fallbackPhoto?: TripPhoto): CropHint {
  if (template === 'vertical_triptych' || template === 'hero_with_details' || template === 'detail_grid') {
    return 'landscape';
  }

  return fallbackPhoto ? cropHintFor(fallbackPhoto) : 'none';
}

function createPhoto(index: number, projectId: string): TripPhoto {
  const moment = moments[index % moments.length];
  const portrait = index % 4 !== 1;
  const width = portrait ? 1200 : 1600;
  const height = portrait ? 1600 : 1100;
  const thumbnailWidth = portrait ? 360 : 520;
  const thumbnailHeight = portrait ? 480 : 360;
  const capturedAt = new Date(Date.UTC(2026, 4, 12, 15 + Math.floor(index / 6), (index * 7) % 60));

  return {
    photoId: `photo-${String(index + 1).padStart(3, '0')}`,
    projectId,
    sourceAssetId: `sample-asset-${index + 1}`,
    localUri: `https://picsum.photos/seed/trip-picks-${index + 11}/${width}/${height}`,
    thumbnailUri: `https://picsum.photos/seed/trip-picks-${index + 11}/${thumbnailWidth}/${thumbnailHeight}`,
    originalFilename: `IMG_${String(4020 + index)}.jpg`,
    width,
    height,
    capturedAt: capturedAt.toISOString(),
    momentId: moment.momentId,
    peopleIds: index % 5 === 0 ? ['person-a', 'person-b'] : index % 3 === 0 ? ['person-a'] : [],
    uploadStatus: 'local_only',
    userFeedback: 'unset',
  };
}

function createPickedPhoto(asset: PickedAssetInput, index: number, projectId: string): TripPhoto {
  const moment = moments[index % moments.length];
  const width = asset.width ?? 1200;
  const height = asset.height ?? 1600;

  return {
    photoId: `picked-${String(index + 1).padStart(3, '0')}`,
    projectId,
    sourceAssetId: asset.assetId ?? `picked-asset-${index + 1}`,
    localUri: asset.uri,
    thumbnailUri: asset.uri,
    originalFilename: asset.fileName ?? `Selected ${index + 1}`,
    width,
    height,
    capturedAt: new Date(Date.now() - index * 1000 * 60 * 13).toISOString(),
    momentId: moment.momentId,
    peopleIds: index % 4 === 0 ? ['person-a'] : [],
    uploadStatus: 'local_only',
    userFeedback: 'unset',
  };
}

function createPhotoScores(photos: TripPhoto[]): PhotoScore[] {
  return photos.map((photo, index) => {
    const scores = scoreFor(index);
    const sceneLabels = sceneByMoment[photo.momentId] ?? ['trip'];
    const qualityFlags = [];

    if (scores.qualityScore < 0.62) {
      qualityFlags.push(index % 2 === 0 ? 'soft_focus' : 'busy_background');
    }

    if (photo.width > photo.height * 1.25) {
      qualityFlags.push('landscape_crop');
    }

    return {
      photoId: photo.photoId,
      ...scores,
      personalTasteScore: index < 18 ? clampScore(0.58 + scoreSeed(index, 12) * 0.34) : undefined,
      sceneLabels,
      qualityFlags,
      faceCount: photo.peopleIds.length,
    };
  });
}

function sortedPhotos(photos: TripPhoto[], photoScores: PhotoScore[]) {
  const scoreById = new Map(photoScores.map((score) => [score.photoId, score]));

  return [...photos].sort((a, b) => {
    const scoreA = scoreById.get(a.photoId)?.finalScore ?? 0;
    const scoreB = scoreById.get(b.photoId)?.finalScore ?? 0;
    return scoreB - scoreA;
  });
}

function createPicks(
  photos: TripPhoto[],
  photoScores: PhotoScore[],
  set: PickSet,
  count: number,
): RankedPick[] {
  const scoreById = new Map(photoScores.map((score) => [score.photoId, score]));
  const ordered = sortedPhotos(photos, photoScores).slice(0, Math.min(count, photos.length));

  return ordered.map((photo, index) => {
    const score = scoreById.get(photo.photoId);
    const sceneLabels = score?.sceneLabels ?? ['trip'];
    const reasons = [
      score?.qualityScore && score.qualityScore > 0.78 ? 'sharp' : 'good frame',
      score?.aestheticScore && score.aestheticScore > 0.76 ? 'strong light' : sceneLabels[0],
      score?.coverageScore && score.coverageScore > 0.78 ? 'adds variety' : 'fits set',
    ];

    return {
      photoId: photo.photoId,
      set,
      rank: index + 1,
      finalScore: score?.finalScore ?? 0.5,
      reasons,
      momentId: photo.momentId,
      cropHint: cropHintFor(photo),
      editHint: editHints[index % editHints.length],
      role: set === 'carousel' ? carouselRoles[index % carouselRoles.length] : undefined,
    };
  });
}

function photoIdsForSlide(orderedPhotos: TripPhoto[], variationIndex: number, slideIndex: number, template: CarouselSlideTemplate) {
  const cursor = variationIndex * 9 + slideIndex * 3;
  const needed = template === 'single' ? 1 : template === 'detail_grid' ? 4 : 3;
  const candidates = orderedPhotos.map((photo, index) => ({
    photo,
    distance: (index - cursor + orderedPhotos.length) % orderedPhotos.length,
  }));
  const orderedCandidates =
    template === 'single'
      ? candidates
      : [...candidates].sort((a, b) => {
          const orientationDelta =
            orientationRankForTemplate(a.photo, template) - orientationRankForTemplate(b.photo, template);
          return orientationDelta || a.distance - b.distance;
        });
  const photoIds: string[] = [];

  for (const { photo } of orderedCandidates) {
    if (photo && !photoIds.includes(photo.photoId)) {
      photoIds.push(photo.photoId);
    }

    if (photoIds.length === needed) {
      break;
    }
  }

  return photoIds;
}

function titleForSlide(template: CarouselSlideTemplate, slideIndex: number) {
  if (slideIndex === 0) {
    return 'Opener';
  }

  if (slideIndex === slideTemplates.length - 1) {
    return 'Closer';
  }

  if (template === 'vertical_triptych') {
    return 'Three-beat stack';
  }

  if (template === 'hero_with_details') {
    return 'Hero plus details';
  }

  if (template === 'detail_grid') {
    return 'Detail grid';
  }

  return carouselRoles[slideIndex % carouselRoles.length];
}

function createCarouselVariations(photos: TripPhoto[], photoScores: PhotoScore[]): CarouselVariation[] {
  const orderedPhotos = sortedPhotos(photos, photoScores);

  return variationDefinitions.map((definition, variationIndex) => {
    const slides = slideTemplates.map((template, slideIndex) => {
      const photoIds = photoIdsForSlide(orderedPhotos, variationIndex, slideIndex, template);

      return {
        slideId: `carousel-${variationIndex + 1}-slide-${slideIndex + 1}`,
        rank: slideIndex + 1,
        template,
        photoIds,
        title: titleForSlide(template, slideIndex),
        note:
          template === 'single'
            ? 'Use one strong frame with minimal cropping.'
            : template === 'vertical_triptych'
              ? 'Stack three landscape frames into horizontal strips.'
              : template === 'hero_with_details'
                ? 'Lead with a wide hero frame and support it with smaller details.'
                : 'Use four landscape or square detail shots as a pacing break.',
        cropHint: cropHintForTemplate(
          template,
          orderedPhotos[(variationIndex * 9 + slideIndex * 3) % orderedPhotos.length],
        ),
      };
    });

    const uniquePhotoIds = new Set(slides.flatMap((slide) => slide.photoIds));

    return {
      variationId: `carousel-${variationIndex + 1}`,
      label: definition.label,
      thesis: definition.thesis,
      confidence: clampScore(0.86 - variationIndex * 0.04),
      coverPhotoId: slides[0].photoIds[0],
      slideCount: slides.length,
      photoCount: uniquePhotoIds.size,
      reasons: definition.reasons,
      slides,
    };
  });
}

function createDuplicateGroups(photos: TripPhoto[], photoScores: PhotoScore[]): DuplicateGroup[] {
  const scoreById = new Map(photoScores.map((score) => [score.photoId, score.finalScore]));
  const groups: DuplicateGroup[] = [];

  for (let index = 0; index < Math.min(photos.length - 2, 24); index += 7) {
    const photoIds = photos.slice(index, index + 3).map((photo) => photo.photoId);

    if (photoIds.length < 3) {
      continue;
    }

    const bestPhotoId = [...photoIds].sort(
      (a, b) => (scoreById.get(b) ?? 0) - (scoreById.get(a) ?? 0),
    )[0];

    groups.push({
      groupId: `dup-${groups.length + 1}`,
      projectId: photos[index].projectId,
      photoIds,
      representativePhotoId: photoIds[0],
      bestPhotoId,
      duplicateType: index % 2 === 0 ? 'burst' : 'near',
      confidence: clampScore(0.78 + groups.length * 0.04),
      reasonCodes: index % 2 === 0 ? ['time_proximity', 'embedding_close'] : ['embedding_close'],
      createdAt: GENERATED_AT,
    });
  }

  return groups;
}

function feedLabelFor(score: number): FeedFitLabel {
  if (score >= 0.75) {
    return 'fits';
  }

  if (score >= 0.56) {
    return 'maybe';
  }

  return 'clashes';
}

function createFeedPreviewCandidates(photos: TripPhoto[], photoScores: PhotoScore[]): FeedPreviewCandidate[] {
  const scoreById = new Map(photoScores.map((score) => [score.photoId, score]));

  return photos.slice(0, Math.min(photos.length, 12)).map((photo, index) => {
    const base = scoreById.get(photo.photoId);
    const fitScore = clampScore((base?.aestheticScore ?? 0.55) * 0.54 + scoreSeed(index, 17) * 0.38);
    const label = feedLabelFor(fitScore);

    return {
      rank: index + 1,
      feedProfileId: 'mock-grid-warm-minimal',
      projectId: photo.projectId,
      photoId: photo.photoId,
      fitScore,
      label,
      paletteMatch: clampScore(fitScore + scoreSeed(index, 21) * 0.08 - 0.04),
      brightnessMatch: clampScore(fitScore + scoreSeed(index, 24) * 0.1 - 0.05),
      compositionMatch: clampScore(fitScore + scoreSeed(index, 28) * 0.1 - 0.05),
      subjectMixFit: clampScore(0.52 + scoreSeed(index, 31) * 0.42),
      noveltyScore: clampScore(0.48 + scoreSeed(index, 34) * 0.46),
      cropSuitability: {
        square: clampScore(0.55 + scoreSeed(index, 38) * 0.38),
        vertical: clampScore(photo.height >= photo.width ? 0.82 : 0.5),
        landscape: clampScore(photo.width > photo.height ? 0.78 : 0.46),
      },
      reasons:
        label === 'fits'
          ? ['warm palette', 'clean crop', 'low contrast']
          : label === 'maybe'
            ? ['strong shot', 'busier frame', 'crop helps']
            : ['darker mood', 'higher saturation', 'less grid fit'],
      previewSlot: 0,
      editHint:
        label === 'fits'
          ? 'Use a square crop and keep the warm tones.'
          : label === 'maybe'
            ? 'Brighten slightly and reduce visual clutter.'
            : 'Use only if the next grid row can handle a darker post.',
    };
  });
}

export function buildRankingResult(projectId: string, photos: TripPhoto[]): RankingResult {
  const photoScores = createPhotoScores(photos);

  return {
    resultId: `${projectId}-result-001`,
    projectId,
    jobId: `${projectId}-job-001`,
    modelVersion: 'fake-ranker-v0.1',
    generatedAt: GENERATED_AT,
    topPicks: createPicks(photos, photoScores, 'top_pool', 50),
    carouselVariations: createCarouselVariations(photos, photoScores),
    photoScores,
    duplicateGroups: createDuplicateGroups(photos, photoScores),
    feedPreviewCandidates: createFeedPreviewCandidates(sortedPhotos(photos, photoScores), photoScores),
    warnings:
      photos.length < 20
        ? ['Small sample: add more trip photos before trusting carousel composition.']
        : ['Fake prototype scores are deterministic and will be replaced by server analysis.'],
  };
}

function createSucceededJob(projectId: string, photoCount: number): AnalysisJob {
  return {
    jobId: `${projectId}-job-001`,
    projectId,
    status: 'succeeded',
    stage: 'complete',
    progress: 1,
    assetCount: photoCount,
    uploadedAssetCount: photoCount,
    createdAt: GENERATED_AT,
    updatedAt: GENERATED_AT,
    startedAt: GENERATED_AT,
    completedAt: GENERATED_AT,
    resultId: `${projectId}-result-001`,
  };
}

export function createSampleProject(): TripProject {
  const photos = Array.from({ length: 96 }, (_, index) => createPhoto(index, PROJECT_ID));
  const result = buildRankingResult(PROJECT_ID, photos);

  return {
    projectId: PROJECT_ID,
    name: 'Santa Lucia Weekend',
    locationLabel: 'Sample coastal trip',
    createdAt: GENERATED_AT,
    photoCount: 1000,
    moments,
    photos,
    job: createSucceededJob(PROJECT_ID, photos.length),
    result,
  };
}

export function createProjectFromPickedAssets(assets: PickedAssetInput[]): TripProject {
  const projectId = `local-trip-${Date.now()}`;
  const photos = assets.map((asset, index) => createPickedPhoto(asset, index, projectId));
  const result = buildRankingResult(projectId, photos);

  return {
    projectId,
    name: 'Selected Trip',
    locationLabel: 'Local photo selection',
    createdAt: new Date().toISOString(),
    photoCount: photos.length,
    moments,
    photos,
    job: createSucceededJob(projectId, photos.length),
    result,
  };
}

export { moments as sampleMoments };
