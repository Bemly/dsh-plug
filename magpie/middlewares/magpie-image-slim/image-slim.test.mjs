import assert from 'node:assert/strict';
import test from 'node:test';
import { onRequest, _internal } from './image-slim.middleware.js';

const ctx = {
    agent: 'dsh',
    model: 'group/sakana-namazu',
    protocol: 'responses',
    options: { log: false },
};
const SLOT = '[0.13 MB image left out here: 图1 一只橘猫趴在键盘上]';
const inlineImage = () => ({ type: 'input_image', detail: 'auto', image_url: `data:image/jpeg;base64,${'A'.repeat(64)}` });
const currentUser = () => ({ type: 'input_text', text: '本轮问题' });
function responsesBody(historyContent, currentContent = [currentUser()]) {
    return {
        input: [
            { role: 'user', content: historyContent },
            { role: 'assistant', content: [{ type: 'output_text', text: '回复' }] },
            { role: 'user', content: currentContent },
        ],
    };
}

test('slims historical image to [image], keeps generic slot text', () => {
    const image = inlineImage();
    const body = responsesBody([{ type: 'input_text', text: SLOT }, image]);
    assert.equal(onRequest(body, ctx), body);
    assert.equal(body.input[0].content[0].text, SLOT);
    assert.equal(body.input[0].content[1].text, '[image]');
    assert.equal(body.input[0].content.length, 2); // 块数不变
});

test('block count stays constant (cache-safe)', () => {
    const body = responsesBody([
        { type: 'input_text', text: SLOT },
        inlineImage(),
        { type: 'input_text', text: '补充说明' },
    ]);
    const before = body.input[0].content.length;
    onRequest(body, ctx);
    assert.equal(body.input[0].content.length, before);
});

test('does NOT recognize v1 legacy marks', () => {
    for (const legacy of ['[图片聚合] 这 2 张图', 'Image "aggregate.jpg" (sha256:abc)', '（↑ tester 发的图）']) {
        const body = responsesBody([{ type: 'input_text', text: legacy }, inlineImage()]);
        assert.equal(onRequest(body, ctx), undefined, `should ignore: ${legacy}`);
    }
});

test('leaves non-slot images untouched', () => {
    const image = inlineImage();
    const body = responsesBody([{ type: 'input_text', text: '普通上传' }, image]);
    assert.equal(onRequest(body, ctx), undefined);
    assert.equal(body.input[0].content[1], image);
});

test('keeps current turn image by default', () => {
    const image = inlineImage();
    const body = responsesBody([{ type: 'input_text', text: '历史' }], [
        { type: 'input_text', text: SLOT },
        image,
    ]);
    assert.equal(onRequest(body, ctx), undefined);
    assert.equal(body.input[2].content[1], image);
});

test('can replace current turn image when configured', () => {
    const body = responsesBody([{ type: 'input_text', text: '历史' }], [
        { type: 'input_text', text: SLOT },
        inlineImage(),
    ]);
    onRequest(body, { ...ctx, options: { log: false, keepCurrentTurn: false } });
    assert.equal(body.input[2].content[1].text, '[image]');
});

test('splitPlaceholders is OFF by default', () => {
    const glued = `before${SLOT}after`;
    const body = responsesBody([{ type: 'input_text', text: glued }]);
    assert.equal(onRequest(body, ctx), undefined);
    assert.equal(body.input[0].content.length, 1);
});

test('splitPlaceholders can be opted in', () => {
    const glued = `before${SLOT}after`;
    const body = responsesBody([{ type: 'input_text', text: glued }]);
    onRequest(body, { ...ctx, options: { log: false, splitPlaceholders: true } });
    assert.equal(body.input[0].content.length, 3);
});

test('ignores other agents and models', () => {
    const body = responsesBody([{ type: 'input_text', text: SLOT }, inlineImage()]);
    assert.equal(onRequest(body, { ...ctx, agent: 'codex' }), undefined);
    assert.equal(onRequest(body, { ...ctx, options: { log: false, models: ['other/model'] } }), undefined);
});

test('generic slot recognition works for any author text', () => {
    const other = '[2.50 MB image left out here: 任意来源的打标描述]';
    const body = responsesBody([{ type: 'input_text', text: other }, inlineImage()]);
    assert.equal(onRequest(body, ctx), body);
    assert.equal(body.input[0].content[1].text, '[image]');
});
