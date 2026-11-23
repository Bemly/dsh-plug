/**
 * /子会话 — 创建子会话的「问答式向导」（2026-10-13）
 *
 * 用法：
 *   /子会话 <会话名> [人设] [工作区] [模型] [推理等级] [回灌模式]
 *   —— 除会话名外**参数顺序随意**，能认的自动认；认不出的当工作区再试一次。
 *   —— 没给全的参数 → **依次发卡片按钮让主人选**（每次一个参数，选完自动进下一步）。
 *
 * 为什么能一条命令干完（不需要 tools/ 也不需要 botplay）：
 *   卡片按钮 data 写成 `ext:子会话:<卡id>:<按钮id>`，插件把它派发给**本命令的 onInteraction**
 *   （2026-10-13 起扩展命令也支持这条链路，见 features/ext-tool-interaction.ts）。
 *   发卡用 `ctx.caps.markdownCard`，登记用 `ctx.caps.registerInteractionCard`。
 *
 * 状态：进行中的向导存在模块内存里（handler 与 onInteraction 是同一个模块实例）。
 *
 * ⚠️ 改完本文件要**重启宿主**才生效（命令不走 /tools-reload）。
 */

const PAGE = 20;                      // 每页选项数（4 行 × 5 列；第 5 行留给翻页/跳过/取消）
const LETTERS = 'ABCDEFGHIJKLMNOPQRST'; // 一页 20 个选项的编号
const CARD_EXPIRE_MS = 10 * 60_000;   // 向导卡 10 分钟有效
const MAX_PAGE_MS = 30 * 60_000;

/** 步骤（顺序即向导顺序） */
const STEPS = ['agent_preset', 'workspace', 'model', 'effort', 'mode'];
const STEP_CN = {
  agent_preset: '人设',
  workspace: '工作区',
  model: '模型',
  effort: '推理等级',
  mode: '回灌模式',
};

/** 进行中的向导：cardId → state */
const W = new Map();
let seq = 0;

// ── 小工具 ─────────────────────────────────────────────────────
const cn = (s) => String(s ?? '').trim();
const short = (s, n = 26) => (cn(s).length > n ? cn(s).slice(0, n - 1) + '…' : cn(s));

/** 从命令 ctx 拿宿主服务（命令侧是全权限：ctx.caps.kernel 或 ctx.kernel） */
function svc(ctx, name) {
  // 同 sendCard：回调 ctx 是**平铺**的（没有 caps 键），所以逐层兜底
  const k = ctx?.caps?.kernel ?? ctx?.caps ?? ctx?.kernel ?? ctx?.ctx ?? ctx;
  try { return k?.get?.(name); } catch { return undefined; }
}

/** 从命令 ctx 推数据根（caps.store.path 形如 {dataRoot}/.qqbot-extensions/commands/data/x.json） */
function dataRootOf(ctx) {
  const p = String(ctx?.caps?.store?.path ?? ctx?.store?.path ?? '');
  const i = p.indexOf('.qqbot-extensions');
  return i > 0 ? p.slice(0, i).replace(/[\\/]+$/, '') : '';
}

/**
 * ★ 诊断日志（2026-10-13 主人要求）：写死路径，只为看清"点击到底有没有走到命令"。
 * 每条只记事实：handler 被调 / onInteraction 被调 / 发卡结果 / 状态表里有没有这张卡。
 */
// ★ 2026-10-16 修复: 原来写死 Windows 路径(D:/…) —— 手机(POSIX)上永远写不进去, 排查等于瞎。
const DIAG_URL = new URL('../data/子会话-diag.log', import.meta.url);
async function diag(msg) {
  try {
    const { appendFileSync, mkdirSync } = await import('node:fs');
    const { dirname } = await import('node:path');
    mkdirSync(new URL('../data/', import.meta.url), { recursive: true });
    appendFileSync(DIAG_URL, `${new Date().toISOString()} ${msg}\n`);
  } catch { /* 诊断失败绝不影响主流程 */ }
}

/**
 * 登记「带回调按钮的卡片」—— **命令侧必须自己写这张表**。
 *
 * 为什么：插件给命令组 caps 时**没有注入 `registerInteractionCard`**（capsForCmd 只传了
 * dataRoot / apiCall / kernel…），而那个能力的实现又依赖外部注入 ⇒ 命令调它**等于什么都没发生**。
 * 于是注册表里永远查不到这张卡，插件收到点击后第一步查表就落空 → **直接 ack**（真机表现：
 * 点了只弹 QQ 客户端的"操作成功"，既没有新卡也没有回执）。
 *
 * 这里按插件那张表的格式（src/features/ext-tool-cards.ts 的 EXT_TOOL_CARD_FILE）自己写一份：
 *   {version:1, cards:[{toolName, cardId, buttonIds, scope, targetId, createdAt, expireAt}]}
 * 插件每次派发都重读这个文件 ⇒ 改完立即生效，不用重启。
 */
async function regCardSelf(ctx, cardId, buttonIds) {
  const root = dataRootOf(ctx);
  if (!root) return false;
  try {
    const { readFileSync, writeFileSync, mkdirSync } = await import('node:fs');
    const { join, dirname } = await import('node:path');
    const file = join(root, '.qqbot', 'ext-tool-cards.json');
    let table = { version: 1, cards: [] };
    try { table = JSON.parse(readFileSync(file, 'utf8')) ?? table; } catch { /* 首次或坏文件 */ }
    if (!Array.isArray(table.cards)) table.cards = [];
    const mc = ctx?.message ?? {};
    const rt = ctx?.replyTarget ?? {};
    const pe = ctx?.peer ?? {};      // 回调 ctx 只给 peer（2026-10-13 实测）
    const scope = cn(rt.scope || ctx?.scope || pe.scope || mc.kind || ((mc.groupOpenid || pe.groupId || pe.peerId) ? 'group' : 'c2c'));
    const targetId = cn(mc.groupOpenid || rt.targetId || pe.groupId || pe.groupOpenid || pe.peerId || pe.id || mc.senderId);
    const now = Date.now();
    // 清掉过期的 + 本命令同一张卡的旧记录，再追加
    table.cards = table.cards.filter((c) => Number(c?.expireAt ?? 0) > now && !(c?.toolName === '子会话' && c?.cardId === cardId));
    table.cards.push({ toolName: '子会话', cardId, buttonIds, scope, targetId, createdAt: now, expireAt: now + CARD_EXPIRE_MS });
    if (table.cards.length > 200) table.cards = table.cards.slice(-200);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(table, null, 2));
    return true;
  } catch { return false; }
}

/** 发一张卡（markdown + 按钮键盘），返回是否发出去 */
async function sendCard(ctx, text, keyboard) {
  // ★ 2026-10-13 实测关键差异：命令 handler 的 ctx 上插件**显式挂了 `caps`**；
  //   而**按钮回调的 ctx 是把能力包平铺在 ctx 自身**（`ctx.api`/`ctx.markdownCard`…），
  //   **没有 `caps` 键** ⇒ 只写 `ctx.caps.xxx` 时回调里全是 undefined、四级发卡全跳过。
  //   所以这里统一 `ctx.caps ?? ctx` 兜底，两种形状都能用。
  const caps = ctx?.caps ?? ctx ?? {};
  // 坐标多路兜底：**回调 ctx 里没有 replyTarget / peerId**（2026-10-13 日志实测），
  // 它只有 `peer`（身份对象）；handler 侧才有 `message`/`replyTarget`。
  const mc = ctx?.message ?? {};
  const rt = ctx?.replyTarget ?? {};
  const pe = ctx?.peer ?? {};
  const scope = cn(rt.scope || ctx?.scope || pe.scope || mc.kind || ((mc.groupOpenid || pe.groupId || pe.peerId) ? 'group' : 'c2c'));
  // ★ 2026-10-16 c2c 修复: 原来 rt.targetId 在私聊里就是**对方 openid**, 会被当成群号 →
  //   tier① 直连去请求 /v2/groups/<user_openid>/messages 必然被拒(gid 非空时 body 也不带
  //   c2c 需要的 content 字段) → 一路降级成"文字发出来了、按钮消失"。
  //   私聊一律 gid='' 走 /v2/users/<openid>/messages。
  const gid = scope === 'group'
    ? cn(mc.groupOpenid || rt.targetId || rt.openid || rt.id || pe.groupId || pe.groupOpenid || pe.peerId || pe.id || '')
    : '';
  const uid = cn(mc.senderId || rt.openid || rt.id || pe.openid || pe.userId || '');
  void diag(`[sendCard] peer=${JSON.stringify(pe ?? null).slice(0, 180)} scope=${scope} gid=${gid} uid=${uid}`);

  // ① 首选：**直连官方接口**，显式 msg_type=2（markdown）+ keyboard。
  //    ⚠️ 2026-10-13 实测踩坑：命令侧 caps.markdownCard 用的 sender 是中间件 ctx 的 bot（只有
  //    sendText/sendMarkdown），markdownCard 发现没有 sendMarkdownWithKeyboard 会**静默降级成
  //    纯文本、还返回 true** ⇒ 卡片发出来了、按钮全没了。所以这里直接打官方 v2 消息接口
  //    （命令 caps 带 appId/appSecret，caps.api() 自动带 token）。
  const api = caps.api;
  const hasKb = !!keyboard;
  void diag(`[sendCard] gid=${gid || '-'} uid=${uid || '-'} kb=${hasKb} hasApi=${typeof api === 'function'} hasMdCard=${typeof caps.markdownCard === 'function'} hasSenderKb=${typeof ctx?.sender?.sendMarkdownWithKeyboard === 'function'} hasMd=${typeof caps.markdown === 'function'}`);
  if (keyboard && typeof api === 'function' && (gid || uid)) {
    const path = gid ? `/v2/groups/${gid}/messages` : `/v2/users/${uid}/messages`;
    // ★ 2026-10-16 c2c 修复: 私聊的 markdown+键盘消息带上 msg_id(被动回复锚点),
    //   否则可能被拒/退化; 群聊保持原样(实测不带 msg_id 也能发)。
    const replyMsgId = cn(rt.msgId || rt.messageId || mc.msgId || mc.messageId || '');
    void diag(`[sendCard] ①path=${path} msgId=${replyMsgId || '-'} kbRows=${keyboard?.content?.rows?.length ?? '?'}`);
    const body = { msg_type: 2, markdown: { content: text }, keyboard, ...(gid ? {} : { content: text, ...(replyMsgId ? { msg_id: replyMsgId } : {}) }) };
    try {
      const r = await api(path, { method: 'POST', body });
      void diag(`[sendCard] ①api 返回=${JSON.stringify(r ?? null).slice(0, 180)}`);
      if (r && r.ok !== false) return true;
    } catch (e) { void diag(`[sendCard] ①api 抛错=${String(e?.message ?? e).slice(0, 180)}`); }
  } else {
    void diag(`[sendCard] ①跳过（无 api 或 无坐标 或 无键盘）`);
  }

  // ② caps.markdownCard（工具侧那种强 sender 才真的带按钮）
  try {
    if (keyboard && typeof caps.markdownCard === 'function') {
      const r2 = await caps.markdownCard(text, keyboard);
      void diag(`[sendCard] ②markdownCard=${r2}`);
      if (r2) return true;
    } else {
      void diag(`[sendCard] ②跳过（无 markdownCard 或 无键盘）`);
    }
  } catch (e) { void diag(`[sendCard] ②抛错=${String(e?.message ?? e).slice(0, 180)}`); }
  try {
    if (keyboard && typeof ctx?.sender?.sendMarkdownWithKeyboard === 'function') {
      await ctx.sender.sendMarkdownWithKeyboard(ctx.replyTarget, text, keyboard);
      void diag(`[sendCard] ③sender 直发 ok`);
      return true;
    }
    void diag(`[sendCard] ③跳过（sender 没有 sendMarkdownWithKeyboard）`);
  } catch (e) { void diag(`[sendCard] ③抛错=${String(e?.message ?? e).slice(0, 180)}`); }
  try {
    if (typeof caps.markdown === 'function' && (await caps.markdown(text))) {
      void diag(`[sendCard] ④纯文本兜底 ok`);
      return true;
    }
  } catch { /* ignore */ }
  void diag(`[sendCard] 全部失败 → false`);
  return false;
}

/** 按钮（QQ type=1 回调按钮；data 带 ext: 前缀才会派发回来） */
function btn(id, label, style = 1) {
  return {
    id,
    render_data: { label: short(label, 18), visited_label: short(label, 18), style },
    action: { type: 1, permission: { type: 2 }, data: id, unsupport_tips: '请升级QQ客户端后重试' },
  };
}

/** 把一行按钮拼成 QQ 的 inline_keyboard 结构 */
function keyboardOf(rows, cardId) {
  return {
    content: {
      rows: rows.map((r) => ({ buttons: r.map((b) => ({ ...b, action: { ...b.action, data: `ext:子会话:${cardId}:${b.id}` } })) })),
    },
  };
}

// ── 各步的候选值（拿不到就返回空数组，让用户手工传参）──────────────

/** 候选值缓存（靠 handler 阶段预取，见下面说明） */
const OPT_CACHE = new Map();

/**
 * 宿主 ctx（kernel）缓存。
 * ★ 2026-10-13 实测：**只有 handler 侧那个 kernel 能取到服务**（回调侧的取不到）。
 *   建会话要用 `sessionController`，而建会话发生在最后一次点击（回调里），
 *   所以必须把 handler 侧那个好 kernel 缓存下来给它用。
 */
let KERNEL = null;

/**
 * handler 侧有、回调侧没有的东西（挂回灌钩子要用）—— 同样靠 handler 阶段缓存。
 * ★ 2026-10-13：`session_create` 挂"回合结束回灌"钩子时读的是
 *   `env.exec.agent.id`（父会话 id）、`env.sender`、`env.replyTarget`，
 *   而命令侧给它传的 env 是 caps ⇒ 这三样全空 ⇒ 钩子挂不上（现象：建完显示"回灌 → 未挂"）。
 */
const CTX_CACHE = { sender: null, replyTarget: null, agentId: '', sessionId: '' };

/**
 * 各步的候选值。
 * ★ 为什么要缓存（2026-10-13 诊断日志实测）：
 *   同一段"取模型列表"的代码，在 **handler** 里 `kernel.get('llm')` **能拿到**（实测 6 个模型），
 *   在**按钮回调**里却 **拿不到**（`llm=false` → 0 个）—— 两种 ctx 的 `kernel` 不是同一个对象。
 *   所以凡是"只有 handler 侧够得着"的数据（模型、推理等级、预设），**首次取到就缓存**；
 *   回调翻页时直接吃缓存。取到空结果不写缓存，下次还有机会重试。
 */
async function optionsOf(ctx, step, st) {
  if (OPT_CACHE.has(step)) return OPT_CACHE.get(step);
  const out = await optionsOfRaw(ctx, step, st);
  if (Array.isArray(out) && out.length > 0) OPT_CACHE.set(step, out);
  return out;
}

/** 实际的取值实现 */
async function optionsOfRaw(ctx, step, st) {
  try {
    if (step === 'agent_preset') {
      const ap = svc(ctx, 'agentPresets');
      const list = (await ap?.list?.()) ?? [];
      return list.map((p) => ({ value: String(p.id), label: `${p.id}${p.name ? ' · ' + p.name : ''}${p.broken ? ' ⚠️' : ''}` }));
    }
    if (step === 'workspace') {
      // ★ 2026-10-13 定案：**不依赖任何宿主服务**。
      //   实测 `kernel.get('workspaceRegistry')` 在命令侧拿不到（宿主对未声明服务静默给 undefined）；
      //   而插件设置面板那个 `/api/qqbot-settings/workspaces` **压根不用服务**，就是扫这个目录：
      //   dsh 把会话按工作区路径归到 `~/.dsh/sessions/--<编码路径>--`，
      //   目录名规则：`-` 分段、段内 `~XXXX` 是 UTF-16 码元、首段是盘符字母要补冒号。
      const { homedir } = await import('node:os');
      const { readdirSync, existsSync } = await import('node:fs');
      const { join, basename } = await import('node:path');
      const sessRoot = join(homedir(), '.dsh', 'sessions');
      const out = [];
      if (existsSync(sessRoot)) {
        for (const ent of readdirSync(sessRoot, { withFileTypes: true })) {
          if (!ent.isDirectory()) continue;
          const segs = String(ent.name).split('-').filter(Boolean);
          if (segs.length === 0) continue;
          const dec = segs.map((s) => s.replace(/~([0-9A-Fa-f]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16))));
          const head = /^[A-Za-z]$/.test(dec[0]) ? dec[0] + ':' : dec[0];
          const full = [head].concat(dec.slice(1)).join('\\');
          if (!full) continue;
          out.push({ value: full, label: basename(full) || full });
        }
      }
      void diag(`[ws] 扫 ${sessRoot} 得到 ${out.length} 个工作区`);
      out.sort((a, b) => a.label.localeCompare(b.label));
      return out;
    }
    if (step === 'model') {
      // 照抄插件 model-resolver.ts 的取法：宿主 `llm` 服务 → listProviders() → listModels(pid)
      // （workspaceRegistry 拿不到，但 llm 是核心服务，多半挂着；拿不到就返回空、卡片会提示跳过）
      const llm = svc(ctx, 'llm') ?? svc(ctx, 'credentials');
      const out = [];
      try {
        if (llm && typeof llm.listProviders === 'function') {
          const provs = await llm.listProviders();
          for (const p of (Array.isArray(provs) ? provs : [])) {
            const pid = String((p && (p.id ?? p.name)) ?? p ?? '');
            if (!pid) continue;
            try {
              if (typeof llm.listModels !== 'function') continue;
              const ms = await llm.listModels(pid);
              for (const m of (Array.isArray(ms) ? ms : [])) {
                const mid = String((m && (m.id ?? m.model)) ?? m ?? '');
                if (!mid) continue;
                // provider **不进选项文本**（主人 2026-10-13 要求）：选项只显示模型名，
                // provider 由卡片正文按 group 做成小标题分段显示。
                out.push({ value: `${pid}/${mid}`, label: mid, group: pid });
              }
            } catch { /* 单个 provider 失败不影响其它 */ }
          }
        }
      } catch { /* ignore */ }
      void diag(`[model] llm=${!!llm} hasListProviders=${typeof llm?.listProviders === 'function'} 得到 ${out.length} 个`);
      return out;
    }
    if (step === 'effort') {
      // dsh 的推理等级：从模型定义里问；问不到就给常见几档
      const m = svc(ctx, 'llm');
      const vals = (await m?.reasoningEfforts?.()) ?? null;
      const arr = Array.isArray(vals) && vals.length ? vals : ['low', 'medium', 'high'];
      return arr.map((v) => ({ value: String(v), label: String(v) }));
    }
    if (step === 'mode') {
      return [
        { value: '1', label: '一档 · 末段回灌+转QQ' },
        { value: '2', label: '二档 · 全部只转QQ' },
        { value: '3', label: '三档 · 进父上下文不唤醒' },
      ];
    }
  } catch { /* 拿不到就空 */ }
  return [];
}

/** 一张卡的正文 */
function cardText(st) {
  const L = [];
  L.push(`### 🧩 创建子会话 · 第 ${st.stepIdx + 1}/${STEPS.length} 步：${STEP_CN[st.step]}`);
  L.push('');
  L.push(`**要说的话**：${short(st.prompt, 80)}`);
  for (const k of STEPS) {
    const v = st.picked[k];
    L.push(`- ${STEP_CN[k]}：${v ? v.label : '（待选）'}`);
  }
  L.push('');
  if (st.error) L.push(`⚠️ ${st.error}`, '');
  const opts = st.options;
  if (!opts.length) {
    L.push('这一项本鲸没拿到候选列表 —— 点「跳过」不设它，或换个写法重发命令。');
  } else {
    const total = Math.max(1, Math.ceil(opts.length / PAGE));
    L.push(`第 ${st.page + 1}/${total} 页（点字母选中）：`);
    let lastGroup = null;
    for (let i = 0; i < PAGE; i++) {
      const idx = st.page * PAGE + i;
      if (idx >= opts.length) break;
      const o = opts[idx];
      // 带 group 的选项（如模型按 provider 分类）先插一个小标题 —— provider 不进按钮文字
      if (o.group && o.group !== lastGroup) {
        L.push('', `**── ${o.group} ──**`);
        lastGroup = o.group;
      }
      L.push(`**${LETTERS[i]}**. ${o.label}`);
    }
  }
  return L.join('\n');
}

/** 一张卡的按钮（每行 5 个，最多 4 行选项 + 1 行导航） */
function cardKeyboard(st) {
  const rows = [];
  const opts = st.options;
  const start = st.page * PAGE;
  const cur = opts.slice(start, start + PAGE);
  for (let r = 0; r * 5 < cur.length && r < 4; r++) {
    const row = [];
    for (let c = 0; c < 5; c++) {
      const i = r * 5 + c;
      if (i >= cur.length) break;
      // ⚠️ 按钮 id **绝不能带冒号**：插件解析 button_data 是 `ext:<工具名>:<卡id>:<按钮id>`
      //    之后 split(':') 且**要求恰好 3 段** —— 带冒号的 id 会让它 split 出 4 段、
      //    直接 return null（连日志都不打），现象就是"点了只弹操作成功"。所以用 p0/p1/p2…
      row.push(btn(`p${start + i}`, LETTERS[i]));
    }
    if (row.length) rows.push(row);
  }
  const nav = [];
  if (st.page > 0) nav.push(btn('prev', '◀ 上一页', 1));
  if (start + PAGE < opts.length) nav.push(btn('next', '下一页 ▶', 1));
  nav.push(btn('skip', '跳过', 1));
  rows.push(nav);
  rows.push([btn('cancel', '取消', 4)]);
  return keyboardOf(rows, st.cardId);
}

/** 发/重发当前步骤的卡 */
async function paint(ctx, st) {
  st.options = await optionsOf(ctx, st.step, st);
  if (st.page * PAGE >= st.options.length) st.page = Math.max(0, Math.ceil(st.options.length / PAGE) - 1);
  st.cardId = `子会话-${++seq}-${Date.now().toString(36)}`;
  const kb = cardKeyboard(st);
  const ok = await sendCard(ctx, cardText(st), kb);
  const caps = ctx?.caps ?? ctx ?? {};
  try {
    if (typeof caps.registerInteractionCard === 'function') {
      caps.registerInteractionCard({
        cardId: st.cardId,
        // ⚠️ 登记必须是**全部选项**的 id：插件按 (卡id, 按钮id) 查表，没登记的按钮会被判
        //    "不属于这张卡"而不派发（翻到第 2 页点 p:20 就死在这儿）。
        buttonIds: [...st.options.map((_, i) => `p${i}`), 'prev', 'next', 'skip', 'cancel'],
        expireAt: Date.now() + CARD_EXPIRE_MS,
      });
    }
  } catch { /* 登记失败 → 按钮点不动，卡还是发出去了 */ }
  // ★ 兜底（2026-10-13 实测定位）：**命令侧自己写注册表**。
  //   插件给命令组 caps 时没注入 registerInteractionCard ⇒ 上面那次调用等于没调，
  //   注册表里查不到这张卡 ⇒ 点击被插件第一步就否掉、只 ack。这条路不依赖插件，立即生效。
  try { await regCardSelf(ctx, st.cardId, [...st.options.map((_, i) => `p${i}`), 'prev', 'next', 'skip', 'cancel']); } catch { /* ignore */ }
  // ★ 必须在这里登记：paint 每次都会**换一个新的 cardId**（重新发一张卡）。
  //   只在 handler / prev / next 分支里登记的话，**选中选项后走 advance→paint 的这条路**
  //   新卡就不在状态表里 ⇒ 下一屏点按钮直接报"向导已过期"（2026-10-13 实测）。
  //   放在 paint 里 = 所有调用点自动登记，不会再漏。
  W.set(st.cardId, st);
  if (W.size > 30) {
    for (const k of [...W.keys()].slice(0, W.size - 30)) if (k !== st.cardId) W.delete(k);
  }
  void diag(`[paint] step=${st.step} page=${st.page} 选项数=${st.options.length} 发卡=${ok ? 'ok' : 'FAIL'} 状态表=${W.size}`);
  if (!ok) st.error = '卡片没发出去（当前环境可能不支持富文本卡片）';
  return ok;
}

/** 全部参数齐了 → 真正建会话（复用现成工具的逻辑，不重写） */
async function createNow(ctx, st) {
  const args = {
    // ★ 2026-10-13 主人定：**不传 name**（会话名让宿主自动生成）；把「要说的话」当初始任务，
    //   wake=true ⇒ 建完立刻在新会话里跑一轮 —— 这句话就把新建的子会话唤醒了。
    task: st.prompt,
    wake: true,
    agent_preset: st.picked.agent_preset?.value,
    workspace: st.picked.workspace?.value,
    mode: st.picked.mode?.value,
    model: st.picked.model?.value,
    effort: st.picked.effort?.value,
  };
  // 直接调「创建子会话」扩展工具的 run —— 参数天然对齐，逻辑零重写
  try {
    const libUrl = new URL(`../tools/session_create.mjs?ts=${Date.now()}`, import.meta.url);
    const mod = await import(libUrl.href);
    const env = ctx?.caps ?? {};
    // ★ session_create 要的是**有 `.get` 的宿主 ctx**（它读 `env.ctx` 或 `env.ctx.root`）；
    //   命令的 ctx 没有 `.get` ⇒ 之前报"拿不到宿主 ctx（需要 expose:'all'）"。
    //   而按钮回调那个 ctx 的 kernel 取不到服务 ⇒ 用 handler 阶段缓存下来的 KERNEL。
    const kernel = KERNEL ?? ctx?.caps?.kernel ?? ctx?.kernel ?? null;
    void diag(`[create] kernel=${!!kernel} hasGet=${typeof kernel?.get === 'function'}`);
    // 回灌钩子还要三件套：父会话 id（`exec`）+ QQ 发送器 + 回复目标 —— 全用 handler 阶段缓存的。
    const parentId = CTX_CACHE.agentId || CTX_CACHE.sessionId || '';
    void diag(`[create] kernel=${!!kernel} parentId=${parentId || '-'} sender=${!!CTX_CACHE.sender} replyTarget=${!!CTX_CACHE.replyTarget}`);
    const out = await mod.default.run(args, {
      ...env,
      kernel,
      ctx: kernel,
      sender: CTX_CACHE.sender ?? env.sender,
      replyTarget: CTX_CACHE.replyTarget ?? env.replyTarget,
      exec: { agent: { id: parentId }, sessionId: parentId },
    });
    const msg = typeof out === 'string' ? out : (out?.msg ?? JSON.stringify(out ?? {}));
    return String(msg);
  } catch (e) {
    return '建会话失败：' + String(e?.message ?? e);
  }
}

/** 推进到下一步；没了就建 */
async function advance(ctx, st) {
  st.error = '';
  while (st.stepIdx < STEPS.length && st.picked[STEPS[st.stepIdx]]) st.stepIdx += 1;
  if (st.stepIdx >= STEPS.length) {
    W.delete(st.cardId);
    return await createNow(ctx, st);
  }
  st.step = STEPS[st.stepIdx];
  st.page = 0;
  await paint(ctx, st);
  return '';
}

// ── 参数解析（除名字外，任意顺序自动匹配）────────────────────────
const MODE_RE = /^(?:[123]|[一二三](?:档)?|mode[123]?)$/i;
const EFFORT_SET = new Set(['low', 'medium', 'high', 'minimal', 'none', '低', '中', '高']);

async function parseArgs(ctx, tokens) {
  const rest = tokens.slice();
  const picked = {};
  // 回灌模式
  for (let i = rest.length - 1; i >= 0; i--) {
    const t = rest[i];
    if (MODE_RE.test(t)) {
      const m = /^[一1]/.test(t) ? '1' : (/^[二2]/.test(t) ? '2' : '3');
      picked.mode = { value: m, label: `${m} 档` };
      rest.splice(i, 1);
      break;
    }
  }
  // 推理等级
  for (let i = 0; i < rest.length; i++) {
    if (EFFORT_SET.has(rest[i].toLowerCase())) {
      const v = rest[i].toLowerCase();
      picked.effort = { value: v, label: v };
      rest.splice(i, 1);
      break;
    }
  }
  // 模型：含 / 的，或能对上模型列表的
  const models = await optionsOf(ctx, 'model', {});
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i];
    if (t.includes('/') || models.some((m) => m.value === t || m.value.endsWith('/' + t))) {
      const hit = models.find((m) => m.value === t || m.value.endsWith('/' + t) || m.label.includes(t));
      picked.model = hit ?? { value: t, label: t };
      rest.splice(i, 1);
      break;
    }
  }
  // 人设：能对上预设列表的
  const presets = await optionsOf(ctx, 'agent_preset', {});
  for (let i = 0; i < rest.length; i++) {
    const t = rest[i].toLowerCase();
    const hit = presets.find((p) => p.value.toLowerCase() === t || p.label.toLowerCase().includes(t));
    if (hit) { picked.agent_preset = hit; rest.splice(i, 1); break; }
  }
  // 剩下第一个当工作区（模糊）
  // ★ 2026-10-13 主人定：**第一个参数就是"要说的话"（对话内容）**，会话名让宿主自动生成。
  //   所以摘完能识别的参数（人设/工作区/模型/推理等级/回灌模式）后，**剩下的全部**拼成 prompt，
  //   不再像以前那样"把剩下第一个当工作区"。
  const prompt = rest.join(' ').trim();
  if (prompt) picked.__prompt = prompt;
  return picked;
}

export default {
  name: ['子会话', 'subsession'],
  description: '创建子会话（会话名之外参数顺序随意；没给全的会依次发卡片让你点选）',
  usage: '/子会话 <会话名> [人设] [工作区] [模型] [推理等级] [回灌模式]',

  async handler(ctx) {
    const raw = cn(ctx?.command?.raw);
    // ★ 把 handler 侧那个「能取到服务的 kernel」缓存下来（建会话发生在回调里，那边取不到）
    KERNEL = ctx?.caps?.kernel ?? ctx?.kernel ?? KERNEL;
    // 顺手缓存回灌钩子要用的三件套（回调侧全都没有）
    CTX_CACHE.sender = ctx?.sender ?? ctx?.caps?.sender ?? CTX_CACHE.sender;
    CTX_CACHE.replyTarget = ctx?.replyTarget ?? ctx?.caps?.replyTarget ?? CTX_CACHE.replyTarget;
    try {
      const st = ctx?.state ?? {};
      const bs = ctx?.bot ?? {};
      const cand = st.agentId ?? st.sessionId ?? st.agent?.id ?? bs.agentId ?? bs.sessionId ?? '';
      if (cand) { CTX_CACHE.agentId = String(cand); CTX_CACHE.sessionId = String(st.sessionId ?? cand); }
    } catch { /* ignore */ }
    // ★★ 正解（读插件 middleware-setup.ts:357-369 得出）：
    //   命令能力包里 `caps.agent` = **manager.findByPeer(scope, peerId).agent** ⇒ 就是"本会话的 agent"；
    //   `caps.sender` 那颗其实来自 `ctx.bot`。这两样正是回灌钩子要的「父会话 id + 发送器」。
    let capInfo = '-';
    try {
      const caps = ctx?.caps ?? {};
      // ★★ 正解（2026-10-13 改插件后新增）：`caps.peerSessionId`
      //    = manager.sessionIdFor(scope, peerId) = `session/event` 里那个 `session.id`
      //    —— **回灌钩子比的就是它**（不是 agent.id；那个一直拿不到、拿到也不是同一个 id）。
      const psid = String(caps.peerSessionId ?? '');
      if (psid) { CTX_CACHE.agentId = psid; CTX_CACHE.sessionId = psid; }
      if (!CTX_CACHE.sender) CTX_CACHE.sender = ctx?.bot ?? caps.sender ?? null;
      capInfo = `peerSessionId=${psid || '-'} agentId=${String(caps.agent?.id ?? '-')}`;
    } catch (e) { capInfo = 'err=' + String(e?.message ?? e).slice(0, 60); }
    void diag(`[handler] kernel=${!!KERNEL} sender=${!!CTX_CACHE.sender} replyTarget=${!!CTX_CACHE.replyTarget} agentId=${CTX_CACHE.agentId || '-'} ${capInfo}`);
    if (!raw) return '用法：/子会话 <要说的话> [人设] [工作区] [模型] [推理等级] [回灌模式]\n例：/子会话 帮我看看这个报错 温柔鲸鱼娘 鲸鱼娘 一档';
    const tokens = raw.split(/\s+/).filter(Boolean);
    const picked = await parseArgs(ctx, tokens);
    const prompt = String(picked.__prompt ?? '').trim();
    if (!prompt) return '要告诉子会话什么呀？用法：/子会话 <要说的话> [人设] [工作区] [模型] [推理等级] [回灌模式]';

    const st = { prompt, picked, stepIdx: 0, step: STEPS[0], page: 0, options: [], cardId: '', error: '' };
    // 已有值就跳过对应步骤
    while (st.stepIdx < STEPS.length && st.picked[STEPS[st.stepIdx]]) st.stepIdx += 1;

    if (st.stepIdx >= STEPS.length) {
      return await createNow(ctx, st);         // 参数齐了，直接建
    }
    st.step = STEPS[st.stepIdx];
    W.set('pending', st);                      // 先占位，paint 后 cardId 才有值
    await paint(ctx, st);
    W.delete('pending');
    W.set(st.cardId, st);
    return '';                                  // 卡已经发了，不再回文本
  },

  async onInteraction(ctx, info) {
    const cardId = cn(info?.cardId);
    const bid = cn(info?.buttonId);
    const st = W.get(cardId);
    void diag(`[onInteraction] card=${cardId} btn=${bid} 状态表命中=${!!st} 表内keys=[${[...W.keys()].join(',')}] hasApi=${typeof ctx?.caps?.api === 'function'}`);
    if (!st) return '这个向导已经过期了，重新发一次 /子会话 吧～';
    if (st.startedAt && Date.now() - st.startedAt > MAX_PAGE_MS) { W.delete(cardId); return '向导放太久了，重新发一次吧～'; }
    st.startedAt = st.startedAt ?? Date.now();

    if (bid === 'cancel') { W.delete(cardId); return '已取消，子会话没有创建。'; }
    if (bid === 'skip') { st.stepIdx += 1; return await advance(ctx, st) || '好，跳过这一项。'; }
    if (bid === 'prev' || bid === 'next') {
      st.page = Math.max(0, st.page + (bid === 'next' ? 1 : -1));
      const ok = await paint(ctx, st);
      W.delete(cardId);
      W.set(st.cardId, st);
      return ok
        ? `已翻到第 ${st.page + 1} 页 ✅（新卡片在上面）`
        : `翻页失败：新卡片没发出去（第 ${st.page + 1} 页）—— 可能是拿不到群号或接口报错`;
    }
    if (/^p\d+$/.test(bid)) {
      const idx = Number(bid.slice(1));
      const opt = st.options[idx];
      if (!opt) return '这个选项没了，翻一页再选～';
      st.picked[st.step] = opt;
      st.stepIdx += 1;
      const done = await advance(ctx, st);
      return done || '';
    }
    return '';
  },
};
