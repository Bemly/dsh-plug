/**
 * qq_send — 查 QQ 聊天对象 + 发消息（文本 / markdown / 图片，可连发）
 *
 * ★ 2026-10-10 主人定：原 `send_texts` 已**并入本工具** —— 一个入口覆盖
 *   「查对象 / 发一条 / 连发多条」，省得在工具之间选错。
 * ★ 2026-10-13 主人要求：**支持图片与 markdown**。底层能力插件早就有了
 *   （`env.qq.sendImage` / `env.qq.sendMarkdown`），本工具以前只暴露了纯文本。
 *   同版修掉一个**真 bug**：插件给的字段名是 `gid`（群）/ `openid`（私聊），
 *   本工具却按 `x.id` 读 ⇒ 列表里 ID 是空的、**按名字寻址时 id 取到 undefined**
 *   （`sendText` 里 `if (!id) return false` ⇒ 静默发不出去）。现在三种字段名都认。
 *
 * 场景：**非 QQ 通道**的会话（web / 终端）也能隔着通道把消息发进某个群或私聊。
 * 数据来源：`expose: 'all'` 注入的 `env.qq`（账号包，由插件按"人设 id"构造）。
 *
 * 动作：
 *   · action:"list" —— 列出已知聊天对象（群 / 私聊，带最近活跃时间），可用 query 过滤
 *   · action:"send"（默认）—— 发消息，三路内容选一路：
 *       ① 纯文本：`text`（配 `count` 重复）或 `texts:[多条]`
 *       ② 富文本：`markdown`（卡片通道，自带纯文本降级）
 *       ③ 图片：`image` / `images:[多张]`，**可再配 `text` 当配文**（先图后文）
 *
 * 发送链路：
 *   · 文本 `env.qq.sendText`：先查**目标会话最近的 msgId** 走被动回复，失败自动转主动兜底；
 *   · 图片 / markdown `env.qq.sendImage` / `sendMarkdown`：**只走主动发送**
 *     （插件侧目前没给它们接被动窗口）⇒ 会消耗主动消息配额，发之前心里有数。
 *
 * 纪律：
 *   ⛔ 按名字寻址时**绝不猜** —— 命中 0 个或多个只回候选清单；
 *   ⛔ markdown 不与图片/多条文本混发（想配图就 `image` + `text`），要发就明确发；
 *   ✅ 返回据实 —— 成功/失败条数与失败位置都报出来，不谎报。
 */
const MAX_LIST = 40;
const MAX_SEND = 50;
const MAX_IMAGES = 10;

/** 聊天对象的 id：插件给的是 `gid`（群）/ `openid`（私聊），老版本可能叫 `id` —— 三种都认 */
const chatId = (x) => String((x && (x.openid != null ? x.openid : (x.gid != null ? x.gid : x.id))) ?? '');
const isOpenid = (s) => /^[A-Za-z0-9_-]{16,}$/.test(String(s || ''));
const isUrl = (s) => /^https?:\/\//i.test(String(s || ''));
const shortId = (id) => (String(id || '').length > 14 ? String(id).slice(0, 12) + '…' : String(id || ''));
const when = (ts) => {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '';
  try { return new Date(n).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' }); } catch { return ''; }
};
const line = (scope, x) => `[${scope === 'c2c' ? '私聊' : '群'}] ${x.name ? x.name : '(无名)'} · ${shortId(chatId(x))}${when(x.lastAt) ? ' （' + when(x.lastAt) + '）' : ''}`;
const KIND_CN = { text: '文本', markdown: 'markdown', image: '图片' };

export default {
  name: 'qq_send',
  expose: 'all',
  description: '查询本机器人的 QQ 聊天对象（群/私聊），并向指定对象发送消息：纯文本（可连发多条）、markdown 富文本卡片、或图片（可配一句文字）。目标可用 openid，也可用群名/昵称（模糊命中多个时不猜，只回候选）',
  inputSchema: {
    action: { type: 'string', enum: ['list', 'send'], description: 'list=只查询聊天对象；send=发消息（默认）' },
    query: { type: 'string', description: 'action=list 用：按名字或 ID 过滤的关键词' },
    target: { type: 'string', description: 'action=send 用：群 openid / 用户 openid / 群名·昵称' },
    scope: { type: 'string', enum: ['group', 'c2c'], description: 'action=send 用：目标类型（用 openid 时建议写明；按名字找可省）' },
    text: { type: 'string', description: '纯文本（配 count 可重复发 N 次）；给了 image/images 时它是**配文**（在图片之后发）' },
    texts: { type: 'array', items: { type: 'string' }, description: '要依次发的多条纯文本（与 text+count 二选一）' },
    count: { type: 'integer', description: '把 text 重复发几次（1~50，默认 1）' },
    markdown: { type: 'string', description: '要发的 markdown 富文本卡片（自带纯文本降级）。⚠️ 独立一路，不要和图片/texts 混发' },
    image: { type: 'string', description: '要发的图片：http(s) 网址，或本机图片的绝对路径' },
    images: { type: 'array', items: { type: 'string' }, description: `依次发多张图（最多 ${MAX_IMAGES} 张），与 image 可同用（自动去重）` },
    intervalMs: { type: 'integer', description: '连发时每条之间的间隔毫秒（默认 600，防 QQ 吞消息）' },
  },
  run: async (args, env) => {
    const qq = env && env.qq;
    if (!qq) {
      return { ok: false, msg: '拿不到 QQ 账号包（env.qq）—— 需要该工具声明 expose:"all"，且对应人设实例在线' };
    }
    const groups = Array.isArray(qq.groups) ? qq.groups : [];
    const c2c = Array.isArray(qq.c2c) ? qq.c2c : [];

    // ── list：只查 ──────────────────────────────────────────────
    if (args.action === 'list') {
      const q = String(args.query || '').trim().toLowerCase();
      const hit = (x) => !q || String(x.name || '').toLowerCase().includes(q) || chatId(x).toLowerCase().includes(q);
      const g = groups.filter(hit);
      const c = c2c.filter(hit);
      if (!g.length && !c.length) {
        return { ok: true, msg: `没有匹配「${String(args.query || '')}」的对象（已知群 ${groups.length} 个 / 私聊 ${c2c.length} 个）` };
      }
      const out = [];
      out.push(`人设「${qq.preset || qq.tag || '?'}」已知聊天对象：群 ${g.length} / 私聊 ${c.length}`);
      if (g.length) out.push('— 群 —\n' + g.slice(0, MAX_LIST).map((x) => '  ' + line('group', x)).join('\n'));
      if (c.length) out.push('— 私聊 —\n' + c.slice(0, MAX_LIST).map((x) => '  ' + line('c2c', x)).join('\n'));
      if (g.length > MAX_LIST || c.length > MAX_LIST) out.push(`（每类最多显示 ${MAX_LIST} 条，可用 query 过滤）`);
      return { ok: true, msg: out.join('\n') };
    }

    // ── send：组装待发清单 ───────────────────────────────────────
    const raw = String(args.target || '').trim();
    if (!raw) return { ok: false, msg: '需要 target（群 openid / 用户 openid / 群名·昵称）' };
    let scope = args.scope === 'c2c' ? 'c2c' : (args.scope === 'group' ? 'group' : '');

    const md = typeof args.markdown === 'string' ? args.markdown.trim() : '';
    const caption = typeof args.text === 'string' ? args.text : '';
    const texts = Array.isArray(args.texts) ? args.texts.map((s) => String(s)).filter((s) => s.trim()) : [];
    const imgs = [];
    for (const s of (Array.isArray(args.images) ? args.images : [])) {
      const v = String(s || '').trim();
      if (v && !imgs.includes(v) && imgs.length < MAX_IMAGES) imgs.push(v);
    }
    if (typeof args.image === 'string' && args.image.trim()) {
      const v = args.image.trim();
      if (!imgs.includes(v)) imgs.unshift(v);
      if (imgs.length > MAX_IMAGES) imgs.length = MAX_IMAGES;
    }

    if (md && (imgs.length || texts.length)) {
      return { ok: false, msg: 'markdown 是独立一路，不和图片 / 多条文本混发 —— 想「图 + 一句话」就发 image + text（不带 markdown）' };
    }

    /** 发送计划：一条一条来，顺序就是数组顺序 */
    let plan = [];
    if (md) {
      plan = [{ type: 'markdown', payload: md }];
    } else if (imgs.length) {
      plan = imgs.map((s) => ({ type: 'image', payload: s }));
      if (caption.trim()) plan.push({ type: 'text', payload: caption });   // 配文跟在图后面
    } else if (texts.length) {
      plan = texts.slice(0, MAX_SEND).map((t) => ({ type: 'text', payload: t }));
    } else if (caption.trim()) {
      const n = Math.max(1, Math.min(MAX_SEND, Math.round(Number(args.count) || 1)));
      plan = Array.from({ length: n }, () => ({ type: 'text', payload: caption }));
    } else {
      return { ok: false, msg: '没有要发的内容：给 text / texts（纯文本）、markdown（富文本卡片）、或 image / images（图片，可再配 text 当配文）' };
    }

    // 能力自检：老版本插件可能没这两个方法 —— 明确说清，别让人以为是发送失败
    if (plan.some((it) => it.type === 'markdown') && typeof qq.sendMarkdown !== 'function') {
      return { ok: false, msg: '当前插件版本没给 env.qq.sendMarkdown —— 发 markdown 需要插件 ≥ v1.9.x（升级插件后重试）' };
    }
    if (plan.some((it) => it.type === 'image') && typeof qq.sendImage !== 'function') {
      return { ok: false, msg: '当前插件版本没给 env.qq.sendImage —— 发图需要插件 ≥ v1.9.x（升级插件后重试）' };
    }

    // ── 解析目标：openid 直接用；否则按名字找（唯一才发）──────────
    let id = '';
    let label = raw;
    if (isOpenid(raw)) {
      id = raw;
      if (!scope) {
        if (groups.some((x) => chatId(x) === raw)) scope = 'group';
        else if (c2c.some((x) => chatId(x) === raw)) scope = 'c2c';
        else scope = raw.length > 30 ? 'group' : 'c2c';
      }
      const known = (scope === 'group' ? groups : c2c).find((x) => chatId(x) === raw);
      label = (known && known.name) ? known.name : raw;
    } else {
      const pool = [];
      if (!scope || scope === 'group') {
        for (const x of groups) if (String(x.name || '').includes(raw) || chatId(x) === raw) pool.push({ scope: 'group', ...x });
      }
      if (!scope || scope === 'c2c') {
        for (const x of c2c) if (String(x.name || '').includes(raw) || chatId(x) === raw) pool.push({ scope: 'c2c', ...x });
      }
      if (!pool.length) return { ok: false, msg: `找不到「${raw}」这个聊天对象 —— 可先用 action:"list" 看一眼已知的群/私聊` };
      if (pool.length > 1) {
        return {
          ok: false,
          msg: `「${raw}」命中 ${pool.length} 个候选，人家不猜着发 —— 请用 openid 指定：\n` + pool.slice(0, 8).map((x) => '  ' + line(x.scope, x)).join('\n'),
        };
      }
      scope = pool[0].scope;
      id = chatId(pool[0]);
      label = pool[0].name || id;
      if (!id) return { ok: false, msg: `「${raw}」解析到空 id（插件字段名可能又变了）—— 请改用 openid 发` };
    }

    // ── 逐条发 ─────────────────────────────────────────────────
    const gap = Number.isFinite(Number(args.intervalMs)) ? Number(args.intervalMs) : 600;
    const where = scope === 'c2c' ? '私聊' : '群';
    let ok = 0;
    const errs = [];
    for (let i = 0; i < plan.length; i++) {
      const it = plan[i];
      let sent = false;
      try {
        if (it.type === 'markdown') sent = await qq.sendMarkdown(scope, id, it.payload);
        else if (it.type === 'image') sent = await qq.sendImage(scope, id, isUrl(it.payload) ? { url: it.payload } : { localPath: it.payload });
        else sent = await qq.sendText(scope, id, it.payload);
      } catch { sent = false; }
      if (sent) ok += 1; else errs.push(`第${i + 1}条(${KIND_CN[it.type] || it.type})`);
      if (i < plan.length - 1 && gap > 0) await new Promise((r) => setTimeout(r, gap));
    }

    // 汇总结论（把发的是什么也说清楚）
    const what = [...new Set(plan.map((it) => KIND_CN[it.type] || it.type))].join('+');
    if (ok === plan.length) {
      const tail = plan.length === 1 ? '' : `连发 ${ok} 条（间隔 ${gap}ms）`;
      const note = plan.some((it) => it.type !== 'text') ? '（图/markdown 走主动通道，会占主动配额）' : '';
      return { ok: true, msg: `已发送到${where}「${label}」：${what}${plan.length === 1 ? ' 1 条' : ''}✓ ${tail}${note}`.replace(/\s+/g, ' ').trim() };
    }
    return {
      ok: ok > 0,
      msg: `发往${where}「${label}」（${what}）：成功 ${ok}/${plan.length} 条${errs.length ? '，失败：' + errs.slice(0, 5).join('、') : ''}`
        + (plan.some((it) => it.type === 'text') ? '（文本失败多为 QQ 侧拒绝：被动窗口过期且主动消息不可用）' : '（图/markdown 只走主动通道：配额用尽或被 QQ 拒绝都会失败）'),
    };
  },
};
