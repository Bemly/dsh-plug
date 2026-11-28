/** dsh-session rc.6 中可加入模型可见 surface 的事件类型。 */
const APPENDABLE_SURFACE_TYPES = new Set([
    'user/message',
    'assistant/message',
    'tool/result',
]);
/**
 * 这条会话现在允许「静默 append」吗？
 *
 * 优先读 `session.surface.nodes`（dsh-session rc.6 的 SurfaceManager）：
 * nodes 保存的是**绝对事件序号**，用 `log[seq - surface.baseSeq]` 取首节点。
 * 首节点必须是 user/message、assistant/message 或 tool/result。
 *
 * 仅当宿主没有提供 surface.nodes 时，才回落扫描 log 的第一个 surface 事件。
 * surface 为空、首节点无法解析或没有日志都 fail-closed。
 *
 * @param session - 宿主 agent 的 `session` 对象（拿不到就返回 false）
 * @returns true = surface 已建立且首节点可安全追加
 */
export function canSilentlyAppend(session) {
    try {
        if (!session || typeof session !== 'object')
            return false;
        const s = session;
        const nodes = s.surface?.nodes;
        if (Array.isArray(nodes)) {
            if (nodes.length === 0)
                return false; // 空 surface ⇒ 绝不追加
            const log = s.log;
            if (!Array.isArray(log))
                return false;
            const rawBase = s.surface?.baseSeq;
            const base = typeof rawBase === 'number' && Number.isSafeInteger(rawBase) && rawBase >= 0
                ? rawBase
                : 0;
            const headSeq = nodes[0];
            if (!Number.isSafeInteger(headSeq) || headSeq < base)
                return false;
            const head = log[headSeq - base];
            if (!head || typeof head !== 'object')
                return false;
            return APPENDABLE_SURFACE_TYPES.has(head.type);
        }
        // 兼容没有暴露 SurfaceManager 的宿主：扫描第一个 surface 事件。
        if (Array.isArray(s.log)) {
            for (const ev of s.log) {
                if (!ev || typeof ev !== 'object')
                    continue;
                if (APPENDABLE_SURFACE_TYPES.has(ev.type))
                    return true;
            }
        }
        return false;
    }
    catch {
        return false; // fail-closed
    }
}
/**
 * 取 agent 上的 session 对象（agent 形状多样，统一在这里兜）
 * @param agent - 宿主 agent（或任何带 `.session` 的对象）
 */
export function sessionOf(agent) {
    try {
        if (!agent || typeof agent !== 'object')
            return undefined;
        return agent.session;
    }
    catch {
        return undefined;
    }
}
/**
 * 「要不要跳过这次静默 append？」——带诊断日志的统一入口。
 * 各调用点写：
 * ```
 * if (skipSilentAppend(agent, logger, 'nothink')) { …走安全兜底… }
 * ```
 *
 * @param agent - 宿主 agent
 * @param logger - 插件 logger（可空）
 * @param tag - 日志前缀（如 'nothink' / '价值评分' / 'group-hub'）
 * @returns true = 应当跳过静默 append（人设未落盘 / 拿不准）
 */
/** 形状探针只打一次：确认守卫判据在当前 dsh 版本上真的拿得到数据 */
let probedOnce = false;
export function skipSilentAppend(agent, logger, tag) {
    const session = sessionOf(agent);
    if (canSilentlyAppend(session))
        return false;
    try {
        if (!probedOnce) {
            probedOnce = true;
            const s = session;
            const nodesShape = Array.isArray(s?.surface?.nodes) ? `array(${s.surface.nodes.length})` : String(typeof s?.surface?.nodes);
            const logShape = Array.isArray(s?.log) ? `array(${s.log.length})` : String(typeof s?.log);
            logger?.info?.('[surface-guard] 首次拦截静默 append（该会话人设尚未落盘）。形状探针: ' +
                `session=${typeof session} surface=${typeof s?.surface} nodes=${nodesShape} log=${logShape} baseSeq=${String(typeof s?.surface?.baseSeq)}`);
        }
        logger?.debug?.(`[${tag}] 跳过静默 append：surface 尚未建立可安全追加的首节点，硬写会报废会话日志`);
    }
    catch { /* 日志失败忽略 */ }
    return true;
}
/** 供诊断端点使用：汇报一次守卫判定结果（不写盘、不打扰） */
export function surfaceGuardState() {
    return { rule: 'silent append requires surface.nodes[0].type === "system/message"' };
}
/** 供调用方判断宿主是否提供了 ctx（预留：将来若需要按 ctx 取会话日志，可在此扩展） */
export function surfaceGuardAvailable(_ctx) {
    return typeof canSilentlyAppend === 'function';
}
//# sourceMappingURL=surface-guard.js.map