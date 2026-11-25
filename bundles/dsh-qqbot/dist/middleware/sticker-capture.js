import { stickerDirOf } from '../gateway/data-root.js';
import { getStickerStore, extractQqFileId } from '../features/sticker-store.js';
import { autoTagImage } from '../features/sticker-tagger.js';
import { lookupImagePath, rememberImagePath } from '../features/image-path-cache.js';
import { recordImageUrl } from '../features/image-url-ledger.js';
import { inferMediaKind } from '../transport/media-kind.js';

export const IMAGE_DOWNLOAD_ATTEMPTS = Object.freeze([
    Object.freeze({ concurrency: 1, timeoutMs: 30_000 }),
    Object.freeze({ concurrency: 2, timeoutMs: 120_000 }),
    Object.freeze({ concurrency: 4, timeoutMs: 300_000 }),
    Object.freeze({ concurrency: 8, timeoutMs: 600_000 }),
]);

const MAX_CANDIDATES = 500;
const MAX_TRASH = 800;
const MAX_PER_MSG = 3;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const GLOBAL_MAX_INFLIGHT = 32;
const captureTasks = new Map();
const captureFailures = new Map();
let activeDownloads = 0;
const downloadWaiters = [];

async function acquireDownloadSlot() {
    if (activeDownloads < GLOBAL_MAX_INFLIGHT) {
        activeDownloads += 1;
        return;
    }
    await new Promise((resolve) => downloadWaiters.push(resolve));
}

function releaseDownloadSlot() {
    activeDownloads -= 1;
    const next = downloadWaiters.shift();
    if (next) {
        activeDownloads += 1;
        next();
    }
}

function isCollectableImage(url) {
    return !!url && /^https:\/\//i.test(url) && /multimedia|qq\.com|download/i.test(url);
}

function captureKey(url) {
    return extractQqFileId(url) || String(url);
}

export async function downloadWithRetry(url, download, logger, attempts = IMAGE_DOWNLOAD_ATTEMPTS) {
    for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        const concurrency = Math.max(1, Math.floor(attempt.concurrency));
        const timeoutMs = Math.max(1, Math.floor(attempt.timeoutMs));
        const controllers = Array.from({ length: concurrency }, () => new AbortController());
        let winner;
        let settled = false;
        const jobs = controllers.map((controller) => Promise.resolve()
            .then(() => download(url, timeoutMs, controller.signal))
            .then((buf) => {
            if (settled)
                return;
            winner = buf;
            settled = true;
            for (const other of controllers) {
                if (other !== controller)
                    other.abort();
            }
        })
            .catch((err) => {
            if (!settled) {
                logger?.debug?.(`[sticker] 图片下载失败 attempt=${index + 1} concurrency=${concurrency}: ${err instanceof Error ? err.message : String(err)}`);
            }
        }));
        let timer;
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                for (const controller of controllers)
                    controller.abort();
                resolve(undefined);
            }, timeoutMs);
        });
        await Promise.race([Promise.all(jobs), timeout]);
        clearTimeout(timer);
        if (winner)
            return winner;
        logger?.warn?.(`[sticker] 图片下载第 ${index + 1} 轮未成功 concurrency=${concurrency} timeout=${timeoutMs}ms`);
    }
    return undefined;
}

async function captureOne(url, contentType, msg, config, logger) {
    const cached = lookupImagePath(url, logger);
    if (cached)
        return cached;
    const key = captureKey(url);
    const failUntil = captureFailures.get(key) ?? 0;
    if (Date.now() < failUntil) {
        logger?.debug?.(`[sticker] 图片下载失败冷却中 key=${key.slice(0, 16)}…`);
        return undefined;
    }
    const running = captureTasks.get(key);
    if (running)
        return running;
    const store = getStickerStore(stickerDirOf(config), logger);
    const sourceGroup = msg.kind === 'group' ? msg.groupOpenid : undefined;
    const input = {
        sourceGroup,
        senderId: msg.senderId,
        senderName: msg.senderName,
        msgText: (msg.content ?? '').trim().slice(0, 120) || undefined,
        sourceUrl: url,
    };
    const task = (async () => {
        const buf = await downloadWithRetry(url, async (downloadUrl, timeoutMs, signal) => {
            await acquireDownloadSlot();
            try {
                return await store.download(downloadUrl, timeoutMs, signal);
            }
            finally {
                releaseDownloadSlot();
            }
        }, logger);
        if (!buf) {
            captureFailures.set(key, Date.now() + FAILURE_COOLDOWN_MS);
            logger?.warn?.(`[sticker] 图片下载四轮均失败 key=${key.slice(0, 16)}…`);
            return undefined;
        }
        const resolved = await store.captureBuffer(buf, input, contentType, url);
        if (!resolved.id) {
            captureFailures.set(key, Date.now() + FAILURE_COOLDOWN_MS);
            logger?.warn?.(`[sticker] 图片写库失败 key=${key.slice(0, 16)}…: ${resolved.error || 'unknown error'}`);
            return undefined;
        }
        captureFailures.delete(key);
        recordImageUrl(stickerDirOf(config), resolved.id, url);
        const localPath = store.pathOf(resolved.id);
        if (localPath)
            rememberImagePath(url, localPath);
        if (resolved.status === 'new') {
            logger.debug(`[sticker] captured #${resolved.id} → ${localPath ?? '(path?)'}`);
            try {
                store.cleanupCandidates(MAX_CANDIDATES);
            }
            catch { /* ignore */ }
            try {
                store.cleanupTrash(MAX_TRASH);
            }
            catch { /* ignore */ }
            try {
                store.purgeTrashed();
            }
            catch { /* ignore */ }
            if (localPath && config.sticker.autoTagEnabled !== false) {
                void (async () => {
                    try {
                        const tag = await autoTagImage(localPath, config.sticker.visionCli ?? '', logger);
                        if (tag) {
                            store.setDescTags(resolved.id, tag.tags, tag.desc);
                            logger.debug(`[sticker] 自动打标 #${resolved.id}: ${tag.tags.join('/') || '(启发)'}`);
                        }
                    }
                    catch (err) {
                        logger.debug(`[sticker] autotag error: ${err instanceof Error ? err.message : String(err)}`);
                    }
                })();
            }
        }
        return localPath;
    })().finally(() => {
        if (captureTasks.get(key) === task)
            captureTasks.delete(key);
    });
    captureTasks.set(key, task);
    return task;
}

export async function prepareImagesForDispatch(attachments, msg, config, logger) {
    const images = (Array.isArray(attachments) ? attachments : [])
        .filter((att) => isCollectableImage(att?.url) && inferMediaKind(att) === 'image')
        .slice(0, MAX_PER_MSG);
    const seen = new Set();
    const tasks = [];
    for (const image of images) {
        const url = String(image.url);
        if (seen.has(url))
            continue;
        seen.add(url);
        tasks.push(captureOne(url, image.content_type, msg, config, logger));
    }
    const paths = await Promise.all(tasks);
    return paths.filter(Boolean);
}

export function stickerCapture(config, logger) {
    return async (ctx, next) => {
        if (config.sticker.collectEnabled) {
            try {
                void prepareImagesForDispatch(ctx.message?.attachments, ctx.message, config, logger)
                    .catch((err) => logger.debug(`[sticker] 后台采集失败: ${err instanceof Error ? err.message : String(err)}`));
            }
            catch { /* 收藏调度失败不影响主链 */ }
        }
        await next();
    };
}
