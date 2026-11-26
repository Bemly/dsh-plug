/**
 * 系统风格检查的唤醒文案必须保持精简（主人 2026-11-26 明确要求）。
 *
 * 原版四行、把模型刚写的内容和两句长指令都念一遍，纯浪费 token；
 * 现在只保留「标题 + 原因 + 一句要求」两行。
 * 这个用例只守文案形态，不测业务逻辑。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const SOURCE = new URL('../examples/outbound/anti-similar-style.mjs', import.meta.url);

test('风格检查唤醒文案保持精简两行', async () => {
    const src = await readFile(SOURCE, 'utf8');

    // 必须有的：标题行 + 单行原因（含插值）
    assert.ok(
        src.includes('`[系统风格检查 · 已拒绝发送]`'),
        '缺少标题行',
    );
    assert.ok(
        src.includes('`原因：${reasonText}，请换一种不同的表达方式重新回复，不要每句话重复相同口癖。`'),
        '缺少精简后的原因行',
    );

    // 不该再出现的冗长句式
    for (const legacy of [
        '你刚才准备发出的消息',
        '没有发出去',
        '拒绝原因：',
        '请立刻换一种完全不同的开头、结尾和表达方式重新回复',
        '不要每句话都带 www',
    ]) {
        assert.ok(!src.includes(legacy), `冗长文案残留: ${legacy}`);
    }
});

test('唤醒文案只有两行', async () => {
    const src = await readFile(SOURCE, 'utf8');
    const block = src.slice(src.indexOf('const wakeMsg = ['), src.indexOf("].join('\\n')"));
    const rows = block.split('\n').filter((line) => line.trim().startsWith('`'));
    assert.equal(rows.length, 2, `wakeMsg 应为 2 行，实际 ${rows.length} 行`);
});
