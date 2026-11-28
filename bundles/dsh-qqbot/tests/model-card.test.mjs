import assert from 'node:assert/strict';
import test from 'node:test';
import { parseModelButton } from '../dist/features/model-switcher.js';

test('模型卡按钮带模型指纹，兼容老格式', () => {
    const fresh = parseModelButton('mdl:1:3:ab12cd34');
    assert.deepEqual(fresh, { page: 1, idx: 3, tag: 'ab12cd34' });
    const legacy = parseModelButton('mdl:0:2');
    assert.deepEqual(legacy, { page: 0, idx: 2, tag: '' });
    assert.equal(parseModelButton('mdl:0:prev'), 'prev');
    assert.equal(parseModelButton('mdl:0:next'), 'next');
    assert.equal(parseModelButton('mdl:0:1:tag:extra'), null);
    assert.equal(parseModelButton('eff:0'), null);
});

test('人格卡按钮同样带预设指纹', async () => {
    const { parsePresetButton } = await import('../dist/features/preset-switcher.js');
    assert.deepEqual(parsePresetButton('ps:0:2:deadbeef'), { page: 0, idx: 2, tag: 'deadbeef' });
    assert.deepEqual(parsePresetButton('ps:1:4'), { page: 1, idx: 4, tag: '' });
    assert.equal(parsePresetButton('ps:0:prev'), 'prev');
    assert.equal(parsePresetButton('mdl:0:1'), null);
});
