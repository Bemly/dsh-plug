import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { IMAGE_DOWNLOAD_ATTEMPTS } from '../dist/middleware/sticker-capture.js';
import { lookupMsgContent, rememberMsgContent } from '../dist/transport/msg-content-cache.js';
import { formatToolResult } from '../dist/transport/tool-presenter.js';

const root = new URL('../', import.meta.url);

test('合并转发下载保留四轮进阶且不再有120秒 race', async () => {
    const inbound = await readFile(new URL('../dist/transport/inbound.js', import.meta.url), 'utf8');
    const capture = await readFile(new URL('../dist/middleware/sticker-capture.js', import.meta.url), 'utf8');
    assert.deepEqual(IMAGE_DOWNLOAD_ATTEMPTS.map((x) => [x.concurrency, x.timeoutMs]), [
        [1, 30_000],
        [2, 120_000],
        [4, 300_000],
        [8, 600_000],
    ]);
    assert.ok(capture.includes('const MAX_PER_MSG = 100'));
    assert.ok(!inbound.includes('MERGE_FORWARD_DOWNLOAD_MS'));
    assert.ok(inbound.includes('const _got = await prepareImagesForDispatch(_fake, msg, config, logger);'));
    assert.ok(inbound.includes('prepareAggregateImages'));
});

test('debounce flush 有并发锁', async () => {
    const source = await readFile(new URL('../dist/gateway/debounce.js', import.meta.url), 'utf8');
    assert.ok(source.includes('if (w.flushing)'));
    assert.ok(source.includes('await flushLocked(key, w)'));
    assert.ok(source.includes('w.flushing = false'));
});

test('fork 失败保留当前会话且不返回已销毁 agent', async () => {
    const source = await readFile(new URL('../dist/session/session-manager.js', import.meta.url), 'utf8');
    assert.ok(source.includes('fork failed, keep current session'));
    assert.ok(source.includes('fork unavailable, keep current session'));
    assert.ok(!source.includes('fallback to dispose'));
    assert.ok(source.includes("if (!forked)\n            return 'failed'"));
});

test('引用台账裁剪后旧索引失效且新索引可用', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'dsh-botqq-msg-index-'));
    const peer = 'group:test';
    try {
        for (let i = 0; i < 2001; i++)
            rememberMsgContent(dir, peer, String(i), { t: `msg-${i}` });
        assert.equal(lookupMsgContent(dir, peer, '0'), undefined);
        assert.equal(lookupMsgContent(dir, peer, '2000')?.t, 'msg-2000');
        const file = await readFile(join(dir, '.qqbot', 'msg-content.jsonl'), 'utf8');
        assert.equal(file.trim().split('\n').length, 2000);
    }
    finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('工具结果首块为图片时仍展示后续文本', () => {
    const out = formatToolResult('demo', '{}', {
        message: {
            content: [
                { type: 'tool-result', content: [{ type: 'image', image_url: 'data:image/png;base64,x' }] },
                { type: 'tool-result', content: [{ type: 'text', text: '后续文本' }] },
            ],
        },
    });
    assert.ok(out.includes('后续文本'));
});

test('groupPrompt 与 group-rules 已从配置、UI和注入链路删除', async () => {
    for (const rel of ['dist/config.js', 'dist/config.d.ts', 'client/qqbot-settings.js', 'dist/session/session-manager.js']) {
        const source = await readFile(new URL(rel, root), 'utf8');
        assert.ok(!source.includes('groupPrompt'), rel);
        assert.ok(!source.includes('qqbot:group-rules'), rel);
    }
});

test('公开类型链与包检查脚本完整', () => {
    for (const rel of ['dist/types.d.ts', 'dist/session/types.d.ts', 'dist/model/types.d.ts', 'scripts/check-package.mjs'])
        assert.ok(existsSync(new URL(rel, root)), rel);
    const output = execFileSync(process.execPath, ['scripts/check-package.mjs'], {
        cwd: new URL('.', root).pathname,
        encoding: 'utf8',
    });
    assert.ok(output.includes('package check OK'));
});
