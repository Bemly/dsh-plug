/**
 * builtin-outbound.js — 内置出站扩展（2026-11-27 主人要求「并进插件本体」）
 *
 * 原来它是 `{dataRoot}/.qqbot-extensions/outbound/anti-similar-style.mjs`，
 * 属于「安装时复制到数据目录」的那类扩展 —— 包更新不会同步那份副本，
 * 于是出现「npm 包里改了、线上还是旧文案」的问题（2026-11-26 实际踩到）。
 *
 * 现在逻辑直接住在插件里、随包发版，不再依赖数据目录的文件：
 *   · 装载器（ext-outbound.js）会把它放在扫描文件**之前**，
 *   · 若数据目录里还有同名扩展，按「内置优先」跳过，避免重复拦截。
 *
 * 规则（与文件版一致）：
 * - 按每个会话独立记录最近 5 条已发正文的开头 2 字 / 结尾 2 字（忽略引用、@、媒体标记与首尾标点）。
 * - 新回复命中 → ctx.annihilate() 拒绝发送 + ctx.appendWake() 把原因反馈给模型重写。
 * - 同一会话连续拦截最多 2 次，第 3 次放行（防死循环）。
 */

export const name = 'anti-similar-style';

const CONFIG = {
    enabled: true,
    /** 每个会话保留最近多少条历史用于比对 */
    historySize: 5,
    /** 同一会话连续拦截上限（防死循环） */
    maxConsecutiveRejects: 2,
};

/** @type {Map<string, { recent: Array<{ head2: string, tail2: string, sample: string }>, rejects: number }>} */
const sessionState = new Map();

/** 剥离控制标签、图片与首尾标点，提取用于比对的纯正文 */
function normalizeForCheck(raw) {
    let s = String(raw ?? '');
    s = s
        .replace(/\[rf:[^\]]+\]/gi, ' ')
        .replace(/<@[^>]+>/g, ' ')
        .replace(/<qqbot-at-everyone\s*\/?>/gi, ' ')
        .replace(/\[MEDIA:[^\]]+\]/gi, ' ')
        .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
        .trim();
    // 去掉首尾常见标点与空白，避免 "www~" / "www！" 绕过检查
    const edgePunct = /^[\s~～!！?？。.,，、…·\-—_'"“”‘’()（）【】\[\]]+|[\s~～!！?？。.,，、…·\-—_'"“”‘’()（）【】\[\]]+$/g;
    s = s.replace(edgePunct, '').trim();
    return s;
}

function getKey(ctx) {
    const scope = String(ctx.target?.scope ?? 'unknown');
    const peerId = String(ctx.target?.peerId ?? ctx.turnId ?? 'default');
    return `${scope}:${peerId}`;
}

export default async function onOutbound(ctx, next) {
    if (!CONFIG.enabled) return next();
    if (ctx.phase !== 'send') return next();
    if (ctx.source !== 'assistant/message') return next();

    const rawText = String(ctx.text ?? '').trim();
    if (!rawText) return next();

    const clean = normalizeForCheck(rawText);
    const chars = Array.from(clean);
    // 少于 2 个有效字符（单字、纯图片/表情）不拦截
    if (chars.length < 2) return next();

    const head2 = chars.slice(0, 2).join('').toLowerCase();
    const tail2 = chars.slice(-2).join('').toLowerCase();

    const key = getKey(ctx);
    let st = sessionState.get(key);
    if (!st) {
        st = { recent: [], rejects: 0 };
        sessionState.set(key, st);
    }

    const headHit = st.recent.find((r) => r.head2 === head2);
    const tailHit = st.recent.find((r) => r.tail2 === tail2);

    if ((headHit || tailHit) && st.rejects < CONFIG.maxConsecutiveRejects) {
        st.rejects += 1;

        const reasons = [];
        if (headHit) reasons.push(`开头两字「${head2}」与你刚才发过的「${headHit.sample}」重复`);
        if (tailHit) reasons.push(`结尾两字「${tail2}」与你刚才发过的「${tailHit.sample}」重复`);
        const reasonText = reasons.join('；');

        try {
            ctx.logger?.info?.(
                `[anti-similar-style] 拦截相似回复(${key}, 第${st.rejects}次): "${rawText.slice(0, 40)}" | ${reasonText}`
            );
        } catch { /* ignore */ }

        const killed = ctx.annihilate(`风格重复: ${reasonText}`);
        if (killed && typeof ctx.appendWake === 'function') {
            // 2026-11-26 主人要求：只留标题 + 一行原因
            const wakeMsg = [
                `[系统风格检查 · 已拒绝发送]`,
                `原因：${reasonText}，请换一种不同的表达方式重新回复，不要每句话重复相同口癖。`,
            ].join('\n');
            try {
                await ctx.appendWake(wakeMsg);
            } catch (err) {
                ctx.logger?.warn?.(
                    `[anti-similar-style] appendWake 失败: ${err instanceof Error ? err.message : String(err)}`
                );
            }
        }
        return;
    }

    // 放行：记录历史并清零连续拦截计数
    st.rejects = 0;
    st.recent.push({ head2, tail2, sample: clean.slice(0, 24) });
    if (st.recent.length > CONFIG.historySize) st.recent.shift();

    return next();
}

/** 供装载器使用：内置扩展清单 */
export const BUILTIN_OUTBOUND = [{ name, file: '(builtin) anti-similar-style', middleware: onOutbound }];
