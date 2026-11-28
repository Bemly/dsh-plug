import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Jimp } from 'jimp';
import { colorHashDistance, colorHashOfImage, dhashDistance, dhashOfImage, extractQqFileId } from './sticker-store.js';
import { pack } from './uvpack/packer.mjs';
import { renderCompositeBuffer } from './uvpack/render.mjs';

export const MAX_AGGREGATE_IMAGES = 100;
const MAX_EDGE = 2560;
const MAX_EXTREME_EDGE = 4096;
const MAX_PACK_ASPECT = 128;
const SENT_KEEP = 4096;
const MAX_BUFFER_SESSIONS = 64;
const MAX_SENT_SESSIONS = 512;
const MAX_SENT_TOTAL = 131072;

const buffers = new Map();
const building = new Map();
const sentFingerprints = new Map();
const sequenceByKey = new Map();
let cacheDir = '';
let fallbackCacheDir = '';
let sentIndexFile = '';
const OUR_ATTACH = new Set();
let ourAttachFile = '';
const OUR_ATTACH_KEEP = 2000;
let probeImageInput;
let saveImage;

function ensureCacheDir() {
    if (!cacheDir) {
        if (!fallbackCacheDir)
            fallbackCacheDir = mkdtempSync(join(tmpdir(), 'dsh-botqq-aggregate-'));
        return fallbackCacheDir;
    }
    mkdirSync(cacheDir, { recursive: true });
    return cacheDir;
}

function atomicWrite(file, data) {
    const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
    try {
        writeFileSync(tmp, data, 'utf8');
        renameSync(tmp, file);
    }
    catch (err) {
        try {
            unlinkSync(tmp);
        }
        catch { /* ignore */ }
        throw err;
    }
}

function pendingFileOf(key) {
    const id = createHash('sha256').update(key).digest('hex').slice(0, 32);
    return join(ensureCacheDir(), `pending-${id}.json`);
}

function persistBuffer(key, items) {
    if (!items?.length) {
        try {
            unlinkSync(pendingFileOf(key));
        }
        catch { /* ignore */ }
        return;
    }
    atomicWrite(pendingFileOf(key), JSON.stringify(items));
}

function cleanupItem(item) {
    if (!item?.ownedCache || !item.path)
        return;
    try {
        unlinkSync(item.path);
    }
    catch { /* ignore */ }
}

function cleanupItems(items) {
    for (const item of items ?? [])
        cleanupItem(item);
}

function clearBuffer(key) {
    const items = loadBuffer(key);
    if (items)
        cleanupItems(items);
    buffers.delete(key);
    sequenceByKey.delete(key);
    try {
        unlinkSync(pendingFileOf(key));
    }
    catch { /* ignore */ }
}

function touchMap(map, key, value, limit) {
    map.delete(key);
    map.set(key, value);
    while (map.size > limit) {
        const oldest = map.keys().next().value;
        map.delete(oldest);
    }
}

function touchBuffers(key, items) {
    buffers.delete(key);
    buffers.set(key, items);
    while (buffers.size > MAX_BUFFER_SESSIONS) {
        const oldest = buffers.keys().next().value;
        const spilled = buffers.get(oldest);
        try {
            persistBuffer(oldest, spilled);
        }
        catch {
            break;
        }
        buffers.delete(oldest);
        sequenceByKey.delete(oldest);
    }
}

function loadBuffer(key) {
    const cached = buffers.get(key);
    if (cached)
        return cached;
    try {
        const raw = JSON.parse(readFileSync(pendingFileOf(key), 'utf8'));
        if (Array.isArray(raw)) {
            const items = raw.filter((item) => item && typeof item.path === 'string');
            buffers.set(key, items);
            for (const item of items)
                sequenceByKey.set(key, Math.max(sequenceByKey.get(key) ?? 0, Number(item.seq) || 0));
            return items;
        }
    }
    catch { /* 没有落盘 pending */ }
    return undefined;
}

function bufferOf(key) {
    const current = loadBuffer(key);
    if (current) {
        touchBuffers(key, current);
        return current;
    }
    const arr = [];
    touchBuffers(key, arr);
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

function trimSentTotal() {
    let total = 0;
    for (const set of sentFingerprints.values())
        total += set.size;
    while (total > MAX_SENT_TOTAL && sentFingerprints.size) {
        const oldest = sentFingerprints.keys().next().value;
        const removed = sentFingerprints.get(oldest)?.size ?? 0;
        sentFingerprints.delete(oldest);
        total -= removed;
    }
}

function mediaTypeOf(buf, path) {
    if (buf.length >= 12) {
        if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
            return 'image/png';
        if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
            return 'image/jpeg';
        if (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
            return 'image/gif';
        if (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x52
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

function sameDHash(a, b) {
    if (!a?.dhash || !b?.dhash || dhashDistance(a.dhash, b.dhash) > 5)
        return false;
    return !a.color || !b.color || colorHashDistance(a.color, b.color) <= 8;
}

function keysOf(item) {
    const keys = [item.fp];
    if (item.fileid)
        keys.push(`q:${item.fileid}`);
    if (item.dhash)
        keys.push(`d:${item.dhash}${item.color ? `:${item.color}` : ''}`);
    return keys;
}

function matchesStored(item, stored) {
    if (stored === item.fp)
        return true;
    if (item.fileid && stored === `q:${item.fileid}`)
        return true;
    if (!item.dhash || !stored.startsWith('d:'))
        return false;
    const [hash, color] = stored.slice(2).split(':');
    return dhashDistance(item.dhash, hash) <= 5
        && (!color || !item.color || colorHashDistance(item.color, color) <= 8);
}

function duplicateInSet(set, item) {
    for (const stored of set) {
        if (matchesStored(item, stored))
            return true;
    }
    return false;
}

function duplicateInArray(arr, item) {
    return arr.some((other) => keysOf(other).some((key) => keysOf(item).includes(key)) || sameDHash(other, item));
}

function hasImageSignature(buf) {
    if (buf.length < 12)
        return false;
    return (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47)
        || (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff)
        || (buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38)
        || (buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x52
            && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50);
}

function normalizeForPack(img, w, h) {
    let out = img;
    if (Math.max(w, h) > MAX_EXTREME_EDGE) {
        out = out.clone();
        if (w >= h)
            out.resize({ w: MAX_EXTREME_EDGE });
        else
            out.resize({ h: MAX_EXTREME_EDGE });
        w = out.bitmap.width;
        h = out.bitmap.height;
    }
    const ratio = w / h;
    if (ratio <= MAX_PACK_ASPECT && ratio >= 1 / MAX_PACK_ASPECT)
        return { img: out, w, h, changed: out !== img };
    if (w >= h) {
        const ph = Math.ceil(w / MAX_PACK_ASPECT);
        const padded = new Jimp({ width: w, height: ph, color: 0xffffffff });
        padded.composite(out, 0, Math.floor((ph - h) / 2));
        return { img: padded, w, h: ph, changed: true };
    }
    const pw = Math.ceil(h / MAX_PACK_ASPECT);
    const padded = new Jimp({ width: pw, height: h, color: 0xffffffff });
    padded.composite(out, Math.floor((pw - w) / 2), 0);
    return { img: padded, w: pw, h, changed: true };
}

export async function prepareAggregateImages(items, logger) {
    const prepared = [];
    const candidates = Array.isArray(items) ? items : [];
    for (const item of candidates) {
        try {
            if (!item?.path || !existsSync(item.path))
                continue;
            const buf = readFileSync(item.path);
            const fp = createHash('sha256').update(buf).digest('hex');
            const fileid = extractQqFileId(item.url ?? '');
            const mediaType = mediaTypeOf(buf, item.path);
            let img = null;
            let w = 0;
            let h = 0;
            let color;
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
            let path = item.path;
            let ownedCache = false;
            let outputMediaType = mediaType;
            if (img) {
                const dhashValue = dhashOfImage(img);
                const colorValue = colorHashOfImage(img);
                const normalized = normalizeForPack(img, w, h);
                w = normalized.w;
                h = normalized.h;
                if (normalized.changed) {
                    path = join(ensureCacheDir(), `${fp}-${randomBytes(6).toString('hex')}.png`);
                    const png = await normalized.img.getBuffer('image/png');
                    writeFileSync(path, png);
                    ownedCache = true;
                    outputMediaType = 'image/png';
                }
                prepared.push({
                    key: item.key ?? '',
                    path,
                    sourcePath: item.path,
                    url: item.url ?? '',
                    sender: item.sender || '某人',
                    at: Date.now(),
                    sent: false,
                    decoded: true,
                    w,
                    h,
                    mediaType: outputMediaType,
                    fp,
                    dhash: dhashValue,
                    color: colorValue,
                    fileid,
                    ownedCache,
                    seq: null,
                });
            }
            else {
                prepared.push({
                    key: item.key ?? '',
                    path,
                    sourcePath: item.path,
                    url: item.url ?? '',
                    sender: item.sender || '某人',
                    at: Date.now(),
                    sent: false,
                    decoded: false,
                    w: 0,
                    h: 0,
                    mediaType,
                    fp,
                    color,
                    fileid,
                    ownedCache,
                    seq: null,
                });
            }
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
    if (duplicateInSet(sentSetOf(key), item)) {
        cleanupItem(item);
        return buffers.get(key)?.length ?? 0;
    }
    const arr = bufferOf(key);
    if (duplicateInArray(arr, item)) {
        cleanupItem(item);
        return arr.length;
    }
    const seq = (sequenceByKey.get(key) ?? 0) + 1;
    sequenceByKey.set(key, seq);
    arr.push({ ...item, key, seq });
    persistBuffer(key, arr);
    return arr.length;
}

export async function pushAggImage(key, path, sender, url = '') {
    const prepared = await prepareAggregateImages([{ path, sender, url }]);
    return pushPreparedAggImage(key, prepared[0]);
}

export function pendingAggImages(key) {
    const arr = loadBuffer(key);
    if (!arr)
        return [];
    touchBuffers(key, arr);
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
        const arr = loadBuffer(key);
        if (!arr)
            continue;
        const kept = arr.filter((item) => !sent.has(item));
        cleanupItems([...sent]);
        if (kept.length) {
            touchBuffers(key, kept);
            persistBuffer(key, kept);
        }
        else {
            buffers.delete(key);
            sequenceByKey.delete(key);
            try {
                unlinkSync(pendingFileOf(key));
            }
            catch { /* ignore */ }
        }
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
    trimSentTotal();
    persistSentIndex();
}

function persistSentIndex() {
    if (!sentIndexFile)
        return;
    try {
        const out = {};
        for (const [key, set] of sentFingerprints)
            out[key] = [...set];
        atomicWrite(sentIndexFile, JSON.stringify(out));
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
        trimSentTotal();
    }
    catch { /* 坏表当空 */ }
}

export function clearAggImages(key) {
    clearBuffer(key);
}

export function resetAggImages(key) {
    clearBuffer(key);
    sentFingerprints.delete(key);
    persistSentIndex();
}

export async function stitchAggImages(items) {
    if (items.length < 2 || items.some((item) => !item.decoded && !item.img))
        return undefined;
    const result = pack(
        items.map((item) => ({ w: item.w, h: item.h })),
        { mode: 'auto', preset: 'standard' },
    );
    const sources = items.map((item) => item.path && existsSync(item.path) ? item.path : item.img);
    const labels = items.map((item) => item.seq ?? null);
    const buf = await renderCompositeBuffer(sources, result, { quality: 90, labels });
    const c = result.canvas;
    return {
        data: new Uint8Array(buf),
        width: c.W,
        height: c.H,
        used: items,
        layout: `${c.cols}x${c.rows}=${c.tiles}t ${result.stats.mode} ${c.W}x${c.H}`,
    };
}

async function saveSingleAggImage(item) {
    let buf = item.buf ? item.buf : readFileSync(item.path);
    let mediaType = item.mediaType;
    if (Math.max(item.w, item.h) > MAX_EDGE) {
        const img = item.img ? item.img.clone() : await Jimp.read(item.path);
        const scale = MAX_EDGE / Math.max(item.w, item.h);
        img.resize({
            w: Math.max(1, Math.round(item.w * scale)),
            h: Math.max(1, Math.round(item.h * scale)),
        });
        buf = await img.getBuffer('image/jpeg', { quality: 88 });
        mediaType = 'image/jpeg';
    }
    const saved = await saveImage(new Uint8Array(buf), mediaType);
    return saved?.attachment ? [{ type: 'image', attachment: saved.attachment }] : undefined;
}

export function buildAggregateBlocks(key, agent, logger) {
    const previous = building.get(key) ?? Promise.resolve();
    const run = previous.catch(() => { }).then(() => buildAggregateBlocksLocked(key, agent, logger));
    building.set(key, run);
    const done = () => {
        if (building.get(key) === run)
            building.delete(key);
    };
    void run.then(done, done);
    return run;
}

async function buildAggregateBlocksLocked(key, agent, logger) {
    if (!pendingAggImages(key).length)
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

    const blocks = [];
    while (true) {
        const items = pendingAggImages(key).slice(0, MAX_AGGREGATE_IMAGES);
        if (items.length === 0)
            break;
        if (items.some((item) => !item.decoded && !item.img)) {
            const savedItems = [];
            for (const item of items) {
                try {
                    const saved = await saveSingleAggImage(item);
                    if (saved) {
                        blocks.push(...saved);
                        savedItems.push(item);
                    }
                }
                catch (err) {
                    logger?.warn?.(`[图片聚合] 单图注入失败: ${item.path} ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (!savedItems.length)
                break;
            rememberAggSentPaths(key, savedItems);
            markAggSent(savedItems);
            continue;
        }
        if (items.length === 1) {
            try {
                const saved = await saveSingleAggImage(items[0]);
                if (!saved)
                    break;
                blocks.push(...saved);
                rememberAggSentPaths(key, items);
                markAggSent(items);
                logger?.debug?.(`[图片聚合] 单图直给: ${items[0].path}`);
                continue;
            }
            catch (err) {
                logger?.warn?.(`[图片聚合] 单图注入失败: ${err instanceof Error ? err.message : String(err)}`);
                break;
            }
        }
        const stitched = await stitchAggImages(items);
        if (!stitched)
            break;
        try {
            const saved = await saveImage(stitched.data, 'image/jpeg');
            if (!saved?.attachment)
                break;
            blocks.push({ type: 'image', attachment: saved.attachment });
            rememberAggSentPaths(key, stitched.used);
            markAggSent(stitched.used);
            logger?.debug?.(`[图片聚合] 合成 ${stitched.used.length} 张 → ${stitched.width}x${stitched.height} (${stitched.layout})`);
        }
        catch (err) {
            logger?.warn?.(`[图片聚合] 存图失败: ${err instanceof Error ? err.message : String(err)}`);
            break;
        }
    }
    return blocks;
}

export function initAggregateRegistry(dataRoot) {
    try {
        if (!dataRoot)
            return;
        cacheDir = join(dataRoot, '.qqbot', 'aggregate-cache');
        mkdirSync(cacheDir, { recursive: true });
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
            atomicWrite(ourAttachFile, JSON.stringify([...OUR_ATTACH]));
    }
    catch { /* ignore */ }
}

export function isOurAttachment(id) {
    return !!String(id ?? '') && OUR_ATTACH.has(String(id));
}

export function aggregateMemoryStats() {
    let sentTotal = 0;
    for (const set of sentFingerprints.values())
        sentTotal += set.size;
    return {
        bufferSessions: buffers.size,
        sequenceSessions: sequenceByKey.size,
        sentSessions: sentFingerprints.size,
        sentTotal,
        pendingDiskDir: cacheDir || fallbackCacheDir || '',
    };
}

export function setImageAggregateHooks(hooks) {
    if (hooks.probeImageInput)
        probeImageInput = hooks.probeImageInput;
    if (hooks.saveImage)
        saveImage = hooks.saveImage;
}
