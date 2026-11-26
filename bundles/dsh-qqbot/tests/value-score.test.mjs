import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createValueScorer } from '../dist/features/value-score.js';
import { setRagServiceResolver } from '../dist/features/rag-embed.js';

test('marks OVMS failure as skipped and recovers on the next score', async () => {
    const dataRoot = mkdtempSync(join(tmpdir(), 'qq-value-score-'));
    let result = null;
    setRagServiceResolver(() => ({
        model: 'conan-embedding-v1',
        status: () => ({ available: true, mode: 'ovms' }),
        embedText: async () => null,
        embedBatch: async () => null,
        scoreValue: async () => result,
    }));
    try {
        const scorer = createValueScorer({ dataRoot, minScore: 0.5 });
        assert.equal(await scorer.score('你好'), undefined);
        assert.equal(scorer.unavailable(), true);
        result = { score: 0.8, worth: true, confidence: 0.9, lowConfidence: false, top: [] };
        assert.equal((await scorer.score('你好')).score, 0.8);
        assert.equal(scorer.unavailable(), false);
    } finally {
        rmSync(dataRoot, { recursive: true, force: true });
    }
});
