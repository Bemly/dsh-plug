import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { autoTagImage, setStickerVisionLlm } from '../dist/features/sticker-tagger.js';

test('uses the configured zako4 endpoint, model, and API key env', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mps-sticker-tagger-test-'));
    const imagePath = join(root, 'test.png');
    writeFileSync(imagePath, Buffer.from('89504e470d0a1a0a', 'hex'));
    const originalFetch = globalThis.fetch;
    const originalKey = process.env.ZAKO4_API_KEY;
    let captured;
    try {
        process.env.ZAKO4_API_KEY = 'test-zako-key';
        globalThis.fetch = async (url, options) => {
            captured = { url, headers: options.headers, body: JSON.parse(options.body) };
            return {
                ok: true,
                json: async () => ({ choices: [{ message: { content: '【标签】测试 表情\n【描述】一张测试图片' } }] }),
            };
        };
        setStickerVisionLlm(null, 'http://localhost:36141/v1', 'junie/junie-lite', 'ZAKO4_API_KEY');
        const result = await autoTagImage(imagePath, '', { warn() {}, debug() {} });
        assert.equal(captured.url, 'http://localhost:36141/v1/chat/completions');
        assert.equal(captured.headers.Authorization, 'Bearer test-zako-key');
        assert.equal(captured.body.model, 'junie/junie-lite');
        assert.ok(result.tags.length > 0);
        assert.equal(result.desc, '一张测试图片');
    } finally {
        globalThis.fetch = originalFetch;
        if (originalKey === undefined) delete process.env.ZAKO4_API_KEY;
        else process.env.ZAKO4_API_KEY = originalKey;
        rmSync(root, { recursive: true, force: true });
    }
});
