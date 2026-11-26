import assert from 'node:assert/strict';
import test from 'node:test';
import { createSemanticEmbedder, setRagServiceResolver } from '../dist/features/rag-embed.js';

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

test('skips semantic work when the RAG service is absent', async () => {
    setRagServiceResolver(() => undefined);
    const embedder = createSemanticEmbedder();
    assert.equal(embedder.available(), false);
    assert.equal(await embedder.embedQuery('hello'), undefined);
});
