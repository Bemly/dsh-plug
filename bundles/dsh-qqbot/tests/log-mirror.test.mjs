import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { configureDiag, diagPathFor } from '../dist/shared/diag.js';
import { mirrorLogger } from '../dist/shared/log-mirror.js';

const home = mkdtempSync(join(tmpdir(), 'qqbot-log-mirror-'));
configureDiag({ home, maxBytes: 4096, enabled: false });

const FILE = diagPathFor('qqbot-logger');

function recorder() {
    const calls = [];
    return {
        calls,
        logger: {
            info: (...a) => calls.push(['info', a]),
            warn: (...a) => calls.push(['warn', a]),
            error: (...a) => calls.push(['error', a]),
            debug: (...a) => calls.push(['debug', a]),
        },
    };
}

function rows() {
    return existsSync(FILE) ? readFileSync(FILE, 'utf8').trim().split('\n').filter(Boolean) : [];
}

test('warn/error 同时落盘，诊断开关关着也写', () => {
    const base = recorder();
    const logger = mirrorLogger(base.logger);
    logger.warn('resume 失败(改走 create): key=qqbot sessionId=abc err=preset unavailable');
    logger.error('ERROR creating session: session "abc" already exists');
    assert.equal(base.calls.length, 2, '宿主 stdout 那边照常收到');
    const lines = rows();
    assert.equal(lines.length, 2);
    assert.match(lines[0], /^\d{4}-\d{2}-\d{2}T[\d:.]+Z warn: resume 失败/);
    assert.match(lines[1], /error: ERROR creating session/);
});

test('info/debug 不进文件，免得把盘写脏', () => {
    const before = rows().length;
    const logger = mirrorLogger(recorder().logger);
    logger.info('价值评分就绪: 793 条样例');
    logger.debug?.('some noise');
    assert.equal(rows().length, before);
});

test('重复包装不会写两遍', () => {
    const base = recorder();
    const once = mirrorLogger(base.logger);
    const twice = mirrorLogger(mirrorLogger(once));
    assert.equal(twice, once, '已镜像的对象应原样返回');
    const before = rows().length;
    twice.warn('dup');
    assert.equal(rows().length, before + 1);
});

test('Error 与对象参数渲染成可读文本并限长', () => {
    const logger = mirrorLogger(recorder().logger);
    const before = rows().length;
    logger.error('boom', new Error('preset mount failed'));
    logger.warn('ctx', { sessionId: 'abc', nested: { y: 1 } });
    logger.warn('长', 'x'.repeat(5000));
    const lines = rows().slice(before);
    assert.match(lines[0], /boom Error: preset mount failed$/);
    assert.match(lines[1], /ctx \{"sessionId":"abc","nested":\{"y":1\}\}$/);
    assert.ok(lines[2].length < 2100, `单行要截断，实际 ${lines[2].length}`);
});

test('循环引用之类的参数也不会抛', () => {
    const base = recorder();
    const logger = mirrorLogger(base.logger);
    const circular = { name: 'x' };
    circular.self = circular;
    assert.doesNotThrow(() => logger.warn('meta', circular));
    assert.equal(base.calls.length, 1);
});

test('超上限自动轮转，只留 1 份旧档', () => {
    configureDiag({ home, maxBytes: 200 });
    const logger = mirrorLogger(recorder().logger);
    for (let i = 0; i < 40; i++)
        logger.warn(`第 ${i} 条很长的告警内容用来触发轮转 ${'y'.repeat(40)}`);
    const files = readdirSync(home).filter((f) => f.startsWith('qqbot-logger'));
    assert.deepEqual(files.sort(), ['qqbot-logger.log', 'qqbot-logger.log.1']);
    assert.ok(existsSync(join(home, 'qqbot-logger.log.1')));
    configureDiag({ home, maxBytes: 4096 });
});

test('目录不可写时只丢文件日志，绝不抛、绝不吞掉 stdout', () => {
    configureDiag({ home: join('/dev/null', 'nope') });
    const base = recorder();
    const logger = mirrorLogger(base.logger);
    assert.doesNotThrow(() => logger.warn('落不了盘也要有 stdout'));
    assert.equal(base.calls.length, 1);
    configureDiag({ home, maxBytes: 4096 });
});
