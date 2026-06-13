import assert from 'node:assert/strict';
import test from 'node:test';

import { createOAuthState, decodeOAuthState } from './oauthState.js';

test('OAuth state round trips a signed payload', () => {
  const state = createOAuthState({
    deviceSessionId: 'device-123',
    now: 1_000,
    returnUrl: 'trippicks://instagram-callback',
    secret: 'secret',
  });
  const decoded = decodeOAuthState({
    now: 1_500,
    secret: 'secret',
    state,
  });

  assert.equal(decoded.ok, true);

  if (decoded.ok) {
    assert.equal(decoded.payload.deviceSessionId, 'device-123');
    assert.equal(decoded.payload.returnUrl, 'trippicks://instagram-callback');
  }
});

test('OAuth state rejects invalid signatures', () => {
  const state = createOAuthState({
    deviceSessionId: 'device-123',
    now: 1_000,
    returnUrl: 'trippicks://instagram-callback',
    secret: 'secret',
  });
  const decoded = decodeOAuthState({
    now: 1_500,
    secret: 'different-secret',
    state,
  });

  assert.equal(decoded.ok, false);
});

test('OAuth state rejects expired payloads', () => {
  const state = createOAuthState({
    deviceSessionId: 'device-123',
    now: 1_000,
    returnUrl: 'trippicks://instagram-callback',
    secret: 'secret',
  });
  const decoded = decodeOAuthState({
    now: 1_000 + 11 * 60 * 1000,
    secret: 'secret',
    state,
  });

  assert.equal(decoded.ok, false);
});
