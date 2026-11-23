/** 没写 settingsNs 时的默认槽名（必须与 index.ts / session-manager 的取值一致） */
export declare const DEFAULT_NS = "im-qqbot";
/** 从一份 patch 文本里取「启用中的本插件实例」所用的 settingsNs（去重）。 */
export declare function settingsNsOfPatch(txt: string): string[];
/**
 * 扫 `{DSH_HOME}/profiles/<name>/cordis.patch.yml`，列出挂载了 targetNs 的 profile 名（已排序）。
 * 只读；任何一步失败都当作"没扫到" —— 自检绝不能反过来把启动搞挂。
 */
export declare function scanNsOwners(dshHome: string, targetNs: string): string[];
/** 生成告警/提示文案（日志与设置页共用；含判据与修法，别只说"有冲突"）。 */
export declare function describeNsConflict(opts: {
    ns: string;
    owners: string[];
    myProfile?: string;
    settingsFile?: string;
    /** profile 隔离是否生效（拿得到 DSH_PROFILE = 生效）。生效时这只是**提示**，不生效才是真风险。 */
    isolated?: boolean;
}): string;
/**
 * 设置文件的路径（2026-10-11 起**按 profile 隔离**）。
 *
 *  老布局：`{DSH_HOME}/qqbot-settings/<ns>.json`            —— 所有 profile 共用一份，这是"互相覆盖"的根源
 *  新布局：`{DSH_HOME}/qqbot-settings/<profile>/<ns>.json`  —— 各 profile 各一份，**同 ns 也不打架**
 *
 * 规则（两个消费方必须一致：`src/index.ts` 读配置、`settings-host.js` 读写设置页）：
 *   · **读**：新路径优先 → 老路径兜底（老数据不丢）；
 *   · **写**：一律写新路径 —— 因为读取已兜底到老文件，首次保存天然是"老内容 + 本次改动"，等于**自动搬家**；
 *   · profile 取自 `DSH_PROFILE`；取不到时落 `_default`（此时退化回老行为，由写入者指纹兜底拦截互相覆盖）。
 */
export declare function nsPathsOf(dshHome: string, ns: string, profile?: string): {
    profileDir: string;
    file: string;
    writerFile: string;
    legacyFile: string;
    legacyWriterFile: string;
};
//# sourceMappingURL=ns-guard.d.ts.map