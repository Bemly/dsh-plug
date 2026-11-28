import type { ModelRoute, ModelEntry } from './types.js';
export declare class SettingsReader {
    /** settings.yaml 缓存 */
    private settingsCache;
    /**
     * 从 settings.yaml 的 agent-default-model 字段读取默认模型路由
     */
    readDefaultRoute(): ModelRoute | undefined;
    /**
     * 列出 settings.yaml 中配置的所有模型
     */
    readModels(): ModelEntry[];
    /**
     * 列出 settings.yaml 中配置的 provider 名称
     */
    readProviders(): string[];
    /**
     * 从 settings.yaml 的 <ns> 段读取 groupAdmin 配置。
     * 解决"QQBot 构造时 intents 一次性读取"的时序坑: settings 服务的 Web 可视化配置
     * (写 settings.yaml)是异步注入, 晚于 gateway 构造 → 启动期读文件才能在构造前拿到值。
     * 返回 undefined = settings.yaml 无该 ns 或 ns 无 groupAdmin。
     */
    readGroupAdmin(ns: string): Record<string, unknown> | undefined;
    private loadSettings;
}
//# sourceMappingURL=settings-reader.d.ts.map