/**
 * hello-hook.mjs — 最小可跑的「启动钩子」示例
 *
 * 放在 `{数据根}/.qqbot-extensions/hooks/hello-hook.mjs`（插件启动时会自动铺一份，只补不覆盖）。
 * 它是**日志型**的：不注册任何清理、不碰宿主状态 —— 用来确认"启动钩子这条链路是通的"。
 *
 * 契约（完整版见 README「启动钩子」一节）：
 *   · 导出 `run(env)`（也接受 `export default { run }` / `export default async (env) => {}`）；
 *   · 可以是 async，返回值只记日志，不影响启动；
 *   · 可选导出 `dispose(env)`，插件卸载 / 宿主退出 / 重建网关时调用。
 *
 * env 给了什么：{ ctx, logger, dataRoot, config, registerDispose, pluginVersion, hookFile, caps, store }
 */

/** 每个启动钩子都可以导出 `name` 给日志用（不写就用文件名） */
export const name = 'hello-hook';

/** 本次启动的时间戳，dispose 时拿来算存活时长 */
let bootedAt = 0;

export async function run(env) {
  bootedAt = Date.now();
  // env.logger 就是插件 logger；建议前缀带上钩子名，日志里好认
  env.logger.info(
    `[ext-hook:hello] 你好，插件 v${env.pluginVersion} 启动完成；数据根 = ${env.dataRoot}`,
  );

  // ── 用 store 记一点跨会话的小状态（落 {数据根}/.qqbot-extensions/hooks/data/hello-hook.json）──
  //    ⚠️ 这里演示"读 → 改 → 写"；真实用途可以是"上次跑到哪了 / 上次的游标"。
  const prev = env.store.load() ?? {};
  const boots = Number(prev.boots ?? 0) + 1;
  const ok = env.store.save({
    boots,
    firstBootAt: prev.firstBootAt ?? new Date().toISOString(),
    lastBootAt: new Date().toISOString(),
    lastPluginVersion: env.pluginVersion,
  });
  env.logger.info(`[ext-hook:hello] 这是第 ${boots} 次启动（状态写入${ok ? '成功' : '失败'}）`);

  // 演示"启动时跳过一段时间"的老套路：store 里存着"下次才处理"的时间戳，没到就直接返回
  // return { skipped: true };   ← 返回什么都行，只是个记录

  return { boots };
}

/**
 * 可选：清理函数。示例里只是打一行日志。
 * ⚠️ 真实场景（定时器 / 监听 / 订阅）**必须**在这里（或 env.registerDispose）收尾，
 *    否则重建网关会不断累积 —— 本插件自己在这个坑上摔过（见维护手册：disposer 要收尾）。
 */
export async function dispose(env) {
  const aliveMs = bootedAt ? Date.now() - bootedAt : 0;
  env.logger.info(`[ext-hook:hello] 再见（本次存活 ${Math.round(aliveMs / 1000)}s）`);
}
