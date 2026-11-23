/** 台账里存的一条：被引用消息的文本 + 图片本地路径 */
export interface MsgContent {
    /** 文本（截断） */
    t?: string;
    /** 图片**本地路径**（入站时由 image-path-cache 解析得到；AI 能直接读） */
    imgs?: string[];
    /** QQ message_id（2026-10-20 撤回功能用；引用补全不需要） */
    m?: string;
    /** 发送者 openid（机器人自己发时 'self'） */
    s?: string;
    /** 昵称 */
    n?: string;
    /** 消息类型 text/image/voice/video/file */
    k?: string;
    /** 是否机器人自己发的 */
    me?: boolean;
}
interface Row {
    /** peer 键：`group:<openid>` / `c2c:<openid>` */
    p: string;
    /** 索引键：引用补全用 REFIDX；撤回台账用 `m:<message_id>`（见 msg-history.ts） */
    i: string;
    t?: string;
    imgs?: string[];
    /** QQ message_id（撤回用） */
    m?: string;
    /** 发送者 openid */
    s?: string;
    /** 昵称 */
    n?: string;
    /** 消息类型 */
    k?: string;
    /** 是否机器人自己发的 */
    me?: boolean;
    at: number;
}
/**
 * 记一条：这条消息（msgIdx）的文本与图片本地路径。
 * 之后有人**引用它**时，就能靠 `refKey = msgIdx` 回查到"被引用的到底是哪张图"。
 */
export declare function rememberMsgContent(dataRoot: string, peerKey: string, msgIdx: string, rec: MsgContent): void;
/** 回查：这条被引用消息（msgIdx）我们记过什么 */
export declare function lookupMsgContent(dataRoot: string, peerKey: string, msgIdx: string): MsgContent | undefined;
export interface MsgScanQuery {
    /** 只看多少毫秒内（默认 2 小时） */
    withinMs?: number;
    /** 最多几条（默认 20，上限 200） */
    limit?: number;
    /** 关键词（子串，忽略大小写；匹配正文 t） */
    keyword?: string;
    /** 类型筛选 */
    kind?: string;
    /** true=只机器人自己发的；false=只别人发的；不填=都算 */
    fromSelf?: boolean;
    /** 只看某个发送者 */
    senderId?: string;
}
/**
 * 扫该 peer 的台账（2026-10-20 撤回功能/消息搜索用）。
 * ★ 严格按 peerKey 过滤 —— 群与群、群与私聊绝不串。
 * 返回新→旧（同一毫秒内按写入顺序倒序）。
 */
export declare function scanMsgContent(dataRoot: string, peerKey: string, q?: MsgScanQuery): Row[];
export {};
//# sourceMappingURL=msg-content-cache.d.ts.map