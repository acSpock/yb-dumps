import http, { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';

import { createMetaClient, MetaClient } from './metaClient.js';
import { createOAuthState, decodeOAuthState } from './oauthState.js';
import { hasMetaCredentials, readConfig } from './config.js';
import {
  disconnectedInstagram,
  InstagramConnectionState,
  InstagramPublishResult,
  publicConnection,
  setupRequiredInstagram,
} from './contracts.js';
import { createFileStore, InstagramStore } from './store.js';

type JsonRecord = Record<string, unknown>;

type AppContext = {
  metaClient?: MetaClient;
  metaConfigured: boolean;
  oauthSecret: string;
  store: InstagramStore;
};

const config = readConfig();

function corsHeaders() {
  return {
    'access-control-allow-headers': 'content-type',
    'access-control-allow-methods': 'GET,POST,OPTIONS',
    'access-control-allow-origin': '*',
    'content-type': 'application/json; charset=utf-8',
  };
}

function sendJson(response: ServerResponse, statusCode: number, body: unknown) {
  response.writeHead(statusCode, corsHeaders());
  response.end(JSON.stringify(body));
}

function redirect(response: ServerResponse, targetUrl: string) {
  response.writeHead(302, {
    location: targetUrl,
  });
  response.end();
}

function redirectWithParams(response: ServerResponse, targetUrl: string, params: Record<string, string>) {
  const url = new URL(targetUrl);

  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }

  redirect(response, url.toString());
}

async function readJsonBody(request: IncomingMessage): Promise<JsonRecord> {
  const chunks: Buffer[] = [];

  for await (const chunk of request) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }

  if (chunks.length === 0) {
    return {};
  }

  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as JsonRecord;
}

function requiredString(value: unknown, field: string) {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`${field} is required.`);
  }

  return value.trim();
}

function publicConnectionOrDisconnected(
  connection: Awaited<ReturnType<InstagramStore['getConnection']>>,
): InstagramConnectionState {
  return connection ? publicConnection(connection) : disconnectedInstagram;
}

function setupRequiredRedirect(response: ServerResponse, returnUrl: string) {
  redirectWithParams(response, returnUrl, {
    instagram_status: 'setup_required',
  });
}

async function routeAuthStart(
  response: ServerResponse,
  url: URL,
  context: AppContext,
) {
  const deviceSessionId = requiredString(url.searchParams.get('deviceSessionId'), 'deviceSessionId');
  const returnUrl = requiredString(url.searchParams.get('returnUrl'), 'returnUrl');

  if (!context.metaConfigured) {
    setupRequiredRedirect(response, returnUrl);
    return;
  }

  const state = createOAuthState({
    deviceSessionId,
    returnUrl,
    secret: context.oauthSecret,
  });
  const authUrl = new URL('https://www.instagram.com/oauth/authorize');
  authUrl.searchParams.set('client_id', config.metaAppId ?? '');
  authUrl.searchParams.set('redirect_uri', config.metaRedirectUri);
  authUrl.searchParams.set('response_type', 'code');
  authUrl.searchParams.set('scope', config.instagramScopes.join(','));
  authUrl.searchParams.set('state', state);

  redirect(response, authUrl.toString());
}

async function routeAuthCallback(
  response: ServerResponse,
  url: URL,
  context: AppContext,
) {
  const state = requiredString(url.searchParams.get('state'), 'state');
  const decoded = decodeOAuthState({
    secret: context.oauthSecret,
    state,
  });

  if (!decoded.ok) {
    sendJson(response, 400, { message: decoded.error });
    return;
  }

  if (!context.metaClient) {
    setupRequiredRedirect(response, decoded.payload.returnUrl);
    return;
  }

  const oauthError = url.searchParams.get('error_description') ?? url.searchParams.get('error');

  if (oauthError) {
    redirectWithParams(response, decoded.payload.returnUrl, {
      instagram_error: oauthError,
      instagram_status: 'error',
    });
    return;
  }

  try {
    const code = requiredString(url.searchParams.get('code'), 'code');
    const connection = await context.metaClient.exchangeCodeForConnection(code);
    await context.store.saveConnection(decoded.payload.deviceSessionId, connection);
    redirectWithParams(response, decoded.payload.returnUrl, {
      instagram_connection_id: connection.connectionId ?? '',
      instagram_status: 'connected',
    });
  } catch (error) {
    redirectWithParams(response, decoded.payload.returnUrl, {
      instagram_error: error instanceof Error ? error.message : 'Instagram OAuth callback failed.',
      instagram_status: 'error',
    });
  }
}

async function routeStatus(response: ServerResponse, url: URL, context: AppContext) {
  const deviceSessionId = requiredString(url.searchParams.get('deviceSessionId'), 'deviceSessionId');

  if (!context.metaConfigured) {
    sendJson(response, 200, setupRequiredInstagram());
    return;
  }

  const connection = await context.store.getConnection(deviceSessionId);
  sendJson(response, 200, publicConnectionOrDisconnected(connection));
}

async function routeDisconnect(response: ServerResponse, request: IncomingMessage, context: AppContext) {
  const body = await readJsonBody(request);
  const deviceSessionId = requiredString(body.deviceSessionId, 'deviceSessionId');
  await context.store.clearConnection(deviceSessionId);
  sendJson(response, 200, disconnectedInstagram);
}

async function routeImportFeed(response: ServerResponse, request: IncomingMessage, context: AppContext) {
  const body = await readJsonBody(request);
  const deviceSessionId = requiredString(body.deviceSessionId, 'deviceSessionId');
  const connection = await context.store.getConnection(deviceSessionId);

  if (!connection) {
    sendJson(response, 401, { message: 'Connect Instagram before importing feed media.' });
    return;
  }

  if (!context.metaClient) {
    sendJson(response, 503, setupRequiredInstagram());
    return;
  }

  const result = await context.metaClient.fetchFeed(connection);
  await context.store.saveConnection(deviceSessionId, {
    ...connection,
    importedMediaCount: result.connection.importedMediaCount,
    lastFeedImportAt: result.connection.lastFeedImportAt,
    shareStatus: 'feed_imported',
  });
  sendJson(response, 200, result);
}

async function routePublishCarousel(response: ServerResponse, request: IncomingMessage, context: AppContext) {
  const body = await readJsonBody(request);
  const deviceSessionId = requiredString(body.deviceSessionId, 'deviceSessionId');
  const mediaUrls = Array.isArray(body.mediaUrls)
    ? body.mediaUrls.filter((url): url is string => typeof url === 'string')
    : [];
  const connection = await context.store.getConnection(deviceSessionId);

  if (!connection) {
    sendJson(response, 200, {
      status: 'not_connected',
      message: 'Connect Instagram before publishing.',
    } satisfies InstagramPublishResult);
    return;
  }

  if (!context.metaClient) {
    sendJson(response, 200, {
      status: 'setup_required',
      message: 'Meta app credentials are not configured on the local API.',
      connection: setupRequiredInstagram(),
    } satisfies InstagramPublishResult);
    return;
  }

  const result = await context.metaClient.publishCarousel({
    caption: typeof body.caption === 'string' ? body.caption : undefined,
    connection,
    mediaUrls,
  });

  if (result.connection) {
    await context.store.saveConnection(deviceSessionId, {
      ...connection,
      ...result.connection,
      accessToken: connection.accessToken,
      longLivedToken: connection.longLivedToken,
    });
  }

  sendJson(response, 200, result);
}

export function createApiServer(context: AppContext) {
  return http.createServer((request, response) => {
    void (async () => {
      if (request.method === 'OPTIONS') {
        sendJson(response, 204, {});
        return;
      }

      const url = new URL(request.url ?? '/', config.apiPublicUrl);

      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, 200, {
          ok: true,
          metaConfigured: context.metaConfigured,
        });
        return;
      }

      if (request.method === 'GET' && url.pathname === '/auth/instagram/start') {
        await routeAuthStart(response, url, context);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/auth/instagram/callback') {
        await routeAuthCallback(response, url, context);
        return;
      }

      if (request.method === 'GET' && url.pathname === '/instagram/status') {
        await routeStatus(response, url, context);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/instagram/disconnect') {
        await routeDisconnect(response, request, context);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/instagram/import-feed') {
        await routeImportFeed(response, request, context);
        return;
      }

      if (request.method === 'POST' && url.pathname === '/instagram/publish-carousel') {
        await routePublishCarousel(response, request, context);
        return;
      }

      sendJson(response, 404, { message: 'Not found.' });
    })().catch((error) => {
      sendJson(response, 500, {
        message: error instanceof Error ? error.message : 'Unexpected API error.',
      });
    });
  });
}

if (process.env.NODE_ENV !== 'test') {
  const metaConfigured = hasMetaCredentials(config);
  const store = createFileStore();
  const server = createApiServer({
    metaClient: metaConfigured ? createMetaClient(config) : undefined,
    metaConfigured,
    oauthSecret: config.metaAppSecret ?? 'trip-picks-local-dev-oauth-state',
    store,
  });

  server.listen(config.port, () => {
    console.log(`Trip Picks API listening on ${config.apiPublicUrl}`);
    console.log(`Meta configured: ${metaConfigured ? 'yes' : 'no'}`);
  });
}
