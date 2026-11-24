import assert from 'node:assert/strict';
import test from 'node:test';
import { shouldDrainInboxAfterAbort } from '../dist/transport/wake-policy.js';

test('drains unseen inbox messages after reply_gate abort', () => {
    assert.equal(shouldDrainInboxAfterAbort(true, 4, true), true);
});

test('does not open an empty turn when inbox is empty', () => {
    assert.equal(shouldDrainInboxAfterAbort(true, 0, true), false);
});

test('does not wake after a normal turn end', () => {
    assert.equal(shouldDrainInboxAfterAbort(false, 4, true), false);
});

test('does not wake without followup capability', () => {
    assert.equal(shouldDrainInboxAfterAbort(true, 4, false), false);
});
