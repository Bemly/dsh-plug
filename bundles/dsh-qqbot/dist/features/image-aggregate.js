import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { computeDHash, dhashDistance, extractQqFileId } from './sticker-store.js';
import { pack } from './uvpack/packer.mjs';
import { renderCompositeBuffer } from './uvpack/render.mjs';

export const MAX_AGGREGATE_IMAGES = 100;
const MAX_EDGE = 2560;
const SENT_KEEP = 4096;
const MAX_BUFFER_SESSIONS = 64;
const MAX_SENT_SESSIONS = 512;

const buffers = new Map();
const sentFingerprints = new Map();
let sentIndexFile = '';
const OUR_ATTACH = new Set();
let ourAttachFile = '';
const OUR_ATTACH_KEEP = 2000;
let probeImageInput;
let saveImage;

function touchMap(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
    }
}

function bufferOf(key) {
    const current = buffers.get(key);
    if (current) {
        touchMap(buffers, key, current, MAX_BUFFER_SESSIONS);
        return current;
    }
    const arr = [];
    touchMap(buffers, key, arr, MAX_BUFFER_SESSIONS);
    return arr;
}

function sentSetOf(key) {
    const current = sentFingerprints.get(key);
    if (current) {
        touchMap(sentFingerprints, key, current, MAX_SENT_SESSIONS);
        return current;
    }
    const set = new Set();
    touchMap(sentFingerprints, key, set, MAX_SENT_SESSIONS);
    return set;
}

function mediaTypeOf(buf, path) {
    if (buf.length >= 12) {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
            return 'image/png';
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
            return 'image/jpeg';
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
            return 'image/gif';
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
            && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
            return 'image/webp';
    }
    const lower = String(path ?? '').toLowerCase();
    if (lower.endsWith('.png'))
        return 'image/png';
    if (lower.endsWith('.webp'))
        return 'image/webp';
    if (lower.endsWith('.gif'))
        return 'image/gif';
    return 'image/jpeg';
}

function keysOf(item) {
    const keys = [item.fp];
    if (item.fileid)
        keys.push(`q:${item.fileid}`);
    if (item.dhash)
        keys.push(`d:${item.dhash}`);
    return keys;
}

function matchesStored(item, stored) {
    if (stored === item.fp)
        return true;
    if (item.fileid && stored === `q:${item.fileid}`)
        return true;
    return !!(item.dhash && stored.startsWith('d:')
        && dhashDistance(item.dhash, stored.slice(2)) <= 5);
}

function duplicateInSet(set, item) {
    for (const stored of set) {
        if (matchesStored(item, stored))
            return true;
    }
    return false;
}

function duplicateInArray(arr, item) {
    return arr.some((other) => keysOf(other).some((key) => keysOf(item).includes(key))
        || (item.dhash && other.dhash && dhashDistance(item.dhash, other.dhash) <= 5));
}

function hasImageSignature(buf) {
    if (buf.length < 12)
        return false;
    return (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        || (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        || (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
        || (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46
            && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50);
}

export async function prepareAggregateImages(items, logger) {
    const prepared = [];
    const candidates = (Array.isArray(items) ? items : []).slice(0, MAX_AGGREGATE_IMAGES);
    for (const item of candidates) {
        try {
            if (!item?.path || !existsSync(item.path))
                continue;
            const buf = readFileSync(item.path);
            const fp = createHash('sha256').update(buf).digest('hex');
            const dhash = await computeDHash(buf);
            const fileid = extractQqFileId(item.url ?? '');
            const mediaType = mediaTypeOf(buf, item.path);
            let img = null;
            let w = 0;
            let h = 0;
            try {
                img = await Jimp.read(buf);
                w = img.bitmap.width;
                h = img.bitmap.height;
                if (!w || !h) {
                    if (candidates.length !== 1)
                        continue;
                    img = null;
                }
            }
            catch (err) {
                if (candidates.length !== 1 || !hasImageSignature(buf)) {
                    logger?.warn?.(`[图片聚合] 预解码失败，不入聚合: ${item.path} ${err instanceof Error ? err.message : String(err)}`);
                    continue;
                }
            }
            prepared.push({
                key: item.key ?? '',
                path: item.path,
                url: item.url ?? '',
                sender: item.sender || '某人',
                at: Date.now(),
                sent: false,
                img,
                w,
                h,
                buf,
                mediaType,
                fp,
                dhash,
                fileid,
            });
        }
        catch (err) {
            logger?.warn?.(`[图片聚合] 预处理失败，不入聚合: ${item?.path ?? ''} ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    return prepared;
}

export function pushPreparedAggImage(key, item) {
    if (!item)
        return 0;
    if (duplicateInSet(sentSetOf(key), item))
        return buffers.get(key)?.length ?? 0;
    const arr = bufferOf(key);
    if (duplicateInArray(arr, item))
        return arr.length;
    arr.push({ ...item, key });
    return arr.length;
}

export async function pushAggImage(key, path, sender, url = '') {
    const prepared = await prepareAggregateImages([{ path, sender, url }]);
    return pushPreparedAggImage(key, prepared[0]);
}

export function pendingAggImages(key) {
    const arr = buffers.get(key);
    if (!arr)
        return [];
    touchMap(buffers, key, arr, MAX_BUFFER_SESSIONS);
    return arr.filter((item) => !item.sent);
}

export function markAggSent(items) {
    const byKey = new Map();
    for (const item of items) {
        if (!item?.key)
            continue;
        if (!byKey.has(item.key))
            byKey.set(item.key, new Set());
        byKey.get(item.key).add(item);
    }
    for (const [key, sent] of byKey) {
        const arr = buffers.get(key);
        if (!arr)
            continue;
        const kept = arr.filter((item) => !sent.has(item));
        if (kept.length)
            touchMap(buffers, key, kept, MAX_BUFFER_SESSIONS);
        else
            buffers.delete(key);
    }
}

export function rememberAggSentPaths(key, items) {
    if (!key || !items?.length)
        return;
    const set = sentSetOf(key);
    for (const item of items) {
        if (typeof item === 'string') {
            set.add(item);
            continue;
        }
        for (const stored of keysOf(item))
            set.add(stored);
    }
    while (set.size > SENT_KEEP) {
        const first = set.values().next().value;
        set.delete(first);
    }
    persistSentIndex();
}

function persistSentIndex() {
    if (!sentIndexFile)
        return;
    try {
        const out = {};
        for (const [key, set] of sentFingerprints)
            out[key] = [...set];
        writeFileSync(sentIndexFile, JSON.stringify(out), 'utf8');
    }
    catch { /* 去重表写入失败不影响消息 */ }
}

function loadSentIndex() {
    if (!sentIndexFile || !existsSync(sentIndexFile))
        return;
    try {
        const raw = JSON.parse(readFileSync(sentIndexFile, 'utf8'));
        for (const [key, arr] of Object.entries(raw ?? {})) {
            if (Array.isArray(arr))
                touchMap(sentFingerprints, key, new Set(arr.filter((x) => typeof x === 'string')), MAX_SENT_SESSIONS);
        }
    }
    catch { /* 坏表当空 */ }
}

export function clearAggImages(key) {
    buffers.delete(key);
}

export async function stitchAggImages(items) {
    if (items.length < 2 || items.some((item) => !item.img))
        return undefined;
    const result = pack(
        items.map((item) => ({ w: item.w, h: item.h })),
        { mode: 'auto', preset: 'standard' },
    );
    const buf = await renderCompositeBuffer(items.map((item) => item.img), result, { quality: 90 });
    const c = result.canvas;
    return {
        data: new Uint8Array(buf),
        width: c.W,
        height: c.H,
        used: items,
        layout: `${c.cols}x${c.rows}=${c.tiles}t ${result.stats.mode} ${c.W}x${c.H}`,
    };
}

export async function buildAggregateBlocks(key, agent, logger) {
    const items = pendingAggImages(key).slice(0, MAX_AGGREGATE_IMAGES);
    if (items.length === 0)
        return [];
    if (!probeImageInput || !saveImage) {
        logger?.debug?.('[图片聚合] 宿主钩子未注入，跳过');
        return [];
    }
    let capable;
    try {
        capable = await probeImageInput(agent);
    }
    catch (err) {
        logger?.debug?.(`[图片聚合] 模型能力探测失败: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
    if (capable !== true) {
        logger?.debug?.('[图片聚合] 当前模型不声明 image 输入，跳过');
        return [];
    }

    if (items.length === 1) {
        const one = items[0];
        try {
            let buf = one.buf;
            let mediaType = one.mediaType;
            if (Math.max(one.w, one.h) > MAX_EDGE) {
                const img = one.img.clone();
                const scale = MAX_EDGE / Math.max(one.w, one.h);
                img.resize({
                    w: Math.max(1, Math.round(one.w * scale)),
                    h: Math.max(1, Math.round(one.h * scale)),
                });
                buf = await img.getBuffer('image/jpeg', { quality: 88 });
                mediaType = 'image/jpeg';
            }
            const saved = await saveImage(new Uint8Array(buf), mediaType);
            if (!saved?.attachment)
                return [];
            rememberAggSentPaths(key, [one]);
            markAggSent([one]);
            logger?.debug?.(`[图片聚合] 单图直给: ${one.path}`);
            return [{ type: 'image', attachment: saved.attachment }];
        }
        catch (err) {
            logger?.warn?.(`[图片聚合] 单图注入失败: ${err instanceof Error ? err.message : String(err)}`);
            return [];
        }
    }

    const stitched = await stitchAggImages(items);
    if (!stitched)
        return [];
    try {
        const saved = await saveImage(stitched.data, 'image/jpeg');
        if (!saved?.attachment)
            return [];
        rememberAggSentPaths(key, stitched.used);
        markAggSent(stitched.used);
        logger?.debug?.(`[图片聚合] 合成 ${stitched.used.length} 张 → ${stitched.width}x${stitched.height} (${stitched.layout})`);
        return [{ type: 'image', attachment: saved.attachment }];
    }
    catch (err) {
        logger?.warn?.(`[图片聚合] 存图失败: ${err instanceof Error ? err.message : String(err)}`);
        return [];
    }
}

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
        if (Array.isArray(arr)) {
            for (const id of arr) {
                if (typeof id === 'string' && id)
                    OUR_ATTACH.add(id);
            }
        }
    }
    catch { /* 台账坏了就当空 */ }
}

export function noteOurAttachment(id) {
    try {
        const value = String(id ?? '');
        if (!value)
            return;
        OUR_ATTACH.add(value);
        while (OUR_ATTACH.size > OUR_ATTACH_KEEP) {
            const first = OUR_ATTACH.values().next().value;
            OUR_ATTACH.delete(first);
        }
        if (ourAttachFile)
            writeFileSync(ourAttachFile, JSON.stringify([...OUR_ATTACH]), 'utf8');
    }
    catch { /* ignore */ }
}

export function isOurAttachment(id) {
    return !!String(id ?? '') && OUR_ATTACH.has(String(id));
}

export function setImageAggregateHooks(hooks) {
    if (hooks.probeImageInput)
        probeImageInput = hooks.probeImageInput;
    if (hooks.saveImage)
        saveImage = hooks.saveImage;
}
