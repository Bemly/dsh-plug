// magpie-unsafe-archive：网关请求钩子（跑在 Bun 插件宿主）。
//
// 位置语义：onRequest 拿到的是遮盖（redact）之前的原文——gatewayHooks 跑在
// serve 之前，而 Masker 在 serve 里面；onResponse 拿到的是还原后 agent 收到
// 的那份。两处都落盘，正文原样交回网关，遮盖对厂商照常生效。
//
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

const DEFAULT_KEEP_DAYS = 30;
// 2 GiB。JS 的位运算是 32 位有符号，`2 << 30` 会得到 -2147483648，
// 那会让 prune 把整个归档删光——必须用普通乘法。
const DEFAULT_KEEP_BYTES = 2 * 1024 * 1024 * 1024;
const PRUNE_EVERY_MS = 60 * 60 * 1000;

let lastPrune = 0;

function settings(ctx) {
  const o = ctx.options || {};
  const num = (v, d) => {
    const n = Number(v);
    return Number.isFinite(n) && n > 0 ? n : d;
  };
  return {
    dir: o.dir || process.env.MAGPIE_UNSAFE_ARCHIVE_DIR || DEFAULT_DIR,
    days: num(o.keepDays, DEFAULT_KEEP_DAYS),
    bytes: num(o.keepBytes, DEFAULT_KEEP_BYTES),
  };
}

const DAY_FILE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;

// 按天分文件，所以过期判断用文件名而不是 mtime。先删超过 keepDays 的，
// 再从最旧的开始删直到总量落到 keepBytes 以内。
function prune(dir, days, bytes) {
  const cutoff = Date.now() - days * 86400000;
  const kept = [];
  let total = 0;
  for (const name of fs.readdirSync(dir)) {
    const m = DAY_FILE.exec(name);
    if (!m) continue;
    const at = Date.parse(`${m[1]}T00:00:00Z`);
    if (Number.isNaN(at)) continue;
    const file = path.join(dir, name);
    if (at < cutoff) {
      try { fs.unlinkSync(file); } catch { }
      continue;
    }
    let size = 0;
    try { size = fs.statSync(file).size; } catch { }
    kept.push({ file, at, size });
    total += size;
  }
  if (!(bytes > 0) || total <= bytes) return;
  kept.sort((a, b) => a.at - b.at);
  for (const e of kept) {
    if (total <= bytes) break;
    try { fs.unlinkSync(e.file); total -= e.size; } catch { }
  }
}

function append(ctx, line) {
  const { dir, days, bytes } = settings(ctx);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${new Date().toISOString().slice(0, 10)}.jsonl`);
  const fd = fs.openSync(file, "a", 0o600);
  try {
    fs.writeSync(fd, line + "\n");
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  const now = Date.now();
  if (now - lastPrune > PRUNE_EVERY_MS) {
    lastPrune = now;
    try { prune(dir, days, bytes); } catch { }
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
