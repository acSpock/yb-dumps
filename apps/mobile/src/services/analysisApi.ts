import * as ImageManipulator from 'expo-image-manipulator';

import {
  FeedImportState,
  AnalysisJob,
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

type AnalysisJobResponse = Omit<AnalysisJob, 'stage'> & {
  stage: AnalysisJob['stage'] | 'created' | 'uploads' | 'cpu_vision' | 'cleanup';
};

type AnalysisJobStartResponse = {
  job: AnalysisJobResponse;
  result?: RankingResult;
};

export type CpuAnalysisResponse = {
  job: AnalysisJobResponse;
  result: RankingResult;
  uploadedAssetCount: number;
  usedCpuVision: boolean;
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

function analysisRequestBody(input: {
  feedImport?: FeedImportState;
  jobId: string;
  photos: TripPhoto[];
  projectId: string;
}) {
  return {
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
  };
}

function jsonBody<T>(text: string) {
  return text ? JSON.parse(text) as T & { message?: string; error?: string } : {} as T & { message?: string; error?: string };
}

async function fetchJson<T>(path: string, init?: RequestInit) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await response.text();
  const body = jsonBody<T>(text);

  if (!response.ok) {
    throw new InstagramApiError(body.message ?? body.error ?? 'Analysis request failed.', response.status);
  }

  return body;
}

function uploadableUriForPhoto(photo: TripPhoto) {
  const uri = photo.localUri ?? photo.thumbnailUri ?? '';

  if (
    uri.startsWith('file://') ||
    uri.startsWith('ph://') ||
    uri.startsWith('assets-library://') ||
    uri.startsWith('data:image/')
  ) {
    return uri;
  }

  return '';
}

function resizeActionForPhoto(photo: TripPhoto): ImageManipulator.Action[] {
  const maxDimension = Math.max(photo.width, photo.height);

  if (maxDimension <= 1024) {
    return [];
  }

  if (photo.width >= photo.height) {
    return [{ resize: { width: 1024 } }];
  }

  return [{ resize: { height: 1024 } }];
}

async function createAnalysisCopy(photo: TripPhoto) {
  const uri = uploadableUriForPhoto(photo);

  if (!uri) {
    return undefined;
  }

  const result = await ImageManipulator.manipulateAsync(
    uri,
    resizeActionForPhoto(photo),
    {
      base64: true,
      compress: 0.72,
      format: ImageManipulator.SaveFormat.JPEG,
    },
  );

  if (!result.base64) {
    throw new Error(`Could not create analysis copy for ${photo.originalFilename ?? photo.photoId}.`);
  }

  return {
    base64: result.base64,
    mimeType: 'image/jpeg',
  };
}

async function uploadAnalysisAsset(jobId: string, photo: TripPhoto) {
  const analysisCopy = await createAnalysisCopy(photo);

  if (!analysisCopy) {
    return false;
  }

  await fetchJson<AnalysisJobResponse>(`/analysis/jobs/${encodeURIComponent(jobId)}/assets`, {
    body: JSON.stringify({
      imageBase64: analysisCopy.base64,
      mimeType: analysisCopy.mimeType,
      photoId: photo.photoId,
    }),
    method: 'POST',
  });

  return true;
}

export async function rankTripPhotos(input: {
  feedImport?: FeedImportState;
  jobId: string;
  photos: TripPhoto[];
  projectId: string;
}): Promise<RankingResult> {
  return fetchJson<RankingResult>('/analysis/rank', {
    body: JSON.stringify(analysisRequestBody(input)),
    method: 'POST',
  });
}

export async function rankTripPhotosWithCpuJob(input: {
  feedImport?: FeedImportState;
  jobId: string;
  photos: TripPhoto[];
  projectId: string;
}): Promise<CpuAnalysisResponse> {
  const job = await fetchJson<AnalysisJobResponse>('/analysis/jobs', {
    body: JSON.stringify(analysisRequestBody(input)),
    method: 'POST',
  });
  let uploadedAssetCount = 0;

  for (const photo of input.photos) {
    try {
      if (await uploadAnalysisAsset(job.jobId, photo)) {
        uploadedAssetCount += 1;
      }
    } catch {
      // Keep the batch moving; the API will rank this photo from metadata if its analysis copy failed.
    }
  }

  const started = await fetchJson<AnalysisJobStartResponse>(`/analysis/jobs/${encodeURIComponent(job.jobId)}/start`, {
    body: JSON.stringify({}),
    method: 'POST',
  });

  if (started.result) {
    return {
      job: started.job,
      result: started.result,
      uploadedAssetCount,
      usedCpuVision: started.result.modelVersion.startsWith('cpu-vision'),
    };
  }

  const result = await fetchJson<RankingResult>(`/analysis/jobs/${encodeURIComponent(job.jobId)}/result`);

  return {
    job: started.job,
    result,
    uploadedAssetCount,
    usedCpuVision: result.modelVersion.startsWith('cpu-vision'),
  };
}
