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

test('declares the OVMS direct target fields in the localModel schema', () => {
    // settings 走 Schema 校验：未声明的字段会被**静默丢掉**（面板保存后重载跳回默认）
    for (const field of ['ovmsEndpoint', 'ovmsModel', 'ovmsTimeoutMs'])
        assert.match(configSource, new RegExp(`^\\s*${field}: Schema\\.`, 'mu'), `${field} 必须声明在 localModelSchema 里`);
});

test('OVMS direct target defaults to the shared conan embedding endpoint', async () => {
    const { getRagOvmsTarget, setRagOvmsTarget } = await import('../dist/features/rag-embed.js');
    // 面板没填 = 用与 dsh-chat-loli 同源的默认值，智能回复开箱即用
    setRagOvmsTarget({});
    assert.equal(getRagOvmsTarget().endpoint, 'http://127.0.0.1:8765/v3/embeddings');
    assert.equal(getRagOvmsTarget().model, 'conan-embedding-v1');
    assert.equal(getRagOvmsTarget().timeoutMs, 15000);
    setRagOvmsTarget({ ovmsEndpoint: ' http://127.0.0.1:9999/v3/embeddings ', ovmsModel: 'x', ovmsTimeoutMs: 300 });
    assert.deepEqual(getRagOvmsTarget(), { endpoint: 'http://127.0.0.1:9999/v3/embeddings', model: 'x', timeoutMs: 300 });
    // 非法超时(0/负数/字符串)不能把请求变成"永不超时"
    setRagOvmsTarget({ ovmsTimeoutMs: 'abc' });
    assert.equal(getRagOvmsTarget().timeoutMs, 15000);
    setRagOvmsTarget({});
});
