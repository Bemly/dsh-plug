import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import { Worker } from 'node:worker_threads';
import { OutboundBuffer, sendRichOutbound } from '../dist/transport/outbound-buffer.js';
import { StickerStore } from '../dist/features/sticker-store.js';

const root = new URL('../', import.meta.url);

test('成功 fork 使用同作用域 composed 并替换活跃 agent', async () => {
    const source = await readFile(new URL('./dist/session/session-manager.js', root), 'utf8');
    const start = source.indexOf('    async forkCurrentSession(');
    const end = source.indexOf('    clearModelOverride(', start);
    assert.ok(start >= 0 && end > start);
    const method = source.slice(start, end);
    const context = {
        console,
        process,
        SessionId: (id) => id,
        randomUUID: () => 'child-id',
        absCwdOf: (value) => value,
        archiveSessionDurably: () => {},
        attachSessionToWorkspaceWithRetry: () => {},
        forgetExtToolContext: () => {},
    };
    vm.runInNewContext(`class TestManager { ${method} }; globalThis.TestManager = TestManager;`, context);
    const manager = new context.TestManager();
    const created = { agent: { id: 'new-agent' }, dispose: async () => {} };
    Object.assign(manager, {
        ctx: {},
        config: { cwd: '/tmp', archiveOnNewSession: true },
        logger: { info() {}, warn() {} },
        modelResolver: { setSessionId() {} },
        agents: { create: async () => created },
        getSessionsService: () => ({}),
        composePreset: async () => ({ agentPreset: 'preset-a', setup() {} }),
        effectivePreset: () => 'preset-a',
        cancelRecordOutbound() {},
    });
    const record = { sessionId: 'old-id', agent: { id: 'old-agent' }, handle: { dispose: async () => {} } };
    const ok = await manager.forkCurrentSession('key', record, undefined, false);
    assert.equal(ok, true);
    assert.equal(record.sessionId, 'child-id');
    assert.equal(record.agent.id, 'new-agent');
    assert.equal(record.agentPreset, 'preset-a');
});

test('reset 取消注册后，在途出站不再发送剩余分块', async () => {
    const sent = [];
    let release;
    let entered;
    const gate = new Promise((resolve) => { release = resolve; });
    const first = new Promise((resolve) => { entered = resolve; });
    const bot = {
        async sendMarkdown(_target, text) {
            sent.push(text);
            if (sent.length === 1) {
                entered();
                await gate;
            }
        },
        async sendMedia() {},
        async recallByIndex() { return false; },
    };
    const record = { replyTarget: { scope: 'c2c', targetId: 'peer', msgId: 'm1' }, outboundCancels: new Set() };
    const buffer = new OutboundBuffer(record, bot, 5, { error() {}, warn() {} }, false, '/tmp', undefined, undefined, undefined, undefined, undefined, undefined, { enabled: false });
    const cancel = () => buffer.cancel();
    record.outboundCancels.add(cancel);
    buffer.onSettled = () => record.outboundCancels.delete(cancel);
    buffer.append('aaaa bbbb cccc dddd');
    const flushing = buffer.flush();
    await first;
    for (const cancelOutbound of record.outboundCancels)
        cancelOutbound();
    release();
    await flushing;
    assert.equal(sent.length, 1);
    assert.equal(buffer.text, '');
    assert.equal(record.outboundCancels.size, 0);
});

test('预取消发送不会阻塞同目标后续发送', async () => {
    const sent = [];
    const bot = {
        async sendMarkdown(_target, text) { sent.push(text); },
        async sendMedia() {},
        async recallByIndex() { return false; },
    };
    const target = { scope: 'c2c', targetId: 'peer', msgId: 'm1' };
    const controller = new AbortController();
    controller.abort();
    await sendRichOutbound(bot, target, 'cancelled', 100, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { enabled: false }, controller.signal);
    let timer;
    await Promise.race([
        sendRichOutbound(bot, target, 'ok', 100, undefined, undefined, undefined, undefined, undefined, undefined, undefined, { enabled: false }),
        new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('send queue blocked')), 1000); }),
    ]);
    clearTimeout(timer);
    assert.deepEqual(sent, ['ok']);
});

test('SessionManager reset/remove/dispose 都会取消在途出站', async () => {
    const source = await readFile(new URL('./dist/session/session-manager.js', root), 'utf8');
    assert.ok(source.includes('cancelRecordOutbound(record);'));
    assert.ok(source.includes('this.cancelRecordOutbound(record);\n            forgetExtToolContext(record.agentCtx);\n            record.agent.cancel'));
    assert.ok(source.includes('this.cancelRecordOutbound(record);\n        forgetExtToolContext(record.agentCtx);\n        void oldHandle.dispose()'));
});

test('model-prefs 多写者并发保留全部 key', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-prefs-lock-'));
    const moduleUrl = new URL('../dist/model/prefs-store.js', import.meta.url).href;
    const workerCode = `
import { parentPort, workerData } from 'node:worker_threads';
const { PrefsStore } = await import(workerData.moduleUrl);
const store = new PrefsStore(() => {}, workerData.dir, () => {});
const original = store.readDiskState.bind(store);
store.readDiskState = () => {
  const disk = original();
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2);
  return disk;
};
for (let i = 0; i < 25; i++) store.setOverride(workerData.prefix + i, { provider: 'p', model: workerData.prefix + i });
parentPort.postMessage('done');
parentPort.close();
`;
    try {
        await Promise.all(['a', 'b'].map((prefix) => new Promise((resolve, reject) => {
            const worker = new Worker(workerCode, { eval: true, workerData: { moduleUrl, dir, prefix } });
            worker.once('message', resolve);
            worker.once('error', reject);
        })));
        const saved = JSON.parse(await readFile(join(dir, 'model-prefs.json'), 'utf8'));
        assert.equal(Object.keys(saved.overrides).length, 50);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('model-prefs 能清理陈旧锁并继续写入', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-prefs-stale-lock-'));
    const { PrefsStore } = await import('../dist/model/prefs-store.js');
    try {
        const lock = join(dir, 'model-prefs.json.lock');
        fs.mkdirSync(lock);
        fs.writeFileSync(join(lock, 'owner'), '999999');
        const old = new Date(Date.now() - 60_000);
        fs.utimesSync(lock, old, old);
        const store = new PrefsStore(() => {}, dir, () => {});
        store.setOverride('a', { provider: 'p', model: 'a' });
        const saved = JSON.parse(await readFile(join(dir, 'model-prefs.json'), 'utf8'));
        assert.equal(saved.overrides.a.model, 'a');
        assert.equal(fs.existsSync(lock), false);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('model-prefs 不窃取 PID 存活的陈旧锁', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-prefs-active-lock-'));
    const lock = join(dir, 'model-prefs.json.lock');
    fs.mkdirSync(lock);
    fs.writeFileSync(join(lock, 'owner'), String(process.pid));
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lock, old, old);
    const moduleUrl = new URL('../dist/model/prefs-store.js', import.meta.url).href;
    const workerCode = `
import { parentPort, workerData } from 'node:worker_threads';
const { PrefsStore } = await import(workerData.moduleUrl);
const store = new PrefsStore(() => {}, workerData.dir, () => {});
const ok = store.acquireLock();
if (ok) store.releaseLock();
parentPort.postMessage(ok);
parentPort.close();
`;
    try {
        const result = new Promise((resolve, reject) => {
            const worker = new Worker(workerCode, { eval: true, workerData: { moduleUrl, dir } });
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        await new Promise((resolve) => setTimeout(resolve, 100));
        assert.equal(fs.existsSync(lock), true);
        fs.rmSync(lock, { recursive: true, force: true });
        assert.equal(await result, true);
        assert.equal(fs.existsSync(lock), false);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('StickerStore 写失败保留旧索引并重试，原子写不留半截', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-sticker-atomic-'));
    const original = fs.writeFileSync;
    try {
        const store = new StickerStore(dir);
        const item = (id) => ({ id, layer: 'library', hash: id, ext: 'png', size: 1, capturedAt: 1, firstSeenAt: 1, lastSeenAt: 1, useCount: 0, tags: [] });
        store.items.set('first', item('first'));
        store.save();
        store.flush();

        store.items.set('second', item('second'));
        store.save();
        fs.writeFileSync = (path, data, ...args) => {
            if (String(path).endsWith('.tmp')) {
                original(path, String(data).slice(0, 8), ...args);
                throw new Error('simulated write failure');
            }
            return original(path, data, ...args);
        };
        syncBuiltinESMExports();
        store.flush();
        fs.writeFileSync = original;
        syncBuiltinESMExports();

        const afterFailure = new StickerStore(dir);
        assert.equal(afterFailure.get('first')?.id, 'first');
        assert.equal(afterFailure.get('second'), undefined);
        assert.equal(store.dirty, true);

        store.flush();
        const afterRetry = new StickerStore(dir);
        assert.equal(afterRetry.get('first')?.id, 'first');
        assert.equal(afterRetry.get('second')?.id, 'second');
    }
    finally {
        fs.writeFileSync = original;
        syncBuiltinESMExports();
        await rm(dir, { recursive: true, force: true });
    }
});
