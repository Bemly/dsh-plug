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
export declare const RECENT_MAX = 80;
/** 保留窗口：官方撤回窗口就是 2 分钟，超过就没意义了（2026-10-20 主人定：按 2 分钟缓冲） */
export declare const RETENTION_MS = 120000;
/** 正文摘要长度（只用于搜索/回显，不存全文） */
export declare const TEXT_SNIPPET = 120;
export type MsgKind = 'text' | 'image' | 'voice' | 'file' | 'video';
export interface RecentMsg {
    msgId: string;
    senderId: string;
    senderName: string;
    at: number;
    /** 正文摘要（图片/语音等可留空或写占位符） */
    text?: string;
    /** 消息类型（默认 text） */
    kind?: MsgKind;
    /** 是否机器人自己发的（自己发的只能自己撤，成员消息需要群管理员） */
    fromSelf?: boolean;
}
export declare function peerKeyOf(scope: 'group' | 'c2c', peerId: string): string;
/** 正文摘要：去换行/压空白/截断 */
export declare function snippetOf(text: string | undefined | null): string;
/** 记一条消息（入站/出站同用；同 msgId 去重；先按 2 分钟窗口裁旧，再按容量裁尾） */
export declare function rememberInbound(scope: 'group' | 'c2c', peerId: string, rec: RecentMsg): void;
/** 记一条**机器人自己发的**消息（出站成功拿到 message_id 后调用） */
export declare function rememberSelf(scope: 'group' | 'c2c', peerId: string, rec: {
    msgId: string;
    text?: string;
    kind?: MsgKind;
    at?: number;
    senderName?: string;
}): void;
/** 取最近消息；senderId 为空 = 不限发送者（群里最近一条） */
export declare function findRecent(scope: 'group' | 'c2c', peerId: string, opts?: {
    senderId?: string;
    withinMs?: number;
}): RecentMsg | undefined;
/** 找「某人 2 分钟内最近一条」并返回下标距离（批量用） */
export declare function filterRecent(scope: 'group' | 'c2c', peerId: string, opts?: {
    keyword?: string;
    kind?: MsgKind;
    fromSelf?: boolean;
    senderId?: string;
    withinMs?: number;
    limit?: number;
}): RecentMsg[];
/** 列出该 peer 最近消息（调试/工具回显用） */
export declare function listRecent(scope: 'group' | 'c2c', peerId: string, limit?: number): RecentMsg[];
/** 清空（测试用） */
export declare function clearRecent(): void;
/** 诊断: 当前缓冲区里有哪些 peer 键、各有几条（查不到时回给 AI，方便定位键不匹配） */
export declare function debugSummary(): string;
//# sourceMappingURL=msg-recent.d.ts.map