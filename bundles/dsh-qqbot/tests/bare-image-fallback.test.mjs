import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rewriteBareImagePaths } from '../dist/features/md-media-rewrite.js';

const dir = mkdtempSync(join(tmpdir(), 'bare-img-'));
const gif = join(dir, '67e0e1df09c2.gif');
const jpg = join(dir, 'a6fbfa31e42a.jpg');
writeFileSync(gif, 'GIF89a');
writeFileSync(jpg, 'JPEG');

test('converts a lone bare sticker path line into MEDIA marker', () => {
    const input = `才没有换人格 杂鱼亚托莉闭嘴啦\n${gif}`;
    const out = rewriteBareImagePaths(input);
    assert.equal(out, `才没有换人格 杂鱼亚托莉闭嘴啦\n[MEDIA:image|${gif}]`);
});

test('converts multiple lone paths but leaves prose intact', () => {
    const input = `看图\n${gif}\n还有这张\n${jpg}\n就这些`;
    const out = rewriteBareImagePaths(input);
    assert.equal(out, `看图\n[MEDIA:image|${gif}]\n还有这张\n[MEDIA:image|${jpg}]\n就这些`);
});

test('leaves paths embedded in prose untouched', () => {
    const input = `路径是 ${gif} 你看一下`;
    assert.equal(rewriteBareImagePaths(input), input);
});

test('leaves list_stickers tool-result lines (arrow-prefixed) untouched', () => {
    const input = `1. [小鱼/鲸鱼娘] 用过0次\n   描述: ...\n   → ${gif}`;
    assert.equal(rewriteBareImagePaths(input), input);
});

test('leaves markdown image syntax and MEDIA markers untouched', () => {
    const md = `![说明 #200px #200px](${gif})`;
    const marker = `[MEDIA:image|${gif}]`;
    assert.equal(rewriteBareImagePaths(md), md);
    assert.equal(rewriteBareImagePaths(marker), marker);
});

test('leaves non-existent paths untouched', () => {
    const input = `${join(dir, 'missing.gif')}`;
    assert.equal(rewriteBareImagePaths(input), input);
});

test('leaves non-image files untouched', () => {
    const txt = join(dir, 'notes.txt');
    writeFileSync(txt, 'hello');
    assert.equal(rewriteBareImagePaths(txt), txt);
});

test('handles file:// URL', () => {
    const input = `file://${gif}`;
    assert.equal(rewriteBareImagePaths(input), `[MEDIA:image|${gif}]`);
});

test('leaves remote URLs untouched', () => {
    const input = 'https://example.com/a.gif';
    assert.equal(rewriteBareImagePaths(input), input);
});
