/**
 * rag-embed —— 智能回复(价值评分 / 语义检索 / 相关度)的向量来源。
 *
 * 两条来路, 按顺序尝试:
 *   ① `conanRag` 服务(由 dsh-chat-loli 的 rag-memory 提供) —— 同作用域可见时优先用;
 *   ② 直接打 OVMS `/v3/embeddings` HTTP —— 服务取不到时的主路。
 *
 * ★ 2026-11-26: 原来只有①。`conanRag` 是在**预设子作用域**里 provide 的, 根作用域的
 *   `ctx.get('conanRag')` 恒为空 ⇒ 面板报「conanRag 服务未加载」, 语义评分全线失效。
 *   任何一条路失败都只是**本次跳过语义判定**(fail-open), 不抛错、不拦消息。
 */
const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765/v3/embeddings';
const DEFAULT_MODEL = 'conan-embedding-v1';
const DEFAULT_TIMEOUT_MS = 15000;
/** 近邻数(实测 k=5 及加权版在独立测试集上 10/10) */
const K = 5;
/** 相似度加权指数: 把近邻的相似度差距拉开(实测区分度更好) */
const WEIGHT_POW = 8;

let resolveService = () => undefined;
let target = { endpoint: DEFAULT_ENDPOINT, model: DEFAULT_MODEL, timeoutMs: DEFAULT_TIMEOUT_MS };
/** 样例向量缓存: `${sampleKey}|${数量}|${endpoint}|${model}` → 向量组(改样例/换端点自动失效) */
const sampleVecCache = new Map();
/** 最近一次 OVMS 直连失败(面板状态用真实探测结果, 别只说"已配置端点"就报 ✅) */
let lastFailure = { at: 0, message: '' };
const FAILURE_MEMORY_MS = 60000;

function noteFailure(err) {
    lastFailure = { at: Date.now(), message: err instanceof Error ? err.message : String(err) };
}

function recentFailure() {
    return lastFailure.at > 0 && Date.now() - lastFailure.at < FAILURE_MEMORY_MS;
}

function resetAll() {
    sampleVecCache.clear();
    lastFailure = { at: 0, message: '' };
}

export function setRagServiceResolver(resolver) {
    resolveService = typeof resolver === 'function' ? resolver : () => undefined;
    resetAll();
}

/**
 * 配置 OVMS 直连目标(取 `localModel` 子配置)。
 * 留空 = 用内置默认端点/模型; 端点或模型变了会清空样例向量缓存。
 */
export function setRagOvmsTarget(localModel) {
    const next = {
        endpoint: String(localModel?.ovmsEndpoint ?? '').trim() || DEFAULT_ENDPOINT,
        model: String(localModel?.ovmsModel ?? '').trim() || DEFAULT_MODEL,
        timeoutMs: Number(localModel?.ovmsTimeoutMs) > 0 ? Number(localModel.ovmsTimeoutMs) : DEFAULT_TIMEOUT_MS,
    };
    if (next.endpoint === target.endpoint && next.model === target.model && next.timeoutMs === target.timeoutMs)
        return target;
    target = next;
    resetAll();
    return target;
}

export function getRagOvmsTarget() {
    return { ...target };
}

function currentService() {
    try {
        return resolveService();
    }
    catch {
        return undefined;
    }
}

/** 打 OVMS 批量嵌入, 返回与输入等长的向量数组; 任何异常向上抛(调用方 fail-open) */
async function ovmsEmbed(texts) {
    if (!Array.isArray(texts) || texts.length === 0)
        return undefined;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), target.timeoutMs);
    try {
        const res = await fetch(target.endpoint, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ model: target.model, input: texts }),
            signal: ctrl.signal,
        });
        if (!res?.ok)
            throw new Error(`OVMS embedding HTTP ${res?.status ?? '?'}`);
        const json = await res.json();
        const rows = Array.isArray(json?.data)
            ? [...json.data].sort((a, b) => (Number(a?.index) || 0) - (Number(b?.index) || 0))
            : [];
        const vectors = texts.map((_, index) => rows[index]?.embedding);
        if (vectors.some((vec) => !Array.isArray(vec) || vec.length === 0))
            throw new Error('OVMS embedding response missing one or more vectors');
        lastFailure = { at: 0, message: '' };
        return vectors;
    }
    catch (err) {
        noteFailure(err);
        throw err;
    }
    finally {
        clearTimeout(timer);
    }
}

function cosine(a, b) {
    let dot = 0;
    let na = 0;
    let nb = 0;
    for (let i = 0; i < a.length; i++) {
        const x = a[i] ?? 0;
        const y = b[i] ?? 0;
        dot += x * y;
        na += x * x;
        nb += y * y;
    }
    const den = Math.sqrt(na) * Math.sqrt(nb);
    return den > 0 ? dot / den : 0;
}

/** 加权近邻投票(与 1.13.x 本地小模型同一套算法, 只是向量来源换成 OVMS) */
export function scoreValueKnn(queryVec, samples, sampleVecs, { minScore = 0.5, k = K, weightPow = WEIGHT_POW } = {}) {
    if (!Array.isArray(queryVec) || !Array.isArray(samples) || !Array.isArray(sampleVecs) || samples.length !== sampleVecs.length)
        return undefined;
    const scored = samples
        .map((sample, index) => ({
            m: sample?.m ?? '',
            y: sample?.y,
            s: cosine(queryVec, sampleVecs[index] ?? []),
        }))
        .sort((a, b) => b.s - a.s);
    const top = scored.slice(0, Math.max(1, Math.floor(k)));
    let w1 = 0;
    let w0 = 0;
    for (const neighbor of top) {
        const weight = Math.max(0, neighbor.s) ** weightPow;
        if (neighbor.y === 1)
            w1 += weight;
        else
            w0 += weight;
    }
    const total = w1 + w0;
    const score = total > 0 ? w1 / total : 0;
    const confidence = top[0]?.s ?? 0;
    return { score, worth: score >= minScore, confidence, lowConfidence: confidence < 0.5, top: top.slice(0, 3) };
}

async function sampleVectorsFor(samples, sampleKey) {
    const key = `${sampleKey || ''}|${samples.length}|${target.endpoint}|${target.model}`;
    const hit = sampleVecCache.get(key);
    if (hit)
        return hit;
    const vecs = await ovmsEmbed(samples.map((sample) => String(sample?.m ?? '')));
    if (!vecs)
        return undefined;
    sampleVecCache.set(key, vecs);
    if (sampleVecCache.size > 32)
        sampleVecCache.delete(sampleVecCache.keys().next().value);
    return vecs;
}

export function createSemanticEmbedder(opts = {}) {
    // 不缓存实例：共享状态(样例向量缓存/目标端点)本来就是模块级的，
    // 缓存反而会让第一个调用方的 logger、enabled 被后来者静默沿用。
    const off = opts.enabled === false;
    const logger = opts.logger;
    const warn = (what, e) => logger?.warn?.(`[智能回复] OVMS ${what}失败(本次跳过): ${e instanceof Error ? e.message : String(e)}`);
    const embedder = {
        get model() {
            return currentService()?.model || target.model;
        },
        available() {
            if (off)
                return false;
            const service = currentService();
            if (typeof service?.embedText === 'function')
                return true;
            return !!target.endpoint;
        },
        status() {
            if (off)
                return { available: false, mode: 'off', reason: '智能回复已关闭' };
            const service = currentService();
            if (service?.embedText)
                return { available: true, mode: 'service', model: service.model || target.model, ...service.status?.() };
            return {
                available: !!target.endpoint && !recentFailure(),
                mode: target.endpoint ? 'ovms-direct' : 'unavailable',
                model: target.model,
                endpoint: target.endpoint,
                reason: recentFailure()
                    ? `OVMS 最近一次请求失败: ${lastFailure.message}`
                    : (target.endpoint ? 'OVMS 故障时跳过语义评分' : '未配置 OVMS 端点'),
            };
        },
        async embedQuery(text) {
            if (off)
                return undefined;
            const service = currentService();
            try {
                if (typeof service?.embedText === 'function')
                    return (await service.embedText(text)) ?? undefined;
                const vectors = await ovmsEmbed([text]);
                return vectors?.[0];
            }
            catch (e) {
                warn('嵌入', e);
                return undefined;
            }
        },
        async embedPassages(texts) {
            if (off || !Array.isArray(texts) || texts.length === 0)
                return undefined;
            const service = currentService();
            try {
                if (typeof service?.embedBatch === 'function')
                    return (await service.embedBatch(texts)) ?? undefined;
                return await ovmsEmbed(texts);
            }
            catch (e) {
                warn('批量嵌入', e);
                return undefined;
            }
        },
        async scoreValue(args = {}) {
            if (off)
                return undefined;
            const service = currentService();
            if (typeof service?.scoreValue === 'function') {
                try {
                    return (await service.scoreValue(args)) ?? undefined;
                }
                catch (e) {
                    warn('RAG 价值评分', e);
                    return undefined;
                }
            }
            const text = String(args.text ?? '').trim();
            const samples = Array.isArray(args.samples) ? args.samples : [];
            if (!text || samples.length === 0)
                return undefined;
            try {
                const vecs = await sampleVectorsFor(samples, args.sampleKey ?? '');
                if (!vecs)
                    return undefined;
                const queryVec = (await ovmsEmbed([text]))?.[0];
                if (!queryVec)
                    return undefined;
                return scoreValueKnn(queryVec, samples, vecs, {
                    minScore: typeof args.minScore === 'number' ? args.minScore : 0.5,
                    k: args.k,
                    weightPow: args.weightPow,
                });
            }
            catch (e) {
                warn('价值评分', e);
                return undefined;
            }
        },
        warmup() { },
        reset() { },
    };
    return embedder;
}
