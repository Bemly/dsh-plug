/**
 * 扩展配置读取（2026-10-24）
 *
 * 扩展在文件里声明 `export const qqbotSettingsPage = { title, schema: [...] }` 后，
 * 用户在「QQ机器人扩展」面板里填的值会落到
 *   {dataRoot}/.qqbot-extensions/.state/ext-config/{扩展id}.json
 *
 * 扩展代码执行时可通过 `ctx.config` 直接拿到（命令与工具都有）：
 *   handler: (ctx) => '当前文字：' + (ctx.config?.text || '默认文字')
 *
 * 本模块只负责「按扩展文件路径反查那份 json」，同步读、失败返回 {}，绝不抛。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join, basename } from 'node:path';
/** 扩展配置目录（相对 dataRoot） */
export function extConfigDir(dataRoot) {
    return join(dataRoot, '.qqbot-extensions', '.state', 'ext-config');
}
/** 扩展文件路径 → 配置文件路径（用文件名去扩展名当 id，与面板侧一致） */
export function extConfigPathOf(dataRoot, extFile) {
    const id = basename(String(extFile || '')).replace(/\.(mjs|js|cjs)$/i, '');
    if (!id)
        return '';
    const safe = id.replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5]/g, '_');
    return join(extConfigDir(dataRoot), safe + '.json');
}
/** 同步读某扩展的配置；不存在/坏了都返回 {} */
export function readExtConfig(dataRoot, extFile) {
    try {
        const p = extConfigPathOf(dataRoot, extFile);
        if (!p || !existsSync(p))
            return {};
        const j = JSON.parse(readFileSync(p, 'utf8'));
        return j && typeof j === 'object' ? j : {};
    }
    catch {
        return {};
    }
}
//# sourceMappingURL=ext-config.js.map