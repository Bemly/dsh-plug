import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Jimp } from 'jimp';
import {
    aggregateMemoryStats,
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

test('不同纯色图不会因 dHash 相同被误去重', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-solid-colors-'));
    const key = `test:${dir}`;
    try {
        const colors = [0xff0000ff, 0xe00000ff, 0x00ff00ff, 0x0000ffff];
        for (let i = 0; i < colors.length; i++) {
            const path = join(dir, `${i}.png`);
            await writeFile(path, await pngBuffer(32, 32, colors[i]));
            const prepared = await prepareAggregateImages([{ path, sender: 'a' }]);
            pushPreparedAggImage(key, prepared[0]);
        }
        assert.equal(pendingAggImages(key).length, 4);
    }
    finally {
        clearAggImages(key);
        resetAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('重复极端图清理不会删除先前 pending 的归一化文件', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-extreme-dup-'));
    const path = join(dir, 'extreme.png');
    const key = `test:${dir}`;
    try {
        const img = new Jimp({ width: 5000, height: 2, color: 0xff0000ff });
        await writeFile(path, await img.getBuffer('image/png'));
        const first = await prepareAggregateImages([{ path, sender: 'a' }]);
        const second = await prepareAggregateImages([{ path, sender: 'a' }]);
        pushPreparedAggImage(key, first[0]);
        pushPreparedAggImage(key, second[0]);
        assert.equal(pendingAggImages(key).length, 1);
        assert.equal(existsSync(pendingAggImages(key)[0].path), true);
    }
    finally {
        clearAggImages(key);
        resetAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('超过64个会话的 pending 落盘且可恢复', () => {
    const keys = Array.from({ length: 65 }, (_, i) => `test:spill-${i}`);
    try {
        for (let i = 0; i < keys.length; i++) {
            pushPreparedAggImage(keys[i], {
                path: `/tmp/spill-${i}.png`, sourcePath: `/tmp/spill-${i}.png`, sender: 'a', at: Date.now(), sent: false,
                decoded: false, w: 0, h: 0, mediaType: 'image/png', fp: `spill-${i}`, fileid: '', ownedCache: false,
            });
        }
        assert.equal(pendingAggImages(keys[0]).length, 1);
        assert.ok(aggregateMemoryStats().sequenceSessions <= 64);
    }
    finally {
        for (const key of keys)
            clearAggImages(key);
    }
});

test('超过100张时一次唤醒按批次全部消费并保持序号', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-over-100-'));
    const path = join(dir, 'pixel.png');
    const key = `test:${dir}`;
    try {
        await writeFile(path, await pngBuffer(8, 8, 0xffffffff));
        for (let i = 0; i < 101; i++) {
            pushPreparedAggImage(key, {
                path, sourcePath: path, sender: 'a', at: Date.now(), sent: false, decoded: false,
                w: 0, h: 0, mediaType: 'image/png', fp: `over-${i}`, fileid: '', ownedCache: false,
            });
        }
        const pending = pendingAggImages(key);
        assert.equal(pending.length, 101);
        assert.equal(pending[100].seq, 101);
        setImageAggregateHooks({
            probeImageInput: async () => true,
            saveImage: async (data, mediaType) => ({ attachment: { attachmentId: 'x', mediaType, name: 'aggregate.jpg', bytes: data.length } }),
        });
        const blocks = await buildAggregateBlocks(key, {}, console);
        assert.equal(blocks.length, 101);
        assert.equal(pendingAggImages(key).length, 0);
    }
    finally {
        clearAggImages(key);
        resetAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
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
