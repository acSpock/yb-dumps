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

export type FeedImportAsset = {
  id: string;
  uri: string;
  width?: number;
  height?: number;
};

export type FeedImportState = {
  mode: 'instagram';
  assets: FeedImportAsset[];
  importedAt?: string;
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

export type StoredInstagramConnection = InstagramConnectionState & {
  accessToken: string;
  longLivedToken?: string;
};

export const disconnectedInstagram: InstagramConnectionState = {
  status: 'not_connected',
  publishCapability: {
    status: 'unknown',
  },
  shareStatus: 'not_started',
};

export function setupRequiredInstagram(message = 'Meta app credentials are not configured on the API.') {
  return {
    status: 'setup_required',
    publishCapability: {
      status: 'setup_required',
      reason: message,
    },
    shareStatus: 'failed',
    errorMessage: message,
  } satisfies InstagramConnectionState;
}

export function publicConnection(connection: StoredInstagramConnection): InstagramConnectionState {
  const { accessToken: _accessToken, longLivedToken: _longLivedToken, ...publicState } = connection;
  return publicState;
}
