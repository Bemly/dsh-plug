/**
 * 唤醒.mjs —— /唤醒 扩展命令：手动叫醒鲸鱼娘（2026-10-16 主人需求）
 *
 * 需求原文：
 *   「私聊不能@，给私聊环境加一个强制唤醒的方式？可以弄个扩展斜杠指令 /唤醒，
 *     作用就是发送一条『用户呼唤你』」
 *
 * ★ 唤醒方式（2026-10-16 第二次修订：跟投票工具走同一条路）
 *   首选 `caps.appendWake(text)` —— 它就是扩展工具 `env.appendWake` 的同源实现
 *   （dist/features/ext-capabilities.js:285）：
 *
 *     appendWake: async (text) => {
 *       agent.followup(createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } }))
 *     }
 *
 *   ⇒ 直接对**本会话的 agent** 调 followup 开一个新回合唤醒 AI。投票结束把结算表推醒 AI，
 *     用的就是这条路（实测有效）。命令侧能力包由 middleware-setup.js 的 capsForCmd 组装，
 *     里面已经带了 `agent: manager.findByPeer(scope, peerId)?.agent`，所以命令同样拿得到。
 *
 *   兜底：若 appendWake 不可用（该 peer 还没有会话记录 / agent 拿不到），返回
 *   `{ wake: { content, senderName } }` —— 插件会走聚合层 injectSynthetic(scope, peerId, …)
 *   把这条合成消息交给聚合窗口（c2c 与群聊都支持；与真人消息同窗口聚合；不伪造 @）。
 *
 * 用法：
 *   /唤醒                 → 默认文案（"用户在呼唤你"）
 *   /唤醒 在吗            → 把「在吗」当成用户在呼唤她
 *
 * ⚠️ 命令新增/改完用 tools_reload 热刷（未生效就重启一次宿主）。
 */

/** 合成消息的前缀 —— 让 AI 一眼看出这是"用户在呼唤"而不是普通群聊 */
const WAKE_PREFIX = '[用户呼唤]';

/** 默认呼唤文案 */
const DEFAULT_SAY = '用户在呼唤你';

export default {
  name: ['唤醒', 'wake', 'huanxing'],
  description: '强制唤醒: /唤醒 [要说的话] —— 把这句话当作"用户在呼唤你"送进会话（私聊没有 @，用它代替）',
  usage: '/唤醒 [要说的话]',

  async handler(ctx) {
    // raw 可能是「/唤醒 在吗」也可能是「在吗」→ 两种都吃掉
    let say = String(ctx?.command?.raw ?? '').trim();
    say = say.replace(/^\/?\s*(唤醒|wake|huanxing)\s*/i, '').trim();
    if (!say) say = DEFAULT_SAY;

    const isGroup = String(ctx?.message?.kind ?? '') === 'group';
    const who = String(ctx?.message?.senderName ?? '').trim() || (isGroup ? '群友' : '主人');
    const where = isGroup ? '群里' : '私聊里';
    const text = `${WAKE_PREFIX} ${who} 在${where}呼唤你：${say}`;
    const receipt = `🔔 叫醒她啦～「${say.slice(0, 40)}」`;

    // ── 首选：caps.appendWake（= 工具侧 env.appendWake：直接 agent.followup 开新回合）──
    const caps = ctx?.caps ?? ctx ?? {};
    const appendWake = caps.appendWake ?? ctx?.appendWake;
    if (typeof appendWake === 'function') {
      try {
        const ok = await appendWake(text);
        if (ok !== false) return { kind: 'text', content: receipt };
      } catch { /* 落到下面的聚合层兜底 */ }
    }

    // ── 兜底：交给聚合层的合成消息通道（middleware-setup 里的 injectSynthetic）──
    return {
      kind: 'text',
      content: receipt,
      wake: { content: text, senderName: who },
    };
  },
};
