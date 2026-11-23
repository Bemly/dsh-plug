/** 扩展包根目录名（与 .qqbot-extensions 同级） */
export declare const EXT_PACKS_SUBDIR = "extension-packs";
/** 六个扩展点对应的子目录名 */
export declare const EXT_KINDS: readonly ["tools", "commands", "botplay", "hooks", "inbound", "outbound"];
export type ExtKind = (typeof EXT_KINDS)[number];
export interface ExtPackInfo {
    /** 目录名（包的唯一标识） */
    dirName: string;
    /** 包根绝对路径 */
    dir: string;
    /** 清单里声明的名字（缺省 = dirName） */
    name: string;
    author: string;
    desc: string;
    version: string;
    homepage: string;
}
/**
 * 列出所有扩展包。目录不存在 / 坏清单都安全跳过，绝不抛。
 *
 * @param dataRoot 插件数据根（= 原来 `.qqbot-extensions` 所在的那一级）
 */
export declare function listExtPacks(dataRoot: string): ExtPackInfo[];
/**
 * 算出某个扩展点要扫的全部目录（内置优先，其后各扩展包）。
 *
 * 调用方按顺序扫描即可：内置先注册，扩展包的排在后面 —— 这样内置扩展若与包内同名，
 * 内置的先生效（不静默覆盖用户自己写的）。
 *
 * @param dataRoot 插件数据根
 * @param kind     扩展点类型，如 'tools'
 * @returns 目录列表（只含**实际存在**的目录）
 */
export declare function extDirsFor(dataRoot: string, kind: ExtKind): string[];
/** 反向：给一个扩展文件绝对路径，判断它属于哪个包（内置返回 null） */
export declare function packOfExtFile(dataRoot: string, filePath: string): ExtPackInfo | null;
/** 扫到的一个扩展文件 */
export interface ExtFileHit {
    /** 所在目录（绝对路径） */
    dir: string;
    /** 文件名（不含路径） */
    name: string;
    /** 完整绝对路径 */
    abs: string;
}
/**
 * 跨内置目录 + 所有扩展包，扫出某个扩展点的全部**直接子文件**。
 *
 * 口径与既有扫描器完全一致：只取直接子文件（子目录不扫）、按文件名排序、
 * 内置目录整体排在扩展包前面。
 *
 * @param dataRoot  插件数据根
 * @param kind      扩展点类型
 * @param allowed   允许的扩展名集合（小写，含点），如 new Set(['.mjs', '.js'])
 */
export declare function scanExtFiles(dataRoot: string, kind: ExtKind, allowed: Set<string>): ExtFileHit[];
/** 扩展启停状态的落盘文件名（相对 dataRoot） */
export declare const EXT_DISABLED_FILE: string;
/**
 * 读「已停用」的扩展 key 集合。
 * 形如 {"tools/xxx.mjs", "extension-packs/demo-author/commands/yyy.mjs"}
 */
export declare function readDisabledKeys(dataRoot: string): Set<string>;
/** 写「已停用」集合（整体覆盖） */
export declare function writeDisabledKeys(dataRoot: string, keys: string[]): void;
/** 判断某个扩展文件是否被停用 */
export declare function isExtDisabled(dataRoot: string, abs: string, disabled?: Set<string>): boolean;
/** 导出 key 计算（供 host 侧开关用） */
export declare function extDisabledKey(dataRoot: string, abs: string): string;
//# sourceMappingURL=ext-packs.d.ts.map