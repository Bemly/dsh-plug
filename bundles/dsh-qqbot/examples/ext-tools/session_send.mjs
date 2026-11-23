/**
 * session_send.mjs — 跨会话/跨工作区投递·**发送工具**（照抄 qqbot 插件的**入站模式**）
 *
 * ── 定案（主人 2026-10-12）────────────────────────────────────────────
 *   · 一律**模拟用户消息**（`source.kind='user'`）。
 *   · **不用 `session.append`** —— 它的消息没被任何回合 claim，前端会当成
 *     "待发送输入"挂到**输入框**上方。改用 `agent.inject`。
 *   · **忙时插话、空闲唤醒**（原话见 qqbot `dist/features/qq-user-questions.js:646`）：
 *       忙(回合进行中) → `agent.inject` = 宿主 `send(msg,'next-step',wakeup:false)`
 *                        —— 进当前回合的下一个轮次边界，她本轮就读到；**不排下一回合队列**。
 *       空闲           → `agent.followup` 唤醒它接着处理。
 *
 * ── 两种调用意图 ──────────────────────────────────────────────────────
 *   mode='append'（默认，不唤醒）→ 一律 `inject`（插话通道，静默进上下文）
 *   mode='wake'  （要它立刻处理）→ 忙 `inject` / 空闲 `followup`
 *
 * ── 保留的两个工程细节 ────────────────────────────────────────────────
 *   ① 先拿 live agent（`agents.get` → 没有就 `agents.resume({resumeSessionId})`）
 *   ② 投递后自检：看该 agent 的 inbox 队列长度有没有变化，如实回报
 */
export const __TOOL_VERSION__ = 'send-v8-20261012-忙插话/闲唤醒';

export const isInjectableMessage = (m) => {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return false;
  if (typeof m.role !== 'string' || !m.role) return false;
  if (!Array.isArray(m.content) || m.content.length === 0) return false;
  const s = m.source;
  if (!s || typeof s !== 'object' || Array.isArray(s)) return false;
  return typeof s.kind === 'string' && !!s.kind && s.kind !== 'plugin';
};
const short = (id) => { const s = String(id ?? ''); return s.startsWith('session-') ? s.slice(8, 16) : s.slice(0, 8); };
const rid = (p) => (globalThis.crypto?.randomUUID?.() ?? (p + '-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
/** 队列长度（inject 的自检依据） */
function queueLen(agent) {
  try {
    const q = agent?.inbox;
    const a = Array.isArray(q?.nextStep) ? q.nextStep.length : 0;
    const b = Array.isArray(q?.nextTurn) ? q.nextTurn.length : 0;
    return a + b;
  } catch { return -1; }
}
function isBusy(agent) {
  try {
    const st = String(agent?.status ?? agent?.phase ?? '');
    return st !== '' && st !== 'idle';
  } catch { return false; }
}

export default {
  name: 'session_send',
  expose: 'all',
  description:
    '跨会话/跨工作区投递（**模拟用户消息**，走插件同款入站模式：忙插话 / 闲唤醒）。目标用 session_id，不填=创建自己的那个会话。' +
    'mode=append（默认）用 inject 静默进对方上下文、不唤醒；mode=wake 忙时 inject 插话、空闲 followup 唤醒。' +
    '目标非 live 会先 resume；投递后自检队列并如实回报。',
  inputSchema: {
    text: { type: 'string', description: '要投递的正文（必填）' },
    session_id: { type: 'string', description: '目标会话 id（完整）；不填=创建自己的那个会话' },
    mode: { type: 'string', description: 'append=inject 静默进上下文不唤醒（默认） / wake=忙插话·闲唤醒' },
    notify: { type: 'boolean', description: 'true=正文前加一行「【来自会话 <我的完整 session id>】」（默认 true；对方据此可直接回投）' },
  },

  async run(args = {}, env = {}) {
    const text = String(args?.text ?? '').trim();
    if (!text) return { ok: false, msg: '缺少 text' };

    const ctx = env?.ctx ?? null;
    const root = ctx && typeof ctx === 'object' && ctx.root ? ctx.root : ctx;
    if (!root?.get) return { ok: false, msg: "拿不到宿主 ctx（需要 expose:'all'）" };
    const svc = (n) => { try { return root.get(n); } catch { return undefined; } };
    const agents = svc('agents'); const sessions = svc('sessions'); const sc = svc('sessionController');
    if (!agents || typeof agents.get !== 'function') return { ok: false, msg: '宿主没挂 agents 服务' };

    const me = String(env?.exec?.agent?.id ?? env?.exec?.sessionId ?? '').trim();
    const mode = String(args?.mode ?? 'append').trim() === 'wake' ? 'wake' : 'append';
    const out = [];

    let targetId = String(args?.session_id ?? '').trim();
    let srcNote = '显式指定';
    if (!targetId) {
      if (!me) return { ok: false, msg: '既没给 session_id，也拿不到"我是谁"' };
      srcNote = '创建者(parentSession)';
      try { targetId = String(sessions?.get?.(me)?.header?.parentSession ?? '').trim(); } catch { /* ignore */ }
      if (!targetId) return { ok: false, msg: '本会话没有创建者 → 请显式给 session_id' };
    }

    // ★ 主人 2026-10-12 定：模拟用户消息的**首行直接给出源会话 id**（完整 id，不是短号）——
    //   对方据此就能回投给我，不用再靠血缘字段去猜。
    const body = (args?.notify === false || !me) ? text : '【来自会话 ' + me + '】\n' + text;
    const msg = { id: rid('snd'), role: 'user', content: [{ type: 'text', text: body }], source: { kind: 'user' } };
    if (!isInjectableMessage(msg)) return { ok: false, msg: '内部错误：消息形状自检不过（已中止）' };

    // ① live agent（没有就 resume）
    let agent = null, resumed = false;
    try { agent = agents.get(targetId) ?? null; } catch { /* ignore */ }
    if (!agent && typeof agents.resume === 'function') {
      try { const h = await agents.resume({ resumeSessionId: targetId }); agent = h?.agent ?? agents.get?.(targetId) ?? null; resumed = !!agent; }
      catch (e) { out.push('resume 失败: ' + String(e?.message ?? e).slice(0, 110)); }
    }
    if (!agent) return { ok: false, msg: `投递失败（${short(targetId)}…）：目标不是 live 且 resume 没成功\n` + out.join('\n') };

    // ② 忙闲 → 选通道（照抄插件"忙时插话、空闲唤醒"）
    const busy = isBusy(agent);
    const before = queueLen(agent);
    let via = ''; const errs = [];
    const doInject = async (why) => { await agent.inject(msg); via = `agent.inject（${why}）`; };
    const doFollow = async (why) => { await agent.followup(msg); via = `agent.followup（${why}）`; };

    try {
      if (mode === 'append') {
        await doInject('不唤醒·插话通道');
      } else if (busy) {
        await doInject('忙 → 插话，不排下一回合');
      } else {
        try { await doFollow('空闲 → 唤醒'); }
        catch (e) { errs.push('followup→' + String(e?.message ?? e).slice(0, 80)); await doInject('followup 失败 → 回落插话'); }
      }
    } catch (e) { errs.push('投递→' + String(e?.message ?? e).slice(0, 100)); }

    // ③ 兜底 sessionController.prompt
    if (!via && sc && typeof sc.prompt === 'function') {
      const req = { requestId: rid('req'), sessionId: targetId, mode: 'queue', content: [{ type: 'text', text: body }] };
      const sig = new AbortController().signal;
      for (const [lb, fn] of [['sc.prompt(req,sig)', () => sc.prompt(req, sig)], ['sc.prompt(req)', () => sc.prompt(req)]]) {
        try { await fn(); via = lb + '（兜底，会开队列回合）'; break; } catch (e) { errs.push(lb + '→' + String(e?.message ?? e).slice(0, 80)); }
      }
    }

    if (!via) return { ok: false, msg: `投递失败（${short(targetId)}…）\n` + (out.join('\n') + '\n') + '尝试明细: ' + errs.join(' | ') };

    const after = queueLen(agent);
    const landed = before >= 0 && after >= 0 ? after > before : null;
    out.push(`队列自检: ${before} → ${after}` + (landed === true ? ' ✅ 已入队' : landed === false ? ' ⚠️ 队列数未变（可能被立即消费，也可能没进去）' : ' ? 无法判定'));
    out.push(`目标忙闲: ${busy ? '忙（回合进行中）' : '空闲'}`);
    return {
      ok: true,
      msg: `✅ 已投递到 ${short(targetId)}…（${srcNote}；用户消息；方式 ${via}；${resumed ? '已 resume；' : ''}` +
        `${mode === 'wake' ? '意图=唤醒' : '意图=静默'}）` + (out.length ? '\n' + out.join('\n') : ''),
    };
  },
};
