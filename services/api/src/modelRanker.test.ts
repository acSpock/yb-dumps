import assert from 'node:assert/strict';
import test from 'node:test';

import { AnalysisPhotoInput, AnalysisRankRequest } from './analysisContracts.js';
import { analyzeTripPhotos } from './modelRanker.js';

function photo(input: Partial<AnalysisPhotoInput> & { photoId: string }): AnalysisPhotoInput {
  return {
    capturedAt: '2026-06-01T12:00:00.000Z',
    colorProfile: {
      brightness: 0.58,
      contrast: 0.6,
      saturation: 0.56,
      warmth: 0.57,
    },
    height: 1600,
    labels: ['place'],
    momentId: 'moment-1',
    peopleIds: [],
    qualitySignals: {
      exposure: 0.8,
      sharpness: 0.8,
    },
    width: 1200,
    ...input,
  };
}

function request(input: Partial<AnalysisRankRequest>): AnalysisRankRequest {
  return {
    photos: [],
    projectId: 'project-test',
    ...input,
  };
}

test('groups near duplicates and keeps the strongest frame in top picks', () => {
  const result = analyzeTripPhotos(request({
    photos: [
      photo({
        aestheticScore: 0.55,
        embedding: [1, 0, 0],
        photoId: 'burst-soft',
        qualitySignals: { sharpness: 0.42, exposure: 0.7 },
      }),
      photo({
        aestheticScore: 0.9,
        capturedAt: '2026-06-01T12:00:08.000Z',
        embedding: [0.999, 0.001, 0],
        photoId: 'burst-best',
        qualitySignals: { sharpness: 0.93, exposure: 0.88 },
      }),
      photo({
        embedding: [0, 1, 0],
        labels: ['food', 'detail'],
        momentId: 'moment-2',
        photoId: 'dinner-detail',
      }),
    ],
    options: {
      topPoolSize: 3,
    },
  }));

  assert.equal(result.duplicateGroups.length, 1);
  assert.equal(result.duplicateGroups[0]?.bestPhotoId, 'burst-best');
  assert.ok(result.topPicks.some((pick) => pick.photoId === 'burst-best'));
  assert.equal(result.topPicks.some((pick) => pick.photoId === 'burst-soft'), false);
});

test('composes carousels under the 20-slide Instagram limit and prefers landscape photos for stacked templates', () => {
  const photos = Array.from({ length: 34 }, (_, index) => {
    const isLandscapeMoment = index < 8;
    const width = isLandscapeMoment ? 2200 : index % 3 === 0 ? 1600 : 1200;
    const height = isLandscapeMoment ? 1300 : index % 3 === 0 ? 1600 : 1800;

    return photo({
      aestheticScore: isLandscapeMoment ? 0.88 - index * 0.01 : 0.72,
      capturedAt: `2026-06-01T12:${String(index).padStart(2, '0')}:00.000Z`,
      colorProfile: {
        brightness: 0.54 + (index % 5) * 0.02,
        contrast: 0.58,
        saturation: 0.56,
        warmth: 0.55,
      },
      embedding: [index / 40, isLandscapeMoment ? 1 : 0.2, (index % 7) / 10],
      height,
      labels: isLandscapeMoment ? ['landscape', 'place'] : index % 4 === 0 ? ['people'] : ['detail'],
      momentId: isLandscapeMoment ? 'wide-view' : `moment-${Math.floor(index / 4)}`,
      peopleIds: index % 4 === 0 ? ['person-1'] : [],
      photoId: `photo-${index}`,
      qualitySignals: {
        faceCount: index % 4 === 0 ? 1 : 0,
        sharpness: 0.82,
      },
      width,
    });
  });

  const result = analyzeTripPhotos(request({
    options: {
      carouselMaxSlides: 20,
      topPoolSize: 34,
      variationCount: 3,
    },
    photos,
  }));
  const stackedSlide = result.carouselVariations
    .flatMap((variation) => variation.slides)
    .find((slide) => slide.template === 'vertical_triptych');

  assert.ok(result.carouselVariations.length > 0);
  assert.ok(result.carouselVariations.every((variation) => variation.slideCount <= 20));
  assert.ok(stackedSlide);
  assert.equal(stackedSlide.photoIds.length, 3);

  for (const photoId of stackedSlide.photoIds) {
    const sourcePhoto = photos.find((item) => item.photoId === photoId);
    assert.ok(sourcePhoto);
    assert.ok(sourcePhoto.width >= sourcePhoto.height);
  }
});

test('scores feed fit against palette and subject style', () => {
  const result = analyzeTripPhotos(request({
    feedProfile: {
      assets: [
        {
          colorProfile: { brightness: 0.62, contrast: 0.55, saturation: 0.48, warmth: 0.8 },
          height: 1600,
          id: 'feed-1',
          labels: ['beach', 'place'],
          width: 1200,
        },
        {
          colorProfile: { brightness: 0.6, contrast: 0.57, saturation: 0.5, warmth: 0.76 },
          height: 1600,
          id: 'feed-2',
          labels: ['beach', 'people'],
          width: 1200,
        },
      ],
    },
    photos: [
      photo({
        aestheticScore: 0.79,
        colorProfile: { brightness: 0.61, contrast: 0.56, saturation: 0.5, warmth: 0.78 },
        labels: ['beach', 'place'],
        photoId: 'warm-beach',
      }),
      photo({
        aestheticScore: 0.92,
        colorProfile: { brightness: 0.34, contrast: 0.82, saturation: 0.86, warmth: 0.22 },
        labels: ['city', 'night'],
        momentId: 'moment-2',
        photoId: 'cool-city',
      }),
      photo({
        aestheticScore: 0.72,
        colorProfile: { brightness: 0.56, contrast: 0.58, saturation: 0.52, warmth: 0.56 },
        labels: ['food', 'detail'],
        momentId: 'moment-3',
        photoId: 'neutral-detail',
      }),
    ],
    options: {
      topPoolSize: 3,
    },
  }));

  assert.equal(result.feedPreviewCandidates[0]?.photoId, 'warm-beach');
  assert.equal(result.feedPreviewCandidates[0]?.label, 'fits');
});
