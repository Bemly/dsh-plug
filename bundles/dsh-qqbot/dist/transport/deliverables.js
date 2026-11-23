/**
 * 交付物投递 — present 声明的文件在轮末发送到当前 QQ 会话
 *
 * 宿主契约（2026-10-27 对齐上游 tencent-connect/dsh-qqbot c28cc4b）：
 *   `deliverables/presented` 事件**先于 turn/end 到达**；文件按引用交付（不复制内容），
 *   读取发生在投递时刻；外层轮次失败不撤销已完成的声明。
 *   每个文件独立投递，失败降级为文字提示，不阻断其余文件。
 *
 * 为什么需要它：模型调 `present(文件)` 只是"登记交付物"，宿主发事件；插件不订阅就
 *   只能靠模型自己在正文里写 `[MEDIA:file|路径]` 才发得出去。
 *
 * 复用现有链路（不另造）：路径解析用 rich-media 的 `resolveSource`（认 file:// / 相对 cwd），
 * 实际发送走注入的 sender.sendMedia —— 与 `send_media` 工具、`[MEDIA:]` 标记同一条嗓子
 * （表情包闸门、已发送台账 pushSent、失败降级都在那一层）。
 */
import { basename } from 'node:path';
import { chunkMarkdownText } from './chunker.js';
import { resolveSource } from './rich-media.js';
export class DeliverablesDeliverer {
    sender;
    config;
    logger;
    resolveTarget;
    constructor(sender, config, logger, 
    /** 逐文件取目标（适配主动：避免过期的 msg_id 让文件发不出去） */
    resolveTarget) {
        this.sender = sender;
        this.config = config;
        this.logger = logger;
        this.resolveTarget = resolveTarget;
    }
    /** 轮末投递一批声明文件：逐个发送，未送达的聚合为一条文字提示 */
    async deliver(record, files) {
        const limit = Math.max(1, this.config.sendFile?.maxFiles ?? 4);
        const cwd = this.config.cwd || process.cwd();
        const missed = [];
        let sent = 0;
        for (const [index, file] of files.entries()) {
            // 宿主给的是绝对路径；兼容 file:// 与历史相对路径（交给 resolveSource 统一解析）
            const src = resolveSource(file.path, cwd);
            const absPath = src.kind === 'localPath' ? src.path : src.url;
            const display = basename(absPath);
            if (index >= limit) {
                missed.push(`${display}（超出单轮投递上限 ${limit} 个，未发送）`);
                continue;
            }
            const target = this.resolveTarget ? this.resolveTarget(record) : record.replyTarget;
            try {
                const out = await this.sender.sendMedia(target, 'file', src.kind === 'url' ? { url: src.url } : { localPath: src.path });
                const id = out?.id;
                sent += 1;
                this.logger.info(`im-qqbot: 交付物已发送 ${display}${id ? ` (id=${id})` : ''} → ${target.scope}:${target.targetId}`);
            }
            catch (err) {
                const msg = err instanceof Error ? err.message : String(err);
                this.logger.warn(`im-qqbot: 交付物发送失败 ${display}: ${msg}`);
                missed.push(`${display}（${msg.slice(0, 80)}）`);
            }
        }
        if (missed.length > 0) {
            const text = ['📎 已生成文件（未能直接发送）：', ...missed.map((name) => `- ${name}`)].join('\n');
            for (const chunk of chunkMarkdownText(text, this.config.textChunkLimit)) {
                try {
                    const target = this.resolveTarget ? this.resolveTarget(record) : record.replyTarget;
                    await this.sender.sendMarkdown(target, chunk);
                }
                catch (err) {
                    this.logger.error(`im-qqbot: deliverables notice failed: ${err instanceof Error ? err.message : String(err)}`);
                }
            }
        }
        this.logger.debug(`im-qqbot: deliverables delivered sent=${sent} missed=${missed.length}`);
    }
}
//# sourceMappingURL=deliverables.js.map