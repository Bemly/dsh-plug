/**
 * session-watch-hook.mjs — 启动钩子：**重启后把「回合结束回灌」接回来**
 *
 * 背景（2026-10-13 主人定「做成持久化的本地存档，不要只靠内存」）：
 *   · **盯梢名单本身就以存档为准**：
 *     `{数据根}/.qqbot-extensions/tools/data/session-watch-watching.json`
 *     （和 `vote.json` 同一个 data 目录）—— register / 改档 / 取消都会落盘，
 *     所以**重启后名单不会丢**；
 *   · **但监听器是内存态**：回灌靠 `root.on('session/event', …)` 这个订阅，
 *     它随插件进程一起消失 ⇒ 重启后"名单还在、却没人听了"。
 *     这就是之前那个「重启后引用子会话没用了」的根因。
 *   ⇒ 所以本钩子只做一件事：`rehydrate(env.ctx)` = **读回存档 + 重装监听器**。
 *
 * 为什么写在这里：hooks/ 是插件**启动期**跑的（每次启动 / 重建网关都会走一遍），
 * 正是"把内存态重新接上"的唯一时机。
 *
 * ⚠️ **改这个文件要重启宿主才生效**（hooks 是启动期加载，不走 /tools-reload）。
 */
export const name = 'session-watch-hook';

/** 本次 run 的现场（重建网关会有新的一份） */
let state = null;

export default {
  name,

  async run(env) {
    state = { restored: 0, hooked: false };
    try {
      // 同一份库（tools/lib/）；不带 ?v= —— 名单走 globalThis 共享，无需新实例
      const lib = await import('../tools/lib/session_watch_lib.mjs');
      const r = await lib.rehydrate(env.ctx);
      state.restored = Number(r?.restored ?? 0);
      state.hooked = !!r?.hooked;
      env.logger.info(
        `[ext-hook:session-watch] 启动恢复：读回 ${state.restored} 条盯梢，` +
        `回灌监听器${state.hooked ? '已装' : '未能装上'}` +
        `（名单存档 tools/data/session-watch-watching.json）`,
      );
      return { restored: state.restored, hooked: state.hooked };
    } catch (err) {
      // 钩子里的失败不要往外抛：抛了也只是被引擎记成"失败"，不如降级 + 留日志
      const msg = String(err?.message ?? err);
      env.logger.warn(`[ext-hook:session-watch] 启动恢复失败（不影响其它功能）: ${msg}`);
      return { restored: 0, hooked: false, error: msg };
    }
  },

  /** 引擎在插件卸载 / 宿主退出 / 重建网关时调用（本钩子没有要归还的资源） */
  async dispose() {
    state = null;
  },
};
