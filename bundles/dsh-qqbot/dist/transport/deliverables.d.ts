import type { ImQQBotConfig } from '../config.js';
import type { SessionRecord } from '../session/index.js';
import type { Logger, ReplyTarget } from '../types.js';
import type { QQBotSender } from './outbound-buffer.js';
import type { PresentedFileRef } from './events.js';
/** 交付物投递器（outbound 路由只依赖此接口，便于测试注入） */
export interface DeliverablesDelivererLike {
    deliver(record: SessionRecord, files: PresentedFileRef[]): Promise<void>;
}
export declare class DeliverablesDeliverer implements DeliverablesDelivererLike {
    private readonly sender;
    private readonly config;
    private readonly logger;
    /** 逐文件取目标（适配主动：避免过期的 msg_id 让文件发不出去） */
    private readonly resolveTarget?;
    constructor(sender: QQBotSender, config: ImQQBotConfig, logger: Logger, 
    /** 逐文件取目标（适配主动：避免过期的 msg_id 让文件发不出去） */
    resolveTarget?: ((record: SessionRecord) => ReplyTarget) | undefined);
    /** 轮末投递一批声明文件：逐个发送，未送达的聚合为一条文字提示 */
    deliver(record: SessionRecord, files: PresentedFileRef[]): Promise<void>;
}
//# sourceMappingURL=deliverables.d.ts.map