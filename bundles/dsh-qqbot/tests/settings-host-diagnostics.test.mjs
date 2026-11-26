import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

/**
 * 设置面板两条桥接路径的结构守卫（2026-11-26 排查会话消失时实测到的两处 bug）。
 * 这两处都在 HTTP 处理器/磁盘扫描里，值不值得做行为测试见注释。
 */
const source = readFileSync(new URL('../settings-host.js', import.meta.url), 'utf8');

function sliceFrom(marker, stopRe) {
    const start = source.indexOf(marker);
    assert.notEqual(start, -1, `源码里找不到 ${marker}`);
    const rest = source.slice(start);
    const stop = rest.slice(marker.length).search(stopRe);
    return stop === -1 ? rest : rest.slice(0, marker.length + stop);
}

test('_debug 路由的处理器必须拿到真正的 req', () => {
    const handler = sliceFrom("'/api/qqbot-settings/_debug'", /\n {2}route\(/u);
    // 以前写成 async (_req, res) 却在校验里用 req.headers —— 打开诊断端点直接 500 "req is not defined"
    assert.match(handler.slice(0, 80), /async \(req, res\)/u, '参数名要和函数体里的 req 一致');
    assert.doesNotMatch(handler, /_req/u);
    assert.match(handler, /hostHeader: req\.headers/u);
    assert.match(handler, /hostTrusted: isTrusted\(req\)/u);
});

test('会话活跃时间扫描按 DSH_HOME 解析会话根目录', () => {
    const body = sliceFrom('function wsScanSessions()', /\n {2}\}\n/u);
    // 应用容器（NAS 等）把 DSH_HOME 指到应用自己的目录，会话在 $DSH_HOME/sessions；
    // 原来固定拼 $HOME/.dsh/sessions ⇒ 恒空表，面板/悬浮窗拿不到"各会话最后活动时间"。
    assert.match(body, /process\.env\.DSH_HOME/u);
    assert.doesNotMatch(body, /join\(home,\s*'\.dsh',\s*'sessions'\)/u);
    assert.match(body, /join\(home,\s*'sessions'\)/u);
});
