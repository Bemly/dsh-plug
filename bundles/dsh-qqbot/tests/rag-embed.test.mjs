import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticEmbedder, setRagOvmsTarget, setRagServiceResolver } from '../dist/features/rag-embed.js';

test('uses the shared conan RAG service for embeddings and value scoring', async () => {
    const calls = [];
    const service = {
        model: 'conan-embedding-v1',
        endpoint: 'http://127.0.0.1:8765/v3/embeddings',
        status: () => ({ available: true, mode: 'ovms' }),
        async embedText(text) { calls.push(['text', text]); return [1, 2]; },
        async embedBatch(texts) { calls.push(['batch', texts]); return texts.map(() => [3, 4]); },
        async scoreValue(args) { calls.push(['score', args]); return { score: 0.75, worth: true, confidence: 0.8, lowConfidence: false, top: [] }; },
    };
    setRagServiceResolver(() => service);
    const embedder = createSemanticEmbedder();
    assert.equal(embedder.available(), true);
    assert.deepEqual(await embedder.embedQuery('hello'), [1, 2]);
    assert.deepEqual(await embedder.embedPassages(['a', 'b']), [[3, 4], [3, 4]]);
    assert.equal((await embedder.scoreValue({ text: 'hello', samples: [{ m: 'a', y: 1 }] })).score, 0.75);
    assert.deepEqual(calls.map(([kind]) => kind), ['text', 'batch', 'score']);
});

test('skips semantic work when OVMS returns no vector', async () => {
    setRagServiceResolver(() => ({
        model: 'conan-embedding-v1',
        status: () => ({ available: true, mode: 'ovms' }),
        embedText: async () => null,
        embedBatch: async () => null,
        scoreValue: async () => null,
    }));
    const embedder = createSemanticEmbedder();
    assert.equal(await embedder.embedQuery('hello'), undefined);
    assert.equal(await embedder.embedPassages(['a']), undefined);
    assert.equal(await embedder.scoreValue({ text: 'hello', samples: [{ m: 'a', y: 1 }] }), undefined);
});

test('falls back to direct OVMS HTTP when the RAG service is absent', async () => {
    setRagServiceResolver(() => undefined);
    setRagOvmsTarget({});
    const requests = [];
    globalThis.fetch = async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) });
        return { ok: true, json: async () => ({ data: [{ index: 0, embedding: [1, 2, 3] }] }) };
    };
    const embedder = createSemanticEmbedder();
    // ★ 2026-11-26 语义变更：conanRag 挂在预设子作用域，根作用域永远取不到；
    //   取不到服务不再等于"智能回复不可用"，改为按 localModel.ovmsEndpoint 直连 OVMS。
    assert.equal(embedder.available(), true);
    assert.deepEqual(await embedder.embedQuery('hello'), [1, 2, 3]);
    assert.equal(requests[0].url, 'http://127.0.0.1:8765/v3/embeddings');
});

test('still skips semantic work when OVMS itself is unreachable', async () => {
    setRagServiceResolver(() => undefined);
    setRagOvmsTarget({});
    globalThis.fetch = async () => {
        throw new Error('ECONNREFUSED');
    };
    const embedder = createSemanticEmbedder();
    assert.equal(await embedder.embedQuery('hello'), undefined);
});
