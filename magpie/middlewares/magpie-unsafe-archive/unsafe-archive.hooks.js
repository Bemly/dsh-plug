// magpie-unsafe-archive：网关请求钩子（跑在 Bun 插件宿主）。
//
// 位置语义：onRequest 拿到的是遮盖（redact）之前的原文——gatewayHooks 跑在
// serve 之前，而 Masker 在 serve 里面；onResponse 拿到的是还原后 agent 收到
// 的那份。正文原样交回网关，遮盖对厂商照常生效。
//
// 归档只追加，**永不删除、永不轮转**：这是审计留痕，删一条就少一条。
// 归档里是含密钥的明文，这是本插件存在的目的，也是它的风险。
//
// 存的是**解析后重新序列化的对象**，不是客户端实际收到的原始字节；流式回复
// 存的是聚合完成的那份。内容完整，但不是逐字节证据。
//
// 拿不到的：HTTP 状态码与错误文本——失败时 reply 是 null，ctx 里没有
// status/error/headers（实测 magpie 0.1.4676/4677）。要按状态分类，只能查看
// 时与 magpie 自己的 usage.jsonl 台账对齐（台账无保留期）。
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

const num = (v) => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

// 三种协议的用量字段名各不相同：OpenAI Chat 用 prompt/completion_tokens，
// Anthropic 与 Responses 用 input/output_tokens，缓存与推理又各埋在 details
// 里。归一成一套，查看侧只认这一套。
function usageOf(reply) {
  const u = reply && reply.usage;
  if (!u) return undefined;
  const pd = u.prompt_tokens_details || u.input_tokens_details || {};
  const cd = u.completion_tokens_details || u.output_tokens_details || {};
  const out = {
    in: num(u.prompt_tokens) ?? num(u.input_tokens),
    out: num(u.completion_tokens) ?? num(u.output_tokens),
    cacheRead: num(pd.cached_tokens) ?? num(u.cache_read_input_tokens),
    cacheWrite:
      num(pd.cache_write_tokens) ??
      num(u.cache_creation_input_tokens) ??
      num(pd.cache_creation?.["ephemeral_5m_input_tokens"]),
    reasoning: num(cd.reasoning_tokens),
    total: num(u.total_tokens),
  };
  for (const k of Object.keys(out)) if (out[k] === undefined) delete out[k];
  return Object.keys(out).length ? out : undefined;
}

export async function onRequest(body, ctx) {
  const pending = {
    at: new Date().toISOString(),
    session: ctx.session ?? "",
    agent: ctx.agent ?? "",
    caller: ctx.caller ?? null,
    model: ctx.model ?? "",
    protocol: ctx.protocol ?? "",
    origin: ctx.origin ?? "",
    path: ctx.path ?? "",
    kind: ctx.kind ?? "",
    cwd: ctx.cwd ?? "",
    query: ctx.query ?? "",
    stream: ctx.stream === true,
    body,
  };
  // ctx.state 是 magpie 给一次请求的暂存位，带命名空间免得和别的插件撞
  if (ctx.state && typeof ctx.state === "object") ctx.state.unsafeArchive = pending;
  else ctx.pending = pending;
  return undefined;
}

export async function onResponse(reply, ctx) {
  const p = (ctx.state && ctx.state.unsafeArchive) || ctx.pending;
  if (!p) return undefined;
  const end = new Date().toISOString();
  const rec = {
    v: 2,
    at: p.at,
    end,
    durMs: Math.max(0, Date.parse(end) - Date.parse(p.at)),
    session: p.session,
    agent: p.agent,
    caller: p.caller,
    model: p.model,
    protocol: p.protocol,
    origin: p.origin,
    path: p.path,
    kind: p.kind,
    cwd: p.cwd,
    query: p.query,
    stream: p.stream,
    success: ctx.success === true,
    request: p.body,
    reply,
  };
  const usage = usageOf(reply);
  if (usage) rec.usage = usage;
  append(ctx, JSON.stringify(rec));
  return undefined;
}
