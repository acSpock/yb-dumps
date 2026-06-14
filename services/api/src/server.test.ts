import assert from 'node:assert/strict';
import { access, mkdtemp, rm } from 'node:fs/promises';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { RankingResult } from './analysisContracts.js';
import { createAnalysisJobService } from './analysisJobs.js';
import {
  disconnectedInstagram,
  InstagramPublishResult,
  publicConnection,
  StoredInstagramConnection,
} from './contracts.js';
import { createApiServer } from './server.js';
import { InstagramStore } from './store.js';

function createMemoryStore(initialConnection?: StoredInstagramConnection): InstagramStore {
  const connections = new Map<string, StoredInstagramConnection>();

  if (initialConnection) {
    connections.set('device-123', initialConnection);
  }

  return {
    async clearConnection(deviceSessionId) {
      connections.delete(deviceSessionId);
    },

    async getConnection(deviceSessionId) {
      return connections.get(deviceSessionId);
    },

    async saveConnection(deviceSessionId, connection) {
      connections.set(deviceSessionId, connection);
    },
  };
}

async function withServer<T>(server: http.Server, run: (baseUrl: string) => Promise<T>) {
  await new Promise<void>((resolve) => {
    server.listen(0, '127.0.0.1', resolve);
  });

  const address = server.address();
  assert.ok(address);
  assert.notEqual(typeof address, 'string');
  const port = (address as AddressInfo).port;

  try {
    return await run(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => (error ? reject(error) : resolve()));
    });
  }
}

const professionalConnection: StoredInstagramConnection = {
  accessToken: 'short-token',
  accountId: 'ig-user-1',
  accountType: 'professional',
  connectedAt: '2026-06-13T10:00:00.000Z',
  connectionId: 'ig-ig-user-1',
  permissions: ['instagram_business_basic', 'instagram_business_content_publish'],
  publishCapability: {
    status: 'available',
  },
  shareStatus: 'not_started',
  status: 'connected',
  username: 'trip_picks_test',
};

async function jpegBase64(color: { b: number; g: number; r: number }) {
  return (await sharp({
    create: {
      background: color,
      channels: 3,
      height: 96,
      width: 128,
    },
  }).jpeg().toBuffer()).toString('base64');
}

test('status returns setup required when Meta credentials are missing', async () => {
  const server = createApiServer({
    metaConfigured: false,
    oauthSecret: 'secret',
    store: createMemoryStore(),
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/instagram/status?deviceSessionId=device-123`);
    const body = (await response.json()) as typeof disconnectedInstagram;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'setup_required');
    assert.equal(body.publishCapability?.status, 'setup_required');
  });
});

test('publish returns not connected instead of throwing', async () => {
  const server = createApiServer({
    metaConfigured: true,
    oauthSecret: 'secret',
    store: createMemoryStore(),
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/instagram/publish-carousel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceSessionId: 'device-123',
        mediaUrls: ['https://example.com/slide.jpg'],
      }),
    });
    const body = (await response.json()) as InstagramPublishResult;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'not_connected');
  });
});

test('publish delegates to Meta client for professional accounts with public media URLs', async () => {
  const server = createApiServer({
    metaClient: {
      async exchangeCodeForConnection() {
        throw new Error('not used');
      },
      async fetchFeed() {
        throw new Error('not used');
      },
      async publishCarousel({ connection, mediaUrls }) {
        assert.deepEqual(mediaUrls, ['https://example.com/slide.jpg']);
        return {
          status: 'published',
          message: 'Published.',
          publishId: 'published-1',
          connection: {
            ...publicConnection(connection),
            shareStatus: 'published',
          },
        };
      },
    },
    metaConfigured: true,
    oauthSecret: 'secret',
    store: createMemoryStore(professionalConnection),
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/instagram/publish-carousel`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        deviceSessionId: 'device-123',
        mediaUrls: ['https://example.com/slide.jpg'],
      }),
    });
    const body = (await response.json()) as InstagramPublishResult;

    assert.equal(response.status, 200);
    assert.equal(body.status, 'published');
    assert.equal(body.publishId, 'published-1');
  });
});

test('analysis rank endpoint returns top picks, carousels, and feed candidates', async () => {
  const server = createApiServer({
    metaConfigured: true,
    oauthSecret: 'secret',
    store: createMemoryStore(),
  });

  await withServer(server, async (baseUrl) => {
    const response = await fetch(`${baseUrl}/analysis/rank`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        feedProfile: {
          assets: [
            {
              colorProfile: { brightness: 0.62, contrast: 0.57, saturation: 0.5, warmth: 0.72 },
              id: 'feed-1',
              labels: ['beach'],
            },
          ],
        },
        options: {
          carouselMaxSlides: 20,
          topPoolSize: 8,
        },
        photos: Array.from({ length: 12 }, (_, index) => ({
          capturedAt: `2026-06-01T12:${String(index).padStart(2, '0')}:00.000Z`,
          colorProfile: { brightness: 0.58, contrast: 0.58, saturation: 0.54, warmth: index % 2 ? 0.7 : 0.55 },
          height: index % 3 === 0 ? 1200 : 1800,
          labels: index % 2 ? ['beach', 'people'] : ['detail'],
          momentId: `moment-${Math.floor(index / 3)}`,
          photoId: `photo-${index}`,
          qualitySignals: { faceCount: index % 2, sharpness: 0.82 },
          width: index % 3 === 0 ? 2000 : 1200,
        })),
        projectId: 'project-analysis',
      }),
    });
    const body = (await response.json()) as RankingResult;

    assert.equal(response.status, 200);
    assert.equal(body.projectId, 'project-analysis');
    assert.ok(body.topPicks.length > 0);
    assert.ok(body.carouselVariations.length > 0);
    assert.ok(body.carouselVariations.every((variation) => variation.slideCount <= 20));
    assert.ok(body.feedPreviewCandidates.length > 0);
  });
});

test('analysis job endpoint uploads resized assets, runs CPU vision, and cleans up images', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trip-picks-analysis-jobs-'));
  const server = createApiServer({
    analysisJobs: createAnalysisJobService(tempDir),
    metaConfigured: true,
    oauthSecret: 'secret',
    store: createMemoryStore(),
  });

  try {
    await withServer(server, async (baseUrl) => {
      const createResponse = await fetch(`${baseUrl}/analysis/jobs`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jobId: 'job-cpu-test',
          options: {
            carouselMaxSlides: 20,
            topPoolSize: 4,
          },
          photos: Array.from({ length: 4 }, (_, index) => ({
            height: 96,
            labels: ['place'],
            momentId: `moment-${index}`,
            photoId: `photo-${index}`,
            width: 128,
          })),
          projectId: 'project-cpu-job',
        }),
      });
      const job = await createResponse.json() as { jobId: string; uploadedAssetCount: number };

      assert.equal(createResponse.status, 201);
      assert.equal(job.jobId, 'job-cpu-test');
      assert.equal(job.uploadedAssetCount, 0);

      const uploadResponse = await fetch(`${baseUrl}/analysis/jobs/${job.jobId}/assets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          imageBase64: await jpegBase64({ b: 72, g: 120, r: 220 }),
          mimeType: 'image/jpeg',
          photoId: 'photo-0',
        }),
      });
      const uploadedJob = await uploadResponse.json() as { uploadedAssetCount: number };

      assert.equal(uploadResponse.status, 200);
      assert.equal(uploadedJob.uploadedAssetCount, 1);

      const startResponse = await fetch(`${baseUrl}/analysis/jobs/${job.jobId}/start`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({}),
      });
      const started = await startResponse.json() as { result: RankingResult };

      assert.equal(startResponse.status, 200);
      assert.equal(started.result.modelVersion, 'cpu-vision-curation-v0.1.0');
      assert.ok(started.result.topPicks.length > 0);

      const resultResponse = await fetch(`${baseUrl}/analysis/jobs/${job.jobId}/result`);
      const result = await resultResponse.json() as RankingResult;

      assert.equal(resultResponse.status, 200);
      assert.equal(result.resultId, started.result.resultId);

      await assert.rejects(
        () => access(path.join(tempDir, job.jobId, 'assets')),
        /ENOENT/,
      );
    });
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
