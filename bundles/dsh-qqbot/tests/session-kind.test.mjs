import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
    buildSessionKindHint,
    initSessionKindRegistry,
    markSessionKindInjected,
    needsSessionKindInjection,
} from '../dist/features/session-kind.js';

test('群聊会话类型提示只保留一行事实', () => {
    assert.equal(
        buildSessionKindHint({ kind: 'group', name: '测试群', peerId: '1234567890ABCDEF' }),
        '[当前会话] 渠道=QQ 群聊 · 群名「测试群」 · 群 openid 尾号 90ABCDEF',
    );
});

test('私聊会话类型提示只保留一行事实', () => {
    assert.equal(
        buildSessionKindHint({ kind: 'c2c', name: '测试用户', peerId: '1234567890ABCDEF' }),
        '[当前会话] 渠道=QQ 私聊 · 对方「测试用户」 · 用户 openid 尾号 90ABCDEF',
    );
});

test('会话类型按 sessionId 整个会话只注入一次并持久化', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-kind-'));
    try {
        initSessionKindRegistry(dir);
        const sessionId = 'session-once-test';
        assert.equal(needsSessionKindInjection(sessionId), true);
        markSessionKindInjected(sessionId);
        assert.equal(needsSessionKindInjection(sessionId), false);
        assert.equal(needsSessionKindInjection('session-new-test'), true);
        const saved = JSON.parse(await readFile(join(dir, '.qqbot', 'session-kind-injected.json'), 'utf8'));
        assert.ok(saved.includes(sessionId));
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('session-manager 不再注入 group-rules，也不做会话类型内容比较', async () => {
    const source = await readFile(new URL('../dist/session/session-manager.js', import.meta.url), 'utf8');
    assert.ok(!source.includes('qqbot:group-rules'));
    assert.ok(!source.includes('needsSessionKindHint'));
    assert.ok(source.includes('needsSessionKindInjection(sessionId)'));
    assert.ok(source.includes('markSessionKindInjected(sessionId)'));
});
