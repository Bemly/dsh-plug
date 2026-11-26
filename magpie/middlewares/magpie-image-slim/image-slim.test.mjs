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
    for (const legacy of ['[图片聚合] 这 2 张图', '（↑ tester 发的图）', 'Image "aggregate.jpg" (sha256:abc)']) {
        const body = responsesBody([{ type: 'input_text', text: legacy }, inlineImage()]);
        assert.equal(onRequest(body, ctx), undefined, `should ignore: ${legacy}`);
    }
});

// DSH 宿主生成的句柄文本（真实格式，来自 dsh-llm-pi-ai requestImageHandleText）
const DSH_HANDLE = 'Image "aggregate.jpg" (sha256:e6fe9406b12d4d76671e3e9b432ba4f175021190fb04954c20544140c7f32735); request preview 1546x2560px. Normalized copy (read-only; may be resized or re-encoded): "/vol1/@appdata/fn-deepseek-harness/attachments/v1/objects/e6/e6fe9406b12d4d76671e3e9b432ba4f175021190fb04954c20544140c7f32735" (1546x2560px, image/jpeg). Source dimensions, format, and byte size may differ. Copy to a writable path ending in .jpg before editing.';

test('v0.1.3: recognizes DSH handle text and keeps the path', () => {
    const body = responsesBody([{ type: 'input_text', text: DSH_HANDLE }, inlineImage()]);
    assert.equal(onRequest(body, ctx), body);
    assert.equal(body.input[0].content[0].text, DSH_HANDLE);   // 路径原样保留
    assert.equal(body.input[0].content[1].text, '[image]');     // 图片数据换成占位
    assert.equal(body.input[0].content.length, 2);              // 块数不变
});

test('v0.1.3: DSH handle slim is cache-safe (block count stable)', () => {
    const body = responsesBody([
        { type: 'input_text', text: 'A文本' },
        { type: 'input_text', text: DSH_HANDLE },
        inlineImage(),
        { type: 'input_text', text: 'C文本' },
    ]);
    const before = body.input[0].content.length;
    onRequest(body, ctx);
    assert.equal(body.input[0].content.length, before);
    assert.equal(body.input[0].content[1].text, DSH_HANDLE);
    assert.equal(body.input[0].content[2].text, '[image]');
});

test('v0.1.3: keeps current-turn DSH image intact', () => {
    const image = inlineImage();
    const body = responsesBody([{ type: 'input_text', text: '历史' }], [
        { type: 'input_text', text: DSH_HANDLE },
        image,
    ]);
    assert.equal(onRequest(body, ctx), undefined);
    assert.equal(body.input[2].content[1], image);
});

test('v0.1.3: still recognizes generic image-slim slot', () => {
    const body = responsesBody([{ type: 'input_text', text: SLOT }, inlineImage()]);
    assert.equal(onRequest(body, ctx), body);
    assert.equal(body.input[0].content[1].text, '[image]');
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
