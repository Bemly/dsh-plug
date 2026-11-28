import assert from 'node:assert/strict';
import test from 'node:test';
import { chunkMarkdownText } from '../dist/transport/chunker.js';

test('超长代码块分段后每段都有完整围栏', () => {
    const code = Array.from({ length: 200 }, (_, i) => `const a${i} = ${i};`).join('\n');
    const text = '```js\n' + code + '\n```';
    const chunks = chunkMarkdownText(text, 200);
    assert.ok(chunks.length > 1, '应当被拆成多段');
    for (const c of chunks) {
        assert.ok(c.length <= 200, `单段超限: ${c.length}`);
        assert.ok(c.startsWith('```js'), '每段都要有开围栏');
        assert.ok(c.trimEnd().endsWith('```'), '每段都要有闭围栏');
        // 围栏数量必须是 2 的倍数（不会出现半截块）
        const fences = c.split('\n').filter((l) => l.startsWith('```')).length;
        assert.equal(fences % 2, 0, '围栏必须成对');
    }
    // 内容不能丢
    assert.equal(chunks.map((c) => c.split('\n').slice(1, -1).join('\n')).join('\n'), code);
});

test('代码块中间的单行超长也会带围栏硬切', () => {
    const long = 'x'.repeat(500);
    const text = '```\n' + long + '\n```';
    const chunks = chunkMarkdownText(text, 120);
    assert.ok(chunks.length >= 4);
    for (const c of chunks) {
        assert.ok(c.startsWith('```\n'));
        assert.ok(c.trimEnd().endsWith('```'));
        assert.ok(c.length <= 120);
    }
});

test('未闭合的代码块（模型输出被截断）不会吞掉后文', () => {
    const text = '```js\nconst a = 1;\n\n后文段落';
    const chunks = chunkMarkdownText(text, 500);
    assert.equal(chunks.length, 1);
    assert.ok(chunks[0].includes('后文段落'));
});

test('普通段落仍按 limit 切，不引入围栏', () => {
    const text = Array.from({ length: 50 }, (_, i) => `第 ${i} 行`).join('\n');
    const chunks = chunkMarkdownText(text, 100);
    assert.ok(chunks.length > 1);
    assert.ok(chunks.every((c) => !c.includes('```')));
    assert.ok(chunks.every((c) => c.length <= 100));
});
