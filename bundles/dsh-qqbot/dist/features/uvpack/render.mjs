/**
 * render.mjs — 将打包布局渲染为带清晰序号角标的合成 JPEG 图
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { Jimp, loadFont } from 'jimp';
import { SANS_16_WHITE, SANS_32_WHITE } from 'jimp/fonts';

let font16Promise = null;
let font32Promise = null;

function getFonts() {
    if (!font16Promise) font16Promise = loadFont(SANS_16_WHITE);
    if (!font32Promise) font32Promise = loadFont(SANS_32_WHITE);
    return Promise.all([font16Promise, font32Promise]);
}

/**
 * 渲染合成图并写入 outPath，返回文件字节数
 * @param {Array<Jimp>} jimpImgs
 * @param {object} result pack() 返回结果
 * @param {object} opts
 */
export async function renderComposite(
    jimpImgs,
    result,
    { outPath, quality = 90, bg = 0xffffffff, label = true } = {}
) {
    const { canvas: c, placements } = result;
    const canvas = new Jimp({ width: c.W, height: c.H, color: bg });
    const [font16, font32] = label ? await getFonts() : [null, null];

    for (const p of placements) {
        const src = jimpImgs[p.idx];
        const im = src.clone();
        if (im.bitmap.width !== p.w || im.bitmap.height !== p.h) {
            im.resize({ w: p.w, h: p.h });
        }
        canvas.composite(im, p.x, p.y);

        if (label) {
            const text = String(p.idx + 1);
            const useLarge = Math.min(p.w, p.h) >= 400;
            const font = useLarge ? font32 : font16;
            const padX = useLarge ? 10 : 6;
            const padY = useLarge ? 6 : 4;
            const charW = useLarge ? 20 : 10;
            const textH = useLarge ? 32 : 16;
            const badgeW = Math.min(p.w, text.length * charW + padX * 2);
            const badgeH = Math.min(p.h, textH + padY * 2);
            const badge = new Jimp({ width: badgeW, height: badgeH, color: 0x000000b8 });
            canvas.composite(badge, p.x + 4, p.y + 4);
            canvas.print({
                font,
                x: p.x + 4 + padX,
                y: p.y + 4 + padY,
                text,
            });
        }
    }

    mkdirSync(dirname(outPath), { recursive: true });
    const buf = await canvas.getBuffer('image/jpeg', { quality });
    writeFileSync(outPath, buf);
    return buf.length;
}
