import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export type Config = {
  apiPublicUrl: string;
  instagramScopes: string[];
  metaAppId?: string;
  metaAppSecret?: string;
  metaRedirectUri: string;
  port: number;
};

function loadDotEnv() {
  const envPath = path.resolve(process.cwd(), '.env');

  if (!existsSync(envPath)) {
    return;
  }

  const contents = readFileSync(envPath, 'utf8');

  for (const line of contents.split(/\r?\n/)) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith('#')) {
      continue;
    }

    const separatorIndex = trimmed.indexOf('=');

    if (separatorIndex === -1) {
      continue;
    }

    const key = trimmed.slice(0, separatorIndex).trim();
    const rawValue = trimmed.slice(separatorIndex + 1).trim();
    const value = rawValue.replace(/^['"]|['"]$/g, '');

    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

loadDotEnv();

export function readConfig(): Config {
  const port = Number(process.env.PORT ?? '8787');
  const apiPublicUrl = (process.env.API_PUBLIC_URL ?? `http://localhost:${port}`).replace(/\/$/, '');

  return {
    apiPublicUrl,
    instagramScopes: (process.env.INSTAGRAM_SCOPES ?? 'instagram_business_basic,instagram_business_content_publish')
      .split(',')
      .map((scope) => scope.trim())
      .filter(Boolean),
    metaAppId: process.env.META_APP_ID,
    metaAppSecret: process.env.META_APP_SECRET,
    metaRedirectUri: process.env.META_REDIRECT_URI ?? `${apiPublicUrl}/auth/instagram/callback`,
    port,
  };
}

export function hasMetaCredentials(config: Config) {
  return Boolean(config.metaAppId && config.metaAppSecret && config.metaRedirectUri);
}
