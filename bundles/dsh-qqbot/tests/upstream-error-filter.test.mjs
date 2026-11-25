import assert from 'node:assert/strict';
import test from 'node:test';
import { isRefusalText, isUpstreamAuthError } from '../dist/transport/upstream-error-filter.js';

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

test('matches refusal phrases in final assistant text', () => {
    assert.equal(isRefusalText("I'm just a language model and can't help with that."), true);
    assert.equal(isRefusalText('Your request may go against my guidelines.'), true);
    assert.equal(isRefusalText('Your request may go against my guideline.'), true);
});

test('matches refusal phrases through markdown links and mixed whitespace', () => {
    assert.equal(isRefusalText('Your request may go against my [guidelines](https://example.com/policy).'), true);
    assert.equal(isRefusalText('A\nLANGUAGE   MODEL replied'), true);
});

test('does not match ordinary model discussion without the configured phrases', () => {
    assert.equal(isRefusalText('LLM 是语言模型，可以做很多事。'), false);
    assert.equal(isRefusalText('This follows my guidelines.'), false);
});
