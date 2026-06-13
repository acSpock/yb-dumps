export type UploadStatus = 'local_only' | 'pending' | 'uploaded' | 'failed';
export type JobStatus =
  | 'created'
  | 'awaiting_uploads'
  | 'queued'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'canceled'
  | 'expired';
export type JobStage =
  | 'ingest'
  | 'quality'
  | 'duplicates'
  | 'embeddings'
  | 'clustering'
  | 'ranking'
  | 'feed_fit'
  | 'complete';
export type PickSet = 'top_pool' | 'carousel';
export type FeedFitLabel = 'fits' | 'maybe' | 'clashes';
export type FeedbackAction = 'keep' | 'reject' | 'favorite' | 'too_similar' | 'more_like_this' | 'unset';
export type CropHint = 'vertical' | 'square' | 'landscape' | 'none';
export type CarouselSlideTemplate = 'single' | 'vertical_triptych' | 'hero_with_details' | 'detail_grid';

export type TripMoment = {
  momentId: string;
  label: string;
  subtitle: string;
};

export type TripPhoto = {
  photoId: string;
  projectId: string;
  sourceAssetId: string;
  localUri?: string;
  thumbnailUri?: string;
  originalFilename?: string;
  width: number;
  height: number;
  capturedAt?: string;
  momentId: string;
  peopleIds: string[];
  uploadStatus: UploadStatus;
  userFeedback: FeedbackAction;
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

export type FeedImportMode = 'none' | 'instagram' | 'screenshot' | 'recent_posts';

export type FeedImportAsset = {
  id: string;
  uri: string;
  width?: number;
  height?: number;
};

export type FeedImportState = {
  mode: FeedImportMode;
  assets: FeedImportAsset[];
  importedAt?: string;
};

export type ExportStatus = 'not_started' | 'saved_to_camera_roll' | 'share_sheet_ready';
export type InstagramAccountType = 'personal' | 'professional' | 'unknown';
export type InstagramConnectionStatus = 'not_connected' | 'connected' | 'setup_required' | 'error';
export type InstagramPublishCapabilityStatus =
  | 'unknown'
  | 'available'
  | 'requires_professional_account'
  | 'requires_public_media'
  | 'setup_required'
  | 'unavailable';
export type InstagramShareStatus =
  | 'not_started'
  | 'feed_imported'
  | 'render_required'
  | 'requires_export'
  | 'publishing'
  | 'published'
  | 'failed';

export type InstagramPublishCapability = {
  status: InstagramPublishCapabilityStatus;
  reason?: string;
};

export type InstagramConnectionState = {
  status: InstagramConnectionStatus;
  connectionId?: string;
  accountId?: string;
  accountType?: InstagramAccountType;
  username?: string;
  profilePictureUrl?: string;
  permissions?: string[];
  publishCapability?: InstagramPublishCapability;
  connectedAt?: string;
  tokenExpiresAt?: string;
  lastFeedImportAt?: string;
  importedMediaCount?: number;
  shareStatus?: InstagramShareStatus;
  errorMessage?: string;
};

export type InstagramPublishResult = {
  status:
    | 'published'
    | 'requires_export'
    | 'render_required'
    | 'setup_required'
    | 'not_connected'
    | 'failed';
  message: string;
  permalink?: string;
  publishId?: string;
  connection?: InstagramConnectionState;
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
};

export type AnalysisJob = {
  jobId: string;
  projectId: string;
  status: JobStatus;
  stage: JobStage;
  progress: number;
  assetCount: number;
  uploadedAssetCount: number;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  completedAt?: string;
  error?: {
    code: string;
    message: string;
    retryable: boolean;
  };
  resultId?: string;
};

export type TripProject = {
  projectId: string;
  name: string;
  locationLabel: string;
  createdAt: string;
  updatedAt?: string;
  savedAt?: string;
  chosenCarouselVariationId?: string;
  exportStatus?: ExportStatus;
  feedImport?: FeedImportState;
  instagram?: InstagramConnectionState;
  photoCount: number;
  moments: TripMoment[];
  photos: TripPhoto[];
  job: AnalysisJob;
  result: RankingResult;
};

export type PickedAssetInput = {
  assetId?: string | null;
  uri: string;
  width?: number;
  height?: number;
  fileName?: string | null;
};
