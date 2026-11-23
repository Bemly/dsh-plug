/**
 * 出站事件解析 — 将 dsh session/event 归一化为强类型
 *
 * 原始事件（ctx.on('session/event') 回调参数）是弱类型：
 *   { type: string, data: Record<string, unknown> }
 * 这里把可识别的事件解析为 discriminated union，未知类型或字段缺失返回 undefined。
 */
/**
 * 解析原始事件为强类型
 *
 * 未知类型或缺失关键字段时返回 undefined，由调用方直接跳过。
 */
export function parseEvent(raw) {
    switch (raw.type) {
        case 'assistant/chunk': {
            const chunk = raw.data.chunk;
            if (chunk === undefined || chunk.type !== 'text-delta' || !chunk.text)
                return undefined;
            return { type: 'assistant/chunk', text: chunk.text };
        }
        case 'assistant/message': {
            const data = raw.data;
            const message = data.message;
            if (message === undefined || !Array.isArray(message.content))
                return undefined;
            // 思考(2026-09-13): content 里的 reasoning 块; 空壳块(只有 thinkingSignature)无 text → 判空跳过。
            const reasoning = message.content
                .filter((b) => b?.type === 'reasoning' && typeof b.text === 'string' && b.text.trim() !== '')
                .map((b) => b.text)
                .join('\n');
            return {
                type: 'assistant/message',
                content: message.content,
                reasoning: reasoning === '' ? undefined : reasoning,
                turn: typeof data.turn === 'number' ? data.turn : undefined,
                step: typeof data.step === 'number' ? data.step : undefined,
                reasoningTokens: typeof data.usage?.reasoningTokens === 'number' ? data.usage.reasoningTokens : undefined,
            };
        }
        case 'tool/call': {
            const data = raw.data;
            if (!data.callId || !data.name)
                return undefined;
            return { type: 'tool/call', callId: data.callId, name: data.name, arguments: data.arguments ?? '' };
        }
        case 'tool/result': {
            const data = raw.data;
            const callId = data.message?.source?.callId;
            if (!callId)
                return undefined;
            return { type: 'tool/result', callId, error: data.error, raw: raw.data };
        }
        case 'turn/end': {
            const reason = raw.data.reason ?? {};
            return { type: 'turn/end', reason };
        }
        case 'deliverables/presented': {
            const data = raw.data;
            if (typeof data.turn !== 'number' || typeof data.callId !== 'string' || !data.callId)
                return undefined;
            if (!Array.isArray(data.files) || data.files.length === 0)
                return undefined;
            const files = [];
            for (const file of data.files) {
                if (file === null || typeof file !== 'object' || Array.isArray(file))
                    return undefined;
                const { path, description } = file;
                if (typeof path !== 'string' || !path)
                    return undefined;
                if (description !== undefined && typeof description !== 'string')
                    return undefined;
                files.push(description === undefined ? { path } : { path, description });
            }
            return { type: 'deliverables/presented', turn: data.turn, callId: data.callId, files };
        }
        default:
            return undefined;
    }
}
/**
 * 从 turn/end reason 提取错误信息
 *
 * 兼容三种形态：error（新格式）、failure（旧格式）、顶层 message/code（最旧格式）。
 */
export function extractTurnError(reason) {
    if (reason.kind !== 'error')
        return undefined;
    const detail = reason.error ?? reason.failure;
    return {
        code: detail?.code ?? reason.code ?? 'UNKNOWN',
        message: detail?.message ?? reason.message ?? 'unknown error',
    };
}
/**
 * 解析宿主 `agent/assistant-stream` 的 payload（{ agent: { id }, frame }）。
 * 只认 start / chunk(text-delta)，其余帧（reasoning/tool-call/finish/end）一律忽略。
 */
export function parseStreamFrame(raw) {
    if (typeof raw !== 'object' || raw === null)
        return undefined;
    const o = raw;
    const agentId = typeof o.agent?.id === 'string' ? o.agent.id : '';
    if (!agentId)
        return undefined;
    const f = o.frame;
    if (!f || typeof f !== 'object')
        return undefined;
    const attemptId = typeof f.attemptId === 'string' ? f.attemptId : '';
    if (!attemptId)
        return undefined;
    if (f.type === 'start')
        return { agentId, delta: { kind: 'attempt-start', attemptId } };
    if (f.type === 'chunk') {
        const ch = f.chunk;
        if (ch && ch.type === 'text-delta' && typeof ch.text === 'string' && ch.text !== '') {
            return { agentId, delta: { kind: 'text-delta', attemptId, text: ch.text } };
        }
        if (ch && ch.type === 'reasoning-delta' && typeof ch.text === 'string' && ch.text !== '') {
            return { agentId, delta: { kind: 'reasoning-delta', attemptId, text: ch.text } };
        }
    }
    return undefined;
}
//# sourceMappingURL=events.js.map