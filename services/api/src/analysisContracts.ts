export type UploadStatus = 'local_only' | 'pending' | 'uploaded' | 'failed';
export type PickSet = 'top_pool' | 'carousel';
export type FeedFitLabel = 'fits' | 'maybe' | 'clashes';
export type CropHint = 'vertical' | 'square' | 'landscape' | 'none';
export type CarouselSlideTemplate = 'single' | 'vertical_triptych' | 'hero_with_details' | 'detail_grid';

export type AnalysisColorProfile = {
  brightness?: number;
  contrast?: number;
  saturation?: number;
  warmth?: number;
};

export type AnalysisQualitySignals = {
  sharpness?: number;
  exposure?: number;
  noise?: number;
  faceCount?: number;
  eyesOpen?: number;
  smile?: number;
  subjectCentered?: number;
  contrast?: number;
};

export type AnalysisPhotoInput = {
  photoId: string;
  projectId?: string;
  sourceAssetId?: string;
  width: number;
  height: number;
  capturedAt?: string;
  momentId?: string;
  peopleIds?: string[];
  labels?: string[];
  colorProfile?: AnalysisColorProfile;
  qualitySignals?: AnalysisQualitySignals;
  embedding?: number[];
  aestheticScore?: number;
  perceptualHash?: string;
  visualEmbedding?: number[];
  modelLabels?: string[];
  modelQualitySignals?: AnalysisQualitySignals;
  modelSource?: 'metadata' | 'cpu' | 'gpu';
  modelProvider?: string;
};

export type FeedProfileAssetInput = {
  id: string;
  width?: number;
  height?: number;
  labels?: string[];
  colorProfile?: AnalysisColorProfile;
  embedding?: number[];
  perceptualHash?: string;
  visualEmbedding?: number[];
  modelLabels?: string[];
};

export type FeedProfileInput = {
  feedProfileId?: string;
  assets: FeedProfileAssetInput[];
};

export type AnalysisRankOptions = {
  topPoolSize?: number;
  carouselMaxSlides?: number;
  variationCount?: number;
};

export type AnalysisRankRequest = {
  projectId: string;
  jobId?: string;
  photos: AnalysisPhotoInput[];
  feedProfile?: FeedProfileInput;
  options?: AnalysisRankOptions;
};

export type PhotoScore = {
  photoId: string;
  qualityScore: number;
  aestheticScore: number;
  personalTasteScore?: number;
  coverageScore: number;
  finalScore: number;
  sceneLabels: string[];
  qualityFlags: string[];
  faceCount?: number;
};

export type RankedPick = {
  photoId: string;
  set: PickSet;
  rank: number;
  finalScore: number;
  reasons: string[];
  momentId?: string;
  duplicateGroupId?: string;
  cropHint: CropHint;
  editHint?: string;
  role?: string;
};

export type CarouselSlide = {
  slideId: string;
  rank: number;
  template: CarouselSlideTemplate;
  photoIds: string[];
  title: string;
  note: string;
  cropHint: CropHint;
};

export type CarouselVariation = {
  variationId: string;
  label: string;
  thesis: string;
  confidence: number;
  coverPhotoId: string;
  slideCount: number;
  photoCount: number;
  reasons: string[];
  slides: CarouselSlide[];
};

export type DuplicateGroup = {
  groupId: string;
  projectId: string;
  photoIds: string[];
  representativePhotoId: string;
  bestPhotoId: string;
  duplicateType: 'exact' | 'near' | 'burst' | 'similar';
  confidence: number;
  reasonCodes: string[];
  createdAt: string;
};

export type FeedFitScore = {
  feedProfileId: string;
  projectId: string;
  photoId: string;
  fitScore: number;
  label: FeedFitLabel;
  paletteMatch: number;
  brightnessMatch: number;
  compositionMatch: number;
  subjectMixFit: number;
  noveltyScore: number;
  cropSuitability: {
    square: number;
    vertical: number;
    landscape: number;
  };
  reasons: string[];
};

export type FeedPreviewCandidate = FeedFitScore & {
  rank: number;
  previewSlot: number;
  editHint: string;
};

export type AnalysisDebugPickSummary = {
  photoId: string;
  rank?: number;
  finalScore?: number;
  reasons?: string[];
  sceneLabels?: string[];
  qualityFlags?: string[];
  modelLabels?: string[];
  modelSource?: 'metadata' | 'cpu' | 'gpu';
  modelProvider?: string;
  aestheticScore?: number;
  qualityScore?: number;
};

export type AnalysisDebugTrace = {
  pipeline: 'metadata-only' | 'cpu-only' | 'cpu-gpu';
  input: {
    photoCount: number;
    feedAssetCount: number;
  };
  cpu?: {
    analyzedAssetCount?: number;
    uploadedAssetCount?: number;
    preselectCandidateCount?: number;
    preselectTopPicks?: AnalysisDebugPickSummary[];
  };
  gpu?: {
    enabled: boolean;
    status: 'not_configured' | 'skipped' | 'completed' | 'failed';
    provider?: string;
    candidateLimit?: number;
    candidateCount?: number;
    candidatePhotoIds?: string[];
    returnedFeatureCount?: number;
    returnedFeatures?: AnalysisDebugPickSummary[];
    error?: string;
  };
  final: {
    topPicks: AnalysisDebugPickSummary[];
    duplicateGroups: DuplicateGroup[];
    carouselSlides: Array<{
      variationId: string;
      label: string;
      slides: Array<{
        slideId: string;
        rank: number;
        template: CarouselSlideTemplate;
        photoIds: string[];
      }>;
    }>;
    warnings: string[];
  };
};

export type RankingResult = {
  resultId: string;
  projectId: string;
  jobId: string;
  modelVersion: string;
  generatedAt: string;
  topPicks: RankedPick[];
  carouselVariations: CarouselVariation[];
  photoScores: PhotoScore[];
  duplicateGroups: DuplicateGroup[];
  feedPreviewCandidates: FeedPreviewCandidate[];
  warnings: string[];
  debugTrace?: AnalysisDebugTrace;
};
