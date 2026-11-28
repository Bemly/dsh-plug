import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { OutboundBuffer } from '../dist/transport/outbound-buffer.js';

const root = new URL('../', import.meta.url);

test('出站 flush 等待期间追加的文本继续发送且不丢失', async () => {
    const sent = [];
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const bot = {
        async sendMarkdown(_target, text) {
            sent.push(text);
            if (sent.length === 1)
                await gate;
        },
        async sendMedia() {},
        async recallByIndex() { return false; },
    };
    const buffer = new OutboundBuffer(
        { replyTarget: { scope: 'c2c', targetId: 'peer', msgId: 'm1' } },
        bot,
        2000,
        { error() {}, warn() {} },
        false,
        '/tmp',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        { enabled: false },
    );
    buffer.append('A');
    const flushing = buffer.flush();
    await new Promise((resolve) => setImmediate(resolve));
    buffer.append('B');
    release();
    await flushing;
    assert.deepEqual(sent, ['A', 'B']);
    assert.equal(buffer.text, '');
});

test('reset 轮换 sessionId 且命令等待重置完成', async () => {
    const manager = await readFile(new URL('./dist/session/session-manager.js', root), 'utf8');
    const command = await readFile(new URL('./dist/commands/session.js', root), 'utf8');
    assert.ok(manager.includes('async reset(scope, peerId)'));
    assert.ok(manager.includes('const nextSessionId = SessionId(randomUUID());'));
    assert.ok(manager.includes('this.modelResolver.setSessionId(key, nextSessionId);'));
    assert.ok(manager.includes('this.sessionGenerations.set(key, (this.sessionGenerations.get(key) ?? 0) + 1);'));
    assert.ok(manager.includes('this.creating.delete(key);'));
    assert.ok(manager.includes('resetAggImages(`${scope}:${peerId}`);'));
    assert.ok(command.includes('await manager.reset(scope, peerId);'));
});

test('/new 无参和带 preset 都使用 fork 超时 abort', async () => {
    const command = await readFile(new URL('./dist/commands/session.js', root), 'utf8');
    assert.equal((command.match(/forkWithTimeout\(\(signal\) => manager\.startNewSession/g) ?? []).length, 3);
    assert.ok(command.includes("if (r === 'timeout')"));
});

test('入站投递前校验会话仍活跃', async () => {
    const inbound = await readFile(new URL('./dist/transport/inbound.js', root), 'utf8');
    assert.ok(inbound.includes('if (!manager.isActiveRecord(record))'));
    assert.ok(inbound.includes('record.agent.followup(message);'));
});

test('getOrCreate 单飞且 fork 失败与超时不替换当前会话', async () => {
    const manager = await readFile(new URL('./dist/session/session-manager.js', root), 'utf8');
    const command = await readFile(new URL('./dist/commands/session.js', root), 'utf8');
    assert.ok(manager.includes('this.creating.get(key)'));
    assert.ok(manager.includes('if (pending && !opts?.forceNew)'));
    assert.ok(manager.includes('requestedGeneration'));
    assert.ok(manager.includes('this.getOrCreateLocked(scope, peerId, senderId, replyTarget, opts)'));
    assert.ok(manager.includes('session changed during creation'));
    assert.ok(manager.includes('fork failed, keep current session'));
    assert.ok(manager.includes('if (signal?.aborted)'));
    assert.ok(manager.includes('await created.dispose().catch(() => { });'));
    assert.ok(command.includes('controller.abort();'));
});

test('debounce 同 key 串行派发且批次摘除后保留新窗口', async () => {
    const source = await readFile(new URL('./dist/gateway/debounce.js', root), 'utf8');
    assert.ok(source.includes('const dispatchChains = new Map();'));
    assert.ok(source.includes('previous.catch(() => { }).then(() => {'));
    assert.ok(source.includes('windows.delete(key);\n        const pre = w.entries;'));
    assert.ok(source.includes('function restoreBatch(key, w, delayMs)'));
    assert.ok(!source.includes('windows.delete(key);\n                            // 与正常派发同款'));
});

test('群历史图片在缓存未命中时走四轮下载', async () => {
    const inbound = await readFile(new URL('./dist/transport/inbound.js', root), 'utf8');
    assert.ok(inbound.includes('const _historyUrls = [];'));
    assert.ok(inbound.includes('prepareImagesForDispatch(_historyFake, msg, config, logger)'));
    assert.ok(inbound.includes('_historyPaths.get(ref.raw)'));
    assert.ok(inbound.includes('x.path === _lp || x.sourcePath === _lp'));
});

test('包检查器能发现普通相对类型导出缺失', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-package-check-'));
    try {
        for (const sub of ['dist/session', 'dist/model', 'client', 'scripts'])
            await mkdir(join(dir, sub), { recursive: true });
        for (const file of [
            'entry.js',
            'dist/index.js',
            'dist/index.d.ts',
            'dist/types.d.ts',
            'dist/session/types.d.ts',
            'dist/model/types.d.ts',
            'client/qqbot-settings.js',
            'settings-host.js',
            'cordis.patch.yml',
        ]) {
            await writeFile(join(dir, file), '');
        }
        await writeFile(join(dir, 'dist/broken.d.ts'), "export { Missing } from './missing.js';\n");
        await cp(new URL('./scripts/check-package.mjs', root), join(dir, 'scripts/check-package.mjs'));
        assert.throws(
            () => execFileSync(process.execPath, [join(dir, 'scripts/check-package.mjs')], { encoding: 'utf8', stdio: 'pipe' }),
            /missing type target/,
        );
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});
