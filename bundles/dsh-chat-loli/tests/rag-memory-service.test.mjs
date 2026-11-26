import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DEFAULT_SERVICE, apply, provideSharedService } from '../lib/rag-memory.js';

process.env.DSH_HOME = mkdtempSync(join(tmpdir(), 'rag-memory-service-'));

/** 只装 apply() 真正会用到的成员: effect / provide / tools / systemPrompt / on / llm */
function makeCtx({ provide, onProvide } = {}) {
    const calls = { register: 0, variable: 0, event: 0 };
    const ctx = {
        effect: (fn) => {
            fn();
            return { dispose: async () => { } };
        },
        provide: provide === undefined
            ? (name, value) => {
                onProvide?.(name, value);
                return () => { };
            }
            : provide,
        tools: { register: () => { calls.register += 1; } },
        systemPrompt: { variable: () => { calls.variable += 1; return () => { }; } },
        on: () => { calls.event += 1; return () => { }; },
        llm: {},
    };
    return { ctx, calls };
}

function captureWarn(fn) {
    const rows = [];
    const before = console.warn;
    console.warn = (msg) => rows.push(String(msg));
    try {
        fn();
    }
    finally {
        console.warn = before;
    }
    return rows;
}

test('returns the disposer when the service name is free', () => {
    const disposer = () => { };
    const seen = [];
    const out = provideSharedService(
        { provide: (name, value) => { seen.push([name, value]); return disposer; } },
        { embedText: async () => null },
    );
    assert.equal(out, disposer);
    assert.equal(seen[0][0], DEFAULT_SERVICE);
    assert.equal(typeof seen[0][1].embedText, 'function');
});

test('swallows the cross-instance provide collision instead of throwing', () => {
    const rows = captureWarn(() => {
        const out = provideSharedService(
            {
                provide: () => {
                    throw new Error('service "conanRag" has been registered at <agent=dsh-loli>');
                },
            },
            { embedText: async () => null },
        );
        assert.equal(out, undefined);
    });
    assert.equal(rows.length, 1);
    assert.match(rows[0], /conanRag 注册跳过/);
    assert.match(rows[0], /has been registered/);
});

test('is a no-op when the scope has no provide', () => {
    assert.equal(provideSharedService({}, { embedText: async () => null }), undefined);
    assert.equal(provideSharedService(undefined, { embedText: async () => null }), undefined);
});

test('apply() still boots the plugin when conanRag is already taken by another session', () => {
    const { ctx, calls } = makeCtx({
        provide: () => {
            throw new Error('service "conanRag" has been registered at <agent=dsh-loli>');
        },
    });
    const rows = captureWarn(() => assert.doesNotThrow(() => apply(ctx, { storeFile: 'rag-memory-service-test.json' })));
    assert.match(rows.join('\n'), /conanRag 注册跳过/);
    // 预设实例化不能因为服务注册失败而半途崩掉 —— 记忆工具与事件钩子都得照常挂上
    assert.ok(calls.register > 0, 'rag_memory_* 工具仍应注册');
    assert.ok(calls.event > 0, 'session/event 监听仍应挂上');
});

test('apply() provides conanRag once the name is free', () => {
    const seen = [];
    const { ctx } = makeCtx({ onProvide: (name, value) => seen.push([name, typeof value?.scoreValue]) });
    apply(ctx, { storeFile: 'rag-memory-service-test.json' });
    assert.deepEqual(seen, [[DEFAULT_SERVICE, 'function']]);
});
