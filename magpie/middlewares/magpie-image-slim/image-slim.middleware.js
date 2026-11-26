/**
 * magpie-image-slim v0.1.4（2026-11-26 重写）
 *
 * 职责：出站时把**历史轮次**的 ImageBlock 换成极短占位符，避免每轮重算视觉 token。
 *
 * v0.1.2 相对 v0.1.1 的变化：
 *   1. 识别两种格式：通用 image-slim 槽位 `[X.XX MB image left out here: …]`，
 *      以及 DSH 宿主自带的图片句柄文本（`Image "…" (sha256:…) … Normalized copy (read-only…): "/path"`）。
 *      dsh-botqq v2.2 起不再注入任何打标文本，路径完全由宿主生成。
 *   2. 历史图片块 → **1 块换 1 块**的 `[image]`，块数恒定 ⇒ 缓存前缀稳定。
 *      带打标的占位符文本原样保留，模型仍知道图内容。
 *   3. `splitPlaceholders` 默认**关闭**：v1 拆块改变 block_count，触发 agy-bridge
 *      判定 history 不一致 → session_new → 缓存清零（实测 63 次）。
 *   4. 保留 `keepCurrentTurn`（默认开）：本回合新图不瘦。
 */
/**
 * 标准 image-slim 占位符正则 —— **必须严格保持这个格式**。
 *
 * ★★★ 2026-11-26 实测结论（关键，勿改）：
 * agy-cli 的 bridge 用 `isImagePlaceholder()` 判定「图片槽位」，该判定只认
 *   ① 本正则 `^\[\d+(\.\d+)? MB image left out here: [\s\S]*\]$`
 *   ② magpie 网关自带的三条固定文案（MAGPIE_IMAGE_PLACEHOLDERS）
 * 图片块与占位符被视为**同一个槽位**，`withoutImages()` 会把两者一并抹掉再比对历史，
 * 于是"图→占位符"这种变化被判为 masked，**不触发 session_new 重建**，缓存继续命中。
 *
 * 若换成 `[image]` 这类自造短标记：bridge 认不出，会多出一个 text 块 →
 * 判为 history_mismatch → session_new 重建 → 整段全量重算（实测 cache_read = 0）。
 * 所以占位符一律用本格式；路径等信息写在冒号后面即可。
 */
const SLOT_RE = /^\[\d+(?:\.\d+)? MB image left out here: [\s\S]*\]$/;
/** 未瘦身状态下，自己写出的占位符（要幂等识别，不能二次处理） */
const SLOT_PREFIX = 'MB image left out here:';
/** DSH 宿主为每张图生成的句柄文本（含 sha256 与 Normalized copy 本地路径） */
const DSH_HANDLE_RE = /^Image "[^"]*"\s*\(sha256:[0-9a-f]{8,}\)[\s\S]*Normalized copy \(read-only/;
/** 从句柄文本里取 Normalized copy 的本地路径 */
const HANDLE_PATH_RE = /Normalized copy \(read-only[^)]*\):\s*"([^"]+)"/;
/** 旧格式识别（仅用于 opt-in 的拆块功能） */
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
        // 该消息里 DSH 句柄给出的本地路径（按出现顺序），用于写进占位符
        const handlePaths = collectHandlePaths(item.content);
        let imageOrdinal = 0;
        const content = [];
        for (const block of item.content) {
            if (aggregate && (!protectCurrentTurn || index < turnStart) && options.replaceImages && isInlineImage(block)) {
                // 1 块换 1 块，且**必须**是标准 image-slim 格式：
                // agy-bridge 靠它把「图片」和「占位符」认成同一槽位，才不会重建会话。
                const path = handlePaths[imageOrdinal] || '';
                imageOrdinal++;
                content.push({ type: 'input_text', text: slotText(imageBytes(block), path) });
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
        console.log(`image-slim v0.1.4: [${ctx.agent || 'unknown'}] replaced ${replaced} image(s), split ${split} text block(s)`);
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

/**
 * 两种格式都认（2026-11-26 v0.1.3）：
 *  ① 通用 image-slim 槽位 `[X.XX MB image left out here: …]`（本中间件产出，幂等）
 *  ② DSH 宿主句柄 `Image "xxx" (sha256:…); … Normalized copy (read-only…): "/path"…`
 *     —— dsh-botqq v2.2 起不再自带文本，路径完全由宿主生成为独立 text 块，
 *        我们只把同消息里的图片数据换掉，路径文本原样保留供模型 read_image。
 */
function isAggregateMessage(content) {
    for (const block of content) {
        if (!TEXT_TYPES.has(block?.type) || typeof block.text !== 'string')
            continue;
        const t = block.text.trim();
        if (SLOT_RE.test(t) || DSH_HANDLE_RE.test(t))
            return true;
    }
    return false;
}

function isInlineImage(block) {
    return block?.type === 'input_image' && typeof block.image_url === 'string' && block.image_url.startsWith('data:');
}

/** data URL 的近似字节数（base64 长度 * 3/4） */
function imageBytes(block) {
    const comma = block.image_url.indexOf(',');
    if (comma < 0) return 0;
    const b64 = block.image_url.length - comma - 1;
    return Math.max(0, Math.floor(b64 * 0.75));
}

/** 收集该消息里 DSH 句柄暴露的本地路径（按块顺序） */
function collectHandlePaths(content) {
    const out = [];
    for (const block of content) {
        if (!TEXT_TYPES.has(block?.type) || typeof block.text !== 'string') continue;
        if (!DSH_HANDLE_RE.test(block.text.trim())) continue;
        const m = HANDLE_PATH_RE.exec(block.text);
        out.push(m ? m[1] : '');
    }
    return out;
}

/**
 * 生成标准 image-slim 占位符，路径写在冒号后。
 * 格式由 SLOT_RE / agy-bridge 的 IMAGE_SLIM_RE 共同约束，不可改成 [image]。
 */
function slotText(bytes, path) {
    const mb = (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(2);
    const tail = path || 'already seen earlier in this conversation; rely on what you already said about it';
    return `[${mb} ${SLOT_PREFIX} ${tail}]`;
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
    DSH_HANDLE_RE,
    slotText,
    collectHandlePaths,
};
