import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
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
const MAX_BUFFER_HARD = 128;
const MAX_SENT_SESSIONS = 512;
const MAX_SENT_TOTAL = 131072;
const MAX_PENDING_ITEMS = 500;
const PENDING_TTL_MS = 24 * 3600_000;
const DROP_AFTER_FAILURES = 3;
/**
 * 多实例隔离（2026-11-28 审计 P1）。
 *
 * 同一进程可能跑多个机器人实例（不同 dataRoot）。原来 buffers / 发送指纹 / 落盘目录
 * 都是模块级单例：后初始化的实例会把前一个的目录顶掉，落盘、LRU 清理、幂等表互相踩。
 *
 * 现在：所有"会话键"在进入本模块时统一加 `<dataRoot>\0` 前缀（scopedKey），
 * 内部函数只认复合键；落盘目录与发送索引按 root 分开。
 * 未传 root 的旧调用保持原键，单实例/测试路径行为不变。
 */
const ROOT_SEP = '\u0000';
const cacheDirs = new Map();
const sentIndexFiles = new Map();
const pendingFailures = new Map();

const buffers = new Map();
const building = new Map();
const sentFingerprints = new Map();
const sequenceByKey = new Map();
let fallbackCacheDir = '';
const OUR_ATTACH = new Set();
let ourAttachFile = '';
const OUR_ATTACH_KEEP = 2000;
let probeImageInput;
let saveImage;

function scopedKey(root, key) {
    const r = String(root || '');
    return r ? r + ROOT_SEP + String(key) : String(key);
}
function rootOf(scoped) {
    const s = String(scoped ?? '');
    const i = s.indexOf(ROOT_SEP);
    return i < 0 ? '' : s.slice(0, i);
}
function ensureCacheDir(root = '') {
    if (!root) {
        if (!fallbackCacheDir)
            fallbackCacheDir = mkdtempSync(join(tmpdir(), 'dsh-botqq-aggregate-'));
        return fallbackCacheDir;
    }
    const hit = cacheDirs.get(root);
    if (hit) {
        mkdirSync(hit, { recursive: true });
        return hit;
    }
    const dir = join(root, '.qqbot', 'aggregate-cache');
    mkdirSync(dir, { recursive: true });
    pruneAggregateDisk(dir);
    cacheDirs.set(root, dir);
    return dir;
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
    return join(ensureCacheDir(rootOf(key)), `pending-${id}.json`);
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
function stableItemKey(item) {
    if (!item)
        return '';
    return [item.key ?? '', item.seq ?? '', item.fp ?? '', item.fileid ?? '', item.path ?? ''].join('\u0000');
}
function dropItems(key, items) {
    if (!items?.length)
        return;
    const doomed = new Set(items.map(stableItemKey));
    const arr = loadBuffer(key) ?? [];
    const kept = arr.filter((item) => !doomed.has(stableItemKey(item)));
    cleanupItems(items);
    for (const item of items)
        pendingFailures.delete(stableItemKey(item));
    if (kept.length) {
        touchBuffers(key, kept);
        persistBuffer(key, kept);
    }
    else {
        buffers.delete(key);
        sequenceByKey.delete(key);
        try { unlinkSync(pendingFileOf(key)); } catch { /* ignore */ }
    }
}
function noteAggFailure(key, items) {
    const now = Date.now();
    const doomed = [];
    for (const item of items ?? []) {
        const id = stableItemKey(item);
        const prev = pendingFailures.get(id) ?? { count: 0, until: 0 };
        const next = { count: prev.count + 1, until: now + Math.min(60_000, 2 ** prev.count * 1000) };
        pendingFailures.set(id, next);
        if (next.count >= DROP_AFTER_FAILURES)
            doomed.push(item);
    }
    while (pendingFailures.size > 4096) {
        const oldest = pendingFailures.keys().next().value;
        pendingFailures.delete(oldest);
    }
    if (doomed.length)
        dropItems(key, doomed);
}
function prunePendingItems(key) {
    const arr = loadBuffer(key);
    if (!arr?.length)
        return arr;
    const cutoff = Date.now() - PENDING_TTL_MS;
    let kept = arr.filter((item) => Number(item.at ?? 0) >= cutoff);
    if (kept.length > MAX_PENDING_ITEMS) {
        const dropped = kept.slice(0, kept.length - MAX_PENDING_ITEMS);
        cleanupItems(dropped);
        kept = kept.slice(-MAX_PENDING_ITEMS);
    }
    if (kept.length !== arr.length) {
        touchBuffers(key, kept);
        persistBuffer(key, kept);
        return kept;
    }
    return arr;
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
            if (buffers.size <= MAX_BUFFER_HARD)
                break;
            cleanupItems(spilled);
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
        if (buf[0] === 0x42 && buf[1] === 0x4d)
            return 'image/bmp';
    }
    const lower = String(path ?? '').toLowerCase();
    if (lower.endsWith('.bmp'))
        return 'image/bmp';
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
    if (a.vdhash && b.vdhash && dhashDistance(a.vdhash, b.vdhash) > 5)
        return false;
    return !a.color || !b.color || colorHashDistance(a.color, b.color) <= 8;
}

function keysOf(item) {
    const keys = [item.fp];
    if (item.fileid)
        keys.push(`q:${item.fileid}`);
    if (item.dhash)
        keys.push(`d:${item.dhash}${item.color ? `:${item.color}` : ''}${item.vdhash ? `:${item.vdhash}` : ''}`);
    return keys;
}

function matchesStored(item, stored) {
    if (stored === item.fp)
        return true;
    if (item.fileid && stored === `q:${item.fileid}`)
        return true;
    if (!item.dhash || !stored.startsWith('d:'))
        return false;
    const [hash, color, vdhash] = stored.slice(2).split(':');
    return dhashDistance(item.dhash, hash) <= 5
        && (!color || !item.color || colorHashDistance(item.color, color) <= 8)
        && (!vdhash || !item.vdhash || dhashDistance(item.vdhash, vdhash) <= 5);
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
            && buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50)
        || (buf[0] === 0x42 && buf[1] === 0x4d);
}
function verticalDhashOfImage(img) {
    const sample = img.clone();
    sample.resize({ w: 8, h: 9 });
    const data = sample.bitmap.data;
    if (!data || data.length < 8 * 9 * 4)
        return undefined;
    const gray = (i) => 0.299 * (data[i * 4] ?? 0) + 0.587 * (data[i * 4 + 1] ?? 0) + 0.114 * (data[i * 4 + 2] ?? 0);
    let bits = '';
    for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
            bits += gray(y * 8 + x) > gray((y + 1) * 8 + x) ? '1' : '0';
    let hex = '';
    for (let i = 0; i < 64; i += 4)
        hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
    return hex;
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

export async function prepareAggregateImages(items, logger, dataRoot = '') {
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
                if (!w || !h)
                    img = null;
            }
            catch (err) {
                if (!hasImageSignature(buf)) {
                    logger?.warn?.(`[图片聚合] 预解码失败，不入聚合: ${item.path} ${err instanceof Error ? err.message : String(err)}`);
                    continue;
                }
                logger?.warn?.(`[图片聚合] Jimp 不支持解码，按原图单图候选保留: ${item.path}`);
            }
            let path = item.path;
            let ownedCache = false;
            let outputMediaType = mediaType;
            if (img) {
                const dhashValue = dhashOfImage(img);
                const vdhashValue = verticalDhashOfImage(img);
                const colorValue = colorHashOfImage(img);
                const normalized = normalizeForPack(img, w, h);
                w = normalized.w;
                h = normalized.h;
                if (normalized.changed) {
                    path = join(ensureCacheDir(String(dataRoot || '')), `${fp}-${randomBytes(6).toString('hex')}.png`);
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
                    vdhash: vdhashValue,
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

export function pushPreparedAggImage(key, item, dataRoot = '') {
    key = scopedKey(dataRoot, key);
    if (!item)
        return 0;
    if (duplicateInSet(sentSetOf(key), item)) {
        cleanupItem(item);
        return buffers.get(key)?.length ?? 0;
    }
    const arr = prunePendingItems(key) ?? bufferOf(key);
    if (duplicateInArray(arr, item)) {
        cleanupItem(item);
        return arr.length;
    }
    const seq = (sequenceByKey.get(key) ?? 0) + 1;
    sequenceByKey.set(key, seq);
    arr.push({ ...item, key, seq });
    if (arr.length > MAX_PENDING_ITEMS) {
        const dropped = arr.splice(0, arr.length - MAX_PENDING_ITEMS);
        cleanupItems(dropped);
    }
    persistBuffer(key, arr);
    return arr.length;
}

export async function pushAggImage(key, path, sender, url = '') {
    const prepared = await prepareAggregateImages([{ path, sender, url }]);
    return pushPreparedAggImage(key, prepared[0]);
}

export function pendingAggImages(key, dataRoot = '') {
    return listPending(scopedKey(dataRoot, key));
}
/** 内部用：key 已经是复合键。 */
function listPending(key) {
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
        const sentKeys = new Set([...sent].map(stableItemKey));
        const kept = arr.filter((item) => !sentKeys.has(stableItemKey(item)));
        cleanupItems([...sent]);
        for (const item of sent)
            pendingFailures.delete(stableItemKey(item));
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
    persistSentIndex(rootOf(key));
}

function sentIndexFileFor(root) {
    if (!root)
        return '';
    const hit = sentIndexFiles.get(root);
    if (hit)
        return hit;
    const file = join(root, '.qqbot', 'aggregate-sent-index.json');
    sentIndexFiles.set(root, file);
    return file;
}

function persistSentIndex(root = '') {
    const file = sentIndexFileFor(root);
    if (!file)
        return;
    try {
        const out = {};
        for (const [key, set] of sentFingerprints) {
            if (rootOf(key) !== root)
                continue;
            out[key] = [...set];
        }
        atomicWrite(file, JSON.stringify(out));
    }
    catch { /* 去重表写入失败不影响消息 */ }
}

function loadSentIndex(root) {
    const file = sentIndexFileFor(root);
    if (!file || !existsSync(file))
        return;
    try {
        const raw = JSON.parse(readFileSync(file, 'utf8'));
        for (const [key, arr] of Object.entries(raw ?? {})) {
            if (!Array.isArray(arr))
                continue;
            // 文件里的键必须属于本实例，防止旧版本把别人的条目带进来
            const scoped = rootOf(key) === root ? key : scopedKey(root, key);
            touchMap(sentFingerprints, scoped, new Set(arr.filter((x) => typeof x === 'string')), MAX_SENT_SESSIONS);
        }
        trimSentTotal();
    }
    catch { /* 坏表当空 */ }
}

export function clearAggImages(key, dataRoot = '') {
    clearBuffer(scopedKey(dataRoot, key));
}

export function resetAggImages(key, dataRoot = '') {
    const scoped = scopedKey(dataRoot, key);
    clearBuffer(scoped);
    sentFingerprints.delete(scoped);
    persistSentIndex(rootOf(scoped));
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

export function buildAggregateBlocks(key, agent, logger, dataRoot = '') {
    key = scopedKey(dataRoot, key);
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
    const ensureRemoved = (items) => {
        const ids = new Set(items.map(stableItemKey));
        if (!pendingAggImages(key).some((item) => ids.has(stableItemKey(item))))
            return true;
        logger?.warn?.(`[图片聚合] 发送后 pending 未清理，强制丢弃 ${items.length} 项以避免重复发送`);
        dropItems(key, items);
        return false;
    };
    while (true) {
        const all = prunePendingItems(key) ?? listPending(key);
        const items = all.slice(0, MAX_AGGREGATE_IMAGES);
        if (items.length === 0)
            break;
        const rawItems = items.filter((item) => !item.decoded && !item.img);
        if (rawItems.length) {
            const savedItems = [];
            const failedItems = [];
            for (const item of rawItems) {
                try {
                    const saved = await saveSingleAggImage(item);
                    if (saved) {
                        blocks.push(...saved);
                        savedItems.push(item);
                    }
                    else {
                        failedItems.push(item);
                    }
                }
                catch (err) {
                    failedItems.push(item);
                    logger?.warn?.(`[图片聚合] raw 单图注入失败: ${item.path} ${err instanceof Error ? err.message : String(err)}`);
                }
            }
            if (savedItems.length) {
                rememberAggSentPaths(key, savedItems);
                markAggSent(savedItems);
                ensureRemoved(savedItems);
            }
            if (failedItems.length)
                noteAggFailure(key, failedItems);
            if (!savedItems.length)
                break;
            continue;
        }
        if (items.length === 1) {
            try {
                const saved = await saveSingleAggImage(items[0]);
                if (!saved) {
                    noteAggFailure(key, items);
                    break;
                }
                blocks.push(...saved);
                rememberAggSentPaths(key, items);
                markAggSent(items);
                ensureRemoved(items);
                logger?.debug?.(`[图片聚合] 单图直给: ${items[0].path}`);
                continue;
            }
            catch (err) {
                logger?.warn?.(`[图片聚合] 单图注入失败: ${items[0].path} ${err instanceof Error ? err.message : String(err)}`);
                noteAggFailure(key, items);
                break;
            }
        }
        const stitched = await stitchAggImages(items);
        if (!stitched) {
            noteAggFailure(key, items);
            break;
        }
        try {
            const saved = await saveImage(stitched.data, 'image/jpeg');
            if (!saved?.attachment) {
                noteAggFailure(key, items);
                break;
            }
            blocks.push({ type: 'image', attachment: saved.attachment });
            rememberAggSentPaths(key, stitched.used);
            markAggSent(stitched.used);
            ensureRemoved(stitched.used);
            logger?.debug?.(`[图片聚合] 合成 ${stitched.used.length} 张 → ${stitched.width}x${stitched.height} (${stitched.layout})`);
        }
        catch (err) {
            logger?.warn?.(`[图片聚合] 存图失败: ${err instanceof Error ? err.message : String(err)}`);
            noteAggFailure(key, items);
            break;
        }
    }
    return blocks;
}

function pruneAggregateDisk(dir) {
    try {
        const cutoff = Date.now() - 7 * 24 * 3600_000;
        const pending = [];
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            let st;
            try { st = statSync(full); } catch { continue; }
            if (!st.isFile())
                continue;
            if (name.startsWith('pending-') && name.endsWith('.json')) {
                pending.push({ full, mtime: st.mtimeMs });
                continue;
            }
            if (st.mtimeMs < cutoff) {
                try { unlinkSync(full); } catch { /* ignore */ }
            }
        }
        pending.sort((a, b) => a.mtime - b.mtime);
        const excess = Math.max(0, pending.length - 512);
        for (let i = 0; i < pending.length; i++) {
            const entry = pending[i];
            if (i >= excess && entry.mtime >= cutoff)
                continue;
            try { unlinkSync(entry.full); } catch { /* ignore */ }
        }
    }
    catch { /* 清理失败不影响启动 */ }
}

/**
 * 预热某个实例的聚合落盘目录与台账。
 * 多实例安全：只初始化传入 root 自己的目录，不再覆盖全局单例。
 */
export function initAggregateRegistry(dataRoot) {
    try {
        if (!dataRoot)
            return;
        ensureCacheDir(String(dataRoot));
        loadSentIndex(String(dataRoot));
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
        pendingDiskDirs: [...cacheDirs.values()],
        pendingDiskDir: [...cacheDirs.values()][0] || fallbackCacheDir || '',
    };
}

export function setImageAggregateHooks(hooks) {
    if (hooks.probeImageInput)
        probeImageInput = hooks.probeImageInput;
    if (hooks.saveImage)
        saveImage = hooks.saveImage;
}
