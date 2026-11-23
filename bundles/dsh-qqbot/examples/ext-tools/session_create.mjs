/**
 * session_create.mjs — 创建**子会话**（跨工作区/跨会话），走宿主 sessionController
 *
 * ⚠️ 本文件的来历：前面几个版本（v1~v5）都在绕路 —— 试图用 `ctx.sessions.create()` +
 *   `ctx.agents.create()` 手工拼一个会话，结果一路撞墙（session 已存在 / agent id 不等于 session id /
 *   选项读不到）。**权威范例是记忆插件 dsh-auto-memory**：它用宿主服务 `sessionController` 建会话，
 *   源码原文（@a9i5k4/dsh-auto-memory/lib/index.js）：
 *     created = await sc.create({
 *       ...(workspaceId ? { workspaceId } : { cwd }),
 *       ...(agentPreset ? { agentPreset } : {}),
 *     })
 *     const newId = String(created && (created.sessionId || created.id) || '')
 *   两个坑（同文件注释）：
 *     ① create() **只在传 workspaceId 时**才 attachSession；只传 cwd 仅设工作目录 → 会话落"未分组"；
 *     ② 权限不在 create 里，走 `permissionPresets`（current 读 / set 写），完全权限预设名 = danger-full-access。
 *
 * ⚠️ 主人定（2026-10-12）：**派活是"父"的职责** ⇒ 本工具只在 QQ 会话注册（`expose: 'qq'`），
 *   子会话看不到，免得无限套娃。回执通道是 `session_send`（那个对子会话开放）。
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 带版本号地加载共用库 —— **必须这么加载**。
 *
 * 背景：插件的 extension-store 只给**工具文件本身**的 import 加了 `?v=<mtime>`
 * 来绕过 ESM 模块缓存；工具**内部**再 import 别的文件时，裸路径会被模块缓存永久命中。
 * 后果：改了 `tools/lib/` 下的文件，热刷（tools_reload）**不会生效**，只有重启宿主才行 ——
 * 这曾导致"以为改好了、实际跑的还是旧代码"（2026-10-12 实测踩到）。
 */
async function loadWatchLib() {
  const url = new URL('./lib/session_watch_lib.mjs', import.meta.url);
  let v = '0';
  try { v = String(statSync(fileURLToPath(url)).mtimeMs); } catch { /* 拿不到 mtime 就退回裸 import */ }
  return import(v === '0' ? url.href : `${url.href}?v=${v}`);
}

export default {
  name: 'session_create',
  // ★ 2026-10-12 主人定：父会话专用 ⇒ 只在 QQ 会话注册（子会话不可见）。
  expose: 'qq',
  description:
    '创建对话（跨工作区/跨会话）：可指定工作区（目录或标题片段，默认同工作区）、可给初始任务、默认完全权限；建好后自动给它挂"回合结束把末段正文回灌创建者"的钩子。',
  inputSchema: {
    task: { type: 'string', description: '初始任务文本（会自动送进新会话；不填=只建不派活）' },
    workspace: { type: 'string', description: '目标工作区：目录路径片段或标题片段（可选；默认同工作区）' },
    cwd: { type: 'string', description: '工作目录（可选；等价于指定工作区）' },
    name: { type: 'string', description: '标签/备注（可选，建好后写进会话标题）' },
    preset: { type: 'string', description: '权限预设（默认 danger-full-access 完全权限）' },
agent_preset: { type: 'string', description: '人设（agent 预设）：收**任何字符** —— 先按预设名（显示名）反查 id，再按 id 匹配（忽略大小写；唯一子串也认）。如「测试2」/standteste/「温柔鲸鱼娘」/softwhale。不填=继承我自己' },
    wake: { type: 'boolean', description: 'true=建完立刻跑一轮（默认 false=只追加不唤醒，省 token）' },
    watch: { type: 'boolean', description: 'true=挂"回合结束回灌"钩子（默认 true）' },
    mode: { type: 'string', description: '回灌档位（挂钩子时才用）：1/一档（默认）=末段正文回灌父会话 + 同时转发到父所在的QQ；2/二档=该回合所有正文+报错只转发QQ、不进父会话上下文；3/三档=所有正文+报错进父会话上下文但不唤醒、同时也转发QQ' },
  },

  async run(args = {}, env = {}) {
    const ctx = env?.ctx ?? null;
    const root = ctx && typeof ctx === 'object' && ctx.root ? ctx.root : ctx;
    if (!root?.get) return { ok: false, msg: '拿不到宿主 ctx（需要 expose:\'all\'）' };

    const me = String(env?.exec?.agent?.id ?? env?.exec?.sessionId ?? '').trim();
    const svc = (k) => { try { return root.get(k); } catch { return undefined; } };
    const sc = svc('sessionController');
    if (!sc || typeof sc.create !== 'function') {
      return { ok: false, msg: '宿主没有可用的 sessionController.create()（跨会话创建就靠它；请确认 dsh web 宿主版本）' };
    }
    const out = [`我=${me.slice(0, 8)}…  服务: sessionController ✓`];

    // ── 解析目标工作区 → workspaceId（关键：只给 cwd 会落"未分组工作区"）──
    const wantWs = String(args?.workspace ?? args?.cwd ?? '').trim();
    let workspaceId = '';
    let wsPath = '';
    let myCwd = '';
    try {
      const reg = svc('workspaceRegistry');
      const list = (reg?.list?.() ?? []).filter(Boolean);
      if (me) {
        const mine = list.find((w) => (w.sessionIds ?? []).includes(me));
        myCwd = String(mine?.path ?? '');
      }
      const key = wantWs || myCwd;
      if (key) {
        const k = key.toLowerCase();
        const hit = list.find((w) => String(w?.path ?? '').toLowerCase().includes(k)) ??
                    list.find((w) => String(w?.title ?? '').toLowerCase().includes(k));
        if (hit) { workspaceId = String(hit.id ?? ''); wsPath = String(hit.path ?? ''); }
        else if (wantWs) out.push(`⚠ 没匹配到工作区「${wantWs}」，改用 cwd 直传（会落"未分组"，可能不是你要的）`);
      }
      out.push(`工作区: ${workspaceId ? wsPath + '  (id=' + workspaceId.slice(0, 8) + '…)' : '(未指定，继承宿主默认)'}`);
    } catch (e) { out.push('工作区解析失败(继续): ' + String(e?.message ?? e)); }

    // ── ① 建会话 ──
    // ⚠️ 2026-10-12 实测纠错：`agentPreset` 是 **agent 预设**（standard / whale-girl / softwhale…），
    //   **不是权限预设** —— 传 'danger-full-access' 会报 `Unknown agent preset: danger-full-access`。
    //   权限是另一条链：permissionPresets.set(session, <权限预设名>)，完全权限 = 'danger-full-access'。
    let myPreset = 'standard';
    try {
      const list = (await svc('sessionQuery')?.listSessions?.()) ?? [];
      const mine = list.find((s) => String(s?.header?.id ?? s?.id) === me);
      if (mine?.header?.agentPreset) myPreset = String(mine.header.agentPreset);
    } catch { /* ignore */ }
    // ★ 2026-10-12 主人定：人设参数收**任何字符** —— 先按「预设名」反查 id，再按「id」匹配。
    //   匹配顺序与容忍度全在 lib/preset_resolve.mjs（按 mtime 版本化加载 ⇒ 改库不必给工具改名）。
    const wantPreset = String(args?.agent_preset ?? '').trim();
    let agentPreset = wantPreset || myPreset;
    if (wantPreset) {
      try {
        const pu = new URL('./lib/preset_resolve.mjs', import.meta.url);
        let pv = '0';
        try { pv = String(statSync(fileURLToPath(pu)).mtimeMs); } catch { /* ignore */ }
        const presetLib = await import(pv === '0' ? pu.href : pu.href + '?v=' + pv);
        const r = await presetLib.resolvePreset(root, wantPreset);
        if (r && r.error) return { ok: false, msg: out.join('\n') + '\n❌ 人设解析失败: ' + r.error };
        if (r && r.id) {
          agentPreset = r.id;
          if (r.via !== 'id') out.push('人设: 「' + wantPreset + '」→ id=' + agentPreset + '（按 ' + r.via + ' 匹配）');
        }
      } catch (e) { out.push('人设解析跳过(沿用原值): ' + String(e?.message ?? e).slice(0, 110)); }
    }
    const permPreset = String(args?.preset ?? 'danger-full-access').trim() || 'danger-full-access';
    out.push('agent 预设 = ' + agentPreset + (wantPreset ? '' : '（继承我自己）') + '  权限预设 = ' + permPreset);
    let sid = '';
    let created = null;
    try {
      const opts = {};
      if (workspaceId) opts.workspaceId = workspaceId;
      else if (wantWs || myCwd) opts.cwd = wantWs || myCwd;
      opts.agentPreset = agentPreset;
      created = await sc.create(opts);
      sid = String(created?.sessionId ?? created?.id ?? '');
      out.push(`① sessionController.create → ${sid ? 'ok ' + sid : '返回里没 sessionId/id（键: ' + Object.keys(created ?? {}).join(',') + '）'}`);
    } catch (e) {
      out.push('① sessionController.create 抛错: ' + String(e?.message ?? e));
      return { ok: false, msg: out.join('\n') };
    }
    if (!sid) return { ok: false, msg: out.join('\n') + '\n（没拿到会话 id，中止）' };

    // ── ② 权限：完全权限（走 permissionPresets，不在 create 里）──
    try {
      const pp = svc('permissionPresets');
      if (pp && typeof pp.set === 'function') {
        let sess = null;
        try { sess = svc('sessions')?.get?.(sid) ?? null; } catch { /* ignore */ }
        if (!sess) {
          try { const r = await sc.resolveAgent(sid); sess = r?.agent?.session ?? null; } catch { /* ignore */ }
        }
        if (sess) { await pp.set(sess, permPreset); out.push('② 权限预设 → ' + permPreset); }
        else out.push(`② 权限预设跳过（没有 live session 对象；会话默认权限等它首次唤醒后由 preset=${preset} 生效）`);
      } else {
        out.push('② permissionPresets 服务不可用（跳过；create 时已带 agentPreset）');
      }
    } catch (e) { out.push('② 权限设置失败(继续): ' + String(e?.message ?? e)); }

    // ── ③ 初始任务 ──
    const task = String(args?.task ?? '').trim();
    if (task && typeof sc.prompt === 'function') {
      // ✅ 权威形状（dsh-api-session-controller/lib/types/types.d.ts:319 SessionPromptRequest）：
      //   { requestId, sessionId, mode: 'queue'|'steer', content: PromptContentPart[], clientTimeZone? }
      //   之前传 {sessionId, text} 全错 —— content 位置放字符串导致内部解析炸 `signal.throwIfAborted`。
      //   mode='queue' 排队（不打断）；mode='steer' 插话（等于 qqbot 的 interject）。
      const rid = (globalThis.crypto?.randomUUID?.() ?? ('req-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8)));
      const body = [{ type: 'text', text: task }];
      const sig = new AbortController().signal;
      // ★ 关键：signal 是**独立的第二参数**（同文件 page(request, signal) / list(signal) / control(signal) 同款），
      //   塞进 request 里它读不到 → 报 `undefined.throwIfAborted`。
      const req = { requestId: rid, sessionId: sid, mode: 'queue', content: body };
      const shapes = [
        ['(request, signal)  mode=queue', () => sc.prompt(req, sig)],
        ['(request)         mode=queue', () => sc.prompt(req)],
        ['(request, signal)  mode=steer', () => sc.prompt({ ...req, mode: 'steer' }, sig)],
      ];
      let via = '';
      const errs = [];
      for (const [lb, fn] of shapes) {
        try { await fn(); via = lb; break; } catch (e) { errs.push(lb + '→' + String(e?.message ?? e).slice(0, 60)); }
      }
      out.push('③ 初始任务 → ' + (via ? 'ok（形式: ' + via + '）' : '全部形式被拒: ' + errs.join(' | ')));
    } else if (task) {
      out.push('③ 初始任务跳过（sessionController 没有 prompt()）');
    }

    // ── ④ 标题（可选）──
    const label = String(args?.name ?? '').trim();
    if (label && typeof sc.rename === 'function') {
      try { await sc.rename({ sessionId: sid, title: label }); out.push('④ 标题 → ' + label); }
      catch (e) { out.push('④ 标题设置失败: ' + String(e?.message ?? e).slice(0, 80)); }
    }

    // ── ⑤ 回合结束回灌钩子 ──
    let watchMsg = '未挂（watch=false）';
    if (args?.watch !== false) {
      try {
        const w = await loadWatchLib();
        // ★ 档位（主人 2026-10-12 定）：1=末段回灌+转QQ / 2=只转QQ不进父 / 3=进父不唤醒+转QQ
        const mv = String(args?.mode ?? '').trim();
        const mode = /^(2|二)/.test(mv) ? 2 : (/^(3|三)/.test(mv) ? 3 : 1);
        watchMsg = await w.register(root, {
          parentAgentId: me,
          childSessionId: sid,
          label,
          mode,
          // ★ 归属行三件套（主人 2026-10-12 定：除了短 id，还要写会话名/预设名/工作区）
          //   顺序有意义：路由键（【子会话 xxxx）在最前，后面这些即使被引用块的 60 字截掉也不影响回流。
          name: label,
          preset: agentPreset,
          workspace: String(wsPath || myCwd || '').split(/[\\/]/).filter(Boolean).pop() ?? '',
          // ★ QQ 转发用"我自己这个会话"的 sender + replyTarget：
          //   replyTarget 自带最近 msgId ⇒ 被动优先；插件的 sendMarkdown 自带 markdown→纯文本降级链。
          sender: env?.sender,
          replyTarget: env?.replyTarget,
          peerName: String(env?.replyTarget?.name ?? ''),
        }) + '  [lib=' + (w.__LIB_VERSION__ ?? '未知(旧版无版本号)') + ']';
      } catch (e) { watchMsg = '未挂（' + String(e?.message ?? e) + '）'; }
    }
    out.push('⑤ 回合结束回灌 → ' + watchMsg);

    return { ok: true, msg: out.join('\n') + `\n\n新会话 id = ${sid}\n（用 session_watch 看钩子名单；用 session_children 看血缘）` };
  },
};
