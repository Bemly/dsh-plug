/**
 * magpie-image-slim v0.1.5（2026-11-26 重写）
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
 * ★★★ 2026-11-26 实测 + 读 agy-cli 源码确认（关键，勿改）：
 * agy-bridge 用 `sameHistoryUpToImages()` 判定历史是否等价：
 *   ① 消息条数必须相同
 *   ② **每条消息的 image 槽位数必须相同**（`imageSlots()`：真图算 1，标准占位符算 1）
 *   ③ 然后把所有 image 槽位**整个抹掉**（`withoutImages()`）再比剩余内容
 *
 * 由此得出两条硬约束：
 *   1) 占位符**必须**是 `[X.XX MB image left out here: …]`（或 magpie 网关那三条固定文案），
 *      否则 `isImageSlot()` 认不出，槽位数从 1 掉到 0 → 判为历史变更 → session_new 重建 →
 *      整段全量重算（实测 cache_read = 0）。绝不能写成 `[image]`。
 *   2) 占位符的**正文内容完全不参与比较**（第 ③ 步会整块删掉），所以不要把路径/描述塞进来 ——
 *      那是纯浪费 token。图片的本地路径由 DSH 宿主的 `Image "…" (sha256:…) … Normalized copy: "/path"`
 *      句柄文本提供，那段每轮都在，模型据此 read_image 即可。
 *
 * 也不要试图直接删掉图片块来"省事"：槽位数会 1→0，同样触发重建。
 */
const SLOT_RE = /^\[\d+(?:\.\d+)? MB image left out here: [\s\S]*\]$/;
/** 占位符固定前缀（⚠️ 冒号后的那个空格是正则的一部分，不能省） */
const SLOT_PREFIX = 'MB image left out here:';
/**
 * 占位符正文：一个全角右括号 `）`。
 *
 * 正文不参与 agy-bridge 的历史比较（`withoutImages()` 会把整个占位符删掉），
 * 只要整体匹配 `^\[\d+(\.\d+)? MB image left out here: [\s\S]*\]$` 即可。
 * 用全角右括号既让肉眼看出"这里有东西被拿走了"，又把长度压到最短
 * （完整占位符约 32 字符；写 "already seen earlier in this conversation" 要 72）。
 * 模型看图靠同一消息里 DSH 的 Normalized copy 路径，不靠这句。
 */
const SLOT_BODY = '）';
/** DSH 宿主为每张图生成的句柄文本（含 sha256 与 Normalized copy 本地路径） */
const DSH_HANDLE_RE = /^Image "[^"]*"\s*\(sha256:[0-9a-f]{8,}\)[\s\S]*Normalized copy \(read-only/;
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
        const content = [];
        for (const block of item.content) {
            if (aggregate && (!protectCurrentTurn || index < turnStart) && options.replaceImages && isInlineImage(block)) {
                // 1 块换 1 块，且**必须**是标准 image-slim 格式：
                // agy-bridge 靠它把「图片」和「占位符」认成同一槽位，才不会重建会话。
                // 正文不写路径（不参与比较，路径见同消息里 DSH 的 Normalized copy 句柄文本）。
                content.push({ type: 'input_text', text: slotText(imageBytes(block)) });
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
        console.log(`image-slim v0.1.5: [${ctx.agent || 'unknown'}] replaced ${replaced} image(s), split ${split} text block(s)`);
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

/**
 * 生成标准 image-slim 占位符。
 * 格式由 SLOT_RE / agy-bridge 的 IMAGE_SLIM_RE 共同约束，不可改成 [image]。
 * 正文固定最短：它会被 agy-bridge 的 withoutImages() 整块删除，写什么都一样。
 */
function slotText(bytes) {
    const mb = (Math.max(0, Number(bytes) || 0) / 1048576).toFixed(2);
    return `[${mb} ${SLOT_PREFIX} ${SLOT_BODY}]`;
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

};
