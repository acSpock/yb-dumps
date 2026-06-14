import {
  FeedImportState,
  RankingResult,
  TripPhoto,
} from '../types';
import { API_BASE_URL, InstagramApiError } from './instagramApi';

type AnalysisColorProfile = {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  warmth?: number;
};

type AnalysisPhotoInput = {
  photoId: string;
  projectId: string;
  sourceAssetId: string;
  width: number;
  height: number;
  capturedAt?: string;
  momentId: string;
  peopleIds: string[];
  labels: string[];
  colorProfile: AnalysisColorProfile;
  qualitySignals: {
    exposure: number;
    faceCount: number;
    sharpness: number;
    subjectCentered: number;
  };
};

type FeedProfileAssetInput = {
  id: string;
  width?: number;
  height?: number;
  labels: string[];
  colorProfile: AnalysisColorProfile;
};

const labelsByMoment: Record<string, string[]> = {
  arrival: ['transit', 'city', 'context'],
  coast: ['beach', 'landscape', 'sun'],
  departure: ['closer', 'travel', 'memory'],
  friends: ['people', 'portrait', 'group'],
  'golden-hour': ['light', 'opener', 'place'],
  market: ['food', 'detail', 'color'],
  night: ['dinner', 'night', 'mood'],
};

function hashString(value: string) {
  let hash = 2166136261;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }

  return hash >>> 0;
}

function normalizedSeed(value: string, offset: number) {
  return ((hashString(`${value}-${offset}`) % 1000) / 1000);
}

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function labelsForPhoto(photo: TripPhoto) {
  const labels = new Set(labelsByMoment[photo.momentId] ?? ['trip']);

  if (photo.peopleIds.length > 0) {
    labels.add(photo.peopleIds.length >= 3 ? 'group' : 'people');
  }

  if (photo.width > photo.height * 1.12) {
    labels.add('landscape');
  } else if (photo.height > photo.width * 1.12) {
    labels.add('portrait');
  }

  return [...labels];
}

function colorProfileForPhoto(photo: TripPhoto): AnalysisColorProfile {
  const labels = labelsForPhoto(photo);
  const seed = normalizedSeed(photo.photoId, 1);
  const warmMoment = labels.some((label) => ['beach', 'sun', 'light', 'dinner', 'food'].includes(label));
  const nightMoment = labels.includes('night');

  return {
    brightness: clamp((nightMoment ? 0.42 : 0.56) + seed * 0.14),
    contrast: clamp(0.5 + normalizedSeed(photo.photoId, 2) * 0.18),
    saturation: clamp(0.48 + normalizedSeed(photo.photoId, 3) * 0.2),
    warmth: clamp((warmMoment ? 0.66 : 0.5) + normalizedSeed(photo.photoId, 4) * 0.14),
  };
}

function qualitySignalsForPhoto(photo: TripPhoto) {
  const megapixels = (photo.width * photo.height) / 1_000_000;
  const resolutionSignal = clamp(megapixels / 8, 0.45, 0.95);

  return {
    exposure: clamp(0.66 + normalizedSeed(photo.photoId, 5) * 0.22),
    faceCount: photo.peopleIds.length,
    sharpness: clamp(resolutionSignal * 0.65 + normalizedSeed(photo.photoId, 6) * 0.28),
    subjectCentered: clamp(0.62 + normalizedSeed(photo.photoId, 7) * 0.26),
  };
}

function sourceAssetIdForPhoto(photo: TripPhoto) {
  const sourceAssetId = photo.sourceAssetId.trim();

  if (sourceAssetId && !sourceAssetId.startsWith('picked-asset-')) {
    return sourceAssetId;
  }

  const localSource = [
    photo.localUri,
    photo.thumbnailUri,
    photo.originalFilename,
    photo.width,
    photo.height,
  ]
    .filter(Boolean)
    .join('|');

  return localSource ? `local-${hashString(localSource).toString(36)}` : sourceAssetId;
}

function photoInput(photo: TripPhoto): AnalysisPhotoInput {
  return {
    capturedAt: photo.capturedAt,
    colorProfile: colorProfileForPhoto(photo),
    height: photo.height,
    labels: labelsForPhoto(photo),
    momentId: photo.momentId,
    peopleIds: photo.peopleIds,
    photoId: photo.photoId,
    projectId: photo.projectId,
    qualitySignals: qualitySignalsForPhoto(photo),
    sourceAssetId: sourceAssetIdForPhoto(photo),
    width: photo.width,
  };
}

function feedAssetInput(asset: FeedImportState['assets'][number], index: number): FeedProfileAssetInput {
  const portrait = (asset.height ?? 1) > (asset.width ?? 1);

  return {
    colorProfile: {
      brightness: clamp(0.55 + normalizedSeed(asset.id, 1) * 0.12),
      contrast: clamp(0.5 + normalizedSeed(asset.id, 2) * 0.16),
      saturation: clamp(0.48 + normalizedSeed(asset.id, 3) * 0.16),
      warmth: clamp(0.56 + normalizedSeed(asset.id, 4) * 0.18),
    },
    height: asset.height,
    id: asset.id,
    labels: portrait ? ['portrait', 'people'] : index % 2 === 0 ? ['place'] : ['detail'],
    width: asset.width,
  };
}

export async function rankTripPhotos(input: {
  feedImport?: FeedImportState;
  jobId: string;
  photos: TripPhoto[];
  projectId: string;
}): Promise<RankingResult> {
  const response = await fetch(`${API_BASE_URL}/analysis/rank`, {
    body: JSON.stringify({
      feedProfile: input.feedImport?.assets.length
        ? {
          assets: input.feedImport.assets.map(feedAssetInput),
          feedProfileId: `${input.projectId}-feed-profile`,
        }
        : undefined,
      jobId: input.jobId,
      options: {
        carouselMaxSlides: 20,
        topPoolSize: 50,
        variationCount: 3,
      },
      photos: input.photos.map(photoInput),
      projectId: input.projectId,
    }),
    headers: {
      'content-type': 'application/json',
    },
    method: 'POST',
  });
  const text = await response.text();
  const body = text ? JSON.parse(text) as RankingResult & { message?: string; error?: string } : {} as RankingResult & { message?: string; error?: string };

  if (!response.ok) {
    throw new InstagramApiError(body.message ?? body.error ?? 'Analysis request failed.', response.status);
  }

  return body;
}
