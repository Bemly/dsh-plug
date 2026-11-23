export interface SeedResult {
    installed: string[];
    skipped: string[];
    errors: string[];
}
export interface SeedOpts {
    dataRoot: string;
    profileRoot?: string;
    /** 源码 examples/ext-ui 的绝对路径（通常是插件包根/examples/ext-ui） */
    examplesDir?: string;
    /**
     * 额外要铺的数据根（2026-10-27 主人要求：**只铺前两个实例**）。
     *
     * 为什么不铺全部：用户可能建几十个实例，全铺会造成大量目录和无谓 IO。
     * 取前 2 个足够测试 —— 没铺到的实例只是 dock 里少一个扩展页签，不影响任何功能。
     */
    extraDataRoots?: string[];
    /** 最多铺几个数据根（含 dataRoot 自己），默认 2 */
    maxDataRoots?: number;
}
/**
 * 执行一次铺设。幂等：重复调用不会覆盖已有内容。
 */
export declare function installExtUi(opts: SeedOpts): SeedResult;
//# sourceMappingURL=ext-ui-seed.d.ts.map