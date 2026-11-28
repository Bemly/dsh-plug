import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';
import {
    buildAggregateBlocks,
    clearAggImages,
    markAggSent,
    pendingAggImages,
    prepareAggregateImages,
    pushPreparedAggImage,
    rememberAggSentPaths,
    setImageAggregateHooks,
    stitchAggImages,
} from '../dist/features/image-aggregate.js';

setImageAggregateHooks({
    probeImageInput: async () => true,
    saveImage: async (data, mediaType) => ({
        attachment: {
            attachmentId: 'sha256:test',
            mediaType,
            name: 'aggregate.jpg',
            bytes: data.length,
        },
    }),
});

async function makePng(path, width = 32, height = 32, color = 0xffffffff, pattern = '') {
    const img = new Jimp({ width, height, color });
    if (pattern === 'vertical') {
        for (let y = 0; y < height; y++)
            for (let x = 0; x < Math.floor(width / 2); x++)
                img.setPixelColor(0x000000ff, x, y);
    }
    else if (pattern === 'horizontal') {
        for (let y = 0; y < Math.floor(height / 2); y++)
            for (let x = 0; x < width; x++)
                img.setPixelColor(0x000000ff, x, y);
    }
    else if (pattern === 'checker') {
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++)
                if ((x + y) % 2 === 0)
                    img.setPixelColor(0x000000ff, x, y);
    }
    else if (pattern === 'diagonal') {
        for (let y = 0; y < height; y++)
            for (let x = 0; x < width; x++)
                if (x === y)
                    img.setPixelColor(0x000000ff, x, y);
    }
    const buf = await img.getBuffer('image/png');
    await writeFile(path, buf);
}

function fakeItem(fp, dhash, fileid = '') {
    return {
        path: `/tmp/${fp}.png`,
        sender: 'tester',
        at: Date.now(),
        sent: false,
        fp,
        dhash,
        fileid,
        w: 100,
        h: 100,
    };
}

function dhashOf(seed) {
    return createHash('sha256').update(seed).digest('hex').slice(0, 16);
}

function shuffled(items, seed) {
    const out = items.slice();
    for (let i = out.length - 1; i > 0; i--) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        const j = seed % (i + 1);
        [out[i], out[j]] = [out[j], out[i]];
    }
    return out;
}

test('聚合渲染复用 uvpack 的 Buffer 接口', async () => {
    const aggregate = await readFile(new URL('../dist/features/image-aggregate.js', import.meta.url), 'utf8');
    const render = await readFile(new URL('../dist/features/uvpack/render.mjs', import.meta.url), 'utf8');
    assert.ok(aggregate.includes("import { renderCompositeBuffer } from './uvpack/render.mjs'"));
    assert.ok(render.includes('export async function renderCompositeBuffer'));
    assert.ok(!aggregate.includes('renderPacked'));
    assert.ok(!aggregate.includes('checkCanvas'));
    assert.ok(!aggregate.includes('loggerFallback'));
});

test('图片先预解码再入缓冲，单图只注入一次', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-aggregate-'));
    const imagePath = join(dir, 'pixel.png');
    const key = `test:${dir}`;
    try {
        await makePng(imagePath);
        const prepared = await prepareAggregateImages([{ path: imagePath, sender: 'tester' }]);
        assert.equal(prepared.length, 1);
        assert.ok(prepared[0].img);
        assert.equal(pushPreparedAggImage(key, prepared[0]), 1);
        assert.equal(pushPreparedAggImage(key, prepared[0]), 1);
        assert.equal(pendingAggImages(key).length, 1);

        const blocks = await buildAggregateBlocks(key, {}, console);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].attachment.name, 'aggregate.jpg');
        assert.equal(pendingAggImages(key).length, 0);
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('解码失败的图片不会进入聚合缓冲', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-aggregate-bad-'));
    const imagePath = join(dir, 'broken.png');
    const key = `test:${dir}`;
    try {
        await writeFile(imagePath, Buffer.from('not-an-image'));
        const prepared = await prepareAggregateImages([{ path: imagePath, sender: 'tester' }]);
        assert.equal(prepared.length, 0);
        assert.equal(pendingAggImages(key).length, 0);
        assert.deepEqual(await buildAggregateBlocks(key, {}, console), []);
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('Jimp 不支持解码的单图保留原字节直给', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-aggregate-raw-'));
    const imagePath = join(dir, 'animated.png');
    const key = `test:${dir}`;
    try {
        await writeFile(imagePath, Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from('unsupported-apng'),
        ]));
        const prepared = await prepareAggregateImages([{ path: imagePath, sender: 'tester' }]);
        assert.equal(prepared.length, 1);
        assert.equal(prepared[0].img, null);
        pushPreparedAggImage(key, prepared[0]);
        const blocks = await buildAggregateBlocks(key, {}, console);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].attachment.name, 'aggregate.jpg');
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('多图聚合保持预解码顺序且不再读盘', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-aggregate-multi-'));
    const first = join(dir, 'first.png');
    const second = join(dir, 'second.png');
    const key = `test:${dir}`;
    try {
        await makePng(first, 64, 32, 0xffffffff, 'checker');
        await makePng(second, 32, 64, 0xff0000ff, 'diagonal');
        const prepared = await prepareAggregateImages([
            { path: first, sender: 'a' },
            { path: second, sender: 'b' },
        ]);
        for (const item of prepared)
            pushPreparedAggImage(key, item);
        const pending = pendingAggImages(key);
        assert.deepEqual(pending.map((item) => item.path), [first, second]);
        const stitched = await stitchAggImages(pending);
        assert.ok(stitched);
        assert.deepEqual(stitched.used.map((item) => item.path), [first, second]);
        const blocks = await buildAggregateBlocks(key, {}, console);
        assert.equal(blocks.length, 1);
        assert.equal(pendingAggImages(key).length, 0);
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('100张合并消息重复3次、乱序、交叉与分辨率变化仍稳定去重', () => {
    const key = 'test:hundred';
    clearAggImages(key);
    const common = Array.from({ length: 60 }, (_, i) => dhashOf(`common-${i}`));
    const expected = new Set();
    try {
        for (let batch = 0; batch < 3; batch++) {
            const items = [
                ...common.map((dhash) => fakeItem(`common-${batch}-${dhash}`, dhash)),
                ...Array.from({ length: 40 }, (_, i) => {
                    const n = 1000 + batch * 40 + i;
                    const dhash = dhashOf(`unique-${n}`);
                    expected.add(`unique-${batch}-${i}`);
                    return fakeItem(`unique-${batch}-${i}`, dhash);
                }),
            ];
            for (const item of shuffled(items, 17 + batch))
                pushPreparedAggImage(key, item);
        }
        assert.equal(pendingAggImages(key).length, 180);
        const pending = pendingAggImages(key);
        rememberAggSentPaths(key, pending);
        markAggSent(pending);
        assert.equal(pendingAggImages(key).length, 0);
        assert.equal(pushPreparedAggImage(key, fakeItem('common-again', common[0])), 0);
        assert.equal(expected.size, 120);
    }
    finally {
        clearAggImages(key);
    }
});
