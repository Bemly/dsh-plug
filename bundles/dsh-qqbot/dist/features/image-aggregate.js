/**
 * 图片聚合 v2（2026-11-26 重写）—— 单图直给；多图合成**一张**，自适应横竖排版。
 *
 * 与 v1 的区别（主人 2026-11-26 定的新规矩）：
 *  1. **不再滚动缓冲、不再 3 张截断**：单条消息里的多图、或合并消息里的多图，
 *     全部合成一张。缓冲/sent 去重保留，只防"同一张图反复烧 token"，不限制张数。
 *  2. **不再输出任何人可见的标记文字**：删掉 `[图片聚合] …` 和 `（↑ xxx 发的图）`。
 *     历史图瘦身改由 magpie-image-slim v0.2 完成，它认通用 image-slim 占位符格式。
 *  3. **打标结果随图入上下文**：入站时把表情库的 desc/tags 写成**固定文本**，
 *     历史轮次 slim 掉图片块后仍保留这段文本 —— 缓存前缀稳定，且模型知道图内容。
 *  4. **长边上限 2560px，只缩不放**（主人实测 1120 tokens 预算）。
 *     自适应排版：横排 / 竖排 / 网格，取"最贴合整体宽高比"的布局。
 *  5. 只有当前模型**声明了 image 输入**才走这条；纯文本模型跳过。
 *  6. 拼接异步，失败静默，绝不阻断入站主链。
 */
import { existsSync, readFileSync, writeFileSync, openSync, readSync, closeSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
let jimpMod;
async function loadJimp() {
    if (jimpMod)
        return jimpMod;
    try {
        jimpMod = (await import('jimp'));
        return jimpMod;
    }
    catch {
        return undefined;
    }
}
/** 长边硬上限（px）：只缩不放 */
export const MAX_EDGE = 2560;
/** 网格候选列数（1=竖排，2~4=网格/横排） */
const COLS_CANDIDATES = [1, 2, 3, 4];
/** 打标文本采用 image-slim 通用占位符格式，无自定义标记（见 describeImages） */
/** 会话 → 待注入的图（保留缓冲，仅用于去重，不再限制张数） */
const buffers = new Map();
/**
 * 会话 → 已注入过的图片**内容哈希**集合（v2.1：不再用路径）。
 * 同一张图换路径/换文件名也能拦住；持久化到 sent-index.json，DSH 重启后仍有效。
 */
const sentFingerprints = new Map();
const SENT_KEEP = 128;
let sentIndexFile = '';
/** 本插件产出的附件 id 台账（保留兼容，v2 下不再做 DSH 侧历史压缩） */
const OUR_ATTACH = new Set();
let ourAttachFile = '';
const OUR_ATTACH_KEEP = 2000;
export function initAggregateRegistry(dataRoot) {
    try {
        if (!dataRoot)
            return;
        sentIndexFile = join(dataRoot, '.qqbot', 'aggregate-sent-index.json');
        loadSentIndex();
        ourAttachFile = join(dataRoot, '.qqbot', 'aggregate-ids.json');
        if (!existsSync(ourAttachFile))
            return;
        const arr = JSON.parse(readFileSync(ourAttachFile, 'utf8'));
        if (Array.isArray(arr))
            for (const id of arr)
                if (typeof id === 'string' && id)
                    OUR_ATTACH.add(id);
    }
    catch { /* 台账坏了就当空 */ }
}
export function noteOurAttachment(id) {
    try {
        const v = String(id ?? '');
        if (!v)
            return;
        OUR_ATTACH.add(v);
        if (OUR_ATTACH.size > OUR_ATTACH_KEEP) {
            const drop = OUR_ATTACH.size - OUR_ATTACH_KEEP;
            let n = 0;
            for (const k of OUR_ATTACH) {
                if (n >= drop)
                    break;
                OUR_ATTACH.delete(k);
                n += 1;
            }
        }
        if (ourAttachFile) {
            try {
                writeFileSync(ourAttachFile, JSON.stringify([...OUR_ATTACH]), 'utf8');
            }
            catch { /* ignore */ }
        }
    }
    catch { /* ignore */ }
}
export function isOurAttachment(id) {
    const v = String(id ?? '');
    return !!v && OUR_ATTACH.has(v);
}
let probeImageInput;
let saveImage;
/** 打标查询钩子：bootstrap 注入，输入本地路径，返回 { desc, tags } 或 undefined */
let lookupTags;
export function setImageAggregateHooks(hooks) {
    if (hooks.probeImageInput)
        probeImageInput = hooks.probeImageInput;
    if (hooks.saveImage)
        saveImage = hooks.saveImage;
    if (hooks.lookupTags)
        lookupTags = hooks.lookupTags;
}
function bufferOf(key) {
    let arr = buffers.get(key);
    if (!arr) {
        arr = [];
        buffers.set(key, arr);
    }
    return arr;
}
/**
 * 图片内容指纹（2026-11-26 v2.1 修）：
 *
 * 为什么不能只用路径去重 —— 同一张表情包被重复发送时，QQ 每次给的是不同 URL/不同下载路径
 * （有时还换文件名），`sentPaths` 里比路径永远比不中 ⇒ 同一张图被反复注入：
 * 每条新消息都多一份「图片块 + 打标文本」，历史前缀被不断推后，缓存几乎全废。
 * 实测：同一 sha256 的图在会话里被注入 3 次，打标文本重复 7 处。
 *
 * 改用「内容哈希」当去重键：同一张图无论换几次路径/文件名，只注入一次。
 * 顺带把去重表持久化（见 sentIndexFile），DSH 重启后仍然有效。
 */
function fingerprintOf(path) {
    try {
        const buf = readFileSync(path);
        return createHash('sha256').update(buf).digest('hex');
    }
    catch {
        return '';
    }
}
/**
 * 把一条消息里的图片塞进缓冲。v2.1：按**内容哈希**去重（不再只看路径）。
 */
export function pushAggImage(key, path, sender, _max) {
    if (!path || !existsSync(path))
        return 0;
    const fp = fingerprintOf(path);
    if (!fp)
        return bufferOf(key).length;
    // 已注入过的内容（同图换路径也能拦住）
    if (sentFingerprints.get(key)?.has(fp))
        return bufferOf(key).length;
    const arr = bufferOf(key);
    if (arr.some((i) => i.fp === fp))
        return arr.length;
    arr.push({ path, fp, sender: sender || '某人', at: Date.now(), sent: false });
    return arr.length;
}
export function pendingAggImages(key) {
    return bufferOf(key).filter((i) => !i.sent);
}
export function markAggSent(items) {
    for (const i of items)
        i.sent = true;
}
/**
 * 记住这些图已经注入过（按内容哈希）。持久化，跨重启有效。
 */
export function rememberAggSentPaths(key, items) {
    if (!items || items.length === 0)
        return;
    let set = sentFingerprints.get(key);
    if (!set) {
        set = new Set();
        sentFingerprints.set(key, set);
    }
    for (const it of items) {
        const fp = typeof it === 'string' ? it : it?.fp;
        if (fp)
            set.add(fp);
    }
    while (set.size > SENT_KEEP) {
        const first = set.values().next().value;
        set.delete(first);
    }
    persistSentIndex();
}
/** 把去重表落盘（失败静默：纯粹是优化，不影响主链） */
function persistSentIndex() {
    if (!sentIndexFile)
        return;
    try {
        const out = {};
        for (const [k, set] of sentFingerprints)
            out[k] = [...set];
        writeFileSync(sentIndexFile, JSON.stringify(out), 'utf8');
    }
    catch { /* ignore */ }
}
/** 启动时读回去重表 */
function loadSentIndex() {
    if (!sentIndexFile || !existsSync(sentIndexFile))
        return;
    try {
        const raw = JSON.parse(readFileSync(sentIndexFile, 'utf8'));
        for (const [k, arr] of Object.entries(raw ?? {})) {
            if (Array.isArray(arr))
                sentFingerprints.set(k, new Set(arr.filter((x) => typeof x === 'string')));
        }
    }
    catch { /* 坏文件当空 */ }
}
export function clearAggImages(key) {
    buffers.delete(key);
}
/**
 * 自适应排版：在候选列数里挑"网格宽高比最接近图片平均宽高比"的布局。
 * 原则：只缩不放，长边交给 canvas 收敛；布局只决定横/竖/网格的形状。
 */
function planLayout(loaded) {
    let best;
    let maxW = 0, maxH = 0;
    for (const x of loaded) {
        maxW = Math.max(maxW, x.w);
        maxH = Math.max(maxH, x.h);
    }
    let aspectSum = 0;
    for (const x of loaded)
        aspectSum += x.w / x.h;
    const avgAspect = aspectSum / loaded.length;
    for (const cols of COLS_CANDIDATES) {
        if (cols > loaded.length)
            continue;
        const rows = Math.ceil(loaded.length / cols);
        const gridAspect = (maxW * cols) / (maxH * rows);
        const fit = 1 / (1 + Math.abs(Math.log(gridAspect / avgAspect)));
        const candidate = { cols, rows, cellW: maxW, cellH: maxH, fit };
        if (!best || candidate.fit > best.fit)
            best = candidate;
    }
    return best ?? { cols: 1, rows: loaded.length, cellW: maxW, cellH: maxH, fit: 0 };
}
/**
 * 把若干张图合成**一张**，自适应横竖网格，长边 ≤ MAX_EDGE，只缩不放。
 */
export async function stitchAggImages(items) {
    if (items.length === 0)
        return undefined;
    const jimp = await loadJimp();
    if (!jimp)
        return undefined;
    const { Jimp } = jimp;
    const loaded = [];
    for (const it of items) {
        try {
            if (!existsSync(it.path))
                continue;
            const img = await Jimp.read(it.path);
            const w = img.bitmap.width, h = img.bitmap.height;
            if (w <= 0 || h <= 0)
                continue;
            loaded.push({ img, src: it, w, h });
        }
        catch {
            /* 单张读不了就跳过 */
        }
    }
    if (loaded.length === 0)
        return undefined;
    const layout = planLayout(loaded);
    let cellW = layout.cellW, cellH = layout.cellH;
    const longest = Math.max(cellW * layout.cols, cellH * layout.rows);
    if (longest > MAX_EDGE) {
        const scale = MAX_EDGE / longest;
        cellW = Math.max(1, Math.round(cellW * scale));
        cellH = Math.max(1, Math.round(cellH * scale));
    }
    const W = cellW * layout.cols;
    const H = cellH * layout.rows;
    const canvas = new Jimp({ width: W, height: H, color: 0xffffffff });
    loaded.forEach((x, idx) => {
        // 只缩不放
        const scale = Math.min(cellW / x.w, cellH / x.h, 1);
        const iw = Math.max(1, Math.round(x.w * scale));
        const ih = Math.max(1, Math.round(x.h * scale));
        if (iw !== x.w || ih !== x.h)
            x.img.resize({ w: iw, h: ih });
        const col = idx % layout.cols;
        const row = Math.floor(idx / layout.cols);
        canvas.composite(x.img, col * cellW + Math.floor((cellW - iw) / 2), row * cellH + Math.floor((cellH - ih) / 2));
    });
    const buf = await canvas.getBuffer('image/jpeg', { quality: 85 });
    return {
        data: new Uint8Array(buf),
        width: W,
        height: H,
        used: loaded.map((u) => u.src),
        layout: `${layout.cols}×${layout.rows}`,
    };
}
/**
 * 生成**固定**的打标描述文本，采用 image-slim 通用占位符格式：
 *   [X.XX MB image left out here: 图1 <desc>；图2 <desc>]
 *
 * 为什么不自造标记：magpie-image-slim 已用标准正则识别这种占位符，
 * 直接复用 ⇒ 不绑定 QQ / 不绑定具体插件，任何一路图片都能被同一套机制瘦身。
 * 打标内容写进占位符的说明部分，历史轮次图块被 slim 掉后仍保留这段文字。
 * bytes 传实际附件字节数（拿不到时 0），保证格式与 image-slim 一致。
 */
export function describeImages(items, bytes) {
    const parts = items.map((it, idx) => {
        const meta = it.tags && typeof it.tags === 'object' ? it.tags : {};
        const desc = typeof meta.desc === 'string' ? meta.desc.trim() : '';
        const tags = Array.isArray(meta.tags) ? meta.tags.filter((t) => typeof t === 'string' && t.trim()).slice(0, 5) : [];
        const text = desc || tags.join('、') || '未打标图片';
        return `图${idx + 1} ${text}`;
    });
    const mb = (Number(bytes) / 1048576 || 0).toFixed(2);
    return `[${mb} MB image left out here: ${parts.join('；')}]`;
}
/**
 * 真正干活：模型支持读图时，把待注入的图变成 content blocks。
 * - 单图：原图直给（长边 >2560 才缩），后跟固定打标文本。
 * - 多图：合成一张，后跟固定打标文本。
 */
export async function buildAggregateBlocks(key, agent, logger) {
    const items = pendingAggImages(key);
    if (items.length === 0)
        return [];
    if (!probeImageInput || !saveImage) {
        logger?.debug?.('[图片聚合v2] 宿主钩子没注入（没重启 dsh？），跳过');
        return [];
    }
    let capable;
    try {
        capable = await probeImageInput(agent);
    }
    catch (e) {
        logger?.debug?.(`[图片聚合v2] 模型能力探测失败，跳过: ${e instanceof Error ? e.message : String(e)}`);
        return [];
    }
    if (capable !== true) {
        logger?.debug?.('[图片聚合v2] 当前模型不声明 image 输入，跳过');
        return [];
    }
    // 每张图的打标结果（入站时固定下来）
    const tagged = items.map((it) => {
        let meta;
        try { meta = lookupTags?.(it.path); } catch { meta = undefined; }
        return { ...it, tags: meta };
    });
    if (tagged.length === 1) {
        const one = tagged[0];
        try {
            let buf = readFileSync(one.path);
            const jimp = await loadJimp();
            if (jimp) {
                const img = await jimp.Jimp.read(one.path);
                const w = img.bitmap.width, h = img.bitmap.height;
                const longest = Math.max(w, h);
                if (longest > MAX_EDGE && w > 0 && h > 0) {
                    const scale = MAX_EDGE / longest;
                    img.resize({ w: Math.max(1, Math.round(w * scale)), h: Math.max(1, Math.round(h * scale)) });
                    buf = await img.getBuffer('image/jpeg', { quality: 88 });
                }
            }
            if (buf.length === 0)
                return [];
            const saved = await saveImage(new Uint8Array(buf), mediaTypeOf(one.path));
            if (!saved || !saved.attachment)
                return [];
            markAggSent([one]);
            rememberAggSentPaths(key, [one]);
            logger?.debug?.(`[图片聚合v2] 单图直给: ${one.path}`);
            return [
                { type: 'image', attachment: saved.attachment },
                { type: 'text', text: describeImages([one], saved.attachment?.bytes) },
            ];
        }
        catch (e) {
            logger?.warn?.(`[图片聚合v2] 单图注入失败: ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }
    const stitched = await stitchAggImages(tagged);
    if (!stitched)
        return [];
    let saved;
    try {
        saved = await saveImage(stitched.data, 'image/jpeg');
    }
    catch (e) {
        logger?.warn?.(`[图片聚合v2] 存图失败，跳过: ${e instanceof Error ? e.message : String(e)}`);
        return [];
    }
    if (!saved || !saved.attachment)
        return [];
    markAggSent(stitched.used);
    rememberAggSentPaths(key, stitched.used);
    logger?.debug?.(`[图片聚合v2] 合成 ${stitched.used.length} 张 → ${stitched.width}x${stitched.height} (${stitched.layout})`);
    return [
        { type: 'image', attachment: saved.attachment },
        { type: 'text', text: describeImages(tagged, saved.attachment?.bytes) },
    ];
}
/** 媒体类型：先看真实字节，后缀兜底 */
function mediaTypeOf(path) {
    try {
        const fd = openSync(path, 'r');
        try {
            const head = Buffer.alloc(12);
            const n = readSync(fd, head, 0, 12, 0);
            if (n >= 12) {
                if (head[0] === 0x89 && head[1] === 0x50 && head[2] === 0x4e && head[3] === 0x47)
                    return 'image/png';
                if (head[0] === 0xff && head[1] === 0xd8 && head[2] === 0xff)
                    return 'image/jpeg';
                if (head[0] === 0x47 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x38)
                    return 'image/gif';
                if (head[0] === 0x52 && head[1] === 0x49 && head[2] === 0x46 && head[3] === 0x46
                    && head[8] === 0x57 && head[9] === 0x45 && head[10] === 0x42 && head[11] === 0x50)
                    return 'image/webp';
            }
        }
        finally {
            closeSync(fd);
        }
    }
    catch { /* 读不到就走后缀兜底 */ }
    const p = path.toLowerCase();
    if (p.endsWith('.png'))
        return 'image/png';
    if (p.endsWith('.webp'))
        return 'image/webp';
    if (p.endsWith('.gif'))
        return 'image/gif';
    return 'image/jpeg';
}
