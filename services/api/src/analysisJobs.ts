import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';

import {
  AnalysisPhotoInput,
  AnalysisRankRequest,
  FeedProfileInput,
  RankingResult,
} from './analysisContracts.js';
import { analyzeImageAsset } from './cpuVision.js';
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

function safeSegment(value: string) {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
}

function nowIso() {
  return new Date().toISOString();
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

export function createAnalysisJobService(dataDir: string) {
  const rootDir = path.resolve(dataDir);

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

  async function startJob(jobId: string) {
    const job = await readJob(jobId);
    const startedAt = nowIso();

    job.startedAt = job.startedAt ?? startedAt;
    job.status = 'running';
    job.stage = 'cpu_vision';
    job.progress = Math.max(job.progress, 0.35);
    job.updatedAt = startedAt;
    await saveJob(job);

    try {
      const enrichedPhotos: AnalysisPhotoInput[] = [];

      for (const [index, photo] of job.photos.entries()) {
        const imagePath = await findAssetPath(jobId, photo.photoId);
        const enrichedPhoto = imagePath
          ? await analyzeImageAsset({ imagePath, photo })
          : photo;

        enrichedPhotos.push(enrichedPhoto);
        job.progress = 0.35 + ((index + 1) / Math.max(job.photos.length, 1)) * 0.38;
        job.updatedAt = nowIso();
        await saveJob(job);
      }

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
