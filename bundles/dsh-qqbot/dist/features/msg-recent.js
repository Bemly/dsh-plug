/**
 * msg-recent.ts — 入站/出站消息的「最近 msgId」环形缓冲（2026-10-20 主人需求: 撤回成员消息）
 *
 * 背景：官方 `DELETE /v2/groups/{gid}/messages/{message_id}` 允许**群管理员撤回普通成员的消息**
 * （2 分钟内），但需要那条消息的 message_id。插件拿到 message_id 的地方只有：
 *   · 入站事件（bootstrap 的 `bot.on('message')` 里 `msg.messageId`）
 *   · 出站发送的返回值（机器人自己发的）
 * 而现有台账都不记全量 msgId：
 *   · `msg-index/[peer]/refs.json` 只记「被引用/被回复」的消息（不是全量）
 *   · `self-said/[peer].json` 只记机器人自己发的（且是给引用用的短号映射）
 *   · `chat-raw.jsonl` 是给 AI 的正文，没有 id
 *
 * 所以这里**不新增落盘台账**：只做一个**进程内内存**环形缓冲（每 peer 最近 RECENT_MAX 条，
 * 且只保留最近 2 分钟——正好是官方撤回窗口），结构：
 *   `peerKey → [{ msgId, senderId, senderName, at, text, kind, fromSelf }]`
 * 重启即清空。用途：
 *   · `group_recall`    —— 撤某人最近一条 / 群里最近一条 / 指定 msgId
 *   · `group_msg_search` —— 按关键词/类型搜出命中消息（含机器人自己发的）
 *   · `group_recall_batch` —— 批量撤回 + 可选批量禁言发送者
 */
export const RECENT_MAX = 80;
/** 保留窗口：官方撤回窗口就是 2 分钟，超过就没意义了（2026-10-20 主人定：按 2 分钟缓冲） */
export const RETENTION_MS = 120_000;
/** 正文摘要长度（只用于搜索/回显，不存全文） */
export const TEXT_SNIPPET = 120;
/** peerKey(`group:<gid>` / `c2c:<openid>`) → 最近消息（新→旧） */
const store = new Map();
export function peerKeyOf(scope, peerId) {
    return `${scope}:${peerId}`;
}
/** 正文摘要：去换行/压空白/截断 */
export function snippetOf(text) {
    const s = String(text ?? '').replace(/\s+/gu, ' ').trim();
    return s.length > TEXT_SNIPPET ? `${s.slice(0, TEXT_SNIPPET)}…` : s;
}
/**
 * 取消息列表：优先精确键；**若该键没有数据，就合并所有同 scope 的键**。
 * 原因(2026-10-20 实测): 入站事件里的 groupOpenid 与出站 target 的群 openid 不一定同源，
 * 按单一 key 查会查不到；这里做兜底，避免"明明有消息却搜不到"。
 */
function collect(scope, peerId) {
    // ★ 严格按会话隔离（2026-10-20 主人要求）: 绝不合并其它群的键
    return (store.get(peerKeyOf(scope, peerId)) ?? []).slice().sort((a, b) => b.at - a.at);
}
function prune(key, now) {
    const arr = (store.get(key) ?? []).filter((x) => now - x.at <= RETENTION_MS);
    store.set(key, arr);
    return arr;
}
/** 记一条消息（入站/出站同用；同 msgId 去重；先按 2 分钟窗口裁旧，再按容量裁尾） */
export function rememberInbound(scope, peerId, rec) {
    if (!peerId || !rec?.msgId)
        return;
    const key = peerKeyOf(scope, peerId);
    const now = Date.now();
    const arr = prune(key, now);
    if (arr.some((x) => x.msgId === rec.msgId))
        return;
    arr.unshift({
        ...rec,
        text: snippetOf(rec.text),
        kind: rec.kind ?? 'text',
        fromSelf: rec.fromSelf === true,
    });
    if (arr.length > RECENT_MAX)
        arr.length = RECENT_MAX;
    store.set(key, arr);
}
/** 记一条**机器人自己发的**消息（出站成功拿到 message_id 后调用） */
export function rememberSelf(scope, peerId, rec) {
    rememberInbound(scope, peerId, {
        msgId: rec.msgId,
        senderId: 'self',
        senderName: rec.senderName ?? '机器人',
        at: rec.at ?? Date.now(),
        text: rec.text,
        kind: rec.kind,
        fromSelf: true,
    });
}
/** 取最近消息；senderId 为空 = 不限发送者（群里最近一条） */
export function findRecent(scope, peerId, opts = {}) {
    const arr = collect(scope, peerId);
    if (arr.length === 0)
        return undefined;
    const now = Date.now();
    const maxAge = opts.withinMs ?? RETENTION_MS;
    return arr.find((x) => (!opts.senderId || x.senderId === opts.senderId) && now - x.at <= maxAge);
}
/** 找「某人 2 分钟内最近一条」并返回下标距离（批量用） */
export function filterRecent(scope, peerId, opts = {}) {
    const arr = collect(scope, peerId);
    const now = Date.now();
    const maxAge = opts.withinMs ?? RETENTION_MS;
    const kw = String(opts.keyword ?? '').trim().toLowerCase();
    const out = arr.filter((x) => {
        if (now - x.at > maxAge)
            return false;
        if (opts.fromSelf !== undefined && Boolean(x.fromSelf) !== opts.fromSelf)
            return false;
        if (opts.senderId && x.senderId !== opts.senderId)
            return false;
        if (opts.kind && (x.kind ?? 'text') !== opts.kind)
            return false;
        if (kw && !String(x.text ?? '').toLowerCase().includes(kw))
            return false;
        return true;
    });
    const limit = Math.max(1, Math.min(RECENT_MAX, opts.limit ?? 20));
    return out.slice(0, limit);
}
/** 列出该 peer 最近消息（调试/工具回显用） */
export function listRecent(scope, peerId, limit = 10) {
    return (store.get(peerKeyOf(scope, peerId)) ?? []).slice(0, Math.max(1, limit));
}
/** 清空（测试用） */
export function clearRecent() {
    store.clear();
}
/** 诊断: 当前缓冲区里有哪些 peer 键、各有几条（查不到时回给 AI，方便定位键不匹配） */
export function debugSummary() {
    const now = Date.now();
    const rows = [];
    for (const [k, v] of store) {
        const alive = v.filter((x) => now - x.at <= RETENTION_MS);
        if (alive.length > 0)
            rows.push(k.slice(0, 26) + '…(' + alive.length + '条)');
    }
    return rows.length ? rows.join(' | ') : '(空)';
}
//# sourceMappingURL=msg-recent.js.map