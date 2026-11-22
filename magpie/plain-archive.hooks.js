// magpie 明文归档钩子（gateway request hooks，跑在 Bun 插件宿主）。
//
// 位置语义：onRequest 拿到的是遮盖（redact）之前的原文——gatewayHooks 跑在
// serve 之前，而 Masker 在 serve 里面；onResponse 拿到的是还原后 agent 收到
// 的那份。两处都落盘，正文原样交回网关，遮盖对厂商照常生效。
//
// 归档目录：环境变量 MAGPIE_PLAIN_DIR 优先，否则落在本文件旁的 archive/。
// 文件权限 0600，目录 0700：这里存的是含密钥的明文。
//
// 可靠性边界（magpie 源码 internal/plugin/gateway.go、host.js）：
//   - 并发跑满 GATEWAY_RUN_LIMIT 时钩子不被调用，请求照常发，本归档静默丢这条；
//   - 钩子有总预算（2~10s），落盘超预算会被 abort，同样丢这条；
//   - onRequest 返回 undefined 表示不改正文；改动 tools/tool_choice/model/stream
//     会被回滚并计为失败，且拿不到 onResponse。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.MAGPIE_PLAIN_DIR || path.join(HERE, "archive");

function ensureDir() {
  fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
}

function append(line) {
  ensureDir();
  const file = path.join(DIR, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const fd = fs.openSync(file, fs.existsSync(file) ? "a" : "a", 0o600);
  try {
    fs.writeSync(fd, line + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

export async function onRequest(body, ctx) {
  ctx.pending = {
    at: new Date().toISOString(),
    session: ctx.session ?? "",
    agent: ctx.agent ?? "",
    caller: ctx.caller ?? null,
    model: ctx.model ?? "",
    protocol: ctx.protocol ?? "",
    origin: ctx.origin ?? "",
    path: ctx.path ?? "",
    kind: ctx.kind ?? "",
    stream: ctx.stream === true,
    body,
  };
  return undefined;
}

export async function onResponse(reply, ctx) {
  const p = ctx.pending;
  if (!p) return undefined;
  append(JSON.stringify({
    at: p.at,
    session: p.session,
    agent: p.agent,
    caller: p.caller,
    model: p.model,
    protocol: p.protocol,
    origin: p.origin,
    path: p.path,
    kind: p.kind,
    stream: p.stream,
    success: ctx.success === true,
    request: p.body,
    reply,
  }));
  return undefined;
}
