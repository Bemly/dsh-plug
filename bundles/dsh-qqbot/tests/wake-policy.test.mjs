import assert from 'node:assert/strict';
import test from 'node:test';
import { selectPendingWake, wakePendingAfterGate } from '../dist/transport/wake-policy.js';

test('returns null when inbox is empty', () => {
    assert.equal(selectPendingWake([], []), null);
});

test('selects the last next-step message', () => {
    const first = { id: 'step-1' };
    const last = { id: 'step-2' };
    assert.equal(selectPendingWake([first, last], []), last);
});

test('selects the last next-turn message', () => {
    const first = { id: 'turn-1' };
    const last = { id: 'turn-2' };
    assert.equal(selectPendingWake([], [first, last]), last);
});

test('preserves normal consumption order across both queues', () => {
    const step = { id: 'step-1' };
    const turn = { id: 'turn-1' };
    assert.equal(selectPendingWake([step], [turn]), turn);
});

test('cancels silently without opening an empty turn', () => {
    const calls = [];
    const agent = {
        cancel: (...args) => calls.push(['cancel', ...args]),
        followup: () => calls.push(['followup']),
        inbox: { nextStep: [], nextTurn: [], remove: () => false },
    };
    assert.equal(wakePendingAfterGate(agent), false);
    assert.deepEqual(calls, [['cancel', { kind: 'user' }, { keepInbox: true }]]);
});

test('re-enqueues an existing pending message after cancel', () => {
    const calls = [];
    const pending = { id: 'pending-1', role: 'user', content: [] };
    const agent = {
        cancel: (...args) => calls.push(['cancel', ...args]),
        followup: (message) => calls.push(['followup', message]),
        inbox: {
            nextStep: [pending],
            nextTurn: [],
            remove: (id) => { calls.push(['remove', id]); return true; },
        },
    };
    assert.equal(wakePendingAfterGate(agent), true);
    assert.deepEqual(calls, [
        ['cancel', { kind: 'user' }, { keepInbox: true }],
        ['remove', 'pending-1'],
        ['followup', pending],
    ]);
});
