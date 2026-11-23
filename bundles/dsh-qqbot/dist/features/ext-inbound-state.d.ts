/** 状态子目录名（挂在入站扩展目录下） */
export declare const EXT_INBOUND_STATE_SUBDIR = ".state";
/** 状态目录：`{dataRoot}/.qqbot-extensions/inbound/.state` */
export declare function inboundStateDir(dataRoot: string): string;
/** 单个扩展的状态文件：`{dataRoot}/.qqbot-extensions/inbound/.state/<扩展文件名>.json` */
export declare function extStatePath(dataRoot: string, file: string): string;
/** 审计账本（所有扩展共用一本）：`{dataRoot}/.qqbot-extensions/inbound/.state/audit.jsonl` */
export declare function auditPath(dataRoot: string): string;
/** 一条禁言名单项 */
export interface ExtMute {
    /** 被禁言的 openid */
    id: string;
    /** 到期时间戳(ms)；**0 = 永久**（`minutes <= 0` 时写 0） */
    until: number;
    /** 为什么禁（写进审计，也方便主人回看） */
    reason?: string;
    /** 谁下的手：缺省 = 执行它的扩展名；也可以自己传（如触发人的昵称/命令） */
    by?: string;
    /** 写名单的时刻（展示用） */
    at?: number;
}
/** 状态文件形状（`mutes` 与 `kv` 同住一个文件，免得两个文件两套坏法） */
export interface ExtStateFile {
    mutes: ExtMute[];
    kv: Record<string, unknown>;
}
/** 名单项的展示形态：多带一个剩余时间 */
export interface ExtMuteView extends ExtMute {
    /** 是否永久（`until === 0`） */
    permanent: boolean;
    /** 剩余毫秒；永久时为 null */
    remainingMs: number | null;
    /** 剩余分钟（向上取整）；永久时为 null */
    remainingMinutes: number | null;
}
/**
 * 读状态文件。**永不抛出**：
 *   · 目录/文件不存在 → 空状态；
 *   · JSON 坏了 / 形状不对 → 空状态（别让一个坏文件把插件搞崩）；
 *   · 读的时候**惰性清理**过期名单项，并把清理结果写回（写不回去也不影响本次返回值）。
 */
export declare function readExtState(dataRoot: string, file: string): ExtStateFile;
/** 写状态文件；返回是否写成功（**永不抛出**） */
export declare function writeExtState(dataRoot: string, file: string, st: ExtStateFile): boolean;
/** 名单项 → 展示形态（带剩余时间） */
export declare function muteView(m: ExtMute, now?: number): ExtMuteView;
/**
 * 写一条禁言。`minutes <= 0`（含缺省之外的负数/0）= **永久**。
 * 同一 id 重复禁言 → 覆盖（改期限/原因），不堆重复项。
 * 返回写入的名单项（读回时已做过期清理）；失败返回 false。
 */
export declare function muteUser(dataRoot: string, file: string, input: {
    id: string;
    minutes?: number;
    reason?: string;
    by?: string;
}): ExtMute | false;
/** 解除禁言；返回是否真的解掉了一条 */
export declare function unmuteUser(dataRoot: string, file: string, id: string): boolean;
/** 查一条是否被禁言；命中返回展示形态（带剩余时间），否则 null */
export declare function isMuted(dataRoot: string, file: string, id: string): ExtMuteView | null;
/** 读整份名单（已做过期清理，带剩余时间），按到期时间升序（永久排最后） */
export declare function mutedUsers(dataRoot: string, file: string): ExtMuteView[];
/**
 * 审计账本的单行上限：512KB。
 * 超了就 `audit.jsonl` → `audit.jsonl.1`（旧的 `.1` 被覆盖，只留一代）。
 * 为什么不按行数：行里带着截断后的文本摘要，字节数才是真正会撑爆磁盘的东西。
 */
export declare const AUDIT_MAX_BYTES: number;
/** 摘要字段截断长度（**别把整条消息塞进审计**） */
export declare const AUDIT_TEXT_CHARS = 120;
export declare const AUDIT_REASON_CHARS = 200;
export declare const AUDIT_TARGET_CHARS = 64;
/** 一条审计记录 */
export interface ExtAuditEntry {
    /** 扩展文件名（谁干的） */
    file?: string;
    /** 扩展展示名 */
    name?: string;
    /** 动作：annihilate / rewrite / forceWake / decide / muteUser / unmuteUser（+ 被拒时同名字段） */
    action: string;
    /** 目标（被禁言的 openid 等） */
    target?: string;
    /** 原因（用户传的 reason） */
    reason?: string;
    /** 文本摘要（**截断**） */
    text?: string;
    /** ok | ok-owner-ack（主人消息经 ownerAck 显式放行被消灭）| refused-owner | refused-breaker | refused-invalid ... */
    result?: string;
}
/**
 * 追加一行审计。**永不抛出**、失败静默返回 false。
 * 轮转：写之前先看大小，超过 {@link AUDIT_MAX_BYTES} 就改名成 `.1`。
 */
export declare function appendAudit(dataRoot: string, entry: ExtAuditEntry): boolean;
/** 读审计（诊断 / 测试用）：返回每行的**原始字符串**（含换行前的 JSON） */
export declare function readAudit(dataRoot: string, limit?: number): string[];
/** 参与窗口（最近多少条"该扩展参与的消息"） */
export declare const BREAKER_WINDOW = 50;
/** 最小样本：参与不足这么多条不判比例（否则头两条全是消灭就熔断了，误伤太狠） */
export declare const BREAKER_MIN_SAMPLE = 10;
/** 比例阈值：破坏性动作占比 > 该值 ⇒ 熔断 */
export declare const BREAKER_RATIO = 0.5;
/** 突发窗口（ms）与窗口内允许的最大破坏性动作数 */
export declare const BURST_WINDOW_MS = 10000;
export declare const BURST_MAX = 20;
/** 当前熔断原因（没熔断返回 undefined） */
export declare function breakerTrippedReason(file: string): string | undefined;
/** 熔断：幂等（已熔断时保留最早那次的原因与时刻） */
export declare function tripBreaker(file: string, reason: string): string;
/**
 * 执行破坏性动作**之前**问一句：现在允许吗？
 *   · 已熔断 → 拒绝；
 *   · 突发窗口里已经打满 {@link BURST_MAX} 次 → **当场熔断**并拒绝（第 21 次就被拦下）。
 * 任何异常都当"允许"（宁可放行，也不能因为统计代码坏了把扩展全废掉）。
 */
export declare function checkDestructiveAllowed(file: string): {
    ok: true;
} | {
    ok: false;
    reason: string;
};
/** 记一次破坏性动作（突发窗口用） */
export declare function noteDestructive(file: string): void;
/**
 * 记一次"该扩展参与了这条消息"（含这条做了什么）。
 * 比例超阈值时熔断，返回熔断原因（调用方负责 logger.warn 出来，好让人一眼看出是哪个扩展、为什么）。
 */
export declare function noteParticipation(file: string, destructive: boolean): string | undefined;
/**
 * 把"最近一次参与记录"升级成破坏性（早+晚两个挂点共用一份参与记录时用）。
 * 例：`onInbound` 什么都没干（记 false），`onDecide` 里禁言了某人 —— 那次参与应当算破坏性。
 */
export declare function upgradeLastParticipation(file: string): void;
/** 诊断：某扩展的熔断状态快照 */
export declare function breakerStatus(file: string): {
    tripped?: {
        at: number;
        reason: string;
    };
    participated: number;
    destructive: number;
};
/**
 * 复位熔断（**只**清熔断记录，不碰名单与 kv）。
 * 调用点：每次装载该扩展文件时（= 热重载/重启即复位，这是文档写明的恢复通道）。
 */
export declare function resetBreaker(file: string): void;
/** 重置全部熔断状态（仅供单元测试） */
export declare function __resetBreakersForTest(): void;
/** 状态目录自检（诊断用；返回是否存在） */
export declare function inboundStateDirExists(dataRoot: string): boolean;
//# sourceMappingURL=ext-inbound-state.d.ts.map