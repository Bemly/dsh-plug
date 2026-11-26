import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticEmbedder, getRagOvmsTarget, scoreValueKnn, setRagOvmsTarget, setRagServiceResolver } from '../dist/features/rag-embed.js';

/** 假 OVMS：记录每次请求，返回按 input 派生的确定向量 */
function mockOvms(handler) {
    const calls = [];
    globalThis.fetch = async (url, init) => {
        const body = JSON.parse(init.body);
        calls.push({ url, body, signal: init.signal });
        return handler(url, body, init);
    };
    return calls;
}

const okVectors = (texts) => ({
    ok: true,
    json: async () => ({ data: texts.map((t, i) => ({ index: i, embedding: [t.length, i + 1] })) }),
});

test.beforeEach(() => {
    setRagServiceResolver(() => undefined);
    setRagOvmsTarget({});
});

test('prefers the conanRag service and never hits HTTP when it is visible', async () => {
    const calls = mockOvms(() => {
        throw new Error('should not be called');
    });
    const seen = [];
    setRagServiceResolver(() => ({
        model: 'svc-model',
        status: () => ({ mode: 'service' }),
        embedText: async (t) => {
            seen.push(['text', t]);
            return [9];
        },
        embedBatch: async (ts) => {
            seen.push(['batch', ts.join(',')]);
            return ts.map(() => [8]);
        },
        scoreValue: async (a) => {
            seen.push(['score', a.text]);
            return { score: 0.9, worth: true, confidence: 0.9, lowConfidence: false, top: [] };
        },
    }));
    const embedder = createSemanticEmbedder({ logger: { warn() { } } });
    assert.equal(embedder.available(), true);
    assert.deepEqual(await embedder.embedQuery('hello'), [9]);
    assert.deepEqual(await embedder.embedPassages(['a', 'b']), [[8], [8]]);
    assert.equal((await embedder.scoreValue({ text: 'x', samples: [{ m: 'a', y: 1 }] })).score, 0.9);
    assert.equal(calls.length, 0);
    assert.deepEqual(seen, [['text', 'hello'], ['batch', 'a,b'], ['score', 'x']]);
});

test('falls back to direct OVMS HTTP when the service is not in scope', async () => {
    const calls = mockOvms((_url, body) => okVectors(body.input));
    setRagServiceResolver(() => undefined);
    const embedder = createSemanticEmbedder({ logger: { warn() { } } });
    assert.equal(embedder.available(), true);
    assert.deepEqual(await embedder.embedQuery('abc'), [3, 1]);
    assert.deepEqual(await embedder.embedPassages(['a', 'bb']), [[1, 1], [2, 2]]);
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[0].body, { model: 'conan-embedding-v1', input: ['abc'] });
    assert.equal(calls[0].url, 'http://127.0.0.1:8765/v3/embeddings');
});

test('sorts out-of-order OVMS rows back to input order', async () => {
    mockOvms(() => ({
        ok: true,
        json: async () => ({
            data: [
                { index: 1, embedding: [20] },
                { index: 0, embedding: [10] },
            ],
        }),
    }));
    const embedder = createSemanticEmbedder();
    assert.deepEqual(await embedder.embedPassages(['a', 'b']), [[10], [20]]);
});

test('scores value locally with weighted KNN and caches sample vectors per sampleKey', async () => {
    const calls = mockOvms((_url, body) => ({
        ok: true,
        json: async () => ({
            data: body.input.map((t, i) => ({
                index: i,
                // 样例 "want" 与查询 "hi" 同向量(相似 1.0)；"skip" 正交(相似 0)
                embedding: t === 'want' || t === 'hi' ? [1, 0] : [0, 1],
            })),
        }),
    }));
    const embedder = createSemanticEmbedder({ logger: { warn() { } } });
    const samples = [
        { m: 'want', y: 1 },
        { m: 'skip', y: 0 },
    ];
    const first = await embedder.scoreValue({ text: 'hi', samples, sampleKey: 'k1', minScore: 0.5 });
    assert.equal(first.score, 1);
    assert.equal(first.worth, true);
    assert.equal(first.confidence, 1);
    assert.equal(first.lowConfidence, false);
    assert.equal(first.top[0].m, 'want');
    // 1 次样例批量嵌入 + 1 次查询嵌入
    assert.equal(calls.length, 2);
    await embedder.scoreValue({ text: 'hi', samples, sampleKey: 'k1', minScore: 0.5 });
    assert.equal(calls.length, 3, '样例向量应命中缓存，第二次只多一次查询嵌入');
    await embedder.scoreValue({ text: 'hi', samples, sampleKey: 'k2', minScore: 0.5 });
    assert.equal(calls.length, 5, 'sampleKey 变了(改了样例库)就要重新嵌入样例');
});

test('every OVMS failure is fail-open: no throw, no score', async () => {
    const warned = [];
    const embedder = createSemanticEmbedder({ logger: { warn: (m) => warned.push(m) } });
    mockOvms(() => ({ ok: false, status: 500, json: async () => ({}) }));
    assert.equal(await embedder.embedQuery('hi'), undefined);
    assert.equal(await embedder.embedPassages(['a']), undefined);
    assert.equal(await embedder.scoreValue({ text: 'hi', samples: [{ m: 'a', y: 1 }], sampleKey: 'err' }), undefined);
    assert.equal(warned.length, 3);
    assert.match(warned[0], /本次跳过/);

    // 响应缺向量同样算失败(不能把 undefined 向量喂给下游)
    mockOvms(() => ({ ok: true, json: async () => ({ data: [] }) }));
    assert.equal(await embedder.embedQuery('hi'), undefined);

    // 网络异常
    mockOvms(() => {
        throw new Error('ECONNREFUSED');
    });
    assert.equal(await embedder.embedQuery('hi'), undefined);
});

test('gives up on a hanging OVMS request at the configured timeout', async () => {
    setRagOvmsTarget({ ovmsTimeoutMs: 25 });
    let sawAbort = false;
    globalThis.fetch = (_url, init) => new Promise((_resolve, reject) => {
        init.signal.addEventListener('abort', () => {
            sawAbort = true;
            reject(init.signal.reason);
        });
    });
    const embedder = createSemanticEmbedder({ logger: { warn() { } } });
    assert.equal(await embedder.embedQuery('hi'), undefined);
    assert.equal(sawAbort, true);
});

test('enabled:false is a separate instance and short-circuits everything', async () => {
    const calls = mockOvms((_url, body) => okVectors(body.input));
    const off = createSemanticEmbedder({ enabled: false });
    assert.equal(off.available(), false);
    assert.deepEqual(off.status(), { available: false, mode: 'off', reason: '智能回复已关闭' });
    assert.equal(await off.embedQuery('hi'), undefined);
    assert.equal(calls.length, 0);
    // 关键回归: 早先缓存只取"第一个实例"，后建的开启实例会沿用 off 的开关
    assert.equal(createSemanticEmbedder({}).available(), true);
});

test('setRagOvmsTarget switches endpoint and invalidates the sample cache', async () => {
    const calls = mockOvms((_url, body) => okVectors(body.input));
    setRagOvmsTarget({ ovmsEndpoint: 'http://10.0.0.1:9999/v4/embed', ovmsModel: 'other-model' });
    assert.deepEqual(getRagOvmsTarget(), {
        endpoint: 'http://10.0.0.1:9999/v4/embed',
        model: 'other-model',
        timeoutMs: 15000,
    });
    const embedder = createSemanticEmbedder();
    const samples = [{ m: 'want', y: 1 }];
    await embedder.scoreValue({ text: 'hi', samples, sampleKey: 'k3' });
    assert.equal(calls[0].url, 'http://10.0.0.1:9999/v4/embed');
    assert.equal(calls[0].body.model, 'other-model');
    assert.deepEqual(embedder.status(), {
        available: true,
        mode: 'ovms-direct',
        model: 'other-model',
        endpoint: 'http://10.0.0.1:9999/v4/embed',
        reason: 'OVMS 故障时跳过语义评分',
    });
});

test('status reports the last OVMS failure instead of claiming OVMS is wired up', async () => {
    mockOvms(() => ({ ok: false, status: 503, json: async () => ({}) }));
    const embedder = createSemanticEmbedder({ logger: { warn() { } } });
    assert.equal(await embedder.embedQuery('hi'), undefined);
    const down = embedder.status();
    assert.equal(down.available, false);
    assert.equal(down.mode, 'ovms-direct');
    assert.match(down.reason, /最近一次请求失败/);
    assert.equal(embedder.available(), true, 'available 仍为 true —— 判定链要 fail-open，不能因为一次失败就整条静默');
    mockOvms((_url, body) => okVectors(body.input));
    assert.deepEqual(await embedder.embedQuery('hi'), [2, 1]);
    assert.equal(embedder.status().available, true);
});

test('scoreValueKnn weights neighbours and rejects mismatched input', () => {
    const samples = [
        { m: 'a', y: 1 },
        { m: 'b', y: 0 },
    ];
    const vecs = [[1, 0], [0.6, 0.8]];
    const r = scoreValueKnn([1, 0], samples, vecs, { minScore: 0.5, k: 2, weightPow: 8 });
    assert.equal(r.lowConfidence, false);
    assert.ok(r.score > 0.9);
    assert.equal(scoreValueKnn([1, 0], samples, [[1, 0]], {}), undefined);
    assert.equal(scoreValueKnn(undefined, samples, vecs, {}), undefined);
});
