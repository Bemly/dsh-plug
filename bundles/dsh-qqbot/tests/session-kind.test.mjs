import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { buildSessionKindHint, needsSessionKindHint } from '../dist/features/session-kind.js';

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

test('会话类型提示只注入一次', () => {
    assert.equal(needsSessionKindHint(false, false), true);
    assert.equal(needsSessionKindHint(true, false), false);
    assert.equal(needsSessionKindHint(false, true), false);
    assert.equal(needsSessionKindHint(true, true), false);
});

test('session-manager 不再按群名变化重复注入', async () => {
    const source = await readFile(new URL('../dist/session/session-manager.js', import.meta.url), 'utf8');
    assert.ok(source.includes('needsSessionKindHint(_kindInBatch, _kindInSurface)'));
    assert.ok(!source.includes('_lastHintText.includes(info.name)'));
});
