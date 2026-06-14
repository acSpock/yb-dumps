import { readFile } from 'node:fs/promises';

import {
  AnalysisColorProfile,
  AnalysisPhotoInput,
  AnalysisQualitySignals,
} from './analysisContracts.js';
import { Config } from './config.js';

export type GpuFeatureAsset = {
  imagePath: string;
  mimeType?: string;
  photo: AnalysisPhotoInput;
};

export type GpuFeature = {
  photoId: string;
  embedding?: number[];
  visualEmbedding?: number[];
  aestheticScore?: number;
  modelLabels?: string[];
  modelQualitySignals?: AnalysisQualitySignals;
  colorProfile?: AnalysisColorProfile;
  modelProvider?: string;
  modelVersion?: string;
};

export type GpuFeatureClient = {
  analyzeBatch(input: {
    assets: GpuFeatureAsset[];
    jobId: string;
    projectId: string;
  }): Promise<GpuFeature[]>;
  provider: string;
};

type RawGpuFeatureResponse = {
  features?: unknown;
  modelProvider?: unknown;
  modelVersion?: unknown;
};

function finiteNumber(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function numericVector(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const vector = value.map((item) => finiteNumber(item) ?? 0);
  return vector.length ? vector : undefined;
}

function stringList(value: unknown) {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const labels = value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim().toLowerCase())
    .filter(Boolean);

  return labels.length ? [...new Set(labels)] : undefined;
}

function numberRecord<T extends Record<string, number | undefined>>(value: unknown, keys: Array<keyof T>) {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const target: Record<string, number> = {};

  for (const key of keys) {
    const numberValue = finiteNumber(source[String(key)]);

    if (numberValue !== undefined) {
      target[String(key)] = numberValue;
    }
  }

  return Object.keys(target).length ? target as T : undefined;
}

function normalizeGpuFeature(value: unknown, defaults: {
  modelProvider?: string;
  modelVersion?: string;
}): GpuFeature | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }

  const source = value as Record<string, unknown>;
  const photoId = typeof source.photoId === 'string' ? source.photoId : '';

  if (!photoId) {
    return undefined;
  }

  return {
    aestheticScore: finiteNumber(source.aestheticScore),
    colorProfile: numberRecord<AnalysisColorProfile>(source.colorProfile, ['brightness', 'contrast', 'saturation', 'warmth']),
    embedding: numericVector(source.embedding),
    modelLabels: stringList(source.modelLabels),
    modelProvider: typeof source.modelProvider === 'string' ? source.modelProvider : defaults.modelProvider,
    modelQualitySignals: numberRecord<AnalysisQualitySignals>(source.modelQualitySignals, [
      'contrast',
      'exposure',
      'faceCount',
      'noise',
      'sharpness',
      'subjectCentered',
    ]),
    modelVersion: typeof source.modelVersion === 'string' ? source.modelVersion : defaults.modelVersion,
    photoId,
    visualEmbedding: numericVector(source.visualEmbedding),
  };
}

async function encodeAsset(asset: GpuFeatureAsset) {
  return {
    capturedAt: asset.photo.capturedAt,
    height: asset.photo.height,
    imageBase64: (await readFile(asset.imagePath)).toString('base64'),
    labels: asset.photo.labels,
    mimeType: asset.mimeType ?? 'image/jpeg',
    modelLabels: asset.photo.modelLabels,
    photoId: asset.photo.photoId,
    width: asset.photo.width,
  };
}

function chunks<T>(items: T[], size: number) {
  const safeSize = Math.max(1, size);
  const result: T[][] = [];

  for (let index = 0; index < items.length; index += safeSize) {
    result.push(items.slice(index, index + safeSize));
  }

  return result;
}

export function createGpuFeatureClient(config: Config): GpuFeatureClient | undefined {
  const endpoint = config.gpuFeaturesUrl?.trim();

  if (!endpoint) {
    return undefined;
  }

  const batchSize = Number.isFinite(config.gpuBatchSize) ? Math.max(1, config.gpuBatchSize) : 24;
  const timeoutMs = Number.isFinite(config.gpuTimeoutMs) ? Math.max(1000, config.gpuTimeoutMs) : 120000;

  return {
    provider: 'http-gpu-features',
    async analyzeBatch(input) {
      const allFeatures: GpuFeature[] = [];

      for (const batch of chunks(input.assets, batchSize)) {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), timeoutMs);

        try {
          const response = await fetch(endpoint, {
            body: JSON.stringify({
              assets: await Promise.all(batch.map(encodeAsset)),
              jobId: input.jobId,
              projectId: input.projectId,
            }),
            headers: {
              'content-type': 'application/json',
              ...(config.gpuFeaturesToken ? { authorization: `Bearer ${config.gpuFeaturesToken}` } : {}),
            },
            method: 'POST',
            signal: controller.signal,
          });
          const text = await response.text();
          const body = text ? JSON.parse(text) as RawGpuFeatureResponse : {};

          if (!response.ok) {
            throw new Error(`GPU feature endpoint returned ${response.status}: ${text.slice(0, 240)}`);
          }

          const rawFeatures = Array.isArray(body.features) ? body.features : [];
          const normalizedFeatures = rawFeatures
            .map((feature) => normalizeGpuFeature(feature, {
              modelProvider: typeof body.modelProvider === 'string' ? body.modelProvider : 'gpu-worker',
              modelVersion: typeof body.modelVersion === 'string' ? body.modelVersion : undefined,
            }))
            .filter((feature): feature is GpuFeature => Boolean(feature));

          allFeatures.push(...normalizedFeatures);
        } finally {
          clearTimeout(timeout);
        }
      }

      return allFeatures;
    },
  };
}

export function mergeGpuFeature(photo: AnalysisPhotoInput, feature: GpuFeature): AnalysisPhotoInput {
  return {
    ...photo,
    aestheticScore: feature.aestheticScore ?? photo.aestheticScore,
    colorProfile: {
      ...photo.colorProfile,
      ...feature.colorProfile,
    },
    embedding: feature.embedding ?? photo.embedding,
    modelLabels: [...new Set([...(photo.modelLabels ?? []), ...(feature.modelLabels ?? [])])],
    modelProvider: feature.modelProvider ?? feature.modelVersion ?? 'gpu-worker',
    modelQualitySignals: {
      ...photo.modelQualitySignals,
      ...feature.modelQualitySignals,
    },
    modelSource: 'gpu',
    visualEmbedding: feature.visualEmbedding ?? photo.visualEmbedding,
  };
}
