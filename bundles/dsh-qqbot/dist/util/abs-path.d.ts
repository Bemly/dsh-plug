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
export declare function absCwdOf(p: unknown): string;
/** 判断一个路径是不是绝对路径（Windows 盘符 / UNC / POSIX 都算） */
export declare function isAbsPath(p: unknown): boolean;
//# sourceMappingURL=abs-path.d.ts.map