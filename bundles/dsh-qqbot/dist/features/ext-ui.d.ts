/** 允许的挂载点 */
export declare const EXT_UI_SLOTS: readonly ["settings", "dock"];
export type ExtUiSlot = (typeof EXT_UI_SLOTS)[number];
/** 允许被面板读取的文件名（写死，不接受任意路径） */
export declare const EXT_UI_FILES: readonly ["card.html", "card.css", "card.js"];
export type ExtUiFile = (typeof EXT_UI_FILES)[number];
export interface ExtUiInfo {
    /** 扩展 id（= 目录名） */
    extId: string;
    /** 目录绝对路径 */
    dir: string;
    /** 来源：profile = profile 级；data = 数据根；pack = 扩展包内 */
    from: 'profile' | 'data' | 'pack';
    /** 扩展包目录名（from=pack 时有） */
    pack?: string;
    slot: ExtUiSlot;
    title: string;
    order: number;
    /** 实际存在哪些文件 */
    files: ExtUiFile[];
}
/**
 * 列出所有扩展 UI 卡片。任何异常都安全跳过，绝不抛。
 *
 * @param dataRoot     插件数据根（每个机器人实例一份）→ 只收 slot=dock
 * @param profileRoot  DSH profile 根（全 profile 一份）→ 只收 slot=settings
 */
export declare function listExtUi(dataRoot: string, profileRoot?: string): ExtUiInfo[];
export interface ExtUiFileResult {
    ok: boolean;
    path?: string;
    text?: string;
    reason?: string;
}
/**
 * 读一个扩展 UI 文件。
 *
 * @param slotHint 可选。同一个扩展 id 可能在两个源各有一张卡（settings 在 profile、dock 在数据根），
 *                 带上 slot 才能取到对的那份文件。不传则取第一个匹配。
 */
export declare function readExtUiFile(dataRoot: string, profileRoot: string | undefined, extId: string, fileName: string, slotHint?: string): ExtUiFileResult;
//# sourceMappingURL=ext-ui.d.ts.map