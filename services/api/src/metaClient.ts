import { Config } from './config.js';
import {
  FeedImportAsset,
  FeedImportState,
  InstagramAccountType,
  InstagramConnectionState,
  InstagramPublishResult,
  StoredInstagramConnection,
} from './contracts.js';

type ShortTokenResponse = {
  access_token?: string;
  user_id?: number | string;
  error_message?: string;
};

type LongTokenResponse = {
  access_token?: string;
  expires_in?: number;
  error?: {
    message?: string;
  };
};

type ProfileResponse = {
  account_type?: string;
  id?: string;
  profile_picture_url?: string;
  username?: string;
  error?: {
    message?: string;
  };
};

type MediaResponse = {
  data?: Array<{
    id: string;
    media_type?: string;
    media_url?: string;
    permalink?: string;
    thumbnail_url?: string;
    timestamp?: string;
  }>;
  error?: {
    message?: string;
  };
};

type ContainerResponse = {
  id?: string;
  error?: {
    message?: string;
  };
};

const graphVersion = 'v21.0';

export type MetaClient = {
  exchangeCodeForConnection: (code: string) => Promise<StoredInstagramConnection>;
  fetchFeed: (connection: StoredInstagramConnection) => Promise<{
    connection: InstagramConnectionState;
    feedImport: FeedImportState;
  }>;
  publishCarousel: (input: {
    caption?: string;
    connection: StoredInstagramConnection;
    mediaUrls: string[];
  }) => Promise<InstagramPublishResult>;
};

function normalizeAccountType(value?: string): InstagramAccountType {
  const normalized = value?.toLowerCase();

  if (normalized === 'business' || normalized === 'creator' || normalized === 'professional') {
    return 'professional';
  }

  if (normalized === 'personal') {
    return 'personal';
  }

  return 'unknown';
}

function tokenFor(connection: StoredInstagramConnection) {
  return connection.longLivedToken ?? connection.accessToken;
}

async function parseGraphResponse<T extends { error?: { message?: string }; error_message?: string }>(
  response: Response,
): Promise<T> {
  const body = (await response.json()) as T;

  if (!response.ok || body.error || body.error_message) {
    throw new Error(body.error?.message ?? body.error_message ?? 'Meta API request failed.');
  }

  return body;
}

function publishCapabilityFor(accountType: InstagramAccountType) {
  if (accountType === 'professional') {
    return {
      status: 'available',
      reason: 'This account is eligible for API publishing once rendered media URLs are public.',
    } as const;
  }

  return {
    status: 'requires_professional_account',
    reason: 'Meta content publishing is available for eligible Instagram professional accounts. Use export/share for personal accounts.',
  } as const;
}

function connectionFromProfile(input: {
  accessToken: string;
  longLivedToken?: string;
  permissions: string[];
  profile: ProfileResponse;
  tokenExpiresAt?: string;
}): StoredInstagramConnection {
  const accountType = normalizeAccountType(input.profile.account_type);
  const accountId = input.profile.id ?? 'unknown';

  return {
    accessToken: input.accessToken,
    accountId,
    accountType,
    connectedAt: new Date().toISOString(),
    connectionId: `ig-${accountId}`,
    longLivedToken: input.longLivedToken,
    permissions: input.permissions,
    profilePictureUrl: input.profile.profile_picture_url,
    publishCapability: publishCapabilityFor(accountType),
    shareStatus: 'not_started',
    status: 'connected',
    tokenExpiresAt: input.tokenExpiresAt,
    username: input.profile.username,
  };
}

function assertProfessional(connection: StoredInstagramConnection): InstagramPublishResult | null {
  if (connection.accountType === 'professional') {
    return null;
  }

  return {
    status: 'requires_export',
    message:
      'This Instagram account is connected, but API publishing requires an eligible professional account. Export the carousel and post through Instagram.',
    connection: {
      ...connection,
      publishCapability: publishCapabilityFor(connection.accountType ?? 'unknown'),
      shareStatus: 'requires_export',
    },
  };
}

function assertPublicMediaUrls(mediaUrls: string[]): InstagramPublishResult | null {
  if (mediaUrls.length === 0) {
    return {
      status: 'render_required',
      message:
        'Carousel slides need to be rendered and hosted at public HTTPS URLs before Meta can publish them.',
    };
  }

  const invalidUrl = mediaUrls.find((url) => !url.startsWith('https://'));

  if (invalidUrl) {
    return {
      status: 'render_required',
      message: `Meta publishing requires public HTTPS media URLs. This URL is not publishable: ${invalidUrl}`,
    };
  }

  return null;
}

async function graphPost<T extends { error?: { message?: string } }>(
  path: string,
  params: Record<string, string>,
) {
  const response = await fetch(`https://graph.instagram.com/${graphVersion}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: new URLSearchParams(params).toString(),
  });

  return parseGraphResponse<T>(response);
}

export function createMetaClient(config: Config): MetaClient {
  if (!config.metaAppId || !config.metaAppSecret) {
    throw new Error('Meta app credentials are required to create the Meta client.');
  }

  const metaAppId = config.metaAppId;
  const metaAppSecret = config.metaAppSecret;

  async function exchangeCodeForShortToken(code: string) {
    const response = await fetch('https://api.instagram.com/oauth/access_token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: metaAppId,
        client_secret: metaAppSecret,
        code,
        grant_type: 'authorization_code',
        redirect_uri: config.metaRedirectUri,
      }).toString(),
    });

    return parseGraphResponse<ShortTokenResponse>(response);
  }

  async function exchangeForLongToken(accessToken: string) {
    const url = new URL(`https://graph.instagram.com/access_token`);
    url.searchParams.set('grant_type', 'ig_exchange_token');
    url.searchParams.set('client_secret', metaAppSecret);
    url.searchParams.set('access_token', accessToken);

    const response = await fetch(url);
    return parseGraphResponse<LongTokenResponse>(response);
  }

  async function fetchProfile(accessToken: string) {
    const url = new URL(`https://graph.instagram.com/${graphVersion}/me`);
    url.searchParams.set('fields', 'id,username,account_type,profile_picture_url');
    url.searchParams.set('access_token', accessToken);

    const response = await fetch(url);
    return parseGraphResponse<ProfileResponse>(response);
  }

  return {
    async exchangeCodeForConnection(code) {
      const shortToken = await exchangeCodeForShortToken(code);

      if (!shortToken.access_token) {
        throw new Error('Meta did not return an access token.');
      }

      const longToken = await exchangeForLongToken(shortToken.access_token).catch(() => undefined);
      const activeToken = longToken?.access_token ?? shortToken.access_token;
      const tokenExpiresAt = longToken?.expires_in
        ? new Date(Date.now() + longToken.expires_in * 1000).toISOString()
        : undefined;
      const profile = await fetchProfile(activeToken);

      return connectionFromProfile({
        accessToken: shortToken.access_token,
        longLivedToken: longToken?.access_token,
        permissions: config.instagramScopes,
        profile,
        tokenExpiresAt,
      });
    },

    async fetchFeed(connection) {
      const url = new URL(`https://graph.instagram.com/${graphVersion}/me/media`);
      url.searchParams.set('fields', 'id,media_type,media_url,thumbnail_url,permalink,timestamp');
      url.searchParams.set('limit', '18');
      url.searchParams.set('access_token', tokenFor(connection));

      const response = await fetch(url);
      const media = await parseGraphResponse<MediaResponse>(response);
      const assets: FeedImportAsset[] = (media.data ?? [])
        .map((item) => ({
          id: item.id,
          uri: item.thumbnail_url ?? item.media_url ?? '',
        }))
        .filter((asset) => asset.uri.length > 0);
      const importedAt = new Date().toISOString();
      const nextConnection: InstagramConnectionState = {
        ...connection,
        importedMediaCount: assets.length,
        lastFeedImportAt: importedAt,
        shareStatus: 'feed_imported',
      };

      return {
        connection: nextConnection,
        feedImport: {
          mode: 'instagram',
          assets,
          importedAt,
        },
      };
    },

    async publishCarousel({ caption, connection, mediaUrls }) {
      const accountGuard = assertProfessional(connection);

      if (accountGuard) {
        return accountGuard;
      }

      const urlGuard = assertPublicMediaUrls(mediaUrls);

      if (urlGuard) {
        return {
          ...urlGuard,
          connection: {
            ...connection,
            publishCapability: {
              status: 'requires_public_media',
              reason: urlGuard.message,
            },
            shareStatus: 'render_required',
          },
        };
      }

      const accessToken = tokenFor(connection);
      const children = [];

      for (const mediaUrl of mediaUrls) {
        const child = await graphPost<ContainerResponse>(`/${connection.accountId}/media`, {
          access_token: accessToken,
          image_url: mediaUrl,
          is_carousel_item: 'true',
        });

        if (!child.id) {
          throw new Error('Meta did not return a child media container id.');
        }

        children.push(child.id);
      }

      const carousel = await graphPost<ContainerResponse>(`/${connection.accountId}/media`, {
        access_token: accessToken,
        caption: caption ?? '',
        children: children.join(','),
        media_type: 'CAROUSEL',
      });

      if (!carousel.id) {
        throw new Error('Meta did not return a carousel container id.');
      }

      const published = await graphPost<ContainerResponse>(`/${connection.accountId}/media_publish`, {
        access_token: accessToken,
        creation_id: carousel.id,
      });

      if (!published.id) {
        throw new Error('Meta did not return a published media id.');
      }

      return {
        status: 'published',
        message: 'Published the carousel through the Instagram Content Publishing API.',
        publishId: published.id,
        connection: {
          ...connection,
          publishCapability: publishCapabilityFor(connection.accountType ?? 'unknown'),
          shareStatus: 'published',
        },
      };
    },
  };
}
