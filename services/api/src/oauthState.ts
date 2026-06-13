import crypto from 'node:crypto';

export type OAuthStatePayload = {
  createdAt: number;
  deviceSessionId: string;
  nonce: string;
  returnUrl: string;
};

type DecodedState =
  | {
      ok: true;
      payload: OAuthStatePayload;
    }
  | {
      ok: false;
      error: string;
    };

const maxStateAgeMs = 10 * 60 * 1000;

function base64UrlEncode(value: string) {
  return Buffer.from(value, 'utf8').toString('base64url');
}

function base64UrlDecode(value: string) {
  return Buffer.from(value, 'base64url').toString('utf8');
}

function sign(payload: string, secret: string) {
  return crypto.createHmac('sha256', secret).update(payload).digest('base64url');
}

function signaturesMatch(actual: string, expected: string) {
  const actualBuffer = Buffer.from(actual);
  const expectedBuffer = Buffer.from(expected);

  return actualBuffer.length === expectedBuffer.length && crypto.timingSafeEqual(actualBuffer, expectedBuffer);
}

export function createOAuthState(input: {
  deviceSessionId: string;
  returnUrl: string;
  secret: string;
  now?: number;
}) {
  const payload = base64UrlEncode(
    JSON.stringify({
      createdAt: input.now ?? Date.now(),
      deviceSessionId: input.deviceSessionId,
      nonce: crypto.randomBytes(12).toString('base64url'),
      returnUrl: input.returnUrl,
    } satisfies OAuthStatePayload),
  );

  return `${payload}.${sign(payload, input.secret)}`;
}

export function decodeOAuthState(input: {
  secret: string;
  state: string;
  now?: number;
}): DecodedState {
  const [payload, signature] = input.state.split('.');

  if (!payload || !signature) {
    return { ok: false, error: 'OAuth state is malformed.' };
  }

  const expectedSignature = sign(payload, input.secret);

  if (!signaturesMatch(signature, expectedSignature)) {
    return { ok: false, error: 'OAuth state signature is invalid.' };
  }

  try {
    const parsed = JSON.parse(base64UrlDecode(payload)) as OAuthStatePayload;
    const age = (input.now ?? Date.now()) - parsed.createdAt;

    if (!parsed.deviceSessionId || !parsed.returnUrl || !parsed.nonce) {
      return { ok: false, error: 'OAuth state is missing required fields.' };
    }

    if (age < 0 || age > maxStateAgeMs) {
      return { ok: false, error: 'OAuth state expired. Try connecting again.' };
    }

    return { ok: true, payload: parsed };
  } catch {
    return { ok: false, error: 'OAuth state payload could not be parsed.' };
  }
}
