import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import vm from 'node:vm';

const source = (await readFile(new URL('../dist/gateway/debounce.js', import.meta.url), 'utf8'))
    .replace(/^import .*;\n/gm, '')
    .replace(/^export /gm, '');

function deferred() {
    let resolve;
    const promise = new Promise((r) => { resolve = r; });
    return { promise, resolve };
}

function loadDebounce(overrides = {}) {
    const calls = { steer: [], inbound: [] };
    const context = {
        console,
        process: { env: {} },
        setTimeout,
        clearTimeout,
        Date,
        Math,
        JSON,
        Map,
        Set,
        Promise,
        join,
        createUserMessage: ({ content, source }) => ({ content, source }),
        dataRootOf: () => '/tmp',
        stickerDirOf: () => '/tmp',
        handleInbound: async (...args) => { calls.inbound.push(args); },
        buildQuotePart: () => '',
        getHistoryStore: () => ({ list: async () => [] }),
        historyGroupKey: (...parts) => parts.join(':'),
        clearGroupHistory: () => {},
        lookupImagePath: () => undefined,
        prepareAggregateImages: async () => [],
        pushPreparedAggImage: () => {},
        applyInjectRules: (text) => text,
        inferMediaKind: (a) => a?.content_type === 'image' ? 'image' : '',
        prepareImagesForDispatch: async () => {},
        appendFileSync: () => {},
        statSync: () => undefined,
        writeFileSync: () => {},
        stripLeadingMentions: (text) => text,
        ...overrides,
    };
    vm.runInNewContext(`${source}\n;globalThis.__debounceTest = { debounceLayer };`, context);
    return { debounceLayer: context.__debounceTest.debounceLayer, calls };
}

function config(busySendMode = 'interject') {
    return {
        appId: 'test',
        outboundMode: 'adaptive',
        behavior: {
            freeIntervalSec: 0,
            debounce: { enabled: true, silenceSec: 1, maxMsgs: 1, mentionDelayed: true, busySendMode, debug: false },
        },
        imageAggregate: { enabled: false },
        injectRules: { rules: [] },
    };
}

function message(id, content) {
    return {
        kind: 'c2c',
        senderId: 'user',
        senderName: '用户',
        content,
        messageId: id,
        timestamp: new Date().toISOString(),
    };
}

test('回合中插话仍走 steer 并标记解除静默', async () => {
    const entered = deferred();
    const calls = { steer: [] };
    const rec = {
        sessionId: 's1',
        turnActive: true,
        interjectSeq: 0,
        agent: {
            status: 'running',
            steer(msg) {
                calls.steer.push(msg);
                entered.resolve();
            },
        },
    };
    const { debounceLayer } = loadDebounce();
    const layer = debounceLayer(config(), { findByPeer: () => rec }, console, new Map());
    await layer({ message: message('1', '第一条'), state: {} }, async () => {});
    await entered.promise;
    assert.equal(calls.steer.length, 1);
    assert.match(calls.steer[0].content[0].text, /第一条/);
    assert.equal(rec.interjectSeq, 1);
    assert.equal(rec.interjectLifted, true);
});

test('插话预解码期间到达的新消息不会被旧窗口吞掉', async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondSteered = deferred();
    const calls = { steer: [] };
    let downloads = 0;
    const rec = {
        sessionId: 's2',
        turnActive: true,
        interjectSeq: 0,
        agent: {
            status: 'running',
            steer(msg) {
                calls.steer.push(msg.content[0].text);
                if (calls.steer.length === 2)
                    secondSteered.resolve();
            },
        },
    };
    const { debounceLayer } = loadDebounce({
        prepareImagesForDispatch: async () => {
            downloads++;
            if (downloads === 1) {
                firstEntered.resolve();
                await releaseFirst.promise;
            }
        },
    });
    const layer = debounceLayer(config(), { findByPeer: () => rec }, console, new Map());
    await layer({ message: message('1', '第一条'), state: {} }, async () => {});
    await firstEntered.promise;
    await layer({ message: message('2', '第二条'), state: {} }, async () => {});
    releaseFirst.resolve();
    await secondSteered.promise;
    assert.equal(calls.steer.length, 2);
    assert.match(calls.steer[0], /第一条/);
    assert.doesNotMatch(calls.steer[0], /第二条/);
    assert.match(calls.steer[1], /第二条/);
});

test('插话注入抛错后回落排队，回合结束仍能派发', async () => {
    const dispatched = deferred();
    const inbound = [];
    let steerAttempts = 0;
    const rec = {
        sessionId: 's-fallback',
        turnActive: true,
        interjectSeq: 0,
        agent: {
            status: 'running',
            steer() {
                steerAttempts++;
                throw new Error('steer failed');
            },
        },
    };
    const { debounceLayer } = loadDebounce({
        handleInbound: async (msg) => {
            inbound.push(msg.content);
            dispatched.resolve();
        },
    });
    const layer = debounceLayer(config(), { findByPeer: () => rec }, console, new Map());
    await layer({ message: message('1', '失败也保留'), state: {} }, async () => {});
    await new Promise((resolve) => setTimeout(resolve, 20));
    rec.turnActive = false;
    rec.agent.status = 'idle';
    await dispatched.promise;
    assert.equal(steerAttempts, 1);
    assert.deepEqual(inbound, ['失败也保留']);
});

test('同 key 正常派发串行，第二批不会先于第一批', async () => {
    const firstEntered = deferred();
    const releaseFirst = deferred();
    const secondDone = deferred();
    const order = [];
    let n = 0;
    const { debounceLayer } = loadDebounce({
        handleInbound: async (msg) => {
            n++;
            order.push(msg.content);
            if (n === 1) {
                firstEntered.resolve();
                await releaseFirst.promise;
            }
            if (n === 2)
                secondDone.resolve();
        },
    });
    const rec = { sessionId: 's3', turnActive: false, agent: { status: 'idle' } };
    const layer = debounceLayer(config('queue'), { findByPeer: () => rec }, console, new Map());
    await layer({ message: message('1', '第一条'), state: {} }, async () => {});
    await firstEntered.promise;
    await layer({ message: message('2', '第二条'), state: {} }, async () => {});
    releaseFirst.resolve();
    await secondDone.promise;
    assert.deepEqual(order, ['第一条', '第二条']);
});
