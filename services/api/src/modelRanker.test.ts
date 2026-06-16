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

test('dedupes repeated source assets before composing multi-photo slides', () => {
  const photos = Array.from({ length: 16 }, (_, index) => photo({
    aestheticScore: index < 2 ? 0.92 - index * 0.01 : 0.76 - index * 0.005,
    capturedAt: `2026-06-01T12:${String(index).padStart(2, '0')}:00.000Z`,
    colorProfile: {
      brightness: 0.58,
      contrast: 0.58,
      saturation: 0.56,
      warmth: 0.6,
    },
    height: index % 3 === 0 ? 1200 : 1500,
    labels: index % 4 === 0 ? ['detail', 'food'] : ['landscape', 'place'],
    momentId: `moment-${Math.floor(index / 4)}`,
    photoId: index === 0 ? 'same-source-a' : index === 1 ? 'same-source-b' : `photo-${index}`,
    qualitySignals: {
      exposure: 0.84,
      faceCount: 0,
      sharpness: 0.86,
    },
    sourceAssetId: index < 2 ? 'same-camera-asset' : `camera-asset-${index}`,
    width: index % 3 === 0 ? 2000 : 1700,
  }));

  const result = analyzeTripPhotos(request({
    options: {
      carouselMaxSlides: 20,
      topPoolSize: 16,
      variationCount: 3,
    },
    photos,
  }));
  const repeatedAssetGroup = result.duplicateGroups.find((group) =>
    group.photoIds.includes('same-source-a') && group.photoIds.includes('same-source-b'),
  );

  assert.ok(repeatedAssetGroup);
  assert.equal(repeatedAssetGroup.duplicateType, 'exact');
  assert.equal(result.topPicks.filter((pick) => ['same-source-a', 'same-source-b'].includes(pick.photoId)).length, 1);

  for (const slide of result.carouselVariations.flatMap((variation) => variation.slides)) {
    const sourceAssetIds = slide.photoIds.map((photoId) => {
      const sourcePhoto = photos.find((item) => item.photoId === photoId);
      assert.ok(sourcePhoto);
      return sourcePhoto.sourceAssetId ?? sourcePhoto.photoId;
    });

    assert.equal(sourceAssetIds.length, new Set(sourceAssetIds).size);
  }
});

test('dedupes repeated perceptual hashes and returns CPU model version', () => {
  const result = analyzeTripPhotos(request({
    photos: [
      photo({
        aestheticScore: 0.62,
        modelQualitySignals: { exposure: 0.72, sharpness: 0.48 },
        perceptualHash: 'ff00ff00ff00ff00',
        photoId: 'hash-soft',
        visualEmbedding: [1, 0, 0, 0],
      }),
      photo({
        aestheticScore: 0.9,
        modelQualitySignals: { exposure: 0.86, sharpness: 0.94 },
        perceptualHash: 'ff00ff00ff00ff00',
        photoId: 'hash-best',
        visualEmbedding: [1, 0, 0.001, 0],
      }),
      photo({
        labels: ['food', 'detail'],
        momentId: 'moment-2',
        perceptualHash: '00ff00ff00ff00ff',
        photoId: 'different-frame',
        visualEmbedding: [0, 1, 0, 0],
      }),
    ],
    options: {
      topPoolSize: 3,
    },
  }));

  assert.equal(result.modelVersion, 'cpu-vision-curation-v0.1.0');
  assert.equal(result.duplicateGroups.length, 1);
  assert.equal(result.duplicateGroups[0]?.bestPhotoId, 'hash-best');
  assert.ok(result.duplicateGroups[0]?.reasonCodes.includes('perceptual_hash'));
  assert.equal(result.topPicks.some((pick) => pick.photoId === 'hash-soft'), false);
});

test('groups visually similar same-scene variants when CPU embeddings agree', () => {
  const result = analyzeTripPhotos(request({
    photos: [
      photo({
        colorProfile: { brightness: 0.55, contrast: 0.72, saturation: 0.62, warmth: 0.76 },
        labels: ['architecture', 'place', 'warm'],
        modelLabels: ['landscape', 'warm'],
        modelQualitySignals: { exposure: 0.8, sharpness: 0.82 },
        photoId: 'yellow-building-wide',
        visualEmbedding: [1, 0, 0, 0],
        width: 1800,
        height: 1200,
      }),
      photo({
        aestheticScore: 0.88,
        colorProfile: { brightness: 0.56, contrast: 0.69, saturation: 0.6, warmth: 0.74 },
        labels: ['architecture', 'place', 'warm'],
        modelLabels: ['landscape', 'warm'],
        modelQualitySignals: { exposure: 0.84, sharpness: 0.9 },
        photoId: 'yellow-building-angle',
        visualEmbedding: [0.94, 0.34, 0, 0],
        width: 1800,
        height: 1200,
      }),
      photo({
        colorProfile: { brightness: 0.43, contrast: 0.55, saturation: 0.48, warmth: 0.5 },
        labels: ['food', 'detail'],
        momentId: 'moment-2',
        photoId: 'dinner-detail',
        visualEmbedding: [0, 1, 0, 0],
      }),
    ],
    options: {
      topPoolSize: 3,
    },
  }));
  const group = result.duplicateGroups.find((duplicateGroup) =>
    duplicateGroup.photoIds.includes('yellow-building-wide') &&
      duplicateGroup.photoIds.includes('yellow-building-angle'),
  );

  assert.ok(group);
  assert.equal(group.duplicateType, 'similar');
  assert.ok(group.reasonCodes.includes('same_scene_variant'));
  assert.equal(result.topPicks.filter((pick) => pick.photoId.startsWith('yellow-building')).length, 1);
});

test('does not collapse metadata-only lookalikes without CPU evidence', () => {
  const result = analyzeTripPhotos(request({
    photos: [
      photo({
        capturedAt: '2026-06-01T12:00:00.000Z',
        colorProfile: { brightness: 0.55, contrast: 0.72, saturation: 0.62, warmth: 0.76 },
        labels: ['architecture', 'place', 'warm'],
        momentId: 'morning-walk',
        photoId: 'metadata-building-a',
        sourceAssetId: 'asset-a',
        width: 1800,
        height: 1200,
      }),
      photo({
        capturedAt: '2026-06-01T17:00:00.000Z',
        colorProfile: { brightness: 0.56, contrast: 0.69, saturation: 0.6, warmth: 0.74 },
        labels: ['architecture', 'place', 'warm'],
        momentId: 'evening-walk',
        photoId: 'metadata-building-b',
        sourceAssetId: 'asset-b',
        width: 1800,
        height: 1200,
      }),
    ],
    options: {
      topPoolSize: 2,
    },
  }));

  assert.equal(result.duplicateGroups.length, 0);
  assert.equal(result.topPicks.filter((pick) => pick.photoId.startsWith('metadata-building')).length, 2);
});

test('clusters GPU semantic same-scene candidates and keeps one representative', () => {
  const result = analyzeTripPhotos(request({
    photos: [
      photo({
        aestheticScore: 0.82,
        colorProfile: { brightness: 0.58, contrast: 0.68, saturation: 0.62, warmth: 0.76 },
        embedding: [1, 0, 0],
        labels: ['place'],
        photoId: 'yellow-hotel-wide',
        semanticTags: [
          { label: 'architecture', score: 0.44, source: 'clip_zero_shot' },
          { label: 'hotel', score: 0.31, source: 'clip_zero_shot' },
        ],
        templateScores: { hero: 0.62, place: 0.58, atmosphere: 0.2 },
        width: 1800,
        height: 1200,
      }),
      photo({
        aestheticScore: 0.9,
        colorProfile: { brightness: 0.57, contrast: 0.66, saturation: 0.61, warmth: 0.74 },
        embedding: [0.93, 0.367, 0],
        labels: ['place'],
        photoId: 'yellow-hotel-angle',
        semanticTags: [
          { label: 'architecture', score: 0.42, source: 'clip_zero_shot' },
          { label: 'hotel', score: 0.29, source: 'clip_zero_shot' },
        ],
        templateScores: { hero: 0.66, place: 0.6, atmosphere: 0.2 },
        width: 1800,
        height: 1200,
      }),
      photo({
        embedding: [0, 1, 0],
        labels: ['food'],
        momentId: 'dinner',
        photoId: 'dinner-table',
        semanticTags: [{ label: 'food', score: 0.48, source: 'clip_zero_shot' }],
        templateScores: { detail: 0.52, food: 0.48 },
      }),
    ],
    options: {
      topPoolSize: 3,
    },
  }));
  const group = result.duplicateGroups.find((duplicateGroup) =>
    duplicateGroup.photoIds.includes('yellow-hotel-wide') &&
      duplicateGroup.photoIds.includes('yellow-hotel-angle'),
  );

  assert.ok(group);
  assert.equal(group.duplicateType, 'similar');
  assert.ok(group.reasonCodes.includes('semantic_cluster'));
  assert.equal(group.bestPhotoId, 'yellow-hotel-angle');
  assert.equal(result.topPicks.filter((pick) => pick.photoId.startsWith('yellow-hotel')).length, 1);
  assert.ok(result.debugTrace?.final.topPicks.some((pick) => pick.semanticClusterId));
});

test('still returns picks when every candidate is low quality', () => {
  const result = analyzeTripPhotos(request({
    photos: [
      photo({
        height: 64,
        modelQualitySignals: { exposure: 0.35, sharpness: 0.2 },
        photoId: 'tiny-soft',
        width: 64,
      }),
    ],
    options: {
      carouselMaxSlides: 1,
      topPoolSize: 1,
      variationCount: 1,
    },
  }));

  assert.equal(result.topPicks.length, 1);
  assert.equal(result.carouselVariations[0]?.slideCount, 1);
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

test('templates prefer semantic role-compatible groups', () => {
  const photos = [
    ...Array.from({ length: 10 }, (_, index) => photo({
      aestheticScore: 0.84 - index * 0.01,
      embedding: Array.from({ length: 14 }, (_, vectorIndex) => vectorIndex === index ? 1 : 0),
      height: 1200,
      labels: ['architecture', 'detail'],
      momentId: 'city-details',
      photoId: `detail-place-${index}`,
      semanticTags: [
        { label: index % 2 ? 'architecture' : 'detail', score: 0.46, source: 'clip_zero_shot' },
        { label: 'street', score: 0.22, source: 'clip_zero_shot' },
      ],
      templateScores: {
        atmosphere: 0.46,
        detail: 0.54,
        hero: 0.38,
        place: 0.52,
      },
      width: 1800,
    })),
    ...Array.from({ length: 4 }, (_, index) => photo({
      aestheticScore: 0.86 - index * 0.01,
      embedding: Array.from({ length: 14 }, (_, vectorIndex) => vectorIndex === index + 10 ? 1 : 0),
      height: 1700,
      labels: ['people'],
      momentId: 'friends',
      photoId: `people-only-${index}`,
      qualitySignals: { faceCount: 1, sharpness: 0.86, exposure: 0.82 },
      semanticTags: [{ label: 'selfie', score: 0.55, source: 'clip_zero_shot' }],
      templateScores: {
        hero: 0.42,
        people: 0.72,
      },
      width: 1200,
    })),
  ];
  const result = analyzeTripPhotos(request({
    options: {
      carouselMaxSlides: 8,
      topPoolSize: 14,
      variationCount: 3,
    },
    photos,
  }));
  const detailGrid = result.carouselVariations
    .flatMap((variation) => variation.slides)
    .find((slide) => slide.template === 'detail_grid');

  assert.ok(detailGrid);
  assert.ok(detailGrid.photoIds.every((photoId) => photoId.startsWith('detail-place')));

  const triptych = result.carouselVariations
    .flatMap((variation) => variation.slides)
    .find((slide) => slide.template === 'vertical_triptych');

  assert.ok(triptych);
  assert.ok(triptych.photoIds.every((photoId) => {
    const sourcePhoto = photos.find((item) => item.photoId === photoId);
    assert.ok(sourcePhoto);
    return sourcePhoto.width >= sourcePhoto.height;
  }));
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
