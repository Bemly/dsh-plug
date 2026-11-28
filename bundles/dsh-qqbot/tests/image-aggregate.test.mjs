import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    buildAggregateBlocks,
    clearAggImages,
    pendingAggImages,
    pushAggImage,
    setImageAggregateHooks,
} from '../dist/features/image-aggregate.js';

const PNG_1X1 = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2nKsAAAAASUVORK5CYII=',
    'base64',
);

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

test('聚合缓冲可注入单图且不会重复入队', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-aggregate-'));
    const imagePath = join(dir, 'pixel.png');
    const key = `test:${dir}`;
    try {
        await writeFile(imagePath, PNG_1X1);
        assert.equal(pushAggImage(key, imagePath, 'tester'), 1);
        assert.equal(pushAggImage(key, imagePath, 'tester'), 1);
        assert.equal(pendingAggImages(key).length, 1);

        const blocks = await buildAggregateBlocks(key, {}, console);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].type, 'image');
        assert.equal(blocks[0].attachment.name, 'aggregate.jpg');
        assert.equal(pendingAggImages(key).length, 0);
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});

test('单图解码失败时保留原始字节继续注入', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-aggregate-raw-'));
    const imagePath = join(dir, 'unsupported.png');
    const key = `test:${dir}`;
    try {
        await writeFile(imagePath, Buffer.from('not-a-decodable-image'));
        assert.equal(pushAggImage(key, imagePath, 'tester'), 1);
        const blocks = await buildAggregateBlocks(key, {}, console);
        assert.equal(blocks.length, 1);
        assert.equal(blocks[0].type, 'image');
        assert.equal(blocks[0].attachment.name, 'aggregate.jpg');
    }
    finally {
        clearAggImages(key);
        await rm(dir, { recursive: true, force: true });
    }
});
