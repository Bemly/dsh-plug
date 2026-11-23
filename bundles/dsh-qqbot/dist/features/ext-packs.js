/**
 * 扩展包（extension packs）—— 让插件作者的扩展与内置扩展目录解耦
 *
 * 背景（2026-10-24 主人定）：
 *   `{dataRoot}/.qqbot-extensions/` 是用户自己的目录，往里塞第三方扩展会混在一起、
 *   也没法整包分发/更新。于是新增一层「扩展包」：
 *
 *     {dataRoot}/extension-packs/{包名}/{tools,commands,botplay,hooks,inbound,outbound}/
 *
 *   包名目录自己取，里面按和内置目录一模一样的结构放扩展；可选清单
 *   `qqbot-pack.json` 声明 name/author/desc/version。
 *
 * 本模块只负责「算出要扫哪些目录」，具体加载仍由各扩展点的原扫描器负责。
 */
import { readdirSync, statSync, existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, extname, dirname } from 'node:path';
/** 扩展包根目录名（与 .qqbot-extensions 同级） */
export const EXT_PACKS_SUBDIR = 'extension-packs';
/** 扩展包清单文件名（首个命中的生效） */
const PACK_MANIFEST_NAMES = ['qqbot-pack.json', 'pack.json'];
/** 六个扩展点对应的子目录名 */
export const EXT_KINDS = ['tools', 'commands', 'botplay', 'hooks', 'inbound', 'outbound'];
/**
 * 列出所有扩展包。目录不存在 / 坏清单都安全跳过，绝不抛。
 *
 * @param dataRoot 插件数据根（= 原来 `.qqbot-extensions` 所在的那一级）
 */
export function listExtPacks(dataRoot) {
    const root = join(dataRoot, EXT_PACKS_SUBDIR);
    let names = [];
    try {
        if (!existsSync(root))
            return [];
        names = readdirSync(root);
    }
    catch {
        return [];
    }
    const out = [];
    for (const dirName of names) {
        const dir = join(root, dirName);
        try {
            if (!statSync(dir).isDirectory())
                continue;
        }
        catch {
            continue;
        }
        let meta = {};
        for (const mf of PACK_MANIFEST_NAMES) {
            const p = join(dir, mf);
            if (!existsSync(p))
                continue;
            try {
                const j = JSON.parse(readFileSync(p, 'utf8'));
                const authorRaw = j.author;
                meta = {
                    name: (j.name || j.displayName || ''),
                    author: typeof authorRaw === 'string'
                        ? authorRaw
                        : authorRaw?.name || '',
                    desc: (j.description || j.desc || ''),
                    version: (j.version || ''),
                    homepage: (j.homepage || j.repository || ''),
                };
                break;
            }
            catch {
                /* 清单坏了：当没有清单 */
            }
        }
        out.push({
            dirName,
            dir,
            name: String(meta.name || dirName),
            author: String(meta.author || ''),
            desc: String(meta.desc || ''),
            version: String(meta.version || ''),
            homepage: String(meta.homepage || ''),
        });
    }
    out.sort((a, b) => a.dirName.localeCompare(b.dirName));
    return out;
}
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
export function extDirsFor(dataRoot, kind) {
    const dirs = [];
    const builtin = join(dataRoot, '.qqbot-extensions', kind);
    try {
        if (existsSync(builtin) && statSync(builtin).isDirectory())
            dirs.push(builtin);
    }
    catch {
        /* ignore */
    }
    for (const pack of listExtPacks(dataRoot)) {
        const d = join(pack.dir, kind);
        try {
            if (existsSync(d) && statSync(d).isDirectory())
                dirs.push(d);
        }
        catch {
            /* ignore */
        }
    }
    return dirs;
}
/** 反向：给一个扩展文件绝对路径，判断它属于哪个包（内置返回 null） */
export function packOfExtFile(dataRoot, filePath) {
    const norm = (p) => p.replace(/\\/g, '/').toLowerCase();
    const f = norm(filePath);
    for (const pack of listExtPacks(dataRoot)) {
        if (f.startsWith(norm(pack.dir) + '/'))
            return pack;
    }
    return null;
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
export function scanExtFiles(dataRoot, kind, allowed) {
    const out = [];
    // ★ 2026-10-24：跳过被停用的扩展
    const disabled = readDisabledKeys(dataRoot);
    for (const dir of extDirsFor(dataRoot, kind)) {
        let entries = [];
        try {
            entries = readdirSync(dir, { withFileTypes: true });
        }
        catch {
            continue;
        }
        const names = entries
            .filter((e) => e.isFile() && allowed.has(extname(e.name).toLowerCase()))
            .map((e) => e.name)
            .sort();
        for (const name of names) {
            const abs = join(dir, name);
            if (isExtDisabled(dataRoot, abs, disabled))
                continue;
            out.push({ dir, name, abs });
        }
    }
    return out;
}
/** 扩展启停状态的落盘文件名（相对 dataRoot） */
export const EXT_DISABLED_FILE = join('.qqbot-extensions', '.state', 'ext-disabled.json');
/** 某扩展的稳定 key：kind/文件名（跨内置与扩展包同名也能区分的话，用相对 dataRoot 的路径） */
function disabledKeyOf(dataRoot, abs) {
    const rel = abs.replace(/\\/g, '/').replace(String(dataRoot).replace(/\\/g, '/') + '/', '');
    return rel;
}
/**
 * 读「已停用」的扩展 key 集合。
 * 形如 {"tools/xxx.mjs", "extension-packs/demo-author/commands/yyy.mjs"}
 */
export function readDisabledKeys(dataRoot) {
    const out = new Set();
    try {
        const p = join(dataRoot, EXT_DISABLED_FILE);
        if (!existsSync(p))
            return out;
        const arr = JSON.parse(readFileSync(p, 'utf8'));
        if (Array.isArray(arr))
            for (const it of arr)
                if (typeof it === 'string')
                    out.add(it);
    }
    catch {
        /* 文件坏了就当没有 */
    }
    return out;
}
/** 写「已停用」集合（整体覆盖） */
export function writeDisabledKeys(dataRoot, keys) {
    const p = join(dataRoot, EXT_DISABLED_FILE);
    try {
        mkdirSync(dirname(p), { recursive: true });
        writeFileSync(p, JSON.stringify([...new Set(keys)].sort(), null, 2), 'utf8');
    }
    catch {
        /* 写不了就算了，不影响加载 */
    }
}
/** 判断某个扩展文件是否被停用 */
export function isExtDisabled(dataRoot, abs, disabled) {
    const set = disabled || readDisabledKeys(dataRoot);
    return set.has(disabledKeyOf(dataRoot, abs));
}
/** 导出 key 计算（供 host 侧开关用） */
export function extDisabledKey(dataRoot, abs) {
    return disabledKeyOf(dataRoot, abs);
}
//# sourceMappingURL=ext-packs.js.map