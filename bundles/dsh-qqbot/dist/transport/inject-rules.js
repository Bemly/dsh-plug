import { inferMediaKind } from './media-kind.js';
/** 单轮累计注入预算(字符), 防爆上下文 */
const BUDGET_CHARS = 1500;
// 2026-11-26 v2.1：原内置读图提示规则（builtin-image）已删除 —— 图片由 image-aggregate v2
// 作为 ImageBlock 直接注入，不再需要让模型自己 read_image。用户自己配的 hasImage 规则不受影响。
/** 消息是否含附件图片。
 *  ⚠️ 2026-09-10 根因修复（主人实测：自定义小提醒配了「消息里带图片」却**永不触发**）：
 *     QQ 群聊里图片附件的 `content_type` 实测是 `'file'`（不是 `image/jpeg`），
 *     原判定要求 content_type 含 'image' 或 URL 带图片扩展名 —— 两条都不成立 → hasImage=false
 *     → 规则不命中；又因"存在启用的 hasImage 规则"而不追加内置兜底 → 读图提示彻底消失。
 *     现统一走 inbound 同款 `inferMediaKind()`（单一真源），不再各写一份判定。 */
function hasImage(msg) {
    return (msg.attachments ?? []).some(a => !!a.url && inferMediaKind(a) === 'image');
}
/** 消息正文是否含 http(s) 链接 */
function hasLink(text) {
    return /https?:\/\/|www\./i.test(text);
}
/** 单条规则命中判定(正则编译失败降级 false) */
function matchRule(rule, text, msg, logger) {
    const c = rule.conditions;
    const parts = [];
    if (c.hasImage)
        parts.push(hasImage(msg));
    if (c.hasLink)
        parts.push(hasLink(text));
    if (c.contentRegex) {
        try {
            parts.push(new RegExp(c.contentRegex, 'i').test(text));
        }
        catch (err) {
            logger?.warn?.(`[inject-rules] 正则编译失败 rule=${rule.id}: ${err instanceof Error ? err.message : String(err)}`);
        }
    }
    // ★★ 2026-11-14 修（审查发现）：c.contentKeywords 是**未校验的嵌套配置读取**，
    //   而这个函数在 pplyInjectRules 里**不在 try 保护内** —— 手改/旧版配置少写一个字段，
    //   每条入站都会抛 TypeError 冒出去 ⇒ 该条消息既不进上下文也不唤醒，静默丢失。
    if (Array.isArray(c.contentKeywords) && c.contentKeywords.length > 0) {
        const tl = text.toLowerCase();
        // ★ 2026-11-14（CodeRabbit）：元素也可能**无法转成字符串**（如 { toString: null }），
        //   那样 String(k) 会抛 TypeError，而从 applyInjectRules 冒出去会把整条入站弄丢。
        parts.push(c.contentKeywords.some((k) => {
            if (!k)
                return false;
            try {
                return tl.includes(String(k).toLowerCase());
            }
            catch {
                return false;
            }
        }));
    }
    if (parts.length === 0)
        return false; // 无条件=永不触发
    return c.matchScope === 'all' ? parts.every(Boolean) : parts.some(Boolean);
}
/**
 * 对组装好的 agentBody 应用全部启用的注入规则, 返回新 body。
 * 2026-11-26 v2.1：内置读图兜底已移除，只应用用户自己配的规则。
 * imageHintAuto 参数保留但不再使用（兼容旧调用方）。
 */
export function applyInjectRules(body, msg, rules, logger, imageHintAuto = true) {
    const text = (msg.content ?? '') || '';
    const active = (rules ?? []).filter(r => r.enabled);
    let budget = BUDGET_CHARS;
    let out = body;
    for (const rule of active) {
        if (budget <= 0) {
            logger?.warn?.('[inject-rules] 预算耗尽, 停止注入');
            break;
        }
        if (!matchRule(rule, text, msg, logger))
            continue;
        const inj = `[系统提示] ${rule.prompt}`;
        out += `\n\n${inj}`;
        budget -= inj.length;
    }
    return out;
}
//# sourceMappingURL=inject-rules.js.map
