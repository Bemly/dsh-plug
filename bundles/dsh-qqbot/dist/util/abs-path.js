import { resolve } from 'node:path';
/**
 * 把配置里的工作区路径归一成**本机可用的绝对路径**。
 *
 * 起因（2026-10-24 / issue #18）：
 * 设置页「已有 dsh 会话的工作区」按钮曾在 Android 上填进
 * `storage\emulated\0\大肥鱼`（丢了前导 `/`、分隔符也反了）。
 * 这个相对路径一路传进 `agents.create()`，被宿主直接拒掉：
 *   Error: session header cwd must be an absolute path, got "storage\emulated\0\大肥鱼"
 *
 * 表现上的迷惑性：
 *   · **已有会话能正常聊** —— `getOrCreate` 走 `agents.resume()`，沿用磁盘上已有的
 *     session header，不重新校验 cwd；
 *   · **新会话全挂** —— 入站消息、`/bot-new`、`/new` 都要 `create()`，只有它校验。
 * 连带后果是数据根被相对路径带偏（在 `process.cwd()` 下又建了一套），扩展页计数归零。
 *
 * 这里做兜底：不管上游给什么，都尽量还原成绝对路径，避免再让坏值流到 create/join。
 */
export function absCwdOf(p) {
    const raw = String(p ?? '').trim();
    if (!raw)
        return '';
    // ⚠️ 已经是绝对路径 → 【原样返回，一个字符都不动】。
    //    为什么不能顺手把反斜杠归一成正斜杠：session-manager:670 用
    //    `prevCfg.cwd !== wantCwd` 做**字符串精确比较**来判断「cwd 改没改」，
    //    改形式会让 Windows 老用户升级后判定 cwd 变了，白白触发一次
    //    fork 热迁移 / 弃旧开新（历史虽然会继承，但那是多余的档案分裂）。
    //    → 只在「相对路径」这一种真正会出事的情况下动手。
    if (/^[A-Za-z]:[\\/]/.test(raw))
        return raw; // D:\a\b 或 D:/a/b
    if (raw.startsWith('\\') || raw.startsWith('//'))
        return raw; // UNC \\server\share
    if (raw.startsWith('/'))
        return raw; // POSIX 绝对路径
    // ── 以下只处理相对路径（issue #18 的坏值就长这样：storage\emulated\0\大肥鱼）──
    const s = raw.replace(/\\/g, '/');
    // POSIX（Linux / Android）：补回被 dsh 编码时丢掉的前导 '/'
    if (process.platform !== 'win32')
        return '/' + s;
    // Windows 相对路径没法可靠还原原意，退化成相对进程 cwd 解析（至少是个绝对路径）
    try {
        return resolve(s).replace(/\\/g, '/');
    }
    catch {
        return raw;
    }
}
/** 判断一个路径是不是绝对路径（Windows 盘符 / UNC / POSIX 都算） */
export function isAbsPath(p) {
    const s = String(p ?? '').trim().replace(/\\/g, '/');
    return /^[A-Za-z]:\//.test(s) || s.startsWith('//') || s.startsWith('/');
}
//# sourceMappingURL=abs-path.js.map