/**
 * sessions_list.mjs — 列出 DSH 的工作区与各会话（跨工作区 / 跨会话，纯只读）
 *
 * 定位：这是「把子代理那套搬到跨会话级」的第 1 块积木 —— 先能看见，再谈操作。
 * expose: 'all' ⇒ 所有通道（QQ / Web / 终端…）的会话都能用；env.ctx 是宿主的 cordis ctx。
 *
 * 数据来源（都是宿主现成服务，不自己扫盘）：
 *   · ctx.workspaceRegistry  （@deepseek-ai/dsh-workspace）      —— 有序、持久的工作区项目列表
 *   · ctx.sessionQuery       （@deepseek-ai/dsh-session-query）  —— 列会话（最新在前）、过滤、trace
 * ⚠️ 取服务用 cordis 运行时 `ctx.get(name)`，不需要 inject（见 qqbot 的实测经验）；
 *   并且优先用 `ctx.root`（插件根作用域）—— 会话作用域的 ctx 会随会话切换而失效。
 *
 * 失败哲学：任何一个服务缺失都只降级、不报错中断 —— 把"哪些服务可用"如实报出来，
 *          方便在别的 DSH 版本上继续排查。
 */
const WORKSPACE_SERVICE = 'workspaceRegistry';
const SESSION_SERVICE = 'sessionQuery';
/** 探测用的候选服务名（有就报出来，便于后续工具挑正确的那个） */
const PROBE = [WORKSPACE_SERVICE, SESSION_SERVICE, 'sessions', 'sessionPersistence', 'tools', 'systemPrompt', 'agents', 'goals'];

/** 宽松取字段：宿主返回结构可能随版本变，这里按候选名依次试 */
function pick(obj, names) {
  if (!obj || typeof obj !== 'object') return undefined;
  for (const n of names) {
    const v = obj[n];
    if (v !== undefined && v !== null) return v;
  }
  const h = obj.header;
  if (h && typeof h === 'object') {
    for (const n of names) {
      const v = h[n];
      if (v !== undefined && v !== null) return v;
    }
  }
  return undefined;
}

/** 时间戳 → 本地 MM-dd HH:mm（吃 number / string / Date） */
function fmtTime(v) {
  if (v === undefined || v === null) return '';
  try {
    const d = v instanceof Date ? v : new Date(typeof v === 'number' ? v : String(v));
    if (Number.isNaN(d.getTime())) return '';
    // ⚠️ 用 UTC 字段显示：实测宿主把**本地时间**当 UTC 存
    //   （createdAt=1791762071432 → UTC 23:41 才与主人的实际时间对得上；按本地读会多 8 小时）。
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`;
  } catch { return ''; }
}

function safeGet(root, name) {
  try { return root.get(name); } catch { return undefined; }
}

export default {
  name: 'sessions_list',
  description:
    '列出 DSH 的工作区及其会话（跨工作区 / 跨会话）：默认按最新活跃在前，可用 limit 控制条数，可只看某个工作区。纯只读。',
  expose: 'all',
  inputSchema: {
    workspace: { type: 'string', description: '只看标题/路径里含这段文字的工作区（可选；不填=全部）' },
    limit: { type: 'integer', description: '每个工作区最多列几个会话（默认 10，上限 50）' },
    debug: { type: 'boolean', description: 'true=附上服务探测结果与一条原始会话记录（排查用，默认 false）' },
    full: { type: 'boolean', description: 'true=显示完整 session id 与血缘（parentSession/origin/depth），编排用（默认 false=精简）' },
  },

  async run(args = {}, env = {}) {
    const ctx = env?.ctx ?? null;
    const root = ctx && typeof ctx === 'object' && ctx.root ? ctx.root : ctx;
    if (!root || typeof root.get !== 'function') {
      return { ok: false, msg: '拿不到宿主 ctx（env.ctx 缺失或没有 .get）—— 本工具需要 expose:\'all\' 才能在跨通道环境里拿到宿主句柄' };
    }

    const limit = Math.max(1, Math.min(50, Number(args?.limit) > 0 ? Math.floor(Number(args.limit)) : 10));
    const filter = String(args?.workspace ?? '').trim().toLowerCase();
    const lines = [];
    const notes = [];

    // ── 服务探测（如实报出可用性，缺了也能看出原因）──
    const probe = {};
    for (const n of PROBE) {
      const s = safeGet(root, n);
      probe[n] = s === undefined || s === null ? null : typeof s;
    }
    const reg = safeGet(root, WORKSPACE_SERVICE);
    const sq = safeGet(root, SESSION_SERVICE);

    // ── ① 工作区列表 ──
    let projects = [];
    if (reg && typeof reg.list === 'function') {
      try { projects = reg.list() || []; } catch (e) { notes.push('workspaceRegistry.list() 抛错: ' + (e?.message ?? e)); }
    } else if (!reg) {
      notes.push(`宿主没挂 ${WORKSPACE_SERVICE} 服务（工作区分组不可用）`);
    }
    if (!Array.isArray(projects)) projects = [];

    // ── ② 会话列表（sessionQuery 优先）──
    let sessions = [];
    if (sq && typeof sq.listSessions === 'function') {
      try { sessions = (await sq.listSessions()) || []; } catch (e) { notes.push('sessionQuery.listSessions() 抛错: ' + (e?.message ?? e)); }
    } else if (!sq) {
      notes.push(`宿主没挂 ${SESSION_SERVICE} 服务（会话查询不可用）`);
    }
    if (!Array.isArray(sessions)) sessions = [];

    // 会话按"最新活跃"排序：优先 lastActivity / updatedAt / 创建时间，取不到的排最后
    const timeOf = (s) => {
      const t = pick(s, ['lastActivity', 'lastActivityAt', 'updatedAt', 'lastMessageAt', 'createdAt', 'createdAtMs', 'timestamp', 'startedAt']);
      const d = t instanceof Date ? t : new Date(typeof t === 'number' ? t : String(t ?? ''));
      return Number.isNaN(d.getTime()) ? 0 : d.getTime();
    };
    sessions.sort((a, b) => timeOf(b) - timeOf(a));

    // 归属：一个会话只归给它 cwd 最长的那个工作区（否则父目录 aiwork 会把子目录鲸鱼娘的会话全列走）
    const owners = new Map();
    for (const s of sessions) {
      const cwd = String(pick(s, ['cwd', 'workdir', 'directory', 'workingDirectory']) ?? '');
      if (!cwd) continue;
      let best = null;
      for (const p of projects) {
        const pd = String(pick(p, ['path', 'directory', 'dir', 'cwd']) ?? '');
        if (!pd) continue;
        if (cwd === pd) { const hit = pd.length + 10000; if (!best || hit > best.len) best = { len: hit, p }; continue; }
        if (cwd.startsWith(pd + '\\') || cwd.startsWith(pd + '/')) { const hit = pd.length; if (!best || hit > best.len) best = { len: hit, p }; }
      }
      if (best) owners.set(s, best.p);
    }

    const full = !!args?.full;
    const line = (s) => {
      const id = String(pick(s, ['id', 'sessionId', 'sid']) ?? '?');
      const title = String(pick(s, ['title', 'name', 'summary']) ?? '').slice(0, 40);
      const live = pick(s, ['live', 'isLive']) ? 'live' : 'persisted';
      const t = fmtTime(pick(s, ['lastActivity', 'lastActivityAt', 'updatedAt', 'createdAt', 'createdAtMs', 'startedAt']));
      const short = id.length > 14 && !full ? id.slice(0, 8) + '…' + id.slice(-4) : id;
      // 血缘（子代理实测建议：跨会话编排必须看到 parent/origin/depth，否则只能另开 debug 手工比对）
      const origin = pick(s, ['origin']) ?? '';
      const depth = pick(s, ['delegationDepth']);
      const parent = String(pick(s, ['parentSession']) ?? '');
      const lin = origin
        ? `  origin=${origin}${depth !== undefined ? ' depth=' + depth : ''}${parent ? ' parent=' + (full ? parent : parent.slice(0, 8) + '…') : ''}`
        : '';
      return `   · ${t || '        '}  [${live}]  ${short}${title ? '  ' + title : ''}${lin}`;
    };

    // 有 workspaceRegistry 就按"目录 → 它的会话"分组；否则退化成一张平表
    if (projects.length) {
      for (const p of projects) {
        const ptitle = String(pick(p, ['title', 'name']) ?? '(未命名)');
        const pdir = String(pick(p, ['path', 'directory', 'dir', 'cwd']) ?? '');
        if (filter && !(ptitle.toLowerCase().includes(filter) || pdir.toLowerCase().includes(filter))) continue;
        const mine = sessions.filter((s) => owners.get(s) === p);
        lines.push(`${ptitle}${pdir ? '  (' + pdir + ')' : ''}   —— ${mine.length} 个会话`);
        if (!mine.length) lines.push('   · (这个工作区下没有可列的会话)');
        for (const s of mine.slice(0, limit)) lines.push(line(s));
        if (mine.length > limit) lines.push(`   … 还有 ${mine.length - limit} 个（用 limit 调整）`);
      }
      // 不属于任何工作区的会话
      const ungrouped = sessions.filter((s) => !owners.get(s));
      if (ungrouped.length && !filter) {
        lines.push(`(不属于任何工作区的会话)   —— ${ungrouped.length} 个`);
        for (const s of ungrouped.slice(0, limit)) lines.push(line(s));
      }
    } else {
      lines.push(`（工作区分组不可用，退化成会话平表）共 ${sessions.length} 个`);
      for (const s of sessions.slice(0, limit)) lines.push(line(s));
    }

    // 注（2026-10-12 主人定）：**不再**在首行显示"我 / 父代"。
    // 会话来源改用另一条更直接的约定：**模拟用户消息的首行直接给出源会话 id**
    // （见 session_send 与 lib/session_watch_lib.mjs）。
    const head = `【DSH 工作区与会话】 工作区 ${projects.length} 个 / 会话 ${sessions.length} 个${filter ? `（筛选: ${args.workspace}）` : ''}`;
    const tail = notes.length ? '\n' + notes.map((n) => '⚠ ' + n).join('\n') : '';
    const dbg = args?.debug
      ? '\n— 服务探测: ' + Object.entries(probe).map(([k, v]) => `${k}=${v ?? '✗'}`).join(', ') +
        '\n— 首条会话原始结构: ' + JSON.stringify(sessions[0] ?? null).slice(0, 600)
      : '';
    return { ok: true, msg: [head, ...lines].join('\n') + tail + dbg };
  },
};
