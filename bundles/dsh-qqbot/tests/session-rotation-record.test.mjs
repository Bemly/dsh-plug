import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

/**
 * 回归：resume 失败 → create 撞 already exists → 轮换 sessionId 时，**活跃记录必须跟着换成新 id**。
 *
 * 现场（2026-11-26 NAS）：dsh-loli 预设实例化失败 ⇒ 每条入站都重演这条兜底链，
 * 而记录里仍写着旧 sessionId ⇒ 下一次照样 resume 失败 ⇒ 每 3 秒轮出一个空壳会话、
 * 消息全丢（群/私聊各一个 peer，实测连轮 4 次）。
 *
 * ⚠️ session-manager 会静态 import 宿主的 @deepseek-ai/dsh-{session,llm,tools}（peerDependencies）。
 *   仓库检出里没有这些包，所以这里**装不上就跳过**，别让套件在没装宿主依赖的环境里报红。
 */
let SessionManager = null;
let loadError = '';
try {
    ({ SessionManager } = await import('../dist/session/session-manager.js'));
}
catch (err) {
    loadError = String(err?.message ?? err);
}
const skip = loadError ? `需要宿主包 @deepseek-ai/dsh-*（当前环境解析不到: ${loadError}）` : false;
function makeManager(behaviour) {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qqbot-rotation-'));
    const created = [];
    const agent = {
        options: {},
        model: {},
        cancel: () => { },
        dispose: async () => { },
    };
    const agents = {
        get: () => undefined,
        async resume(options) {
            return behaviour.resume(options);
        },
        async create(options) {
            created.push(options.sessionId);
            return behaviour.create(options, created.length);
        },
    };
    const ctx = {
        get: () => {
            throw new Error('service not found');
        },
        on: () => () => { },
        root: {},
        agents,
    };
    const config = {
        dataRoot,
        cwd: dataRoot,
        sessionIdleTimeout: 0,
        archiveOnNewSession: false,
        preset: '',
        localModel: {},
    };
    const logger = { info: () => { }, warn: () => { }, debug: () => { }, error: () => { } };
    const manager = new SessionManager(ctx, agents, config, logger);
    return { manager, dataRoot, created, agent };
}

test('rotation replaces the recorded sessionId so the next inbound can resume it', { skip }, async () => {
    const { manager, dataRoot, created, agent } = makeManager({
        resume: async () => {
            throw new Error('preset dsh-loli instantiation failed');
        },
        create: async (_options, attempt) => {
            // 第一次撞已存在(磁盘上确实有旧档)，轮换后第二次成功
            if (attempt === 1)
                throw new Error('session "old" already exists');
            return { agent };
        },
    });
    const record = await manager.getOrCreate('group', 'PEER1', 'SENDER1', {});
    assert.equal(created.length, 2, 'resume 失败后应重试一次轮换创建');
    const rotated = created[1];
    assert.notEqual(rotated, created[0], '轮换必须换出新的 sessionId');
    assert.equal(record.sessionId, rotated, '记录里的 sessionId 要用轮换后的新 id');
    assert.equal(manager.sessions.get('qqbot:undefined:group:PEER1')?.sessionId ?? record.sessionId, rotated);

    const prefs = JSON.parse(readFileSync(join(dataRoot, '.qqbot', 'model-prefs.json'), 'utf8'));
    const mapped = Object.values(prefs.sessionIds).find((v) => v === rotated);
    assert.equal(mapped, rotated, '映射也要落到轮换后的 id，否则下一条消息又去 resume 旧档');
});

test('a plain resume failure still creates under the original id', { skip }, async () => {
    const { manager, created, agent } = makeManager({
        resume: async () => {
            throw new Error('boom');
        },
        create: async () => ({ agent }),
    });
    const record = await manager.getOrCreate('c2c', 'PEER2', 'SENDER2', {});
    assert.equal(created.length, 1);
    assert.equal(record.sessionId, created[0]);
});
