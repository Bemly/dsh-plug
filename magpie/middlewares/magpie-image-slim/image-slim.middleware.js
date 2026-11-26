/**
 * magpie-image-slim v0.1.2（2026-11-26 重写）
 *
 * 职责：出站时把**历史轮次**的 ImageBlock 换成极短占位符，避免每轮重算视觉 token。
 *
 * v0.1.2 相对 v0.1.1 的变化：
 *   1. 识别**只用通用 image-slim 占位符正则** `[X.XX MB image left out here: …]`，
 *      不再认 v1 的 `[图片聚合]` / `Image "aggregate.jpg"` / `（↑…发的图）` 标记。
 *      dsh-botqq v2.1 把打标内容写进这个通用占位符，任何插件写的都认。
 *   2. 历史图片块 → **1 块换 1 块**的 `[image]`，块数恒定 ⇒ 缓存前缀稳定。
 *      带打标的占位符文本原样保留，模型仍知道图内容。
 *   3. `splitPlaceholders` 默认**关闭**：v1 拆块改变 block_count，触发 agy-bridge
 *      判定 history 不一致 → session_new → 缓存清零（实测 63 次）。
 *   4. 保留 `keepCurrentTurn`（默认开）：本回合新图不瘦。
 */
/** 通用占位符正则：dsh-botqq 写入的打标文本就是这种格式，不绑定任何插件/渠道 */
const SLOT_RE = /^\[\d+(?:\.\d+)? MB image left out here: [^\]\r\n]*\]$/;
/** 旧格式识别（仅用于 opt-in 的拆块功能，不再用于判定消息是否聚合） */
const IMAGE_SLIM_RE = /\[\d+(?:\.\d+)? MB image left out here: [^\]\r\n]*\]/g;
const TEXT_TYPES = new Set(['input_text', 'output_text', 'text']);
const PLACEHOLDER = '[image]';

export function onRequest(body, ctx) {
    const options = readOptions(ctx?.options);
    if (!matchesScope(ctx, options)) return;
    if (ctx?.protocol !== 'responses' || !Array.isArray(body?.input)) return;

    let changed = false;
    let replaced = 0;
    let split = 0;
    const protectCurrentTurn = options.keepCurrentTurn;
    const turnStart = protectCurrentTurn ? currentTurnStart(body.input) : -1;

    for (let index = 0; index < body.input.length; index++) {
        const item = body.input[index];
        if (item?.role !== 'user' || !Array.isArray(item.content)) continue;
        const aggregate = isAggregateMessage(item.content);
        const content = [];
        for (const block of item.content) {
            if (aggregate && (!protectCurrentTurn || index < turnStart) && options.replaceImages && isInlineImage(block)) {
                // 1 块换 1 块：块数不变，缓存稳定；打标文本在相邻 text 块里原样保留。
                content.push({ type: 'input_text', text: PLACEHOLDER });
                replaced++;
                changed = true;
                continue;
            }
            if (options.splitPlaceholders && TEXT_TYPES.has(block?.type) && typeof block.text === 'string') {
                const pieces = splitImageSlimText(block);
                if (pieces.length > 1) {
                    content.push(...pieces);
                    split++;
                    changed = true;
                    continue;
                }
            }
            content.push(block);
        }
        item.content = content;
    }

    if (changed && options.log) {
        console.log(`image-slim v0.1.2: [${ctx.agent || 'unknown'}] replaced ${replaced} image(s), split ${split} text block(s)`);
    }
    return changed ? body : undefined;
}

function matchesScope(ctx, options) {
    if (options.agents.length && !options.agents.includes(ctx?.agent)) return false;
    if (options.models.length && !options.models.includes(ctx?.model)) return false;
    return true;
}

function readOptions(raw) {
    const value = raw && typeof raw === 'object' ? raw : {};
    return {
        agents: Array.isArray(value.agents) ? value.agents.filter((x) => typeof x === 'string' && x) : ['dsh'],
        models: Array.isArray(value.models) ? value.models.filter((x) => typeof x === 'string' && x) : [],
        keepCurrentTurn: value.keepCurrentTurn !== false,
        replaceImages: value.replaceImages !== false,
        // 2026-11-26：默认关闭拆块，避免 block_count 变化打断缓存
        splitPlaceholders: value.splitPlaceholders === true,
        log: value.log !== false,
    };
}

function currentTurnStart(input) {
    for (let index = input.length - 1; index >= 0; index--) {
        const item = input[index];
        if (item?.role === 'assistant' || item?.type === 'reasoning' ||
            item?.type === 'function_call' || item?.type === 'custom_tool_call') return index + 1;
    }
    return 0;
}

function textOf(content) {
    return content.map((block) => TEXT_TYPES.has(block?.type) ? String(block.text || '') : '').join('\n');
}

/** 只认通用 image-slim 占位符；不再兼容 v1 的任何标记。 */
function isAggregateMessage(content) {
    for (const block of content) {
        if (TEXT_TYPES.has(block?.type) && typeof block.text === 'string' && SLOT_RE.test(block.text.trim()))
            return true;
    }
    return false;
}

function isInlineImage(block) {
    return block?.type === 'input_image' && typeof block.image_url === 'string' && block.image_url.startsWith('data:');
}

function splitImageSlimText(block) {
    const text = block.text;
    IMAGE_SLIM_RE.lastIndex = 0;
    const matches = [...text.matchAll(IMAGE_SLIM_RE)];
    if (!matches.length) return [block];
    const pieces = [];
    let cursor = 0;
    for (const match of matches) {
        if (match.index > cursor) pieces.push({ ...block, text: text.slice(cursor, match.index) });
        pieces.push({ ...block, text: match[0] });
        cursor = match.index + match[0].length;
    }
    if (cursor < text.length) pieces.push({ ...block, text: text.slice(cursor) });
    return pieces;
}

export const _internal = {
    readOptions,
    currentTurnStart,
    isAggregateMessage,
    splitImageSlimText,
    SLOT_RE,
    PLACEHOLDER,
};
