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
/**
 * MaxRects 矩形装箱 —— 纹理图集（sprite sheet / UV atlas）的工业标准算法，
 * Unity SpriteAtlas 与 TexturePacker 默认用它，空间利用率通常 85%~95%。
 *
 * 2026-11-27 主人指出「每张图都是同样大小」的问题后替换掉原来的统一网格：
 * 旧做法把所有图塞进等大的格子，小图周围大片空白、大图被压扁，分辨率全浪费。
 * 现在按**每张图的真实宽高**动态找位置（BSSF：Best Short Side Fit，
 * 每次挑"放进去后剩下短边最短"的那个空洞），紧凑贴合、不再留格子。
 */
class MaxRectsBin {
    constructor(width, height) {
        this.free = [{ x: 0, y: 0, w: width, h: height }];
        this.used = [];
    }
    /** 放入一个 w×h 的矩形；放不下返回 null。策略：Best Short Side Fit */
    insert(w, h) {
        let best = null;
        for (const fr of this.free) {
            if (fr.w < w || fr.h < h)
                continue;
            const dw = fr.w - w;
            const dh = fr.h - h;
            const shortSide = Math.min(dw, dh);
            const longSide = Math.max(dw, dh);
            if (!best
                || shortSide < best.shortSide
                || (shortSide === best.shortSide && longSide < best.longSide)) {
                best = { x: fr.x, y: fr.y, w, h, shortSide, longSide };
            }
        }
        if (!best)
            return null;
        this._place(best);
        return best;
    }
    _place(node) {
        const next = [];
        for (const fr of this.free) {
            // 不相交 → 原样保留
            if (node.x >= fr.x + fr.w || node.x + node.w <= fr.x
                || node.y >= fr.y + fr.h || node.y + node.h <= fr.y) {
                next.push(fr);
                continue;
            }
            // 相交 → 把剩余空间切成四个方向的碎片
            if (node.x > fr.x)
                next.push({ x: fr.x, y: fr.y, w: node.x - fr.x, h: fr.h });
            if (node.x + node.w < fr.x + fr.w)
                next.push({ x: node.x + node.w, y: fr.y, w: fr.x + fr.w - (node.x + node.w), h: fr.h });
            if (node.y > fr.y)
                next.push({ x: fr.x, y: fr.y, w: fr.w, h: node.y - fr.y });
            if (node.y + node.h < fr.y + fr.h)
                next.push({ x: fr.x, y: node.y + node.h, w: fr.w, h: fr.y + fr.h - (node.y + node.h) });
        }
        this.free = this._prune(next);
        this.used.push(node);
    }
    /** 去掉被其它碎片完全包含的小矩形（MaxRects 必须的合并步骤，否则碎片爆炸） */
    _prune(rects) {
        const out = [];
        for (let i = 0; i < rects.length; i++) {
            const a = rects[i];
            if (a.w <= 0 || a.h <= 0)
                continue;
            let contained = false;
            for (let j = 0; j < rects.length; j++) {
                if (i === j)
                    continue;
                const b = rects[j];
                if (a.x >= b.x && a.y >= b.y
                    && a.x + a.w <= b.x + b.w && a.y + a.h <= b.y + b.h) {
                    contained = true;
                    break;
                }
            }
            if (!contained)
                out.push(a);
        }
        return out;
    }
}
/**
 * 把一组带原始宽高的图打包进不超过 maxEdge 的画布。
 * 先按面积估一个统一缩放（保证总像素能塞进 0.85 利用率），放不下就逐步缩小重试。
 * @returns {{width:number,height:number,placements:Array}} 或 null
 */
export function packRects(loaded, maxEdge) {
    if (!Array.isArray(loaded) || loaded.length === 0)
        return null;
    const totalArea = loaded.reduce((s, x) => s + x.w * x.h, 0);
    if (!(totalArea > 0))
        return null;
    const targetArea = maxEdge * maxEdge * 0.85;
    let scale = Math.min(1, Math.sqrt(targetArea / totalArea));
    for (let attempt = 0; attempt < 14; attempt++) {
        const items = loaded.map((x) => ({
            src: x,
            w: Math.max(1, Math.round(x.w * scale)),
            h: Math.max(1, Math.round(x.h * scale)),
        }));
        // 面积大的先放：MaxRects 的标准预处理，能显著提高利用率
        const order = items.slice().sort((a, b) => (b.w * b.h) - (a.w * a.h));
        const bin = new MaxRectsBin(maxEdge, maxEdge);
        const placements = [];
        let ok = true;
        for (const it of order) {
            const node = bin.insert(it.w, it.h);
            if (!node) {
                ok = false;
                break;
            }
            placements.push({ src: it.src, x: node.x, y: node.y, w: it.w, h: it.h });
        }
        if (ok) {
            // 按实际占用收缩画布：不留右下角空白
            const width = Math.max(...placements.map((p) => p.x + p.w));
            const height = Math.max(...placements.map((p) => p.y + p.h));
            return { width, height, placements, scale };
        }
        scale *= 0.88;
    }
    return null;
}
/** 打标文本已彻底移除（2026-11-26 v2.2）：路径由 DSH 宿主自带，不再重复写。 */
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
export function setImageAggregateHooks(hooks) {
    if (hooks.probeImageInput)
        probeImageInput = hooks.probeImageInput;
    if (hooks.saveImage)
        saveImage = hooks.saveImage;
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
/**
 * 把若干张图合成**一张**：MaxRects 矩形装箱（纹理图集做法），
 * 每张按原始宽高比动态落位，不再套等大格子。长边 ≤ MAX_EDGE。
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
    const packed = packRects(loaded, MAX_EDGE);
    if (!packed)
        return undefined;
    const { width: W, height: H, placements } = packed;
    const canvas = new Jimp({ width: W, height: H, color: 0xffffffff });
    for (const p of placements) {
        const img = p.src.img;
        if (img.bitmap.width !== p.w || img.bitmap.height !== p.h)
            img.resize({ w: p.w, h: p.h });
        canvas.composite(img, p.x, p.y);
    }
    const buf = await canvas.getBuffer('image/jpeg', { quality: 85 });
    return {
        data: new Uint8Array(buf),
        width: W,
        height: H,
        used: loaded.map((u) => u.src),
        layout: `packed ${placements.length}@${W}x${H} scale=${packed.scale.toFixed(2)}`,
    };
}
/**
 * 真正干活：模型支持读图时，把待注入的图变成 content blocks。
 *
 * 2026-11-26 v2.2（主人定）：**只注入 ImageBlock，不再附带任何文本**。
 * 图片的本地路径由 DSH 宿主自己生成（dsh-llm-pi-ai 的 requestImageHandleText：
 * `Image "xxx" (sha256:…); … Normalized copy (read-only…): "/path/…"`），
 * 那段文本每轮随 image block 现生成、内容恒定，模型可据此 read_image。
 * 我们自己再写一份打标/路径只会重复烧 token，且打标是异步的（入站时常常还没打完，
 * 曾出现"未打标图片"）。所以这里彻底不写文本。
 * - 单图：原图直给（长边 >2560 才缩）。
 * - 多图：合成一张。
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
    if (items.length === 1) {
        const one = items[0];
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
            ];
        }
        catch (e) {
            logger?.warn?.(`[图片聚合v2] 单图注入失败: ${e instanceof Error ? e.message : String(e)}`);
            return [];
        }
    }
    const stitched = await stitchAggImages(items);
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
