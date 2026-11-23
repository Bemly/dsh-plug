/**
 * report-relay.mjs — 正文/思考里的 [汇报]…[/汇报] 独立转发到 QQ（2026-10-21 v3）
 *
 * v3 修两处（都对上了实测）：
 *   ① 正文通道不再限定 ctx.kind === 'text' —— 我们的正文可能被判成 markdown/other，写死 text 就永远不触发；
 *   ② reasoning API 是**后挂**的（installOutboundApi / bus 注册发生在插件 setup 里），
 *      扩展模块加载时可能还拿不到 → 改成"拿不到就重试"，最多 20 次 × 500ms。
 *
 * 语义：标记从正文里抠掉、独立成条；思考块里凑齐即发；都带上本回合的 target（防串群）。
 */

export const name = 'report-relay';

const OPEN = '[汇报]';
const CLOSE = '[/汇报]';
const MAX_CHARS = 800;
const DUP_KEEP = 8;
const DUP_TTL_MS = 120000;

const sent = [];

function keyOf(text) {
  const t = String(text).replace(/\s+/g, ' ').trim();
  return t.length + ':' + t.slice(0, 40) + ':' + t.slice(-40);
}

function isDup(text) {
  const k = keyOf(text);
  const now = Date.now();
  while (sent.length && now - sent[0].at > DUP_TTL_MS) sent.shift();
  if (sent.some((x) => x.key === k)) return true;
  sent.push({ key: k, at: now });
  if (sent.length > DUP_KEEP) sent.shift();
  return false;
}

function extractAll(text) {
  const bodies = [];
  let s = String(text == null ? '' : text);
  for (;;) {
    const a = s.indexOf(OPEN);
    if (a < 0) break;
    const b = s.indexOf(CLOSE, a + OPEN.length);
    if (b < 0) break;
    const body = s.slice(a + OPEN.length, b).trim();
    if (body) bodies.push(body);
    s = s.slice(0, a) + s.slice(b + CLOSE.length);
  }
  return { bodies, rest: s };
}

function clip(text) {
  return text.length > MAX_CHARS ? text.slice(0, MAX_CHARS - 1) + '…' : text;
}

// ── 正文通道：任何带标记的正文块都在发出去前抠掉并独立补发 ──
export default async function onOutbound(ctx, next) {
  try {
    const text = String((ctx && ctx.text) || '');
    if (text.indexOf(OPEN) >= 0 && text.indexOf(CLOSE) >= 0) {
      const r = extractAll(text);
      if (r.bodies.length > 0) {
        const out = clip(r.bodies.join('\n———\n'));
        const clean = r.rest.replace(/\n{3,}/g, '\n\n').trim();
        try {
          if (clean) ctx.rewrite(clean);
          else ctx.annihilate('only-report');
        } catch (e) { /* 改不动就照原样发 */ }
        if (!isDup(out)) {
          try { ctx.background(function () { return ctx.send(out); }); } catch (e) { /* ignore */ }
        }
      }
    }
  } catch (e) { /* 扩展失败绝不能挡正文 */ }
  return next();
}

// ── 思考通道：API 可能后挂 → 重试绑定 ──
const tails = new Map();
let bound = false;
let tries = 0;

function onReasoningDelta(agentId, delta, target) {
  if (!agentId || !delta) return;
  const buf = (tails.get(agentId) || '') + delta;
  const r = extractAll(buf);
  tails.set(agentId, r.rest.length > 64 ? r.rest.slice(-64) : r.rest);
  if (r.bodies.length === 0) return;
  const out = clip(r.bodies.join('\n———\n'));
  if (isDup(out)) return;
  const ob = globalThis[Symbol.for('im-qqbot.outbound')];
  if (ob && typeof ob.send === 'function') {
    Promise.resolve().then(function () { return ob.send(out, { target: target }); }).catch(function () {});
  }
}

function tryBind() {
  const rb = globalThis[Symbol.for('im-qqbot.reasoning')];
  if (rb && typeof rb.onDelta === 'function') {
    rb.onDelta(onReasoningDelta);
    if (typeof rb.onTurnEnd === 'function') rb.onTurnEnd(function (a) { tails.delete(a); });
    bound = true;
    console.log('[report-relay] reasoning 通道已绑定（第 ' + (tries + 1) + ' 次尝试）');
    return;
  }
  if (tries++ < 20) setTimeout(tryBind, 500);
  else console.log('[report-relay] reasoning 通道放弃绑定（内核未提供 API）');
}
tryBind();
