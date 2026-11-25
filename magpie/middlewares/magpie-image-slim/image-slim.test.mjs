import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest, _internal } from './image-slim.middleware.js';

const ctx = {
    agent: 'dsh',
    model: 'group/sakana-namazu',
    protocol: 'responses',
    options: { log: false },
};
const placeholder = '[1.00 MB image left out here: an image the user attached, already seen earlier in this conversation. Rely on what you already said about it.]';
const inlineImage = () => ({ type: 'input_image', detail: 'auto', image_url: `data:image/jpeg;base64,${'A'.repeat(64)}` });
const aggregateText = [
    { type: 'input_text', text: '正文' },
    { type: 'input_text', text: 'Image "aggregate.jpg" (sha256:abc); request preview 10x10px.' },
];

function responsesBody(content, currentContent = [{ type: 'input_text', text: '继续' }]) {
    return {
        input: [
            { role: 'user', content },
            { role: 'assistant', content: [{ type: 'output_text', text: '回复' }] },
            { role: 'user', content: currentContent },
        ],
    };
}

test('replaces historical aggregate images and preserves DSH metadata', () => {
    const currentImage = inlineImage();
    const body = responsesBody([
        ...aggregateText,
        inlineImage(),
        { type: 'input_text', text: '（↑ tester 发的图）' },
    ], [currentImage, { type: 'input_text', text: '（↑ tester 发的图）' }]);

    assert.equal(onRequest(body, ctx), body);
    assert.equal(body.input[0].content[0].text, '正文');
    assert.match(body.input[0].content[1].text, /^Image "aggregate\.jpg"/u);
    assert.equal(body.input[0].content[2].type, 'input_text');
    assert.match(body.input[0].content[2].text, /^\[0\.00 MB image left out here:/u);
    assert.equal(body.input[0].content[3].text, '（↑ tester 发的图）');
    assert.equal(body.input[2].content[0], currentImage);
});

test('leaves non-aggregate historical images untouched', () => {
    const image = inlineImage();
    const body = responsesBody([
        { type: 'input_text', text: '普通上传' },
        image,
    ]);
    assert.equal(onRequest(body, ctx), undefined);
    assert.equal(body.input[0].content[1], image);
});

test('keeps the current turn image by default', () => {
    const image = inlineImage();
    const body = responsesBody([{ type: 'input_text', text: '历史' }], [
        { type: 'input_text', text: 'Image "aggregate.jpg" (sha256:abc)' },
        image,
        { type: 'input_text', text: '（↑ tester 发的图）' },
    ]);
    assert.equal(onRequest(body, ctx), undefined);
    assert.equal(body.input[2].content[1], image);
});

test('protects every user message after the last assistant in the current turn', () => {
    const firstImage = inlineImage();
    const secondImage = inlineImage();
    const body = {
        input: [
            { role: 'user', content: [{ type: 'input_text', text: '历史' }] },
            { role: 'assistant', content: [{ type: 'output_text', text: '回复' }] },
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'Image "aggregate.jpg" (sha256:abc)' },
                    firstImage,
                    { type: 'input_text', text: '（↑ tester 发的图）' },
                ],
            },
            {
                role: 'user',
                content: [
                    { type: 'input_text', text: 'Image "aggregate.jpg" (sha256:def)' },
                    secondImage,
                    { type: 'input_text', text: '（↑ tester 发的图）' },
                ],
            },
        ],
    };
    assert.equal(onRequest(body, ctx), undefined);
    assert.equal(body.input[2].content[1], firstImage);
    assert.equal(body.input[3].content[1], secondImage);
});

test('can replace the current turn image when configured', () => {
    const body = responsesBody([{ type: 'input_text', text: '历史' }], [
        { type: 'input_text', text: 'Image "aggregate.jpg" (sha256:abc)' },
        inlineImage(),
        { type: 'input_text', text: '（↑ tester 发的图）' },
    ]);
    onRequest(body, { ...ctx, options: { log: false, keepCurrentTurn: false } });
    assert.equal(body.input[2].content[1].type, 'input_text');
});

test('splits a glued image-slim placeholder into standalone blocks', () => {
    const body = responsesBody([{ type: 'input_text', text: `before${placeholder}after` }]);
    onRequest(body, ctx);
    assert.deepEqual(body.input[0].content, [
        { type: 'input_text', text: 'before' },
        { type: 'input_text', text: placeholder },
        { type: 'input_text', text: 'after' },
    ]);
});

test('splits multiple placeholders and drops empty edge blocks', () => {
    const body = responsesBody([{ type: 'input_text', text: `${placeholder}middle${placeholder}` }]);
    onRequest(body, ctx);
    assert.deepEqual(body.input[0].content, [
        { type: 'input_text', text: placeholder },
        { type: 'input_text', text: 'middle' },
        { type: 'input_text', text: placeholder },
    ]);
});

test('is idempotent for an already standalone placeholder', () => {
    const body = responsesBody([{ type: 'input_text', text: placeholder }]);
    assert.equal(onRequest(body, ctx), undefined);
    assert.deepEqual(body.input[0].content, [{ type: 'input_text', text: placeholder }]);
});

test('ignores other agents and models', () => {
    const body = responsesBody([{ type: 'input_text', text: `before${placeholder}after` }]);
    assert.equal(onRequest(body, { ...ctx, agent: 'codex' }), undefined);
    assert.equal(onRequest(body, { ...ctx, options: { log: false, models: ['other/model'] } }), undefined);
});

test('recognizes single-image aggregate attribution only when an inline image exists', () => {
    const content = [inlineImage(), { type: 'input_text', text: '（↑ tester 发的图）' }];
    assert.equal(_internal.isAggregateMessage(content), true);
    assert.equal(_internal.isAggregateMessage([{ type: 'input_text', text: '（↑ tester 发的图）' }]), false);
});
