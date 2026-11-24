import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldWakeInterjectAfterAbort } from '../dist/transport/wake-policy.js';

test('does not wake when reply_gate has no newer interjection', () => {
    assert.equal(shouldWakeInterjectAfterAbort(true, 2, 2, true), false);
});

test('wakes when a new interjection arrives after reply_gate', () => {
    assert.equal(shouldWakeInterjectAfterAbort(true, 3, 2, true), true);
});

test('keeps the existing wake behavior for non-gate aborts', () => {
    assert.equal(shouldWakeInterjectAfterAbort(true, 1, 0, true), true);
});

test('does not wake after a normal turn end', () => {
    assert.equal(shouldWakeInterjectAfterAbort(false, 1, 0, true), false);
});

test('does not wake without followup capability', () => {
    assert.equal(shouldWakeInterjectAfterAbort(true, 1, 0, false), false);
});
