import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { getHistoryStore, historyGroupKey } from '../dist/features/history-store.js';
import { listQuotes, pushQuote } from '../dist/features/quote-cache.js';
import { captureSegment, clearSegment, getPrevSegment, noteSegmentItem, segmentLedgerStats } from '../dist/features/segment-ledger.js';

test('群历史写入磁盘并可重新读取', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-history-disk-'));
    const appId = `app-${Date.now()}-${Math.random()}`;
    const key = historyGroupKey(appId, 'group-1');
    try {
        const store = getHistoryStore(appId, dir);
        store.append(key, { messageId: 'm1', content: 'hello', senderId: 'u1', senderName: '用户', timestamp: 1 }, 20);
        assert.equal(store.list(key, 20)[0].content, 'hello');
        const files = await readdir(join(dir, '.qqbot', 'history-cache', appId));
        assert.equal(files.filter((name) => name.endsWith('.json')).length, 1);
        store.clear(key);
        assert.deepEqual(store.list(key, 20), []);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('文件历史多写者并发不丢条目', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-history-lock-'));
    const appId = `lock-${Date.now()}-${Math.random()}`;
    const key = historyGroupKey(appId, 'group-1');
    const moduleUrl = new URL('../dist/features/history-store.js', import.meta.url).href;
    const workerCode = `
import { parentPort, workerData } from 'node:worker_threads';
const { getHistoryStore, historyGroupKey } = await import(workerData.moduleUrl);
const store = getHistoryStore(workerData.appId, workerData.dir);
const key = historyGroupKey(workerData.appId, 'group-1');
for (let i = 0; i < 20; i++) store.append(key, { messageId: workerData.prefix + i, content: 'x', timestamp: i }, 100);
parentPort.postMessage('done');
parentPort.close();
`;
    try {
        await Promise.all(['a', 'b'].map((prefix) => new Promise((resolve, reject) => {
            const worker = new Worker(workerCode, { eval: true, workerData: { moduleUrl, dir, appId, prefix } });
            worker.once('message', resolve);
            worker.once('error', reject);
        })));
        const rows = getHistoryStore(appId, dir).list(key, 100);
        assert.equal(rows.length, 40);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('引用缓存 peer 数量有上界', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-quote-cap-'));
    try {
        for (let i = 0; i < 257; i++)
            pushQuote(dir, `peer-${i}`, `quote-${i}`, '用户');
        assert.deepEqual(listQuotes(dir, 'peer-0'), []);
        assert.equal(listQuotes(dir, 'peer-256').length, 1);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('segment ledger 会话键数量有上界', () => {
    for (let i = 0; i < 2049; i++) {
        const key = `memory-cap-${i}`;
        noteSegmentItem(key, { id: `m-${i}`, t: 'x' }, false);
        captureSegment(key, {});
    }
    const stats = segmentLedgerStats();
    assert.ok(stats.pendingKeys <= 2048);
    assert.ok(stats.snapshotKeys <= 2048);
    assert.equal(getPrevSegment('memory-cap-0'), undefined);
    assert.ok(getPrevSegment('memory-cap-2048'));
    for (let i = 0; i < 2049; i++)
        clearSegment(`memory-cap-${i}`);
});
