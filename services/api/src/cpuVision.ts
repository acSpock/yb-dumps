import sharp from 'sharp';

import {
  AnalysisColorProfile,
  AnalysisPhotoInput,
  AnalysisQualitySignals,
} from './analysisContracts.js';

const ANALYSIS_SIZE = 64;
const HASH_WIDTH = 9;
const HASH_HEIGHT = 8;
const EMBEDDING_SIZE = 32;

type PixelStats = {
  brightness: number;
  contrast: number;
  saturation: number;
  warmth: number;
  sharpness: number;
  exposure: number;
  noise: number;
  centerBias: number;
  gridLuma: number[];
  redHistogram: number[];
  greenHistogram: number[];
  blueHistogram: number[];
};

function clamp(value: number, min = 0, max = 1) {
  return Math.max(min, Math.min(max, value));
}

function average(values: number[], fallback = 0) {
  const usableValues = values.filter((value) => Number.isFinite(value));
  return usableValues.length ? usableValues.reduce((sum, value) => sum + value, 0) / usableValues.length : fallback;
}

function standardDeviation(values: number[], mean = average(values, 0)) {
  if (!values.length) {
    return 0;
  }

  const variance = average(values.map((value) => (value - mean) ** 2), 0);
  return Math.sqrt(variance);
}

function roundFeature(value: number) {
  return Math.round(clamp(value) * 1000) / 1000;
}

function normalizeVector(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0));

  if (!magnitude) {
    return vector.map(() => 0);
  }

  return vector.map((value) => Math.round((value / magnitude) * 10000) / 10000);
}

function luma(red: number, green: number, blue: number) {
  return (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
}

function saturationFor(red: number, green: number, blue: number) {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;

  if (max === 0) {
    return 0;
  }

  return (max - min) / max;
}

async function rawPixels(imagePath: string, width: number, height: number) {
  const { data, info } = await sharp(imagePath, { failOn: 'none' })
    .rotate()
    .resize(width, height, { fit: 'fill' })
    .removeAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return {
    data,
    height: info.height,
    width: info.width,
  };
}

function pixelAt(data: Buffer, x: number, y: number, width: number) {
  const offset = (y * width + x) * 3;
  return {
    blue: data[offset + 2] ?? 0,
    green: data[offset + 1] ?? 0,
    red: data[offset] ?? 0,
  };
}

function computeStats(data: Buffer, width: number, height: number): PixelStats {
  const lumas: number[] = [];
  const saturations: number[] = [];
  const redValues: number[] = [];
  const greenValues: number[] = [];
  const blueValues: number[] = [];
  const gridBuckets = Array.from({ length: 16 }, () => [] as number[]);
  const redHistogram = Array.from({ length: 4 }, () => 0);
  const greenHistogram = Array.from({ length: 4 }, () => 0);
  const blueHistogram = Array.from({ length: 4 }, () => 0);
  let gradientTotal = 0;
  let gradientCount = 0;
  let centerTotal = 0;
  let centerCount = 0;
  let clippedCount = 0;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const { red, green, blue } = pixelAt(data, x, y, width);
      const pixelLuma = luma(red, green, blue);
      const pixelSaturation = saturationFor(red, green, blue);
      const gridX = Math.min(3, Math.floor((x / width) * 4));
      const gridY = Math.min(3, Math.floor((y / height) * 4));

      lumas.push(pixelLuma);
      saturations.push(pixelSaturation);
      redValues.push(red / 255);
      greenValues.push(green / 255);
      blueValues.push(blue / 255);
      gridBuckets[gridY * 4 + gridX]?.push(pixelLuma);
      redHistogram[Math.min(3, Math.floor((red / 256) * 4))] += 1;
      greenHistogram[Math.min(3, Math.floor((green / 256) * 4))] += 1;
      blueHistogram[Math.min(3, Math.floor((blue / 256) * 4))] += 1;

      if (pixelLuma <= 0.03 || pixelLuma >= 0.97) {
        clippedCount += 1;
      }

      const centerDistanceX = Math.abs((x + 0.5) / width - 0.5);
      const centerDistanceY = Math.abs((y + 0.5) / height - 0.5);

      if (centerDistanceX < 0.22 && centerDistanceY < 0.22) {
        centerTotal += pixelLuma;
        centerCount += 1;
      }

      if (x + 1 < width) {
        const right = pixelAt(data, x + 1, y, width);
        gradientTotal += Math.abs(pixelLuma - luma(right.red, right.green, right.blue));
        gradientCount += 1;
      }

      if (y + 1 < height) {
        const down = pixelAt(data, x, y + 1, width);
        gradientTotal += Math.abs(pixelLuma - luma(down.red, down.green, down.blue));
        gradientCount += 1;
      }
    }
  }

  const brightness = average(lumas, 0.55);
  const contrast = clamp(standardDeviation(lumas, brightness) * 3.2);
  const saturation = clamp(average(saturations, 0.5) * 1.2);
  const warmth = clamp(0.5 + (average(redValues, 0.5) - average(blueValues, 0.5)) * 0.8);
  const gradient = gradientCount ? gradientTotal / gradientCount : 0;
  const sharpness = clamp(gradient * 7.5 + contrast * 0.28);
  const clippedRatio = clippedCount / Math.max(lumas.length, 1);
  const exposure = clamp((1 - Math.abs(brightness - 0.56) * 1.6) * 0.72 + (1 - clippedRatio * 5) * 0.28);
  const centerBrightness = centerCount ? centerTotal / centerCount : brightness;
  const centerBias = clamp(0.62 + Math.abs(centerBrightness - brightness) * 1.8);
  const highFrequencyNoise = clamp(Math.max(0, gradient * 6.5 - contrast * 0.9));

  return {
    blueHistogram: blueHistogram.map((value) => value / Math.max(lumas.length, 1)),
    brightness,
    centerBias,
    contrast,
    exposure,
    greenHistogram: greenHistogram.map((value) => value / Math.max(lumas.length, 1)),
    gridLuma: gridBuckets.map((bucket) => average(bucket, brightness)),
    noise: highFrequencyNoise,
    redHistogram: redHistogram.map((value) => value / Math.max(lumas.length, 1)),
    saturation,
    sharpness,
    warmth,
  };
}

function computeDHash(data: Buffer, width: number, height: number) {
  let bits = '';

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width - 1; x += 1) {
      const left = pixelAt(data, x, y, width);
      const right = pixelAt(data, x + 1, y, width);
      bits += luma(left.red, left.green, left.blue) > luma(right.red, right.green, right.blue) ? '1' : '0';
    }
  }

  let hex = '';

  for (let index = 0; index < bits.length; index += 4) {
    hex += Number.parseInt(bits.slice(index, index + 4).padEnd(4, '0'), 2).toString(16);
  }

  return hex.padStart(16, '0');
}

function labelsForStats(photo: AnalysisPhotoInput, stats: PixelStats) {
  const labels = new Set<string>();
  const aspectRatio = photo.width / Math.max(photo.height, 1);

  labels.add(aspectRatio > 1.12 ? 'landscape' : aspectRatio < 0.88 ? 'portrait' : 'square');

  if (stats.brightness < 0.34) {
    labels.add('low_light');
  } else if (stats.brightness > 0.76) {
    labels.add('bright');
  }

  if (stats.saturation > 0.64) {
    labels.add('colorful');
  }

  if (stats.warmth > 0.62) {
    labels.add('warm');
  } else if (stats.warmth < 0.4) {
    labels.add('cool');
  }

  if (stats.contrast > 0.58) {
    labels.add('high_contrast');
  }

  if (stats.sharpness < 0.42) {
    labels.add('soft_focus');
  }

  return [...labels].sort();
}

function embeddingForStats(photo: AnalysisPhotoInput, stats: PixelStats) {
  const aspectRatio = clamp(photo.width / Math.max(photo.height, 1) / 2.2);
  const vector = [
    stats.brightness,
    stats.contrast,
    stats.saturation,
    stats.warmth,
    stats.sharpness,
    stats.exposure,
    stats.noise,
    stats.centerBias,
    aspectRatio,
    ...stats.gridLuma,
    ...stats.redHistogram,
    ...stats.greenHistogram,
    ...stats.blueHistogram,
  ];

  while (vector.length < EMBEDDING_SIZE) {
    vector.push(0);
  }

  return normalizeVector(vector.slice(0, EMBEDDING_SIZE));
}

function colorProfileForStats(stats: PixelStats): AnalysisColorProfile {
  return {
    brightness: roundFeature(stats.brightness),
    contrast: roundFeature(stats.contrast),
    saturation: roundFeature(stats.saturation),
    warmth: roundFeature(stats.warmth),
  };
}

function qualitySignalsForStats(stats: PixelStats): AnalysisQualitySignals {
  return {
    contrast: roundFeature(stats.contrast),
    exposure: roundFeature(stats.exposure),
    noise: roundFeature(stats.noise),
    sharpness: roundFeature(stats.sharpness),
    subjectCentered: roundFeature(stats.centerBias),
  };
}

function aestheticScoreForStats(stats: PixelStats) {
  const colorHarmony = average([
    1 - Math.abs(stats.saturation - 0.54) * 1.1,
    1 - Math.abs(stats.contrast - 0.5) * 1.2,
    1 - Math.abs(stats.warmth - 0.56) * 0.7,
  ], 0.65);

  return roundFeature(stats.sharpness * 0.36 + stats.exposure * 0.27 + colorHarmony * 0.27 + stats.centerBias * 0.1);
}

export async function analyzeImageAsset(input: {
  imagePath: string;
  photo: AnalysisPhotoInput;
}): Promise<AnalysisPhotoInput> {
  const metadata = await sharp(input.imagePath, { failOn: 'none' }).rotate().metadata();
  const analysis = await rawPixels(input.imagePath, ANALYSIS_SIZE, ANALYSIS_SIZE);
  const hashPixels = await rawPixels(input.imagePath, HASH_WIDTH, HASH_HEIGHT);
  const stats = computeStats(analysis.data, analysis.width, analysis.height);
  const width = metadata.width ?? input.photo.width;
  const height = metadata.height ?? input.photo.height;
  const photo = {
    ...input.photo,
    height,
    width,
  };

  return {
    ...photo,
    aestheticScore: input.photo.aestheticScore ?? aestheticScoreForStats(stats),
    colorProfile: {
      ...input.photo.colorProfile,
      ...colorProfileForStats(stats),
    },
    modelLabels: [...new Set([...(input.photo.modelLabels ?? []), ...labelsForStats(photo, stats)])],
    modelSource: input.photo.modelSource ?? 'cpu',
    modelQualitySignals: {
      ...input.photo.modelQualitySignals,
      ...qualitySignalsForStats(stats),
    },
    perceptualHash: computeDHash(hashPixels.data, hashPixels.width, hashPixels.height),
    visualEmbedding: embeddingForStats(photo, stats),
  };
}
