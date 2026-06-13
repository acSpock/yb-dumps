import {
  AnalysisColorProfile,
  AnalysisPhotoInput,
  AnalysisQualitySignals,
  AnalysisRankRequest,
  CarouselSlide,
  CarouselSlideTemplate,
  CarouselVariation,
  CropHint,
  DuplicateGroup,
  FeedFitLabel,
  FeedProfileAssetInput,
  FeedPreviewCandidate,
  PhotoScore,
  RankedPick,
  RankingResult,
} from './analysisContracts.js';

const MODEL_VERSION = 'heuristic-curation-v0.1.0';
const EMBEDDING_SIZE = 32;
const DEFAULT_TOP_POOL_SIZE = 50;
const DEFAULT_CAROUSEL_MAX_SLIDES = 20;
const DEFAULT_VARIATION_COUNT = 3;

type Orientation = 'portrait' | 'square' | 'landscape';

type PhotoFeature = {
  photo: AnalysisPhotoInput;
  embedding: number[];
  sceneLabels: string[];
  colorProfile: Required<AnalysisColorProfile>;
  qualityScore: number;
  aestheticScore: number;
  coverageScore: number;
  finalScore: number;
  qualityFlags: string[];
  faceCount: number;
  orientation: Orientation;
  cropHint: CropHint;
  capturedAtMs?: number;
  duplicateGroupId?: string;
  isDuplicateWinner: boolean;
};

type FeedProfileFeature = {
  feedProfileId: string;
  assetCount: number;
  colorProfile: Required<AnalysisColorProfile>;
  embedding?: number[];
  labels: string[];
  portraitRatio: number;
};

type VariationStrategy = 'complete' | 'people' | 'atmosphere';

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function roundScore(value: number) {
  return Math.round(clamp(value) * 1000) / 1000;
}

function average(values: number[], fallback = 0) {
  const usableValues = values.filter((value) => Number.isFinite(value));
  return usableValues.length ? usableValues.reduce((sum, value) => sum + value, 0) / usableValues.length : fallback;
}

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (!magnitude) {
    return vector.map(() => 0);
  }

  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length);
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;

  for (let index = 0; index < length; index += 1) {
    const leftValue = left[index] ?? 0;
    const rightValue = right[index] ?? 0;
    dot += leftValue * rightValue;
    leftMagnitude += leftValue * leftValue;
    rightMagnitude += rightValue * rightValue;
  }

  if (!leftMagnitude || !rightMagnitude) {
    return 0;
  }

  return dot / Math.sqrt(leftMagnitude * rightMagnitude);
}

function safeNumber(value: number | undefined, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value) : fallback;
}

function normalizedColorProfile(colorProfile?: AnalysisColorProfile): Required<AnalysisColorProfile> {
  return {
    brightness: safeNumber(colorProfile?.brightness, 0.56),
    contrast: safeNumber(colorProfile?.contrast, 0.58),
    saturation: safeNumber(colorProfile?.saturation, 0.55),
    warmth: safeNumber(colorProfile?.warmth, 0.52),
  };
}

function orientationFor(photo: Pick<AnalysisPhotoInput, 'height' | 'width'>): Orientation {
  const aspectRatio = photo.width / Math.max(photo.height, 1);

  if (aspectRatio > 1.12) {
    return 'landscape';
  }

  if (aspectRatio < 0.88) {
    return 'portrait';
  }

  return 'square';
}

function cropHintFor(orientation: Orientation): CropHint {
  if (orientation === 'portrait') {
    return 'vertical';
  }

  if (orientation === 'landscape') {
    return 'landscape';
  }

  return 'square';
}

function labelsFor(photo: AnalysisPhotoInput, orientation: Orientation) {
  const labels = new Set((photo.labels ?? []).map((label) => label.trim().toLowerCase()).filter(Boolean));
  const faceCount = photo.qualitySignals?.faceCount ?? photo.peopleIds?.length ?? 0;

  if (faceCount > 0) {
    labels.add(faceCount >= 3 ? 'group' : 'people');
  }

  if (!labels.size) {
    labels.add(orientation === 'landscape' ? 'place' : 'moment');
  }

  return [...labels].sort();
}

function fallbackEmbedding(photo: AnalysisPhotoInput, labels: string[], colorProfile: Required<AnalysisColorProfile>) {
  const vector = Array.from({ length: EMBEDDING_SIZE }, () => 0);
  const orientation = orientationFor(photo);
  const momentHash = hashString(photo.momentId ?? 'moment');
  const photoHash = hashString(photo.photoId);

  for (const label of labels) {
    const hash = hashString(label);
    vector[hash % EMBEDDING_SIZE] += 1;
    vector[(hash >>> 8) % EMBEDDING_SIZE] += 0.5;
  }

  vector[0] += colorProfile.brightness;
  vector[1] += colorProfile.contrast;
  vector[2] += colorProfile.saturation;
  vector[3] += colorProfile.warmth;
  vector[4] += photo.width / Math.max(photo.height, 1);
  vector[5] += (photo.peopleIds?.length ?? photo.qualitySignals?.faceCount ?? 0) / 5;
  vector[6] += (momentHash % 997) / 997;
  vector[7] += orientation === 'landscape' ? 1 : orientation === 'square' ? 0.5 : 0;
  vector[8] += orientation === 'portrait' ? 1 : 0;

  // Keep metadata-only embeddings from collapsing every same-label photo into one duplicate cluster.
  vector[EMBEDDING_SIZE - 1] += ((photoHash % 1000) / 1000) * 0.2;

  return normalizeVector(vector);
}

function embeddingFor(photo: AnalysisPhotoInput, labels: string[], colorProfile: Required<AnalysisColorProfile>) {
  if (photo.embedding?.length) {
    return normalizeVector(photo.embedding.map((value) => (Number.isFinite(value) ? value : 0)));
  }

  return fallbackEmbedding(photo, labels, colorProfile);
}

function scoreQuality(
  photo: AnalysisPhotoInput,
  colorProfile: Required<AnalysisColorProfile>,
  qualitySignals?: AnalysisQualitySignals,
) {
  const megapixels = (photo.width * photo.height) / 1_000_000;
  const resolutionScore = clamp(megapixels / 8, 0.35, 1);
  const sharpness = safeNumber(qualitySignals?.sharpness, 0.72);
  const exposure = safeNumber(qualitySignals?.exposure, 1 - Math.abs(colorProfile.brightness - 0.56) * 1.6);
  const noiseScore = 1 - safeNumber(qualitySignals?.noise, 0.18);
  const faceCount = qualitySignals?.faceCount ?? photo.peopleIds?.length ?? 0;
  const faceScore = faceCount > 0
    ? average([
      safeNumber(qualitySignals?.eyesOpen, 0.78),
      safeNumber(qualitySignals?.smile, 0.68),
      safeNumber(qualitySignals?.subjectCentered, 0.72),
    ], 0.72)
    : 0.68;

  return clamp(
    resolutionScore * 0.2 +
      sharpness * 0.34 +
      exposure * 0.22 +
      noiseScore * 0.14 +
      faceScore * 0.1,
  );
}

function scoreAesthetic(
  photo: AnalysisPhotoInput,
  colorProfile: Required<AnalysisColorProfile>,
  qualityScore: number,
) {
  if (typeof photo.aestheticScore === 'number' && Number.isFinite(photo.aestheticScore)) {
    return clamp(photo.aestheticScore);
  }

  const colorHarmony = average([
    1 - Math.abs(colorProfile.saturation - 0.55) * 1.2,
    1 - Math.abs(colorProfile.contrast - 0.58) * 1.1,
    1 - Math.abs(colorProfile.warmth - 0.56) * 0.8,
    1 - Math.abs(colorProfile.brightness - 0.58) * 0.9,
  ], 0.65);
  const orientation = orientationFor(photo);
  const compositionBias = orientation === 'portrait' ? 0.78 : orientation === 'square' ? 0.75 : 0.73;

  return clamp(colorHarmony * 0.56 + qualityScore * 0.28 + compositionBias * 0.16);
}

function createFeatures(photos: AnalysisPhotoInput[]) {
  const momentCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();

  for (const photo of photos) {
    const orientation = orientationFor(photo);
    const labels = labelsFor(photo, orientation);
    const momentId = photo.momentId ?? 'moment-unknown';
    momentCounts.set(momentId, (momentCounts.get(momentId) ?? 0) + 1);

    for (const label of labels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }

  return photos.map<PhotoFeature>((photo) => {
    const orientation = orientationFor(photo);
    const sceneLabels = labelsFor(photo, orientation);
    const colorProfile = normalizedColorProfile(photo.colorProfile);
    const qualityScore = scoreQuality(photo, colorProfile, photo.qualitySignals);
    const aestheticScore = scoreAesthetic(photo, colorProfile, qualityScore);
    const momentSize = momentCounts.get(photo.momentId ?? 'moment-unknown') ?? 1;
    const labelRarity = average(sceneLabels.map((label) => 1 / Math.sqrt(labelCounts.get(label) ?? 1)), 0.5);
    const coverageScore = clamp(0.45 + 0.24 / Math.sqrt(momentSize) + 0.31 * labelRarity);
    const faceCount = photo.qualitySignals?.faceCount ?? photo.peopleIds?.length ?? 0;
    const peopleBonus = faceCount > 0 ? 0.035 : 0;
    const finalScore = clamp(qualityScore * 0.43 + aestheticScore * 0.36 + coverageScore * 0.21 + peopleBonus);
    const qualityFlags = qualityFlagsFor(photo, qualityScore, colorProfile);

    return {
      photo,
      aestheticScore,
      capturedAtMs: parseCapturedAt(photo.capturedAt),
      colorProfile,
      coverageScore,
      cropHint: cropHintFor(orientation),
      embedding: embeddingFor(photo, sceneLabels, colorProfile),
      faceCount,
      finalScore,
      isDuplicateWinner: true,
      orientation,
      qualityFlags,
      qualityScore,
      sceneLabels,
    };
  });
}

function qualityFlagsFor(
  photo: AnalysisPhotoInput,
  qualityScore: number,
  colorProfile: Required<AnalysisColorProfile>,
) {
  const flags: string[] = [];

  if (qualityScore < 0.5) {
    flags.push('low_quality');
  }

  if (safeNumber(photo.qualitySignals?.sharpness, 0.72) < 0.45) {
    flags.push('soft_focus');
  }

  if (colorProfile.brightness < 0.28) {
    flags.push('dark');
  }

  if (colorProfile.brightness > 0.86) {
    flags.push('overexposed');
  }

  if (photo.width * photo.height < 900_000) {
    flags.push('low_resolution');
  }

  return flags;
}

function parseCapturedAt(value?: string) {
  if (!value) {
    return undefined;
  }

  const timestamp = Date.parse(value);
  return Number.isNaN(timestamp) ? undefined : timestamp;
}

function detectDuplicates(features: PhotoFeature[], projectId: string, createdAt: string) {
  const duplicateGroups: DuplicateGroup[] = [];
  const assigned = new Set<string>();

  for (const feature of features) {
    if (assigned.has(feature.photo.photoId)) {
      continue;
    }

    const group = [feature];

    for (const candidate of features) {
      if (candidate.photo.photoId === feature.photo.photoId || assigned.has(candidate.photo.photoId)) {
        continue;
      }

      const similarity = cosineSimilarity(feature.embedding, candidate.embedding);
      const sameMoment = (feature.photo.momentId ?? '') === (candidate.photo.momentId ?? '');
      const closeTime = areCloseInTime(feature, candidate, 90_000);
      const exactEmbedding = Boolean(feature.photo.embedding?.length && candidate.photo.embedding?.length && similarity > 0.985);

      if (exactEmbedding || similarity > 0.975 || (similarity > 0.91 && sameMoment && closeTime)) {
        group.push(candidate);
      }
    }

    if (group.length < 2) {
      continue;
    }

    const rankedGroup = [...group].sort((left, right) => right.finalScore - left.finalScore);
    const bestFeature = rankedGroup[0];

    if (!bestFeature) {
      continue;
    }

    const groupId = `dup-${duplicateGroups.length + 1}`;
    const averageSimilarity = average(group.slice(1).map((item) => cosineSimilarity(feature.embedding, item.embedding)), 0.9);
    const duplicateType = group.every((item) => areCloseInTime(feature, item, 20_000))
      ? 'burst'
      : averageSimilarity > 0.985
        ? 'near'
        : 'similar';

    for (const item of group) {
      item.duplicateGroupId = groupId;
      item.isDuplicateWinner = item.photo.photoId === bestFeature.photo.photoId;
      assigned.add(item.photo.photoId);
    }

    duplicateGroups.push({
      bestPhotoId: bestFeature.photo.photoId,
      confidence: roundScore(averageSimilarity),
      createdAt,
      duplicateType,
      groupId,
      photoIds: rankedGroup.map((item) => item.photo.photoId),
      projectId,
      reasonCodes: duplicateType === 'burst' ? ['time_proximity', 'visual_similarity'] : ['visual_similarity'],
      representativePhotoId: feature.photo.photoId,
    });
  }

  return duplicateGroups;
}

function areCloseInTime(left: PhotoFeature, right: PhotoFeature, thresholdMs: number) {
  if (left.capturedAtMs === undefined || right.capturedAtMs === undefined) {
    return false;
  }

  return Math.abs(left.capturedAtMs - right.capturedAtMs) <= thresholdMs;
}

function selectDiverseFeatures(features: PhotoFeature[], limit: number) {
  const candidates = features
    .filter((feature) => feature.isDuplicateWinner && !feature.qualityFlags.includes('low_quality'))
    .sort((left, right) => right.finalScore - left.finalScore);
  const selected: PhotoFeature[] = [];
  const selectedIds = new Set<string>();
  const momentCounts = new Map<string, number>();
  const labelCounts = new Map<string, number>();

  while (selected.length < limit && selected.length < candidates.length) {
    let bestCandidate: PhotoFeature | undefined;
    let bestScore = Number.NEGATIVE_INFINITY;

    for (const candidate of candidates) {
      if (selectedIds.has(candidate.photo.photoId)) {
        continue;
      }

      const momentId = candidate.photo.momentId ?? 'moment-unknown';
      const maxSimilarity = selected.length
        ? Math.max(...selected.map((item) => cosineSimilarity(candidate.embedding, item.embedding)))
        : 0;
      const newMomentBonus = (momentCounts.get(momentId) ?? 0) === 0 ? 0.08 : 0;
      const labelNoveltyBonus = average(
        candidate.sceneLabels.map((label) => ((labelCounts.get(label) ?? 0) === 0 ? 0.05 : 0)),
        0,
      );
      const peopleBalanceBonus = candidate.faceCount > 0 && selected.filter((item) => item.faceCount > 0).length < Math.ceil(limit * 0.35)
        ? 0.035
        : 0;
      const diversityScore = candidate.finalScore - maxSimilarity * 0.22 + newMomentBonus + labelNoveltyBonus + peopleBalanceBonus;

      if (diversityScore > bestScore) {
        bestCandidate = candidate;
        bestScore = diversityScore;
      }
    }

    if (!bestCandidate) {
      break;
    }

    selected.push(bestCandidate);
    selectedIds.add(bestCandidate.photo.photoId);
    const momentId = bestCandidate.photo.momentId ?? 'moment-unknown';
    momentCounts.set(momentId, (momentCounts.get(momentId) ?? 0) + 1);

    for (const label of bestCandidate.sceneLabels) {
      labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
    }
  }

  return selected;
}

function reasonsFor(feature: PhotoFeature) {
  const reasons: string[] = [];

  if (feature.qualityScore >= 0.75) {
    reasons.push('sharp, usable quality');
  }

  if (feature.aestheticScore >= 0.75) {
    reasons.push('strong color and composition');
  }

  if (feature.coverageScore >= 0.7) {
    reasons.push('adds variety to the trip');
  }

  if (feature.faceCount > 0) {
    reasons.push(feature.faceCount >= 3 ? 'good group energy' : 'strong people moment');
  }

  if (feature.duplicateGroupId) {
    reasons.push('best frame from a similar burst');
  }

  if (!reasons.length) {
    reasons.push('balanced carousel candidate');
  }

  return reasons.slice(0, 3);
}

function editHintFor(feature: PhotoFeature) {
  if (feature.cropHint === 'landscape') {
    return 'Works well in horizontal layered templates or as a wide detail slide.';
  }

  if (feature.cropHint === 'vertical') {
    return 'Best as a full-height hero or carousel cover candidate.';
  }

  return 'Flexible square crop for feed preview or grid details.';
}

function rankedPicksFor(features: PhotoFeature[]) {
  return features.map<RankedPick>((feature, index) => ({
    cropHint: feature.cropHint,
    duplicateGroupId: feature.duplicateGroupId,
    editHint: editHintFor(feature),
    finalScore: roundScore(feature.finalScore),
    momentId: feature.photo.momentId,
    photoId: feature.photo.photoId,
    rank: index + 1,
    reasons: reasonsFor(feature),
    role: feature.faceCount > 0 ? 'people' : feature.sceneLabels.includes('detail') ? 'detail' : 'scene',
    set: 'top_pool',
  }));
}

function photoScoresFor(features: PhotoFeature[]) {
  return features
    .slice()
    .sort((left, right) => right.finalScore - left.finalScore)
    .map<PhotoScore>((feature) => ({
      aestheticScore: roundScore(feature.aestheticScore),
      coverageScore: roundScore(feature.coverageScore),
      faceCount: feature.faceCount,
      finalScore: roundScore(feature.finalScore),
      photoId: feature.photo.photoId,
      qualityFlags: feature.qualityFlags,
      qualityScore: roundScore(feature.qualityScore),
      sceneLabels: feature.sceneLabels,
    }));
}

function composeCarouselVariations(
  selectedFeatures: PhotoFeature[],
  requestedVariationCount: number,
  maxSlides: number,
) {
  const strategies: VariationStrategy[] = ['complete', 'people', 'atmosphere'];
  return strategies.slice(0, requestedVariationCount).map((strategy) => composeVariation(strategy, selectedFeatures, maxSlides));
}

function composeVariation(strategy: VariationStrategy, selectedFeatures: PhotoFeature[], maxSlides: number): CarouselVariation {
  const pool = poolForStrategy(strategy, selectedFeatures);
  const fallbackPool = selectedFeatures.filter((feature) => !pool.includes(feature));
  const workingPool = [...pool, ...fallbackPool];
  const usedPhotoIds = new Set<string>();
  const slides: CarouselSlide[] = [];
  const hero = workingPool[0] ?? selectedFeatures[0];

  if (hero) {
    slides.push(createSlide('single', [hero], slides.length + 1, titleForStrategy(strategy, 'Opener'), 'Strongest cover candidate for this edit.'));
    usedPhotoIds.add(hero.photo.photoId);
  }

  const sameMomentGroups = groupByMoment(workingPool.filter((feature) => !usedPhotoIds.has(feature.photo.photoId)));
  addTemplateSlides(slides, sameMomentGroups, usedPhotoIds, strategy, maxSlides);
  fillSingleSlides(slides, workingPool, usedPhotoIds, maxSlides);

  const uniquePhotoIds = new Set(slides.flatMap((slide) => slide.photoIds));
  const confidence = average(
    slides.flatMap((slide) => slide.photoIds)
      .map((photoId) => selectedFeatures.find((feature) => feature.photo.photoId === photoId)?.finalScore ?? 0.6),
    0.6,
  );

  return {
    confidence: roundScore(confidence),
    coverPhotoId: slides[0]?.photoIds[0] ?? hero?.photo.photoId ?? '',
    label: variationLabel(strategy),
    photoCount: uniquePhotoIds.size,
    reasons: variationReasons(strategy),
    slideCount: slides.length,
    slides,
    thesis: variationThesis(strategy),
    variationId: `carousel-${strategy}`,
  };
}

function poolForStrategy(strategy: VariationStrategy, selectedFeatures: PhotoFeature[]) {
  const sorted = [...selectedFeatures];

  if (strategy === 'people') {
    return sorted.sort((left, right) =>
      right.faceCount - left.faceCount ||
      right.finalScore - left.finalScore ||
      compareTime(left, right),
    );
  }

  if (strategy === 'atmosphere') {
    return sorted.sort((left, right) =>
      atmosphereScore(right) - atmosphereScore(left) ||
      right.finalScore - left.finalScore ||
      compareTime(left, right),
    );
  }

  return sorted.sort((left, right) => compareTime(left, right) || right.finalScore - left.finalScore);
}

function atmosphereScore(feature: PhotoFeature) {
  const detailBonus = feature.sceneLabels.some((label) => ['detail', 'food', 'architecture', 'landscape', 'place'].includes(label)) ? 0.35 : 0;
  const orientationBonus = feature.orientation === 'landscape' ? 0.18 : feature.orientation === 'square' ? 0.1 : 0;
  return feature.aestheticScore + detailBonus + orientationBonus;
}

function compareTime(left: PhotoFeature, right: PhotoFeature) {
  return (left.capturedAtMs ?? Number.MAX_SAFE_INTEGER) - (right.capturedAtMs ?? Number.MAX_SAFE_INTEGER);
}

function groupByMoment(features: PhotoFeature[]) {
  const groups = new Map<string, PhotoFeature[]>();

  for (const feature of features) {
    const momentId = feature.photo.momentId ?? `moment-${feature.photo.photoId}`;
    groups.set(momentId, [...(groups.get(momentId) ?? []), feature]);
  }

  return [...groups.values()]
    .map((group) => group.sort((left, right) => right.finalScore - left.finalScore))
    .sort((left, right) => (right[0]?.finalScore ?? 0) - (left[0]?.finalScore ?? 0));
}

function addTemplateSlides(
  slides: CarouselSlide[],
  sameMomentGroups: PhotoFeature[][],
  usedPhotoIds: Set<string>,
  strategy: VariationStrategy,
  maxSlides: number,
) {
  const templateOrder: CarouselSlideTemplate[] = strategy === 'people'
    ? ['hero_with_details', 'vertical_triptych', 'detail_grid']
    : strategy === 'atmosphere'
      ? ['vertical_triptych', 'detail_grid', 'hero_with_details']
      : ['vertical_triptych', 'hero_with_details', 'detail_grid'];

  for (const template of templateOrder) {
    if (slides.length >= maxSlides) {
      return;
    }

    const selected = selectPhotosForTemplate(template, sameMomentGroups, usedPhotoIds, strategy);

    if (!selected.length) {
      continue;
    }

    slides.push(createSlide(
      template,
      selected,
      slides.length + 1,
      titleForStrategy(strategy, templateTitle(template)),
      noteForTemplate(template),
    ));

    for (const feature of selected) {
      usedPhotoIds.add(feature.photo.photoId);
    }
  }
}

function selectPhotosForTemplate(
  template: CarouselSlideTemplate,
  sameMomentGroups: PhotoFeature[][],
  usedPhotoIds: Set<string>,
  strategy: VariationStrategy,
) {
  const requiredCount = template === 'detail_grid' ? 4 : template === 'single' ? 1 : 3;

  for (const group of sameMomentGroups) {
    const available = group.filter((feature) => !usedPhotoIds.has(feature.photo.photoId));
    const ranked = rankTemplateCandidates(template, available, strategy);

    if (ranked.length >= requiredCount) {
      return ranked.slice(0, requiredCount);
    }
  }

  const globalRanked = rankTemplateCandidates(
    template,
    sameMomentGroups.flat().filter((feature) => !usedPhotoIds.has(feature.photo.photoId)),
    strategy,
  );

  return globalRanked.length >= requiredCount ? globalRanked.slice(0, requiredCount) : [];
}

function rankTemplateCandidates(
  template: CarouselSlideTemplate,
  features: PhotoFeature[],
  strategy: VariationStrategy,
) {
  return [...features].sort((left, right) => {
    const leftScore = templateSuitability(template, left, strategy);
    const rightScore = templateSuitability(template, right, strategy);
    return rightScore - leftScore || right.finalScore - left.finalScore;
  });
}

function templateSuitability(template: CarouselSlideTemplate, feature: PhotoFeature, strategy: VariationStrategy) {
  const landscapePreference = feature.orientation === 'landscape' ? 0.32 : feature.orientation === 'square' ? 0.18 : -0.12;
  const detailPreference = feature.sceneLabels.some((label) => ['detail', 'food', 'architecture', 'texture'].includes(label)) ? 0.22 : 0;
  const peoplePreference = feature.faceCount > 0 ? 0.18 : 0;

  if (template === 'vertical_triptych') {
    return feature.finalScore + landscapePreference + (strategy === 'people' ? peoplePreference : 0);
  }

  if (template === 'hero_with_details') {
    return feature.finalScore + (feature.orientation !== 'portrait' ? 0.12 : 0) + peoplePreference + detailPreference * 0.5;
  }

  if (template === 'detail_grid') {
    return feature.finalScore + landscapePreference * 0.7 + detailPreference + (feature.faceCount === 0 ? 0.08 : 0);
  }

  return feature.finalScore;
}

function fillSingleSlides(
  slides: CarouselSlide[],
  workingPool: PhotoFeature[],
  usedPhotoIds: Set<string>,
  maxSlides: number,
) {
  for (const feature of workingPool) {
    if (slides.length >= maxSlides) {
      return;
    }

    if (usedPhotoIds.has(feature.photo.photoId)) {
      continue;
    }

    slides.push(createSlide(
      'single',
      [feature],
      slides.length + 1,
      slides.length >= maxSlides - 2 ? 'Closer' : 'Moment',
      feature.sceneLabels.includes('people') || feature.sceneLabels.includes('group')
        ? 'Keeps the edit social and alive.'
        : 'Adds another distinct scene to the carousel.',
    ));
    usedPhotoIds.add(feature.photo.photoId);
  }
}

function createSlide(
  template: CarouselSlideTemplate,
  features: PhotoFeature[],
  rank: number,
  title: string,
  note: string,
): CarouselSlide {
  return {
    cropHint: slideCropHint(template, features),
    note,
    photoIds: features.map((feature) => feature.photo.photoId),
    rank,
    slideId: `slide-${rank}-${template}`,
    template,
    title,
  };
}

function slideCropHint(template: CarouselSlideTemplate, features: PhotoFeature[]): CropHint {
  if (template === 'vertical_triptych' || template === 'detail_grid') {
    return 'vertical';
  }

  return features[0]?.cropHint ?? 'square';
}

function templateTitle(template: CarouselSlideTemplate) {
  if (template === 'vertical_triptych') {
    return 'Three-frame stack';
  }

  if (template === 'hero_with_details') {
    return 'Hero and details';
  }

  if (template === 'detail_grid') {
    return 'Detail grid';
  }

  return 'Hero';
}

function noteForTemplate(template: CarouselSlideTemplate) {
  if (template === 'vertical_triptych') {
    return 'Uses horizontal-friendly photos in a stacked editorial slide.';
  }

  if (template === 'hero_with_details') {
    return 'Pairs the strongest moment with smaller supporting details.';
  }

  if (template === 'detail_grid') {
    return 'Collects texture, food, architecture, and atmosphere into one slide.';
  }

  return 'Single-photo slide for a clean carousel beat.';
}

function titleForStrategy(strategy: VariationStrategy, title: string) {
  if (strategy === 'people') {
    return `${title}: people`;
  }

  if (strategy === 'atmosphere') {
    return `${title}: atmosphere`;
  }

  return title;
}

function variationLabel(strategy: VariationStrategy) {
  if (strategy === 'people') {
    return 'People And Energy';
  }

  if (strategy === 'atmosphere') {
    return 'Atmosphere And Details';
  }

  return 'The Complete Trip';
}

function variationThesis(strategy: VariationStrategy) {
  if (strategy === 'people') {
    return 'Prioritizes friends, movement, and social energy while keeping enough place context.';
  }

  if (strategy === 'atmosphere') {
    return 'Leans into scenery, food, texture, and quieter visual details.';
  }

  return 'Balances the strongest scenes into a complete trip story.';
}

function variationReasons(strategy: VariationStrategy) {
  if (strategy === 'people') {
    return ['people-forward', 'social energy', 'still varied'];
  }

  if (strategy === 'atmosphere') {
    return ['place-forward', 'detail rich', 'editorial pacing'];
  }

  return ['balanced story', 'scene variety', 'quality-first'];
}

function buildFeedProfile(feedProfile: AnalysisRankRequest['feedProfile']): FeedProfileFeature | undefined {
  if (!feedProfile?.assets.length) {
    return undefined;
  }

  const assets = feedProfile.assets;
  const colors = assets.map((asset) => normalizedColorProfile(asset.colorProfile));
  const embeddings = assets
    .map((asset) => feedAssetEmbedding(asset))
    .filter((embedding): embedding is number[] => Boolean(embedding.length));
  const labels = [...new Set(assets.flatMap((asset) => asset.labels ?? []).map((label) => label.toLowerCase()))];
  const portraitRatio = assets.filter((asset) => {
    if (!asset.width || !asset.height) {
      return false;
    }

    return asset.height > asset.width * 1.12;
  }).length / assets.length;

  return {
    assetCount: assets.length,
    colorProfile: {
      brightness: average(colors.map((color) => color.brightness), 0.56),
      contrast: average(colors.map((color) => color.contrast), 0.58),
      saturation: average(colors.map((color) => color.saturation), 0.55),
      warmth: average(colors.map((color) => color.warmth), 0.52),
    },
    embedding: embeddings.length ? normalizeVector(averageVectors(embeddings)) : undefined,
    feedProfileId: feedProfile.feedProfileId ?? 'feed-profile-current',
    labels,
    portraitRatio,
  };
}

function feedAssetEmbedding(asset: FeedProfileAssetInput) {
  if (asset.embedding?.length) {
    return normalizeVector(asset.embedding);
  }

  const pseudoPhoto: AnalysisPhotoInput = {
    photoId: asset.id,
    height: asset.height ?? 1200,
    labels: asset.labels,
    width: asset.width ?? 1200,
  };
  const colorProfile = normalizedColorProfile(asset.colorProfile);
  return fallbackEmbedding(pseudoPhoto, labelsFor(pseudoPhoto, orientationFor(pseudoPhoto)), colorProfile);
}

function averageVectors(vectors: number[][]) {
  if (!vectors.length) {
    return [];
  }

  const size = Math.max(...vectors.map((vector) => vector.length));
  const sum = Array.from({ length: size }, () => 0);

  for (const vector of vectors) {
    for (let index = 0; index < size; index += 1) {
      sum[index] += vector[index] ?? 0;
    }
  }

  return sum.map((value) => value / vectors.length);
}

function scoreFeedFit(
  projectId: string,
  selectedFeatures: PhotoFeature[],
  feedProfile?: FeedProfileFeature,
) {
  const candidates = selectedFeatures.slice(0, 24).map((feature) => {
    const paletteMatch = feedProfile
      ? colorMatch(feature.colorProfile, feedProfile.colorProfile)
      : clamp(feature.aestheticScore * 0.8);
    const brightnessMatch = feedProfile
      ? 1 - Math.abs(feature.colorProfile.brightness - feedProfile.colorProfile.brightness)
      : clamp(feature.colorProfile.brightness);
    const compositionMatch = feedProfile
      ? compositionMatchFor(feature, feedProfile)
      : cropSuitabilityFor(feature).square;
    const subjectMixFit = feedProfile
      ? subjectMixFitFor(feature, feedProfile)
      : clamp(0.55 + feature.coverageScore * 0.3);
    const noveltyScore = feedProfile?.embedding
      ? clamp(1 - cosineSimilarity(feature.embedding, feedProfile.embedding) * 0.6)
      : clamp(0.5 + feature.coverageScore * 0.35);
    const fitScore = clamp(
      paletteMatch * 0.32 +
        brightnessMatch * 0.18 +
        compositionMatch * 0.17 +
        subjectMixFit * 0.2 +
        noveltyScore * 0.13,
    );

    return {
      brightnessMatch: roundScore(brightnessMatch),
      compositionMatch: roundScore(compositionMatch),
      cropSuitability: cropSuitabilityFor(feature),
      editHint: feedProfile
        ? 'Use as the first carousel slide if you want the post to blend into the grid.'
        : 'Import a feed screenshot or recent posts for a more personal fit score.',
      feedProfileId: feedProfile?.feedProfileId ?? 'feed-profile-default',
      fitScore: roundScore(fitScore),
      label: feedFitLabel(fitScore),
      noveltyScore: roundScore(noveltyScore),
      paletteMatch: roundScore(paletteMatch),
      photoId: feature.photo.photoId,
      previewSlot: 0,
      projectId,
      rank: 0,
      reasons: feedFitReasons(feature, fitScore, paletteMatch, subjectMixFit),
      subjectMixFit: roundScore(subjectMixFit),
    } satisfies FeedPreviewCandidate;
  });

  return candidates
    .sort((left, right) => right.fitScore - left.fitScore)
    .slice(0, 6)
    .map((candidate, index) => ({
      ...candidate,
      previewSlot: index === 0 ? 0 : Math.min(index + 2, 8),
      rank: index + 1,
    }));
}

function colorMatch(left: Required<AnalysisColorProfile>, right: Required<AnalysisColorProfile>) {
  const distance = average([
    Math.abs(left.brightness - right.brightness),
    Math.abs(left.contrast - right.contrast),
    Math.abs(left.saturation - right.saturation),
    Math.abs(left.warmth - right.warmth),
  ], 0.5);
  return clamp(1 - distance * 1.35);
}

function compositionMatchFor(feature: PhotoFeature, feedProfile: FeedProfileFeature) {
  const suitability = cropSuitabilityFor(feature);
  const portraitPreference = feedProfile.portraitRatio;
  return clamp(suitability.square * 0.55 + suitability.vertical * portraitPreference * 0.35 + suitability.landscape * (1 - portraitPreference) * 0.1);
}

function cropSuitabilityFor(feature: PhotoFeature) {
  const square = feature.orientation === 'square' ? 0.95 : feature.orientation === 'portrait' ? 0.82 : 0.72;
  const vertical = feature.orientation === 'portrait' ? 0.95 : feature.orientation === 'square' ? 0.72 : 0.58;
  const landscape = feature.orientation === 'landscape' ? 0.94 : feature.orientation === 'square' ? 0.68 : 0.45;

  return {
    landscape: roundScore(landscape),
    square: roundScore(square),
    vertical: roundScore(vertical),
  };
}

function subjectMixFitFor(feature: PhotoFeature, feedProfile: FeedProfileFeature) {
  if (!feedProfile.labels.length) {
    return feature.coverageScore;
  }

  const overlap = feature.sceneLabels.filter((label) => feedProfile.labels.includes(label)).length;
  return clamp(0.45 + (overlap / Math.max(feature.sceneLabels.length, 1)) * 0.45 + feature.coverageScore * 0.1);
}

function feedFitLabel(fitScore: number): FeedFitLabel {
  if (fitScore >= 0.74) {
    return 'fits';
  }

  if (fitScore >= 0.56) {
    return 'maybe';
  }

  return 'clashes';
}

function feedFitReasons(
  feature: PhotoFeature,
  fitScore: number,
  paletteMatch: number,
  subjectMixFit: number,
) {
  const reasons: string[] = [];

  if (paletteMatch >= 0.75) {
    reasons.push('palette matches the grid');
  }

  if (subjectMixFit >= 0.72) {
    reasons.push('subject matter feels consistent');
  }

  if (feature.cropHint !== 'landscape') {
    reasons.push('safe square crop for profile grid');
  }

  if (fitScore < 0.56) {
    reasons.push('may clash without editing');
  }

  return reasons.length ? reasons.slice(0, 3) : ['balanced feed-fit candidate'];
}

function validateRequest(request: AnalysisRankRequest) {
  if (!request.projectId || typeof request.projectId !== 'string') {
    throw new Error('projectId is required.');
  }

  if (!Array.isArray(request.photos) || request.photos.length === 0) {
    throw new Error('photos must contain at least one photo.');
  }

  for (const photo of request.photos) {
    if (!photo.photoId || typeof photo.photoId !== 'string') {
      throw new Error('each photo requires photoId.');
    }

    if (!Number.isFinite(photo.width) || !Number.isFinite(photo.height) || photo.width <= 0 || photo.height <= 0) {
      throw new Error(`photo ${photo.photoId} requires positive width and height.`);
    }
  }
}

function warningsFor(request: AnalysisRankRequest, features: PhotoFeature[]) {
  const warnings: string[] = [];

  if (request.photos.length < 20) {
    warnings.push('Fewer than 20 photos were provided, so the carousel may be shorter than Instagram maximum length.');
  }

  if (!request.photos.some((photo) => photo.embedding?.length)) {
    warnings.push('No neural embeddings were provided; ranking used deterministic metadata features.');
  }

  if (!request.feedProfile?.assets.length) {
    warnings.push('No feed profile assets were provided; feed-fit scores use a neutral default profile.');
  }

  if (features.filter((feature) => feature.orientation === 'landscape').length < 3) {
    warnings.push('Few landscape photos were available, so layered templates may use square or portrait fallbacks.');
  }

  return warnings;
}

export function analyzeTripPhotos(request: AnalysisRankRequest): RankingResult {
  validateRequest(request);

  const generatedAt = new Date().toISOString();
  const topPoolSize = Math.min(Math.max(request.options?.topPoolSize ?? DEFAULT_TOP_POOL_SIZE, 1), 100);
  const carouselMaxSlides = Math.min(Math.max(request.options?.carouselMaxSlides ?? DEFAULT_CAROUSEL_MAX_SLIDES, 1), 20);
  const variationCount = Math.min(Math.max(request.options?.variationCount ?? DEFAULT_VARIATION_COUNT, 1), 3);
  const features = createFeatures(request.photos);
  const duplicateGroups = detectDuplicates(features, request.projectId, generatedAt);
  const selectedFeatures = selectDiverseFeatures(features, topPoolSize);
  const feedProfile = buildFeedProfile(request.feedProfile);
  const topPicks = rankedPicksFor(selectedFeatures);

  return {
    carouselVariations: composeCarouselVariations(selectedFeatures, variationCount, carouselMaxSlides),
    duplicateGroups,
    feedPreviewCandidates: scoreFeedFit(request.projectId, selectedFeatures, feedProfile),
    generatedAt,
    jobId: request.jobId ?? `analysis-${request.projectId}`,
    modelVersion: MODEL_VERSION,
    photoScores: photoScoresFor(features),
    projectId: request.projectId,
    resultId: `result-${request.projectId}-${Date.parse(generatedAt)}`,
    topPicks,
    warnings: warningsFor(request, features),
  };
}
