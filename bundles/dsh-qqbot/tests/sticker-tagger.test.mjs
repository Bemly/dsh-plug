import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { autoTagImage, setStickerVisionLlm } from '../dist/features/sticker-tagger.js';
import { StickerStore } from '../dist/features/sticker-store.js';
import { IMAGE_DOWNLOAD_ATTEMPTS, downloadWithRetry } from '../dist/middleware/sticker-capture.js';
import { inferMediaKind } from '../dist/transport/media-kind.js';

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

test('uses the approved 1/2/4/8 retry ladder with fresh timeouts', async () => {
    assert.deepEqual(IMAGE_DOWNLOAD_ATTEMPTS, [
        { concurrency: 1, timeoutMs: 30_000 },
        { concurrency: 2, timeoutMs: 120_000 },
        { concurrency: 4, timeoutMs: 300_000 },
        { concurrency: 8, timeoutMs: 600_000 },
    ]);
    const counts = new Map();
    const attempts = [
        { concurrency: 1, timeoutMs: 10 },
        { concurrency: 2, timeoutMs: 20 },
        { concurrency: 4, timeoutMs: 30 },
        { concurrency: 8, timeoutMs: 40 },
    ];
    const result = await downloadWithRetry('https://example.com/image.jpg', async (_url, timeoutMs, signal) => {
        counts.set(timeoutMs, (counts.get(timeoutMs) ?? 0) + 1);
        await new Promise((_resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('timeout')), Math.min(timeoutMs, 5));
            signal.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(new Error('aborted'));
            }, { once: true });
        });
    }, { debug() {}, warn() {} }, attempts);
    assert.equal(result, undefined);
    assert.deepEqual([...counts.entries()], [[10, 1], [20, 2], [30, 4], [40, 8]]);
});

test('resolves immediately when any concurrent download wins', async () => {
    let calls = 0;
    const result = await downloadWithRetry('https://example.com/image.jpg', async (_url, _timeoutMs, signal) => {
        calls += 1;
        if (calls === 2)
            return Buffer.from('winner');
        await new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true });
        });
    }, { debug() {}, warn() {} }, [{ concurrency: 2, timeoutMs: 100 }]);
    assert.equal(result.toString(), 'winner');
    assert.equal(calls, 2);
});

test('recognizes QQ images delivered as content_type file', () => {
    assert.equal(inferMediaKind({ content_type: 'file', filename: 'photo.jpg', url: 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=Eh123456789' }), 'image');
    assert.equal(inferMediaKind({ content_type: 'file', filename: 'archive.zip', url: 'https://example.com/archive.zip' }), 'file');
});

test('captureBuffer deduplicates and writes one library file', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mps-sticker-store-test-'));
    const store = new StickerStore(root, { debug() {}, warn() {}, info() {} });
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64');
    const input = { sourceGroup: 'group', senderId: 'user', senderName: 'tester', sourceUrl: 'https://example.com/a.png' };
    try {
        const first = await store.captureBuffer(png, input, 'image/png', input.sourceUrl);
        const second = await store.captureBuffer(png, input, 'image/png', input.sourceUrl);
        assert.equal(first.status, 'new');
        assert.equal(second.status, 'dup');
        assert.equal(first.id, second.id);
        store.flush();
        const index = JSON.parse(readFileSync(join(root, 'index.json'), 'utf8'));
        assert.equal(index.items.length, 1);
    }
    finally {
        store.flush();
        rmSync(root, { recursive: true, force: true });
    }
});

test('enforces attempt timeout even when the downloader ignores abort', async () => {
    const started = Date.now();
    const result = await downloadWithRetry('https://example.com/hang.jpg', () => new Promise(() => {}), { debug() {}, warn() {} }, [{ concurrency: 1, timeoutMs: 20 }]);
    assert.equal(result, undefined);
    assert.ok(Date.now() - started < 1000);
});

test('does not automatically prune sticker candidates or trash', () => {
    const capture = readFileSync(new URL('../dist/middleware/sticker-capture.js', import.meta.url), 'utf8');
    const bootstrap = readFileSync(new URL('../dist/gateway/bootstrap.js', import.meta.url), 'utf8');
    assert.doesNotMatch(capture, /cleanupCandidates|cleanupTrash|purgeTrashed/);
    assert.doesNotMatch(bootstrap, /cleanupTrash|purgeTrashed/);
});
