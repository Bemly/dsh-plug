import assert from 'node:assert/strict';
import test from 'node:test';
import { noteOurAttachment } from '../dist/features/image-aggregate.js';
import { imageSlimPlaceholder, offloadHistoryImages } from '../dist/features/image-offload.js';

const IMAGE_SLIM_RE = /^\[\d+(?:\.\d+)? MB image left out here: [\s\S]*\]$/;

function fakeSession(events) {
    const appended = [];
    let next = 100;
    return {
        surface: { nodes: [0, ...Object.keys(events).map(Number)] },
        eventAt(seq) { return events[seq]; },
        append(type, data) {
            const event = { seq: next++, type, data };
            appended.push(event);
            events[event.seq] = event;
            return event;
        },
        appended,
    };
}

const logger = { info() {}, debug() {}, warn() {} };

test('formats the standard image-slim placeholder from attachment bytes', () => {
    assert.match(imageSlimPlaceholder({ bytes: 600639 }), IMAGE_SLIM_RE);
    assert.ok(imageSlimPlaceholder({ bytes: 600639 }).startsWith('[0.57 MB image left out here:'));
    assert.ok(imageSlimPlaceholder({}).startsWith('[0.00 MB image left out here:'));
});

test('offloads only registered aggregate images before the last assistant message', async () => {
    const ownId = 'sha256:own-image-offload-test';
    noteOurAttachment(ownId);
    const original = {
        type: 'user/message',
        data: {
            role: 'user',
            content: [
                { type: 'text', text: '正文' },
                { type: 'image', attachment: { attachmentId: ownId, mediaType: 'image/jpeg', bytes: 600639 } },
                { type: 'text', text: '（↑ tester 发的图）' },
            ],
        },
    };
    const current = {
        type: 'user/message',
        data: {
            role: 'user',
            content: [
                { type: 'image', attachment: { attachmentId: ownId, mediaType: 'image/jpeg', bytes: 600639 } },
                { type: 'text', text: '（↑ tester 发的图）' },
            ],
        },
    };
    const session = fakeSession({
        1: original,
        2: { type: 'assistant/message', data: {} },
        3: current,
    });

    assert.equal(await offloadHistoryImages({ session }, logger, 7), 1);
    const replacement = session.appended.find((event) => event.type === 'user/message');
    assert.ok(replacement);
    assert.equal(replacement.data.content[0].text, '正文');
    assert.match(replacement.data.content[1].text, IMAGE_SLIM_RE);
    assert.equal(replacement.data.content[2].text, '（↑ tester 发的图）');
    assert.equal(original.data.content[1].type, 'image');
    assert.equal(current.data.content[0].type, 'image');
});

test('leaves images not registered by this plugin untouched', async () => {
    const session = fakeSession({
        1: {
            type: 'user/message',
            data: {
                role: 'user',
                content: [
                    { type: 'text', text: '正文' },
                    { type: 'image', attachment: { attachmentId: 'sha256:other-plugin-image', mediaType: 'image/png', bytes: 100 } },
                    { type: 'text', text: '（↑ tester 发的图）' },
                ],
            },
        },
        2: { type: 'assistant/message', data: {} },
    });

    assert.equal(await offloadHistoryImages({ session }, logger, 7), 0);
    assert.equal(session.appended.length, 0);
});
