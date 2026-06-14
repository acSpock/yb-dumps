import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import sharp from 'sharp';

import { AnalysisPhotoInput } from './analysisContracts.js';
import { analyzeImageAsset } from './cpuVision.js';

function photo(photoId: string): AnalysisPhotoInput {
  return {
    height: 128,
    labels: ['test'],
    photoId,
    width: 128,
  };
}

async function writeSolidImage(filePath: string, color: { b: number; g: number; r: number }) {
  await sharp({
    create: {
      background: color,
      channels: 3,
      height: 128,
      width: 128,
    },
  }).jpeg().toFile(filePath);
}

async function writeCheckerImage(filePath: string) {
  const width = 128;
  const height = 128;
  const data = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const on = (Math.floor(x / 8) + Math.floor(y / 8)) % 2 === 0;
      const value = on ? 245 : 10;
      const offset = (y * width + x) * 3;
      data[offset] = value;
      data[offset + 1] = value;
      data[offset + 2] = value;
    }
  }

  await sharp(data, {
    raw: {
      channels: 3,
      height,
      width,
    },
  }).jpeg().toFile(filePath);
}

test('cpu vision computes stable perceptual hashes and embeddings', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trip-picks-cpu-vision-'));

  try {
    const leftPath = path.join(tempDir, 'left.jpg');
    const rightPath = path.join(tempDir, 'right.jpg');
    await writeSolidImage(leftPath, { b: 80, g: 120, r: 210 });
    await writeSolidImage(rightPath, { b: 80, g: 120, r: 210 });

    const left = await analyzeImageAsset({ imagePath: leftPath, photo: photo('left') });
    const right = await analyzeImageAsset({ imagePath: rightPath, photo: photo('right') });

    assert.equal(left.perceptualHash, right.perceptualHash);
    assert.equal(left.visualEmbedding?.length, 32);
    assert.ok(left.modelQualitySignals?.exposure);
    assert.ok(left.modelLabels?.includes('warm'));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});

test('cpu vision sharpness responds to high-frequency image detail', async () => {
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'trip-picks-cpu-vision-'));

  try {
    const solidPath = path.join(tempDir, 'solid.jpg');
    const checkerPath = path.join(tempDir, 'checker.jpg');
    await writeSolidImage(solidPath, { b: 128, g: 128, r: 128 });
    await writeCheckerImage(checkerPath);

    const solid = await analyzeImageAsset({ imagePath: solidPath, photo: photo('solid') });
    const checker = await analyzeImageAsset({ imagePath: checkerPath, photo: photo('checker') });

    assert.ok((checker.modelQualitySignals?.sharpness ?? 0) > (solid.modelQualitySignals?.sharpness ?? 0));
    assert.ok((checker.modelQualitySignals?.contrast ?? 0) > (solid.modelQualitySignals?.contrast ?? 0));
  } finally {
    await rm(tempDir, { force: true, recursive: true });
  }
});
