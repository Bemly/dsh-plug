import { fileURLToPath } from 'node:url';
/**
 * route-isolate.mjs — 入站中间件：**二档绑定的路由消息，不进父会话上下文（彻底隔绝）**
 *
 * 放在 `{数据根}/.qqbot-extensions/inbound/route-isolate.mjs`；改完 `/tools-reload` 立即生效。
 *
 * ── 它解决什么（主人 2026-10-14 需求，原话）────────────────────────────────
 *   「如果是挡位2的情况下，所有的路由的消息，不进入父会话的上下文，彻底隔绝」
 *   「我是说，用户发的消息，如果是路由用的，不进入你的上下文，不是说回灌的消息」
 * 即：群里那条 `[s:c0249642] 喜欢你` —— 只该出现在**目标会话**里，
 * 不该同时躺进鲸鱼娘本尊（父会话）的上下文。二档本就意味着"子会话内容只去 QQ、不进父上下文"，
 * 本扩展把**反方向**补齐：**父上下文 ↔ 子会话 彻底互不可见**。
 *
 * ── 为什么只能写在**早挂点 onInbound** ──────────────────────────────────────
 * 链上位置：`… → quoteRef → ★onInbound（本文件）★ → 引用图预取 → 记群历史 → … → AI`
 * 只有这里在"记群历史之前"，所以只有这里的 `ctx.annihilate()` 才真的等于"这条没来过"
 * （不进历史、不进上下文、不占冷却）。晚挂点调它会**被拒 + 告警**。
 *
 * ── 三个必须这么写的地方 ───────────────────────────────────────────────────
 * ① **消灭之后必须自己投递**：`session_watch_lib` 原来那条路由投递挂在 `session/event` 的
 *    `user/message` 上；消息都被消灭了，那个事件**永远不会发生** ⇒ 这里消灭前先解析目标、
 *    消灭后直接调 `lib.routeToSession()`。
 * ② **`return next()`，不能"消灭完就 return"**：插件引擎有条兜底 —— 扩展"既没调 next、
 *    又没有成功的消灭"时**替它放行**，且白名单写着"主人的消息永远不被入站扩展吞掉"。
 *    但这条兜底**只在 `!onward` 时触发**（=扩展压根没调 next）；调了 next，
 *    `annihilate` 的置位会**直接吃掉 next**（链停在这里 + 跳过兜底）⇒ **主人的消息也真的被消灭**。
 *    这正是主人要的。⚠️ 该语义照 `src/features/ext-inbound.ts` 的
 *    `runEarlyInboundExtensions` 确认；哪天插件收紧它，这里会退化成"主人消息照进上下文"（不会更糟）。
 * ③ **只有二档才隔绝**：`modeOfRoute(key) === 2`。没绑过 / 一档 / 三档 ⇒ 原样放行。
 *
 * ── 安全阀（宁可"不隔绝"，也不要"消息凭空消失"）──────────────────────────
 *   · 没路由标记 ⇒ 放行；· 不是二档 ⇒ 放行；
 *   · **路由 id 解析不出会话**（写错了）⇒ 放行；· `annihilate` 返回 false（熔断/挂点不允许）⇒ 放行，
 *     交回原路径投递，避免"我投一次 + 原路径再投一次"双投；
 *   · 已消灭但投递失败（目标不在线且唤不醒）⇒ 不回父上下文（这是隔绝的代价），只记诊断日志。
 *
 * ── 诊断 ──────────────────────────────────────────────────────────────────
 * 全程写 `{数据根}/.qqbot-extensions/data/route-isolate-diag.log`。
 * （教训：一开始只往 logger 写，而**从来没人注入过 logger** ⇒ 真机上完全静默、无法定位。）
 */

/** 只在插件日志里显示的名字 */
export const name = 'route-isolate';

/** ★ 诊断必须**落盘**：logger 没人注入过，只往 logger 写等于瞎的 */
// ★ 2026-10-24 修复（issue #17）: 原来写死 Windows 路径(D:/…) —— Linux/容器/手机上会被当成
//   相对路径，在家目录里生成一个叫 "D:" 的畸形目录，日志全丢。改成跟着本文件走。
const DIAG_FILE = fileURLToPath(new URL('../data/route-isolate-diag.log', import.meta.url));
let LOG = null;

async function note(msg) {
  try { LOG?.(msg); } catch { /* ignore */ }
  try {
    const { appendFile, mkdir } = await import('node:fs/promises');
    const { dirname } = await import('node:path');
    await mkdir(dirname(DIAG_FILE), { recursive: true });
    const line = new Date().toISOString() + ' ' + String(msg) + '\n';
    await appendFile(DIAG_FILE, line);
  } catch { /* 诊断失败绝不影响主流程 */ }
}

async function loadLib() {
  return await import(new URL('../tools/lib/session_watch_lib.mjs?v=' + Date.now(), import.meta.url).href);
}

/** 早挂点：链上唯一"还没记群历史"的位置 */
export async function onInbound(ctx, next) {
  try {
    // ★★ 正文从哪读：**`ctx.text` 才是插件给的规范读法**（它内部 = `textOf(ctx)`），
    //    实际存在 `ctx.message.content` 里。**不存在 `ctx.message.text`** ——
    //    2026-10-14 就是因为写成 `.text` 读到空串、第一行就 return next()，
    //    整条链路静默放行（审计里一条记录都没有）才排查了半天。
    const text = String(ctx?.text ?? ctx?.message?.content ?? ctx?.message?.text ?? '');
    if (!text) return next();
    const lib = await loadLib();

    // ★★ 2026-10-14：**顺手把 sender/replyTarget 交给回灌库**（`rememberFwd`）。
    //   为什么必须挂在入站链上：QQ 转发能力 `fwd` 是**内存态**，插件一重启就丢；
    //   唯一的自愈路径是"父会话发言时 hydrateFwd"，而它需要 sender ——
    //   工具侧只有"被调用过"才注入（`session_watch.mjs` 里的 rememberFwd），
    //   于是重启后如果没人记得调工具，转发就一直断（实测踩到）。
    //   挂在这里 ⇒ **每条群消息都刷新一次** ⇒ 重启后父会话随便说一句话转发就自动恢复。
    //   注意用 `ctx.caps.*` 而不是 `ctx.*`：ctx 上那个 `sender` 已被插件定义成"发送者 openid"（字符串）。
    try {
      lib.rememberFwd?.(ctx?.caps?.sender, ctx?.caps?.replyTarget);
    } catch { /* 注入失败不影响隔绝 */ }

    const key = lib.parseRouteKey(text);
    // 每次都记"手上有什么" —— kernel / annihilate 缺任一个都会走放行分支，先看清
    void note('[enter] text=' + JSON.stringify(text.slice(0, 50))
      + ' key=' + (key || '-')
      + ' kernel=' + typeof ctx?.kernel
      + ' annihilate=' + typeof ctx?.annihilate
      + ' next=' + typeof next);

    if (!key) return next();

    // ① 只有二档才隔绝（没绑 = 0，一/三档 = 1/3，都放行）
    const mode = lib.modeOfRoute(key);
    void note('[mode] key=' + key + ' mode=' + mode);
    if (mode !== 2) return next();

    // ② 目标解析不出来 ⇒ 不吞（写错 id 时别让消息凭空消失）
    const kernel = ctx?.kernel ?? null;
    let full = '';
    try { full = lib.resolveShortId(kernel, key) ?? ''; } catch { full = ''; }
    if (!full) {
      try { full = lib.findSessionOnDisk(key)?.id ?? ''; } catch { full = ''; }
    }
    if (!full) { void note('[skip] id 解析不到会话 key=' + key); return next(); }

    // ③ 先消灭再投递 —— 顺序不能反：先投再吞的话，一旦消灭被熔断拒绝就会双投
    // ★ `ownerAck: true` —— 唯一能吞"主人消息"的通道（2026-10-14 为此专门给插件加了显式例外）。
    //   语义：这条我已经**另行投递到目标会话**了，请允许对主人生效；插件会落审计 ok-owner-ack。
    const acked = ctx?.annihilate?.({ reason: '二档路由隔绝：目标 ' + key, ownerAck: true });
    if (!acked) { void note('[skip] annihilate 被拒 key=' + key + ' target=' + full.slice(0, 20)); return next(); }

    // ④ 已消灭 ⇒ 自己投递（原路径的 user/message 钩子不会跑了）
    let r = null;
    try {
      r = await lib.routeToSession(kernel, text, { message: ctx?.message });
    } catch (e) {
      r = { ok: false, reason: 'throw:' + (e?.message ?? e) };
    }
    void note('[done] key=' + key + ' target=' + full.slice(0, 20)
      + ' 已从父上下文移除；投递=' + (r?.ok ? 'ok(' + r.reason + ')' : 'FAIL(' + r?.reason + ')'));
  } catch (e) {
    void note('[error] ' + (e?.message ?? e));
  }
  // ★ 必须调 next()：跳过"发送者是主人 ⇒ 引擎替它放行"那条兜底（见文件头 ②）
  return next();
}

/** 插件可用它注入日志（没注入也会落盘诊断） */
export function setLogger(fn) { LOG = typeof fn === 'function' ? fn : null; }
