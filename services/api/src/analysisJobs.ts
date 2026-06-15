import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AnalysisDebugPickSummary,
  AnalysisDebugTrace,
  AnalysisPhotoInput,
  AnalysisRankRequest,
  FeedProfileInput,
  RankingResult,
} from './analysisContracts.js';
import { analyzeImageAsset } from './cpuVision.js';
import {
  GpuFeature,
  GpuFeatureAsset,
  GpuFeatureClient,
  mergeGpuFeature,
} from './gpuFeatures.js';
import { analyzeTripPhotos } from './modelRanker.js';

export type AnalysisJobStatus =
  | 'created'
  | 'awaiting_uploads'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed';

export type AnalysisJobStage =
  | 'created'
  | 'uploads'
  | 'cpu_vision'
  | 'gpu_vision'
  | 'ranking'
  | 'cleanup'
  | 'complete';

export type PublicAnalysisJob = {
  jobId: string;
  projectId: string;
  status: AnalysisJobStatus;
  stage: AnalysisJobStage;
  progress: number;
  assetCount: number;
  uploadedAssetCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  resultId?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
};

type StoredAnalysisJob = PublicAnalysisJob & {
  feedProfile?: FeedProfileInput;
  options?: AnalysisRankRequest['options'];
  photos: AnalysisPhotoInput[];
  result?: RankingResult;
};

type CreateAnalysisJobInput = {
  feedProfile?: FeedProfileInput;
  jobId?: string;
  options?: AnalysisRankRequest['options'];
  photos: AnalysisPhotoInput[];
  projectId: string;
};

type SaveAssetInput = {
  imageBase64: string;
  mimeType?: string;
  photoId: string;
};

export type AnalysisJobService = ReturnType<typeof createAnalysisJobService>;

type AnalysisJobServiceOptions = {
  gpuCandidateLimit?: number;
  gpuClient?: GpuFeatureClient;
};

type GpuDebugTrace = NonNullable<AnalysisDebugTrace['gpu']>;

type GpuEnrichmentResult = {
  debug: GpuDebugTrace;
  gpuAnalyzedAssetCount: number;
  gpuFeatureCount: number;
  photos: AnalysisPhotoInput[];
};

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
}

function nowIso() {
  return new Date().toISOString();
}

function logAnalysisJob(event: string, fields: Record<string, unknown>) {
  console.log(JSON.stringify({
    at: new Date().toISOString(),
    event,
    ...fields,
  }));
}

function publicJob(job: StoredAnalysisJob): PublicAnalysisJob {
  return {
    assetCount: job.assetCount,
    completedAt: job.completedAt,
    createdAt: job.createdAt,
    error: job.error,
    jobId: job.jobId,
    progress: job.progress,
    projectId: job.projectId,
    resultId: job.resultId,
    stage: job.stage,
    startedAt: job.startedAt,
    status: job.status,
    updatedAt: job.updatedAt,
    uploadedAssetCount: job.uploadedAssetCount,
  };
}

function fileExtensionForMimeType(mimeType?: string) {
  if (mimeType === 'image/png') {
    return 'png';
  }

  if (mimeType === 'image/webp') {
    return 'webp';
  }

  return 'jpg';
}

function parseDataUrl(value: string) {
  const match = /^data:(?<mimeType>[^;]+);base64,(?<data>.+)$/s.exec(value);

  if (!match?.groups) {
    return {
      base64: value,
      mimeType: undefined,
    };
  }

  return {
    base64: match.groups.data,
    mimeType: match.groups.mimeType,
  };
}

function validatePhotos(photos: unknown): AnalysisPhotoInput[] {
  if (!Array.isArray(photos) || photos.length === 0) {
    throw new Error('photos must contain at least one photo.');
  }

  return photos as AnalysisPhotoInput[];
}

function roundDebugNumber(value: number | undefined) {
  return Number.isFinite(value) ? Math.round((value ?? 0) * 1000) / 1000 : undefined;
}

function debugPicksFromResult(result: RankingResult, limit = 20): AnalysisDebugPickSummary[] {
  return result.debugTrace?.final.topPicks.slice(0, limit) ?? result.topPicks.slice(0, limit).map((pick) => ({
    finalScore: roundDebugNumber(pick.finalScore),
    photoId: pick.photoId,
    rank: pick.rank,
    reasons: pick.reasons,
  }));
}

function debugFeatureSummary(feature: GpuFeature): AnalysisDebugPickSummary {
  return {
    aestheticScore: roundDebugNumber(feature.aestheticScore),
    modelLabels: feature.modelLabels?.slice(0, 8),
    modelProvider: feature.modelProvider ?? feature.modelVersion,
    modelSource: 'gpu',
    photoId: feature.photoId,
    qualityFlags: [
      feature.modelQualitySignals?.sharpness !== undefined ? `sharpness ${roundDebugNumber(feature.modelQualitySignals.sharpness)}` : undefined,
      feature.modelQualitySignals?.exposure !== undefined ? `exposure ${roundDebugNumber(feature.modelQualitySignals.exposure)}` : undefined,
    ].filter((value): value is string => Boolean(value)),
  };
}

function attachPipelineDebugTrace(input: {
  analyzedAssetCount: number;
  finalResult: RankingResult;
  gpuDebug: GpuDebugTrace;
  preliminaryResult: RankingResult;
  uploadedAssetCount: number;
}) {
  const finalTrace = input.finalResult.debugTrace;

  input.finalResult.debugTrace = {
    ...finalTrace,
    cpu: {
      analyzedAssetCount: input.analyzedAssetCount,
      preselectCandidateCount: input.preliminaryResult.topPicks.length,
      preselectTopPicks: debugPicksFromResult(input.preliminaryResult, 20),
      uploadedAssetCount: input.uploadedAssetCount,
    },
    final: finalTrace?.final ?? {
      carouselSlides: [],
      duplicateGroups: input.finalResult.duplicateGroups,
      topPicks: debugPicksFromResult(input.finalResult, 20),
      warnings: input.finalResult.warnings,
    },
    gpu: input.gpuDebug,
    input: finalTrace?.input ?? {
      feedAssetCount: 0,
      photoCount: input.finalResult.photoScores.length,
    },
    pipeline: input.analyzedAssetCount > 0
      ? input.gpuDebug.status === 'completed' ? 'cpu-gpu' : 'cpu-only'
      : 'metadata-only',
  };
}

export function createAnalysisJobService(dataDir: string, options: AnalysisJobServiceOptions = {}) {
  const rootDir = path.resolve(dataDir);
  const gpuCandidateLimit = Math.max(0, options.gpuCandidateLimit ?? 240);

  function jobDir(jobId: string) {
    return path.join(rootDir, safeSegment(jobId));
  }

  function jobFile(jobId: string) {
    return path.join(jobDir(jobId), 'job.json');
  }

  function assetDir(jobId: string) {
    return path.join(jobDir(jobId), 'assets');
  }

  function assetPath(jobId: string, photoId: string, extension = 'jpg') {
    return path.join(assetDir(jobId), `${safeSegment(photoId)}.${extension}`);
  }

  async function ensureJobRoot(jobId: string) {
    await mkdir(assetDir(jobId), { recursive: true });
  }

  async function saveJob(job: StoredAnalysisJob) {
    await mkdir(jobDir(job.jobId), { recursive: true });
    await writeFile(jobFile(job.jobId), `${JSON.stringify(job, null, 2)}\n`, 'utf8');
  }

  async function readJob(jobId: string): Promise<StoredAnalysisJob> {
    const rawJob = await readFile(jobFile(jobId), 'utf8');
    return JSON.parse(rawJob) as StoredAnalysisJob;
  }

  async function removeAssets(jobId: string) {
    await rm(assetDir(jobId), { force: true, recursive: true });
  }

  async function createJob(input: CreateAnalysisJobInput) {
    const createdAt = nowIso();
    const photos = validatePhotos(input.photos);
    const job: StoredAnalysisJob = {
      assetCount: photos.length,
      createdAt,
      feedProfile: input.feedProfile,
      jobId: input.jobId ? safeSegment(input.jobId) : `analysis-${randomUUID()}`,
      options: input.options,
      photos,
      progress: 0.05,
      projectId: input.projectId,
      stage: 'uploads',
      status: 'awaiting_uploads',
      updatedAt: createdAt,
      uploadedAssetCount: 0,
    };

    await saveJob(job);
    logAnalysisJob('analysis.job.created', {
      assetCount: job.assetCount,
      jobId: job.jobId,
      projectId: job.projectId,
    });
    return publicJob(job);
  }

  async function saveAsset(jobId: string, input: SaveAssetInput) {
    const job = await readJob(jobId);
    const photo = job.photos.find((item) => item.photoId === input.photoId);

    if (!photo) {
      throw new Error(`photo ${input.photoId} does not belong to job ${jobId}.`);
    }

    const parsed = parseDataUrl(input.imageBase64);
    const extension = fileExtensionForMimeType(input.mimeType ?? parsed.mimeType);
    const buffer = Buffer.from(parsed.base64, 'base64');

    await ensureJobRoot(jobId);
    await writeFile(assetPath(jobId, input.photoId, extension), buffer);

    const uploadedPhotoIds = new Set<string>();

    for (const candidate of job.photos) {
      for (const candidateExtension of ['jpg', 'png', 'webp']) {
        try {
          await readFile(assetPath(jobId, candidate.photoId, candidateExtension));
          uploadedPhotoIds.add(candidate.photoId);
          break;
        } catch {
          // Missing files are expected while upload is still in progress.
        }
      }
    }

    job.uploadedAssetCount = uploadedPhotoIds.size;
    job.progress = Math.max(job.progress, 0.12 + Math.min(0.28, job.uploadedAssetCount / Math.max(job.assetCount, 1) * 0.28));
    job.status = job.uploadedAssetCount >= job.assetCount ? 'queued' : 'awaiting_uploads';
    job.stage = 'uploads';
    job.updatedAt = nowIso();
    await saveJob(job);
    logAnalysisJob('analysis.asset.uploaded', {
      assetCount: job.assetCount,
      jobId: job.jobId,
      mimeType: input.mimeType ?? parsed.mimeType ?? 'unknown',
      photoId: input.photoId,
      projectId: job.projectId,
      uploadedAssetCount: job.uploadedAssetCount,
    });

    return publicJob(job);
  }

  async function findAssetPath(jobId: string, photoId: string) {
    for (const extension of ['jpg', 'png', 'webp']) {
      const candidate = assetPath(jobId, photoId, extension);

      try {
        await readFile(candidate);
        return candidate;
      } catch {
        // Continue to the next supported extension.
      }
    }

    return undefined;
  }

  async function gpuCandidateAssets(job: StoredAnalysisJob, photos: AnalysisPhotoInput[], preliminaryResult: RankingResult): Promise<GpuFeatureAsset[]> {
    if (!options.gpuClient || gpuCandidateLimit <= 0) {
      return [];
    }

    const candidateIds = new Set(preliminaryResult.topPicks.slice(0, gpuCandidateLimit).map((pick) => pick.photoId));
    const candidates: GpuFeatureAsset[] = [];

    for (const photo of photos) {
      if (!candidateIds.has(photo.photoId)) {
        continue;
      }

      const imagePath = await findAssetPath(job.jobId, photo.photoId);

      if (imagePath) {
        candidates.push({
          imagePath,
          mimeType: 'image/jpeg',
          photo,
        });
      }
    }

    return candidates;
  }

  async function enrichWithGpuFeatures(job: StoredAnalysisJob, photos: AnalysisPhotoInput[], preliminaryResult: RankingResult): Promise<GpuEnrichmentResult> {
    if (!options.gpuClient) {
      return {
        debug: {
          enabled: false,
          status: 'not_configured',
        },
        gpuAnalyzedAssetCount: 0,
        gpuFeatureCount: 0,
        photos,
      };
    }

    const assets = await gpuCandidateAssets(job, photos, preliminaryResult);

    if (!assets.length) {
      logAnalysisJob('analysis.gpu.skipped', {
        jobId: job.jobId,
        projectId: job.projectId,
        reason: 'no_uploaded_candidate_assets',
      });

      return {
        debug: {
          candidateLimit: gpuCandidateLimit,
          enabled: true,
          provider: options.gpuClient.provider,
          status: 'skipped',
        },
        gpuAnalyzedAssetCount: 0,
        gpuFeatureCount: 0,
        photos,
      };
    }

    job.stage = 'gpu_vision';
    job.progress = Math.max(job.progress, 0.74);
    job.updatedAt = nowIso();
    await saveJob(job);
    logAnalysisJob('analysis.gpu.started', {
      candidateAssetCount: assets.length,
      candidateLimit: gpuCandidateLimit,
      jobId: job.jobId,
      projectId: job.projectId,
      provider: options.gpuClient.provider,
    });

    try {
      const features = await options.gpuClient.analyzeBatch({
        assets,
        jobId: job.jobId,
        projectId: job.projectId,
      });
      const featuresByPhotoId = new Map(features.map((feature) => [feature.photoId, feature]));
      const nextPhotos = photos.map((photo) => {
        const feature = featuresByPhotoId.get(photo.photoId);
        return feature ? mergeGpuFeature(photo, feature) : photo;
      });

      job.progress = Math.max(job.progress, 0.82);
      job.updatedAt = nowIso();
      await saveJob(job);
      logAnalysisJob('analysis.gpu.completed', {
        candidateAssetCount: assets.length,
        featureCount: features.length,
        jobId: job.jobId,
        projectId: job.projectId,
        provider: options.gpuClient.provider,
      });

      return {
        debug: {
          candidateCount: assets.length,
          candidateLimit: gpuCandidateLimit,
          candidatePhotoIds: assets.map((asset) => asset.photo.photoId),
          enabled: true,
          provider: options.gpuClient.provider,
          returnedFeatureCount: features.length,
          returnedFeatures: features.slice(0, 20).map(debugFeatureSummary),
          status: 'completed',
        },
        gpuAnalyzedAssetCount: assets.length,
        gpuFeatureCount: features.length,
        photos: nextPhotos,
      };
    } catch (error) {
      logAnalysisJob('analysis.gpu.failed', {
        candidateAssetCount: assets.length,
        error: error instanceof Error ? error.message : 'GPU feature extraction failed.',
        jobId: job.jobId,
        projectId: job.projectId,
        provider: options.gpuClient.provider,
      });

      return {
        debug: {
          candidateCount: assets.length,
          candidateLimit: gpuCandidateLimit,
          candidatePhotoIds: assets.map((asset) => asset.photo.photoId),
          enabled: true,
          error: error instanceof Error ? error.message : 'GPU feature extraction failed.',
          provider: options.gpuClient.provider,
          status: 'failed',
        },
        gpuAnalyzedAssetCount: 0,
        gpuFeatureCount: 0,
        photos,
      };
    }
  }

  async function startJob(jobId: string) {
    const job = await readJob(jobId);
    const startedAt = nowIso();

    job.startedAt = job.startedAt ?? startedAt;
    job.status = 'running';
    job.stage = 'cpu_vision';
    job.progress = Math.max(job.progress, 0.35);
    job.updatedAt = startedAt;
    await saveJob(job);
    logAnalysisJob('analysis.job.started', {
      assetCount: job.assetCount,
      jobId,
      projectId: job.projectId,
      uploadedAssetCount: job.uploadedAssetCount,
    });

    try {
      let enrichedPhotos: AnalysisPhotoInput[] = [];
      let analyzedAssetCount = 0;

      for (const [index, photo] of job.photos.entries()) {
        const imagePath = await findAssetPath(jobId, photo.photoId);
        const enrichedPhoto = imagePath
          ? await analyzeImageAsset({ imagePath, photo })
          : photo;

        if (imagePath) {
          analyzedAssetCount += 1;
        }

        enrichedPhotos.push(enrichedPhoto);
        job.progress = 0.35 + ((index + 1) / Math.max(job.photos.length, 1)) * 0.38;
        job.updatedAt = nowIso();
        await saveJob(job);
      }

      const preliminaryResult = analyzeTripPhotos({
        feedProfile: job.feedProfile,
        jobId: `${job.jobId}-cpu-preselect`,
        options: {
          ...job.options,
          topPoolSize: Math.max(gpuCandidateLimit, job.options?.topPoolSize ?? 0),
        },
        photos: enrichedPhotos,
        projectId: job.projectId,
      });

      const gpuResult = await enrichWithGpuFeatures(job, enrichedPhotos, preliminaryResult);
      enrichedPhotos = gpuResult.photos;

      job.stage = 'ranking';
      job.progress = 0.82;
      job.updatedAt = nowIso();
      await saveJob(job);

      const result = analyzeTripPhotos({
        feedProfile: job.feedProfile,
        jobId: job.jobId,
        options: job.options,
        photos: enrichedPhotos,
        projectId: job.projectId,
      });
      attachPipelineDebugTrace({
        analyzedAssetCount,
        finalResult: result,
        gpuDebug: gpuResult.debug,
        preliminaryResult,
        uploadedAssetCount: job.uploadedAssetCount,
      });

      job.result = result;
      job.resultId = result.resultId;
      job.stage = 'cleanup';
      job.progress = 0.94;
      job.updatedAt = nowIso();
      await saveJob(job);
      await removeAssets(jobId);

      job.completedAt = result.generatedAt;
      job.stage = 'complete';
      job.status = 'succeeded';
      job.progress = 1;
      job.updatedAt = result.generatedAt;
      await saveJob(job);
      logAnalysisJob('analysis.job.completed', {
        analyzedAssetCount,
        gpuAnalyzedAssetCount: gpuResult.gpuAnalyzedAssetCount,
        gpuFeatureCount: gpuResult.gpuFeatureCount,
        jobId,
        modelVersion: result.modelVersion,
        projectId: job.projectId,
        resultId: result.resultId,
        topPickCount: result.topPicks.length,
        uploadedAssetCount: job.uploadedAssetCount,
      });

      return {
        job: publicJob(job),
        result,
      };
    } catch (error) {
      const completedAt = nowIso();
      await removeAssets(jobId);
      job.completedAt = completedAt;
      job.error = {
        code: 'analysis_failed',
        message: error instanceof Error ? error.message : 'CPU analysis failed.',
        retryable: true,
      };
      job.progress = Math.max(job.progress, 0.2);
      job.stage = 'complete';
      job.status = 'failed';
      job.updatedAt = completedAt;
      await saveJob(job);
      logAnalysisJob('analysis.job.failed', {
        error: job.error.message,
        jobId,
        projectId: job.projectId,
        uploadedAssetCount: job.uploadedAssetCount,
      });
      throw error;
    }
  }

  async function getJob(jobId: string) {
    return publicJob(await readJob(jobId));
  }

  async function getResult(jobId: string) {
    const job = await readJob(jobId);

    if (!job.result) {
      throw new Error(`analysis job ${jobId} has no result yet.`);
    }

    return job.result;
  }

  return {
    createJob,
    getJob,
    getResult,
    saveAsset,
    startJob,
  };
}
