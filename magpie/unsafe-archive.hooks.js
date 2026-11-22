// magpie-unsafe-archive：网关请求钩子（跑在 Bun 插件宿主）。
//
// 位置语义：onRequest 拿到的是遮盖（redact）之前的原文——gatewayHooks 跑在
// serve 之前，而 Masker 在 serve 里面；onResponse 拿到的是还原后 agent 收到
// 的那份。两处都落盘，正文原样交回网关，遮盖对厂商照常生效。
//
// 归档只追加，**永不删除、永不轮转**：这是审计留痕，删一条就少一条。
// 归档里是含密钥的明文，这是本插件存在的目的，也是它的风险。
//
// 可靠性边界（magpie 源码 internal/plugin/gateway.go、host.js）：
//   - 并发跑满 GATEWAY_RUN_LIMIT 时钩子不被调用，请求照常发，本归档静默丢这条；
//   - 钩子有 2~10 秒总预算，落盘超预算会被中断，同样丢这条；
//   - onRequest 返回 undefined 表示不改正文；改动 tools/tool_choice/model/stream
//     会被回滚并计为失败，且拿不到 onResponse。
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
// npm 安装时本文件在 node_modules 里，归档写在那儿会随升级丢失；那种情况退到
// 用户主目录。按路径安装（magpie plugin add <路径>）仍写插件旁。
const IN_NODE_MODULES = HERE.includes(`${path.sep}node_modules${path.sep}`);
const DEFAULT_DIR = IN_NODE_MODULES
  ? path.join(os.homedir(), "magpie-unsafe-archive")
  : path.join(HERE, "archive");

function archiveDir(ctx) {
  const o = ctx.options || {};
  return o.dir || process.env.MAGPIE_UNSAFE_ARCHIVE_DIR || DEFAULT_DIR;
}

function append(ctx, line) {
  const dir = archiveDir(ctx);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const fd = fs.openSync(file, "a", 0o600);
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
  append(ctx, JSON.stringify({
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
