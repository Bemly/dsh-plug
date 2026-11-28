import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
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
    resetAggImages,
    setImageAggregateHooks,
    stitchAggImages,
} from '../dist/features/image-aggregate.js';
import { computeDHash } from '../dist/features/sticker-store.js';
import { renderCompositeBuffer } from '../dist/features/uvpack/render.mjs';

async function pngBuffer(width, height, color, pattern = '') {
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
    return img.getBuffer('image/png');
}

test('reset 清空图片发送指纹，允许新会话再次接收同一图', () => {
    const key = 'test:reset-images';
    clearAggImages(key);
    resetAggImages(key);
    const item = { path: '/tmp/same.png', sender: 'a', at: Date.now(), sent: false, fp: 'same-fp', dhash: undefined, fileid: '', w: 1, h: 1 };
    pushPreparedAggImage(key, item);
    const pending = pendingAggImages(key)[0];
    rememberAggSentPaths(key, [pending]);
    markAggSent([pending]);
    assert.equal(pushPreparedAggImage(key, item), 0);
    resetAggImages(key);
    assert.equal(pushPreparedAggImage(key, item), 1);
    clearAggImages(key);
    resetAggImages(key);
});

test('dHash 使用随包 Jimp，不依赖宿主 sharp', async () => {
    const buf = await pngBuffer(32, 32, 0xffffffff, 'vertical');
    assert.match(await computeDHash(buf), /^[0-9a-f]{16}$/);
});

test('raw 单图与可解码图片同批时不会永久阻塞', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-raw-batch-'));
    const rawPath = join(dir, 'raw.png');
    const pngPath = join(dir, 'decoded.png');
    const key = `test:${dir}`;
    try {
        await writeFile(rawPath, Buffer.concat([
            Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
            Buffer.from('unsupported-apng'),
        ]));
        await writeFile(pngPath, await pngBuffer(32, 32, 0xff0000ff, 'horizontal'));
        const raw = await prepareAggregateImages([{ path: rawPath, sender: 'a' }]);
        const decoded = await prepareAggregateImages([{ path: pngPath, sender: 'b' }]);
        assert.equal(raw.length, 1);
        assert.equal(decoded.length, 1);
        pushPreparedAggImage(key, raw[0]);
        pushPreparedAggImage(key, decoded[0]);
        setImageAggregateHooks({
            probeImageInput: async () => true,
            saveImage: async (data, mediaType) => ({ attachment: { attachmentId: 'x', mediaType, name: 'aggregate.jpg', bytes: data.length } }),
        });
        const blocks = await buildAggregateBlocks(key, {}, console);
        assert.equal(blocks.length, 2);
        assert.equal(pendingAggImages(key).length, 0);
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('同一会话并发构建聚合时只消费一次 pending', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-build-lock-'));
    const first = join(dir, 'first.png');
    const second = join(dir, 'second.png');
    const key = `test:${dir}`;
    try {
        await writeFile(first, await pngBuffer(64, 32, 0xffffffff, 'checker'));
        await writeFile(second, await pngBuffer(32, 64, 0xff0000ff, 'diagonal'));
        const prepared = await prepareAggregateImages([
            { path: first, sender: 'a' },
            { path: second, sender: 'b' },
        ]);
        for (const item of prepared)
            pushPreparedAggImage(key, item);
        let release;
        let started;
        const gate = new Promise((resolve) => { release = resolve; });
        const entered = new Promise((resolve) => { started = resolve; });
        let active = 0;
        let maxActive = 0;
        setImageAggregateHooks({
            probeImageInput: async () => true,
            saveImage: async (data, mediaType) => {
                active++;
                maxActive = Math.max(maxActive, active);
                started();
                await gate;
                active--;
                return { attachment: { attachmentId: 'x', mediaType, name: 'aggregate.jpg', bytes: data.length } };
            },
        });
        const one = buildAggregateBlocks(key, {}, console);
        await entered;
        const two = buildAggregateBlocks(key, {}, console);
        release();
        const [a, b] = await Promise.all([one, two]);
        assert.equal(a.length, 1);
        assert.deepEqual(b, []);
        assert.equal(maxActive, 1);
        assert.equal(pendingAggImages(key).length, 0);
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('极端宽高比聚合前补白且渲染保持等比', async () => {
    const items = [
        { img: new Jimp({ width: 65535, height: 1, color: 0xff0000ff }), w: 65535, h: 1 },
        ...Array.from({ length: 18 }, () => ({ img: new Jimp({ width: 32, height: 32, color: 0xffffffff }), w: 32, h: 32 })),
    ];
    const stitched = await stitchAggImages(items);
    assert.ok(stitched);
    assert.equal(stitched.used.length, 19);

    const source = new Jimp({ width: 4, height: 1, color: 0xff0000ff });
    const rendered = await renderCompositeBuffer([source], {
        canvas: { W: 4, H: 2 },
        placements: [{ idx: 0, x: 0, y: 0, w: 4, h: 2 }],
    }, { label: false });
    const out = await Jimp.read(rendered);
    const rgba = (value) => ({ r: (value >>> 24) & 255, g: (value >>> 16) & 255, b: (value >>> 8) & 255 });
    const top = rgba(out.getPixelColor(0, 0));
    const bottom = rgba(out.getPixelColor(0, 1));
    assert.ok(top.r > 240 && top.g < 20 && top.b < 20);
    assert.ok(bottom.r > 240 && bottom.g > 240 && bottom.b > 240);
});
