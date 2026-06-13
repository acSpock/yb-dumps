import {
  FeedImportState,
  InstagramConnectionState,
  InstagramPublishResult,
} from '../types';

export const API_BASE_URL =
  process.env.EXPO_PUBLIC_API_BASE_URL?.replace(/\/$/, '') ?? 'http://localhost:8787';

type ApiErrorBody = {
  message?: string;
  error?: string;
};

export class InstagramApiError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = 'InstagramApiError';
    this.status = status;
  }
}

async function parseApiResponse<T>(response: Response): Promise<T> {
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T & ApiErrorBody) : ({} as T & ApiErrorBody);

  if (!response.ok) {
    throw new InstagramApiError(body.message ?? body.error ?? 'Instagram API request failed.', response.status);
  }

  return body;
}

function deviceQuery(deviceSessionId: string) {
  return `deviceSessionId=${encodeURIComponent(deviceSessionId)}`;
}

export function instagramAuthStartUrl(deviceSessionId: string, returnUrl: string) {
  const query = new URLSearchParams({
    deviceSessionId,
    returnUrl,
  });

  return `${API_BASE_URL}/auth/instagram/start?${query.toString()}`;
}

export async function getInstagramStatus(deviceSessionId: string): Promise<InstagramConnectionState> {
  const response = await fetch(`${API_BASE_URL}/instagram/status?${deviceQuery(deviceSessionId)}`);
  return parseApiResponse<InstagramConnectionState>(response);
}

export async function disconnectInstagram(deviceSessionId: string): Promise<InstagramConnectionState> {
  const response = await fetch(`${API_BASE_URL}/instagram/disconnect`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ deviceSessionId }),
  });

  return parseApiResponse<InstagramConnectionState>(response);
}

export async function importInstagramFeed(deviceSessionId: string): Promise<{
  connection: InstagramConnectionState;
  feedImport: FeedImportState;
}> {
  const response = await fetch(`${API_BASE_URL}/instagram/import-feed`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify({ deviceSessionId }),
  });

  return parseApiResponse(response);
}

export async function publishInstagramCarousel(input: {
  caption?: string;
  deviceSessionId: string;
  mediaUrls: string[];
  projectId: string;
  variationId: string;
}): Promise<InstagramPublishResult> {
  const response = await fetch(`${API_BASE_URL}/instagram/publish-carousel`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(input),
  });

  return parseApiResponse(response);
}
