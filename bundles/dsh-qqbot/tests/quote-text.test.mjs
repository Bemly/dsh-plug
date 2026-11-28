import assert from 'node:assert/strict';
import test from 'node:test';
import { stripQqQuoteTemplate } from '../dist/transport/quote-text.js';

test('普通聊天里出现"引用消息/第1条"不会被当成 QQ 引用模板', () => {
    assert.deepEqual(stripQqQuoteTemplate('你引用消息里的第1条我没看懂'), ['你引用消息里的第1条我没看懂']);
    assert.deepEqual(stripQqQuoteTemplate('第 2 条规则写的是啥？'), ['第 2 条规则写的是啥？']);
});

test('真正的 QQ 引用模板仍然按层剥开', () => {
    const raw = '=== 消息 1 === [消息内容] 外层原话 [消息类型] 引用消息 [关联消息] --- 第1条 --- [消息内容] 更早的一句';
    assert.deepEqual(stripQqQuoteTemplate(raw), ['外层原话', '更早的一句']);
    assert.deepEqual(stripQqQuoteTemplate('[消息内容] 只有方括号标记'), ['只有方括号标记']);
});
