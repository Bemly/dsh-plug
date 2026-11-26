import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const configSource = readFileSync(new URL('../dist/config.js', import.meta.url), 'utf8');

test('keeps session image offload disabled by default', () => {
    assert.match(configSource, /imageOffload: Schema\.boolean\(\)\.default\(false\)/u);
});

test('removes bge model paths and lexical fallback configuration', () => {
    assert.doesNotMatch(configSource, /bge-small|modelDir|lexicalFallback/u);
});
