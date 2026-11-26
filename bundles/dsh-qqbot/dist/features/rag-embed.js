let resolveService = () => undefined;
const embedders = new Set();

export function setRagServiceResolver(resolver) {
    resolveService = typeof resolver === 'function' ? resolver : () => undefined;
    for (const embedder of embedders) embedder.reset();
}

function currentService() {
    try {
        return resolveService();
    }
    catch {
        return undefined;
    }
}

export function createSemanticEmbedder(opts = {}) {
    const cached = embedders.values().next().value;
    if (cached) return cached;
    const logger = opts.logger;
    const embedder = {
        model: 'conan-embedding-v1',
        available() {
            return opts.enabled !== false && typeof currentService()?.embedText === 'function';
        },
        status() {
            if (opts.enabled === false) return { available: false, mode: 'off', reason: '智能回复已关闭' };
            const service = currentService();
            if (!service) return { available: false, mode: 'unavailable', reason: 'conanRag 服务未加载' };
            return { available: true, ...service.status?.() };
        },
        async embedQuery(text) {
            if (opts.enabled === false) return undefined;
            const service = currentService();
            if (!service) return undefined;
            try {
                return await service.embedText(text) ?? undefined;
            }
            catch (e) {
                logger?.warn(`[智能回复] OVMS 嵌入失败(本次跳过): ${e instanceof Error ? e.message : String(e)}`);
                return undefined;
            }
        },
        async embedPassages(texts) {
            if (opts.enabled === false || !Array.isArray(texts) || texts.length === 0) return undefined;
            const service = currentService();
            if (!service) return undefined;
            try {
                return await service.embedBatch(texts) ?? undefined;
            }
            catch (e) {
                logger?.warn(`[智能回复] OVMS 批量嵌入失败(本次跳过): ${e instanceof Error ? e.message : String(e)}`);
                return undefined;
            }
        },
        async scoreValue(args) {
            if (opts.enabled === false) return undefined;
            const service = currentService();
            if (!service?.scoreValue) return undefined;
            try {
                return await service.scoreValue(args) ?? undefined;
            }
            catch (e) {
                logger?.warn(`[智能回复] RAG 价值评分失败(本次跳过): ${e instanceof Error ? e.message : String(e)}`);
                return undefined;
            }
        },
        warmup() { },
        reset() { },
    };
    embedders.add(embedder);
    return embedder;
}
