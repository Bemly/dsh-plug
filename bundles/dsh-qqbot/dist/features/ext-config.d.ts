/** 扩展配置目录（相对 dataRoot） */
export declare function extConfigDir(dataRoot: string): string;
/** 扩展文件路径 → 配置文件路径（用文件名去扩展名当 id，与面板侧一致） */
export declare function extConfigPathOf(dataRoot: string, extFile: string): string;
/** 同步读某扩展的配置；不存在/坏了都返回 {} */
export declare function readExtConfig(dataRoot: string, extFile: string): Record<string, unknown>;
//# sourceMappingURL=ext-config.d.ts.map