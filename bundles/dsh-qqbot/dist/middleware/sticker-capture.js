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

// 2026-11-26 v2.1：去掉"每条消息只取 3 张"的截断，多图全部采集由 image-aggregate 合成一张。
const MAX_PER_MSG = 100;
const FAILURE_COOLDOWN_MS = 5 * 60_000;
const GLOBAL_MAX_INFLIGHT = 32;
const MAX_FAILURE_KEYS = 4096;
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

function captureScope(config) {
    try { return String(stickerDirOf(config) || ''); }
    catch { return ''; }
}
function captureKey(url, config) {
    return `${captureScope(config)}\u0000${extractQqFileId(url) || String(url)}`;
}

function noteCaptureFailure(key, until) {
    const now = Date.now();
    for (const [candidate, expiry] of captureFailures)
        if (expiry <= now)
            captureFailures.delete(candidate);
    captureFailures.delete(key);
    captureFailures.set(key, until);
    while (captureFailures.size > MAX_FAILURE_KEYS)
        captureFailures.delete(captureFailures.keys().next().value);
}

export async function downloadWithRetry(url, download, logger, attempts = IMAGE_DOWNLOAD_ATTEMPTS) {
    for (let index = 0; index < attempts.length; index += 1) {
        const attempt = attempts[index];
        const concurrency = Math.max(1, Math.floor(attempt.concurrency));
        const timeoutMs = Math.max(1, Math.floor(attempt.timeoutMs));
        const controllers = Array.from({ length: concurrency }, () => new AbortController());
        let settled = false;
        let timer;
        const abortAll = () => { for (const controller of controllers) controller.abort(); };
        const jobs = controllers.map((controller) => Promise.resolve()
            .then(() => download(url, timeoutMs, controller.signal))
            .then((buf) => {
            if (settled || !buf)
                return undefined;
            settled = true;
            abortAll();
            return buf;
        }, (err) => {
            if (!settled)
                logger?.debug?.(`[sticker] 图片下载失败 attempt=${index + 1} concurrency=${concurrency}: ${err instanceof Error ? err.message : String(err)}`);
            return undefined;
        }));
        const timeout = new Promise((resolve) => {
            timer = setTimeout(() => {
                if (settled)
                    return;
                settled = true;
                abortAll();
                resolve(undefined);
            }, timeoutMs);
            // 不能 unref：这是"下载必须在上限内结束"的**硬期限**。unref 后若事件循环里只剩它，
            // 进程会先判定无事可做，等待方永远等不到 settled —— 表现为下载链路静默挂死
            // （tests/sticker-tagger.test.mjs「enforces attempt timeout even when the downloader ignores abort」）。
        });
        const firstSuccess = new Promise((resolve) => {
            let remaining = jobs.length;
            for (const job of jobs) {
                job.then((buf) => {
                    if (buf)
                        resolve(buf);
                    else if (--remaining === 0)
                        resolve(undefined);
                }, () => {
                    if (--remaining === 0)
                        resolve(undefined);
                });
            }
        });
        let winner;
        try {
            winner = await Promise.race([firstSuccess, timeout]);
        }
        catch { /* 全部失败 */ }
        finally {
            clearTimeout(timer);
        }
        if (winner)
            return winner;
        logger?.warn?.(`[sticker] 图片下载第 ${index + 1} 轮未成功 concurrency=${concurrency} timeout=${timeoutMs}ms`);
    }
    return undefined;
}

async function captureOne(url, contentType, msg, config, logger) {
    const scope = captureScope(config);
    const cached = lookupImagePath(url, logger, scope);
    if (cached)
        return cached;
    const key = captureKey(url, config);
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
            noteCaptureFailure(key, Date.now() + FAILURE_COOLDOWN_MS);
            logger?.warn?.(`[sticker] 图片下载四轮均失败 key=${key.slice(0, 16)}…`);
            return undefined;
        }
        const resolved = await store.captureBuffer(buf, input, contentType, url);
        if (!resolved.id) {
            noteCaptureFailure(key, Date.now() + FAILURE_COOLDOWN_MS);
            logger?.warn?.(`[sticker] 图片写库失败 key=${key.slice(0, 16)}…: ${resolved.error || 'unknown error'}`);
            return undefined;
        }
        captureFailures.delete(key);
        recordImageUrl(stickerDirOf(config), resolved.id, url);
        const localPath = store.pathOf(resolved.id);
        if (localPath)
            rememberImagePath(url, localPath, scope);
        if (resolved.status === 'new') {
            logger.debug(`[sticker] captured #${resolved.id} → ${localPath ?? '(path?)'}`);
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
    return paths;
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
