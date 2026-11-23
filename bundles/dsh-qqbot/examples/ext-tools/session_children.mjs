/**
 * session_children.mjs — 列出「自己创建的会话」（跨工作区/跨会话，按血缘）
 *
 * 「把子会话那套搬到跨会话级」的第 4 块：创建者要能随时看到自己开了哪些会话、跑得怎么样。
 * 血缘不用自己记台账 —— 宿主 header 里本来就有 `parentSession` / `origin` / `delegationDepth`。
 *
 * ⚠️ 主人要求：本工具**只给 QQ 会话用**（父会话专用，不给子会话看）。
 *   已落地为 `expose: 'qq'`（2026-10-12）——非 'all' 的值只在 QQ 侧注册。
 */
export default {
  name: 'session_children',
  // ★ 2026-10-12：**父会话专用** ⇒ 不给子会话看（`expose:'all'` 会被挂到插件根、暴露给所有会话；
  //   非 'all' 的值只在 QQ 会话注册 ⇒ 子会话（web）看不到）。本工具只对"有子代的人"有意义。
  // 只注册到 QQ 会话（子会话不可见）—— 本工具是"父会话专用"。
  expose: 'qq',
  description:
    '列出「自己创建的会话」（按 parentSession 血缘，默认只列直接子代，deep=true 递归到全部后代）：按最新活跃在前，可 limit。纯只读。',
  inputSchema: {
    limit: { type: 'integer', description: '最多列几个（默认 20，上限 100）' },
    deep: { type: 'boolean', description: 'true=递归列全部后代（默认 false=只看直接子代）' },
    all: { type: 'boolean', description: 'true=列所有会话里的"非我创建"的部分（排查用，默认 false）' },
  },

  async run(args = {}, env = {}) {
    const ctx = env?.ctx ?? null;
    const root = ctx && typeof ctx === 'object' && ctx.root ? ctx.root : ctx;
    if (!root?.get) return { ok: false, msg: '拿不到宿主 ctx（需要 expose:\'all\'）' };

    const me = String(env?.exec?.agent?.id ?? env?.exec?.sessionId ?? '').trim();
    if (!me) return { ok: false, msg: '拿不到"我是谁"（env.exec.agent.id 缺失）→ 无法按血缘筛选' };

    const limit = Math.max(1, Math.min(100, Number(args?.limit) > 0 ? Math.floor(Number(args.limit)) : 20));
    const deep = !!args?.deep;

    const sq = (() => { try { return root.get('sessionQuery'); } catch { return undefined; } })();
    if (!sq || typeof sq.listSessions !== 'function') return { ok: false, msg: '宿主没挂 sessionQuery 服务' };

    let list = [];
    try { list = (await sq.listSessions()) ?? []; } catch (e) { return { ok: false, msg: 'listSessions 抛错: ' + String(e?.message ?? e) }; }
    if (!Array.isArray(list)) list = [];

    const hdr = (s) => s?.header ?? s ?? {};
    const idOf = (s) => String(hdr(s).id ?? '');
    const parentOf = (s) => String(hdr(s).parentSession ?? '');
    const timeOf = (s) => {
      const t = hdr(s).createdAt ?? s?.lastActivity;
      const d = new Date(typeof t === 'number' ? t : String(t ?? ''));
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    };

    // 直接子代
    const direct = list.filter((s) => parentOf(s) === me);
    // 递归后代（BFS，防环）
    let picked = direct;
    if (deep) {
      const seen = new Set(direct.map(idOf));
      const out = [...direct];
      let frontier = direct;
      for (let depth = 0; depth < 6 && frontier.length; depth += 1) {
        const next = [];
        for (const p of frontier) {
          const pid = idOf(p);
          for (const s of list) {
            const sid = idOf(s);
            if (sid && parentOf(s) === pid && !seen.has(sid)) { seen.add(sid); out.push(s); next.push(s); }
          }
        }
        frontier = next;
      }
      picked = out;
    }
    picked.sort((a, b) => timeOf(b) - timeOf(a));

    const p = (n) => String(n).padStart(2, '0');
    const fmt = (s) => {
      const t = new Date(timeOf(s));
      const when = Number.isNaN(t.getTime()) ? '' : `${p(t.getUTCMonth() + 1)}-${p(t.getUTCDate())} ${p(t.getUTCHours())}:${p(t.getUTCMinutes())}`;
      const h = hdr(s);
      const wid = idOf(s);
      const short = wid.length > 14 ? wid.slice(0, 8) + '…' + wid.slice(-4) : wid;
      const live = (h.live ?? s?.live) ? 'live' : 'persisted';
      const cwd = String(h.cwd ?? '').replace(/^.*[\\/]/, '') || '?';
      return `   · ${when}  [${live}]  ${short}  ${cwd}  origin=${h.origin ?? '?'}  depth=${h.delegationDepth ?? '?'}`;
    };

    const head = `【我创建的会话】我=${me.slice(0, 8)}…  直接子代 ${direct.length} 个` +
      (deep ? ` / 全部后代 ${picked.length} 个` : '');
    const body = picked.length
      ? picked.slice(0, limit).map(fmt).join('\n') +
        (picked.length > limit ? `\n   … 还有 ${picked.length - limit} 个（用 limit 调整）` : '')
      : '   （还没有子会话 —— 用"创建对话"那个工具开一个就会出现在这里）';

    const otherLine = args?.all
      ? `\n（对照）非我创建的会话 ${list.length - picked.length} 个，其中 live ${list.filter((s) => hdr(s).live ?? s?.live).length} 个`
      : '';

    return { ok: true, msg: [head, body].join('\n') + otherLine };
  },
};
