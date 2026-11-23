/**
 * 网关组装 — 创建 bot、编排中间件、注册事件、出站、生命周期
 *
 * 将 QQ 消息平台作为 dsh 前端协议驱动：入站消息 → handleInbound → dsh agent，
 * dsh session/event → createOutboundHandler → QQ 出站。
 */
import type { Context } from '@deepseek-ai/cordis';
import { type DshAgentRegistry } from '../session/index.js';
import type { ImQQBotConfig } from '../config.js';
import type { Logger } from '../types.js';
/**
 * `bootstrapGateway` 的可选钩子（2026-10-12 新增）。
 *
 * 起因：设置页保存凭据后**本应"自动重连"**，但 `src/index.ts` 里那个 `tryStartGateway()`
 * 带"只启动一次"的守卫（`gatewayStarted`）—— 已有实例改 appId/appSecret 时它直接 return，
 * 于是表现成"只有新建实例并保存才会连上"（主人 2026-10-12 实测反馈）。
 *
 * 这里把「拆卸本次网关」的函数交出去，让调用方能在**连接相关字段变化**时先拆后建。
 * 与交给 `im-qqbot.lifecycle` 的是同一个函数，且做了幂等守卫 —— 重复调用只生效一次。
 */
export interface GatewayBootstrapHooks {
    onDisposer?: (dispose: () => Promise<void>) => void;
}
export declare function bootstrapGateway(ctx: Context, agents: DshAgentRegistry, config: ImQQBotConfig, logger: Logger, hooks?: GatewayBootstrapHooks): Promise<void>;
//# sourceMappingURL=bootstrap.d.ts.map