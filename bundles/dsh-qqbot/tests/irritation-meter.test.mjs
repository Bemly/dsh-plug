import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { onInbound } from '../examples/inbound/irritation-meter.mjs';

test('keeps scores but delegates target judgment to context', async () => {
    const root = mkdtempSync(join(tmpdir(), 'mps-irritation-test-'));
    const originalNow = Date.now;
    const now = originalNow();
    const injected = [];
    const ctx = {
        dataRoot: root,
        scope: 'group',
        sender: 'sender-1',
        senderName: '叶子',
        groupId: 'group-1',
        isOwner: false,
        platform: { mentioned: false },
        silentInto: ({ text }) => injected.push(text),
        decide() {},
        logger: { debug() {} },
    };
    try {
        Date.now = () => now;
        for (let i = 0; i < 6; i++) {
            await onInbound(ctx, async () => {});
        }
    } finally {
        Date.now = originalNow;
    }
    try {
        const text = injected.join('\n');
        assert.match(text, /【烦躁 2\/6】/);
        assert.match(text, /【被单方面缠住 4\/6】/);
        assert.match(text, /结合当前上下文判断/);
        assert.match(text, /bot/);
        for (const phrase of ['又来了', '耳朵都听起茧了', '真是的', '你怎么一直在说呀', '抱怨', '小吐槽']) {
            assert.equal(text.includes(phrase), false, `removed phrase still present: ${phrase}`);
        }
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
