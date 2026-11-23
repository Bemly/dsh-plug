/**
 * session_watch.mjs — 查看/补挂「回合结束回灌」钩子（含三档 + QQ 转发）
 *
 * 配合 session_create 用：创建时会自动挂钩子（session_create → lib/session_watch_lib.register）。
 * 本工具负责：
 *   · list（默认）：列出正在盯的子会话（子 id / 父 id / 标签 / **档位** / QQ 转发是否就绪 / 已结算几次）
 *   · attach：给一个"已存在的子会话"补挂钩子（创建时漏挂、或插件重启后钩子丢了的情况）
 *   · mode：改已挂盯梢的档位（一/二/三档随时可改）
 *   · detach：取消盯某个子会话
 *
 * ★ 2026-10-12 主人定：三档（mode）
 *   1 = 一档（默认）：末段正文回灌父会话 + **同时**转发到父会话所在的 QQ
 *   2 = 二档：本回合**所有正文 + 报错**都转发 QQ，**不进**父会话上下文
 *   3 = 三档：所有正文 + 报错**进**父会话上下文（**不唤醒**）+ 同时也转发 QQ
 *
 * ⚠️ 主人要求这类工具不给全部会话用：已落地 `expose: 'qq'`（2026-10-12），只在 QQ 会话注册。
 */
import { statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * 带版本号地加载共用库 —— **必须这么加载**。
 *
 * 原因同 session_create.mjs：插件只给**工具文件本身**的 import 加了 `?v=<mtime>`，
 * 工具内部裸路径 import 会被 ESM 模块缓存永久命中 ⇒ 改 `tools/lib/` 热刷不生效。
 * （这里原来是顶层静态 import，等于永远锁死在插件启动那一刻的旧版本。）
 */
async function loadWatchLib() {
  const url = new URL('./lib/session_watch_lib.mjs', import.meta.url);
  let v = '0';
  try { v = String(statSync(fileURLToPath(url)).mtimeMs); } catch { /* 拿不到 mtime 就退回裸 import */ }
  return import(v === '0' ? url.href : `${url.href}?v=${v}`);
}

/** 档位 → 人话 */
const modeText = (m) => (Number(m) === 2 ? '二档·只转QQ不进父' : (Number(m) === 3 ? '三档·进父不唤醒+转QQ' : '一档·末段回灌+转QQ'));
/** 把用户给的档位写法归一（收 1/2/3 与中文「一档/二档/三档」） */
function normMode(v) {
  const s = String(v ?? '').trim();
  if (/^(2|二)/.test(s)) return 2;
  if (/^(3|三)/.test(s)) return 3;
  if (/^(1|一)/.test(s)) return 1;
  return 1;
}

export default {
  name: 'session_watch',
  // ★ 2026-10-12：**父会话专用**（"我作为父"去挂/摘回灌钩子）⇒ 不给子会话看。
  expose: 'qq',
  description:
    '查看/补挂「回合结束回灌」钩子：默认列出正在盯的子会话、档位与状态；' +
    'attach=给指定子会话补挂（子会话 id + 父会话 id + 可选 mode）；mode=改已挂盯梢的档位（1/2/3）；detach=取消盯梢。' +
    '档位：1=只把末段正文回灌父会话并转发到父所在的QQ；2=只把该回合所有正文+报错转发QQ、不进父上下文；3=进父上下文但不唤醒、同时也转发QQ。',
  inputSchema: {
    action: { type: 'string', description: 'list（默认）=看状态 / attach=给已存在的子会话补挂 / mode=改档位 / detach=取消盯梢' },
    child_session_id: { type: 'string', description: 'attach / mode / detach 时要指定的子会话 id' },
    parent_agent_id: { type: 'string', description: 'attach 时填**父会话 id**（历史上叫"父 agent id"，指的是同一个东西；不填＝用"我自己这个会话"）' },
    label: { type: 'string', description: 'attach 时的标签，便于记认（可选）' },
    name: { type: 'string', description: '会话名（可选；只影响转发到 QQ 时行首归属里显示什么，缺省用 label）' },
    preset: { type: 'string', description: '预设名（可选；同上，归属行显示用）' },
    workspace: { type: 'string', description: '工作区名（可选；同上，归属行显示用，建议只写目录名）' },
    mode: { type: 'string', description: '档位：1/一档（默认）=末段回灌父+转QQ；2/二档=只转QQ不进父上下文；3/三档=进父上下文但不唤醒+转QQ' },
  },

  async run(args = {}, env = {}) {
    const ctx = env?.ctx ?? null;
    const root = ctx && typeof ctx === 'object' && ctx.root ? ctx.root : ctx;
    if (!root?.get) return { ok: false, msg: '拿不到宿主 ctx（需要 expose:\'all\'）' };

    const lib = await loadWatchLib();

    // ★ 2026-10-13：把本次 env 的 sender/replyTarget 交给回灌库。
    //   工具 env **一定有**这两样（{cwd, manager, sender, replyTarget, exec, ctx, logger}），
    //   而插件根 ctx（handler 的 root）上实测拿不到 ⇒ 记住它，回灌库才能在"父会话发言"时
    //   把重启后丢失的 QQ 转发能力补回来。
    const fwdOk = lib.rememberFwd?.(env?.sender, env?.replyTarget) ?? false;

    const action = String(args?.action ?? 'list').toLowerCase();
    const p = (n) => String(n).padStart(2, '0');
    const fmt = (t) => {
      if (!t) return '—';
      const d = new Date(t);
      return Number.isNaN(d.getTime()) ? '—' : `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    };

    // ★ 2026-10-13 加：**不重启也能让最新 lib 接管**。
    //   背景：`tools/lib/*.mjs` 是按 mtime 版本化加载的，改完只有"监听器真正用的那份 handler"
    //   才是新代码；而 handler 指针靠 `installHook()` 更新。`rehydrate()` 同时做两件事：
    //   ① 读回落盘名单；② installHook（把 globalThis 上的 handler 换成最新实例）。
    //   ⇒ 改完 lib 跑一次本动作即可生效，**不必重启宿主**。
    if (action === 'rehydrate' || action === '重载' || action === '刷新') {
      const root = env?.kernel ?? env?.ctx ?? null;
      if (!root || typeof root.on !== 'function') {
        return { ok: false, msg: 'rehydrate 需要宿主根 ctx（env.kernel），当前拿不到' };
      }
      const r = await lib.rehydrate(root);
      return {
        ok: true,
        msg: `已重载：读回 ${r?.restored ?? 0} 条盯梢，回灌监听器${r?.hooked ? '已装' : '未装'}` +
          `（新代码已接管；QQ 转发能力会在父会话下一次发言时自动补回）`,
      };
    }

    if (action === 'attach' || action === '补挂') {
      const child = String(args?.child_session_id ?? '').trim();
      const parent = String(args?.parent_agent_id ?? env?.exec?.agent?.id ?? '').trim();
      if (!child) return { ok: false, msg: 'attach 需要 child_session_id' };
      if (!parent) return { ok: false, msg: 'attach 需要 parent_agent_id（不填会用"我自己"）' };
      const r = await lib.register(root, {
        parentAgentId: parent,
        childSessionId: child,
        label: String(args?.label ?? ''),
        mode: normMode(args?.mode),
        // 归属行三件套（可选；不填就只显示短 id）
        name: String(args?.name ?? args?.label ?? ''),
        preset: String(args?.preset ?? ''),
        workspace: String(args?.workspace ?? ''),
        // ★ QQ 转发用的就是"我自己这个会话"的 sender + replyTarget
        //   （replyTarget 自带最近 msgId ⇒ 被动优先；插件的 sendMarkdown 自带 markdown 降级链）
        sender: env?.sender,
        replyTarget: env?.replyTarget,
        peerName: String(env?.replyTarget?.name ?? ''),
      });
      return { ok: !String(r).startsWith('未挂'), msg: 'attach → ' + r };
    }

    if (action === 'mode' || action === '档位') {
      const child = String(args?.child_session_id ?? '').trim();
      if (!child) return { ok: false, msg: 'mode 需要 child_session_id（先用 list 看）' };
      // 已挂的直接改；没挂但库里能按短 id 找到也认
      const hit = lib.listWatching().find((x) => x.childSessionId === child || x.shortId === child.slice(0, 8));
      const target = hit ? hit.childSessionId : child;
      const r = await lib.setMode(target, normMode(args?.mode));
      return { ok: !String(r).includes('没找到'), msg: `mode → ${r}` };
    }

    if (action === 'detach' || action === '取消') {
      const child = String(args?.child_session_id ?? '').trim();
      if (!child) return { ok: false, msg: 'detach 需要 child_session_id' };
      const hit = lib.listWatching().find((x) => x.childSessionId === child || x.shortId === child.slice(0, 8));
      const r = await lib.unregister(hit ? hit.childSessionId : child);
      return { ok: true, msg: r + `（${String(child).slice(0, 14)}…；钩子本身是全局一个，这里只是不再为它回灌/转发）` };
    }

    // list
    const items = lib.listWatching();
    if (!items.length) {
      return {
        ok: true,
        msg: '【回合结束回灌】当前没有盯着任何子会话。\n用 session_create 建会话时会自动挂（可带 mode）；也可以用 attach 给已存在的子会话补挂。',
      };
    }
    const lines = items.map(
      (x) =>
        `   · 子 ${x.shortId ?? x.childSessionId.slice(0, 8)}… → 父 ${x.parentShortId ?? x.parentAgentId.slice(0, 8)}…` +
        `${x.label ? '  [' + x.label + ']' : ''}\n` +
        `     档位=${modeText(x.mode)}  QQ转发=${x.qqReady ? '就绪' : '未就绪(没拿到 sender/replyTarget)'}` +
        `${x.peerName ? ' → ' + x.peerName : ''}\n` +
        `     已结算=${x.turnsSeen} 次  上次回灌=${fmt(x.lastFiredAt)}  最近被引用=${fmt(x.quotedAt)}`,
    );
    return { ok: true, msg: `【回合结束回灌】正在盯 ${items.length} 个子会话：\n` + lines.join('\n') };
  },
};
