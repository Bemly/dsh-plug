const IMAGE_SLIM_RE = /\[\d+(?:\.\d+)? MB image left out here: [^\]\r\n]*\]/g;
const TEXT_TYPES = new Set(['input_text', 'output_text', 'text']);

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
                content.push({ type: 'input_text', text: imageSlimPlaceholder(imageBytes(block)) });
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
        console.log(`image-slim: [${ctx.agent || 'unknown'}] replaced ${replaced} image(s), split ${split} text block(s)`);
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
        splitPlaceholders: value.splitPlaceholders !== false,
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

function isAggregateMessage(content) {
    const text = textOf(content);
    return text.includes('[图片聚合]') || text.includes('Image "aggregate.jpg"') ||
        (/（↑ [^\n]* 发的图）/u.test(text) && content.some(isInlineImage));
}

function isInlineImage(block) {
    return block?.type === 'input_image' && typeof block.image_url === 'string' && block.image_url.startsWith('data:');
}

function imageBytes(block) {
    const comma = block.image_url.indexOf(',');
    return comma < 0 ? 0 : Math.max(0, block.image_url.length - comma - 1);
}

function imageSlimPlaceholder(bytes) {
    const mb = (bytes / 1048576).toFixed(2);
    return `[${mb} MB image left out here: an image the user attached, already seen earlier in this conversation. Rely on what you already said about it.]`;
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
    imageSlimPlaceholder,
    splitImageSlimText,
};
