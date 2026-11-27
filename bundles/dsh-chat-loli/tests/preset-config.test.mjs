import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const patch = readFileSync(new URL('../cordis.patch.yml', import.meta.url), 'utf8');

function presetBlock(id) {
  const start = patch.indexOf(`        id: ${id}\n`);
  assert.notEqual(start, -1, `preset ${id} must exist`);
  const end = patch.indexOf('\n- insert:', start);
  return patch.slice(start, end === -1 ? undefined : end);
}

test('dsh-loli preset does not enable the time-context component', () => {
  assert.doesNotMatch(presetBlock('dsh-loli'), /@deepseek-ai\/dsh-time-context/);
});
