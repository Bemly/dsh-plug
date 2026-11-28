/**
 * 群历史存储共享模块
 *
 * historyBuffer 中间件需要一个跨调用可访问的 HistoryStore 实例，
 * 以便在回复完成后清空某群的历史缓存（避免下次 @ 时重复组包）。
 * 对齐 openclaw-qqbot 的 features/history-store。
 */
import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, readdirSync, renameSync, rmdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function acquireFileLock(file) {
    const dir = `${file}.lock`;
    const owner = `${dir}/owner`;
    const deadline = Date.now() + 5000;
    const sleeper = new Int32Array(new SharedArrayBuffer(4));
    while (true) {
        try {
            mkdirSync(dir);
        }
        catch (err) {
            if (err.code !== 'EEXIST')
                throw err;
            let remove = false;
            let lockStat;
            let ownerText;
            try {
                lockStat = statSync(dir);
                ownerText = readFileSync(owner, 'utf8');
                const pid = Number(ownerText);
                if (pid) {
                    try {
                        process.kill(pid, 0);
                    }
                    catch (killErr) {
                        remove = killErr.code === 'ESRCH';
                    }
                }
                else {
                    remove = Date.now() - lockStat.mtimeMs > 30_000;
                }
            }
            catch { /* 锁刚建或 owner 尚未写入 */ }
            if (remove) {
                const tomb = `${dir}.stale.${process.pid}.${Date.now()}.${randomBytes(4).toString('hex')}`;
                try {
                    const currentStat = statSync(dir);
                    const currentOwner = readFileSync(owner, 'utf8');
                    if (currentStat.ino !== lockStat.ino || currentStat.mtimeMs !== lockStat.mtimeMs || currentOwner !== ownerText)
                        continue;
                    renameSync(dir, tomb);
                }
                catch {
                    continue;
                }
                try {
                    unlinkSync(`${tomb}/owner`);
                }
                catch { /* ignore */ }
                try {
                    rmdirSync(tomb);
                }
                catch { /* ignore */ }
                continue;
            }
            if (Date.now() >= deadline)
                return undefined;
            Atomics.wait(sleeper, 0, 0, 20);
            continue;
        }
        try {
            writeFileSync(owner, String(process.pid), 'utf8');
            return { dir, owner };
        }
        catch (writeErr) {
            try {
                rmdirSync(dir);
            }
            catch { /* ignore */ }
            throw writeErr;
        }
    }
}

function releaseFileLock(lock) {
    if (!lock)
        return;
    try {
        unlinkSync(lock.owner);
    }
    catch { /* ignore */ }
    try {
        rmdirSync(lock.dir);
    }
    catch { /* ignore */ }
}

class FileHistoryStore {
    dir;
    constructor(dir) {
        this.dir = dir;
        mkdirSync(dir, { recursive: true });
    }
    fileOf(groupKey) {
        const id = createHash('sha256').update(String(groupKey)).digest('hex').slice(0, 32);
        return join(this.dir, `${id}.json`);
    }
    read(groupKey) {
        try {
            const raw = JSON.parse(readFileSync(this.fileOf(groupKey), 'utf8'));
            return Array.isArray(raw) ? raw : [];
        }
        catch {
            return [];
        }
    }
    append(groupKey, entry, limit) {
        const file = this.fileOf(groupKey);
        const lock = acquireFileLock(file);
        if (!lock)
            throw new Error('history lock timeout');
        try {
            const rows = this.read(groupKey);
            if (rows.some((item) => item.messageId === entry.messageId))
                return;
            rows.push(entry);
            const kept = rows.slice(-Math.max(1, limit));
            const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
            writeFileSync(tmp, JSON.stringify(kept), 'utf8');
            renameSync(tmp, file);
        }
        finally {
            releaseFileLock(lock);
        }
    }
    list(groupKey, limit) {
        return this.read(groupKey).slice(-Math.max(1, limit));
    }
    clear(groupKey) {
        const file = this.fileOf(groupKey);
        const lock = acquireFileLock(file);
        if (!lock)
            return;
        try {
            unlinkSync(file);
        }
        catch { /* ignore */ }
        finally {
            releaseFileLock(lock);
        }
    }
    size() {
        try {
            return readdirSync(this.dir).filter((name) => name.endsWith('.json')).length;
        }
        catch {
            return 0;
        }
    }
}

const _storesByAppId = new Map();
const _rootsByAppId = new Map();
let _store = null;

export function getHistoryStore(appId, dataRoot) {
    const previousRoot = appId ? _rootsByAppId.get(appId) : undefined;
    if (dataRoot)
        _rootsByAppId.set(appId, dataRoot);
    if (appId) {
        let store = _storesByAppId.get(appId);
        const currentRoot = _rootsByAppId.get(appId);
        if (store && dataRoot && previousRoot !== dataRoot)
            store = undefined;
        if (!store) {
            const root = currentRoot ?? join(process.env.DSH_HOME || tmpdir(), '.dsh-qqbot-history');
            store = new FileHistoryStore(join(root, '.qqbot', 'history-cache', String(appId)));
            _storesByAppId.set(appId, store);
        }
        return store;
    }
    if (!_store)
        _store = new FileHistoryStore(join(process.env.DSH_HOME || tmpdir(), '.dsh-qqbot-history', 'default'));
    return _store;
}

export function historyGroupKey(appId, groupId) {
    return `${appId}:${groupId}`;
}

export function clearGroupHistory(appId, groupId) {
    getHistoryStore(appId).clear?.(historyGroupKey(appId, groupId));
}
