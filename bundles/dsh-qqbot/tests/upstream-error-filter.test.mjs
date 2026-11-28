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
    assert.equal(isRefusalText('I am\n  just  a LANGUAGE   MODEL, I cannot help with that.'), true);
});

test('does not treat bare policy/guideline/language-model substrings as refusals', () => {
    // 2026-11-28 审计：原来拿 policy/guideline 做子串匹配，policyholder、正常讨论 policies
    // 都会被误判成拒答并触发会话轮换。现在只认明确的拒答句式或结构化错误码。
    assert.equal(isRefusalText('policyholder'), false);
    assert.equal(isRefusalText('policies'), false);
    assert.equal(isRefusalText('guidelines'), false);
    assert.equal(isRefusalText('A LANGUAGE MODEL'), false);
});

test('does not match text without configured substrings', () => {
    assert.equal(isRefusalText('LLM 是语言模型，可以做很多事。'), false);
    assert.equal(isRefusalText('This request is allowed.'), false);
});
