import assert from 'node:assert/strict';
import test from 'node:test';
import { isUpstreamAuthError } from '../dist/transport/upstream-error-filter.js';

test('matches the Google OAuth 401 payload with surrounding whitespace', () => {
    const text = '\n⚠ UNAUTHENTICATED (code 401): Request had invalid authentication credentials. Expected OAuth 2 access token, login cookie or other valid authentication credential. See https://developers.google.com/identity/sign-in/web/devconsole-project.\n';
    assert.equal(isUpstreamAuthError(text), true);
});

test('does not suppress ordinary discussion of authentication errors', () => {
    assert.equal(isUpstreamAuthError('今天遇到 UNAUTHENTICATED 401，登录失效了'), false);
});

test('does not suppress unrelated 401 messages', () => {
    assert.equal(isUpstreamAuthError('⚠ UNAUTHENTICATED (code 401): session expired'), false);
});
