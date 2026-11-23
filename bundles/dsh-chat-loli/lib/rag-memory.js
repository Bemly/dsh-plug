/**
 * conan-rag-memory —— 基于本机 OpenVINO-OVMS + TencentBAC/Conan-embedding-v1 的 RAG 长期记忆插件。
 *
 * - 通过 OpenAI 兼容 `/v3/embeddings` 接口调用本机 OVMS（Intel 核显 GPU 加速）；
 * - 零外部数据库依赖：记忆正文与向量落盘到 `<DSH_HOME>/<storeFile>`；
 * - 注册三个工具：`rag_memory_add`、`rag_memory_search`、`rag_memory_delete`；
 * - 注册提示变量 `{{conan_rag_memory}}`，兼容 `complete: true` 人设。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'conan-rag-memory';
export const inject = ['systemPrompt', 'tools'];

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765/v3/embeddings';
export const DEFAULT_MODEL = 'conan-embedding-v1';
export const DEFAULT_STORE_FILE = 'conan-rag-loli.json';
export const DEFAULT_VARIABLE = 'conan_rag_memory';

function resolveDshHome() {
  if (process.env.DSH_HOME && process.env.DSH_HOME.trim()) {
    return process.env.DSH_HOME.trim();
  }
  return join(homedir(), '.dsh');
}

function resolveStorePath(storeFile) {
  if (storeFile.startsWith('/') || /^[A-Za-z]:[\\/]/.test(storeFile)) {
    return storeFile;
  }
  return join(resolveDshHome(), storeFile);
}

function loadStore(storePath, model) {
  if (!existsSync(storePath)) {
    return { version: 1, model, nextSeq: 1, items: [] };
  }
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      return {
        version: raw.version || 1,
        model: raw.model || model,
        nextSeq: typeof raw.nextSeq === 'number' ? raw.nextSeq : raw.items.length + 1,
        items: raw.items,
      };
    }
  } catch {
    // 损坏时回退为空库，避免阻塞会话
  }
  return { version: 1, model, nextSeq: 1, items: [] };
}

function saveStore(storePath, store) {
  const dir = dirname(storePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(storePath, JSON.stringify(store), 'utf8');
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) {
    return -1;
  }
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    const x = a[i];
    const y = b[i];
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }
  if (normA === 0 || normB === 0) return -1;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function keywordScore(query, text) {
  const q = query.toLowerCase().trim();
  const t = text.toLowerCase();
  if (!q) return 0;
  if (t.includes(q)) return 0.9;
  const tokens = q.split(/[\s,，。！？、;；]+/).filter((w) => w.length >= 2);
  if (tokens.length === 0) return 0;
  let hits = 0;
  for (const tok of tokens) {
    if (t.includes(tok)) hits++;
  }
  return (hits / tokens.length) * 0.7;
}

async function embedText(endpoint, model, text, timeoutMs = 15000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, input: text }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      throw new Error(`OVMS embedding HTTP ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = await res.json();
    const vec = json?.data?.[0]?.embedding;
    if (!Array.isArray(vec) || vec.length === 0) {
      throw new Error('OVMS embedding response missing data[0].embedding');
    }
    return vec;
  } finally {
    clearTimeout(timer);
  }
}

function formatSummary(store, { maxPinned = 10, maxRecent = 10, maxChars = 4000 } = {}) {
  if (!store.items.length) {
    return '（RAG 记忆库暂无记录；需要记住重要事实请调 rag_memory_add，回忆旧事请调 rag_memory_search）';
  }
  const pinned = store.items.filter((x) => x.pinned).slice(-maxPinned);
  const pinnedIds = new Set(pinned.map((x) => x.id));
  const recent = store.items.filter((x) => !pinnedIds.has(x.id)).slice(-maxRecent);

  const lines = [`RAG 记忆库共 ${store.items.length} 条（检索请用 rag_memory_search，新增请用 rag_memory_add）`];
  if (pinned.length) {
    lines.push('【固定记忆】');
    for (const it of pinned) {
      const tagStr = it.tags?.length ? ` [${it.tags.join(',')}]` : '';
      lines.push(`- ${it.id}${tagStr}: ${it.text}`);
    }
  }
  if (recent.length) {
    lines.push('【最近记忆】');
    for (const it of recent) {
      const tagStr = it.tags?.length ? ` [${it.tags.join(',')}]` : '';
      lines.push(`- ${it.id}${tagStr}: ${it.text}`);
    }
  }
  const out = lines.join('\n');
  return out.length > maxChars ? `${out.slice(0, maxChars)}\n…(已截断，请用 rag_memory_search 按语义检索)` : out;
}

export function apply(ctx, config = {}) {
  const endpoint =
    typeof config.endpoint === 'string' && config.endpoint.trim()
      ? config.endpoint.trim()
      : DEFAULT_ENDPOINT;
  const model =
    typeof config.model === 'string' && config.model.trim() ? config.model.trim() : DEFAULT_MODEL;
  const storeFile =
    typeof config.storeFile === 'string' && config.storeFile.trim()
      ? config.storeFile.trim()
      : DEFAULT_STORE_FILE;
  const variableName =
    typeof config.variableName === 'string' && config.variableName.trim()
      ? config.variableName.trim()
      : DEFAULT_VARIABLE;
  const defaultTopK = typeof config.topK === 'number' && config.topK > 0 ? config.topK : 6;
  const maxPinned = typeof config.maxPinned === 'number' ? config.maxPinned : 10;
  const maxRecent = typeof config.maxRecent === 'number' ? config.maxRecent : 10;
  const maxChars = typeof config.maxChars === 'number' ? config.maxChars : 4000;

  const storePath = resolveStorePath(storeFile);

  // 1. 注册系统提示变量（兼容 complete: true 人设）
  ctx.effect(() => {
    if (typeof ctx.systemPrompt?.variable === 'function') {
      return ctx.systemPrompt.variable(variableName, () => {
        const store = loadStore(storePath, model);
        return formatSummary(store, { maxPinned, maxRecent, maxChars });
      });
    }
    return undefined;
  }, `conan-rag-memory.var(${variableName})`);

  // 2. 注册 rag_memory_add
  ctx.effect(() => {
    return ctx.tools.register({
      name: 'rag_memory_add',
      description:
        '把重要事实、群友偏好、约定或事件写入 Conan RAG 长期记忆库（自动用本机 OpenVINO Conan-embedding-v1 向量化并去重）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            description: '要记住的内容（建议简洁完整的一两句话）',
          },
          tags: {
            type: 'array',
            items: { type: 'string' },
            description: '可选标签列表，如 ["偏好", "群友"]',
          },
          pinned: {
            type: 'boolean',
            description: '是否设为固定记忆（长期常驻提示）',
          },
        },
        required: ['text'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string' },
            updated: { type: 'boolean' },
            embedded: { type: 'boolean' },
            total: { type: 'integer' },
          },
          required: ['id', 'updated', 'embedded', 'total'],
        },
        render: (_args, val) => [
          {
            type: 'text',
            text: `${val.updated ? '已更新' : '已记住'} ${val.id}（${val.embedded ? '已向量化' : '仅文本保存，OVMS暂不可达'}，共 ${val.total} 条）`,
          },
        ],
      },
      async execute(args) {
        const text = typeof args?.text === 'string' ? args.text.trim() : '';
        if (!text) throw new Error('text 不能为空');
        const tags = Array.isArray(args?.tags)
          ? args.tags.map((t) => String(t).trim()).filter(Boolean)
          : [];
        const pinned = Boolean(args?.pinned);

        let embedding = null;
        try {
          embedding = await embedText(endpoint, model, text);
        } catch (err) {
          console.warn(`[conan-rag-memory] embed failed on add: ${err?.message || err}`);
        }

        const store = loadStore(storePath, model);
        const now = new Date().toISOString();

        // 去重：完全一致或向量余弦相似度 >= 0.94 时直接更新
        let existing = store.items.find((it) => it.text === text);
        if (!existing && embedding) {
          let bestSim = 0;
          for (const it of store.items) {
            if (!it.embedding) continue;
            const sim = cosineSimilarity(embedding, it.embedding);
            if (sim >= 0.94 && sim > bestSim) {
              bestSim = sim;
              existing = it;
            }
          }
        }

        if (existing) {
          existing.text = text;
          if (tags.length) existing.tags = Array.from(new Set([...(existing.tags || []), ...tags]));
          if (pinned) existing.pinned = true;
          if (embedding) existing.embedding = embedding;
          existing.updatedAt = now;
          saveStore(storePath, store);
          return { id: existing.id, updated: true, embedded: Boolean(embedding), total: store.items.length };
        }

        const id = `M${String(store.nextSeq++).padStart(4, '0')}`;
        store.items.push({
          id,
          text,
          tags,
          pinned,
          createdAt: now,
          embedding,
        });
        saveStore(storePath, store);
        return { id, updated: false, embedded: Boolean(embedding), total: store.items.length };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '写入 RAG 记忆',
        kind: 'other',
        rawInput: args?.text || '',
      }),
    });
  }, 'conan-rag-memory.tool(rag_memory_add)');

  // 3. 注册 rag_memory_search
  ctx.effect(() => {
    return ctx.tools.register({
      name: 'rag_memory_search',
      description:
        '按语义从 Conan RAG 长期记忆库检索最相关的历史记忆（使用本机 OpenVINO Conan-embedding-v1 向量检索）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '要回忆的问题或关键词描述',
          },
          topK: {
            type: 'integer',
            description: '返回条数（默认 6，上限 20）',
          },
          tag: {
            type: 'string',
            description: '可选：按标签过滤',
          },
        },
        required: ['query'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            mode: { type: 'string' },
            total: { type: 'integer' },
            hits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  score: { type: 'number' },
                  text: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  pinned: { type: 'boolean' },
                  createdAt: { type: 'string' },
                },
                required: ['id', 'score', 'text', 'tags', 'pinned', 'createdAt'],
              },
            },
          },
          required: ['mode', 'total', 'hits'],
        },
        render: (_args, val) => {
          if (!val.hits.length) {
            return [{ type: 'text', text: `未找到相关记忆（库内共 ${val.total} 条，模式=${val.mode}）` }];
          }
          const lines = val.hits.map(
            (h) =>
              `- [${h.id}] (${h.score.toFixed(3)})${h.pinned ? ' [固定]' : ''}${h.tags.length ? ` [${h.tags.join(',')}]` : ''} ${h.text}`,
          );
          return [{ type: 'text', text: `检索到 ${val.hits.length} 条记忆（模式=${val.mode}）：\n${lines.join('\n')}` }];
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (!query) throw new Error('query 不能为空');
        const topK = Math.min(20, Math.max(1, Number(args?.topK) || defaultTopK));
        const tagFilter = typeof args?.tag === 'string' && args.tag.trim() ? args.tag.trim() : null;

        const store = loadStore(storePath, model);
        let candidates = store.items;
        if (tagFilter) {
          candidates = candidates.filter((it) => Array.isArray(it.tags) && it.tags.includes(tagFilter));
        }

        let queryVec = null;
        let mode = 'vector';
        try {
          queryVec = await embedText(endpoint, model, query);
        } catch (err) {
          mode = 'keyword-fallback';
          console.warn(`[conan-rag-memory] embed failed on search, fallback to keyword: ${err?.message || err}`);
        }

        const scored = candidates.map((it) => {
          let score = 0;
          if (queryVec && Array.isArray(it.embedding)) {
            score = cosineSimilarity(queryVec, it.embedding);
          } else {
            score = keywordScore(query, it.text);
          }
          return {
            id: it.id,
            score: Number(score.toFixed(4)),
            text: it.text,
            tags: Array.isArray(it.tags) ? it.tags : [],
            pinned: Boolean(it.pinned),
            createdAt: it.createdAt || '',
          };
        });

        scored.sort((a, b) => b.score - a.score);
        const hits = scored.filter((x) => x.score > 0.15).slice(0, topK);
        return { mode, total: store.items.length, hits };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '检索 RAG 记忆',
        kind: 'other',
        rawInput: args?.query || '',
      }),
    });
  }, 'conan-rag-memory.tool(rag_memory_search)');

  // 4. 注册 rag_memory_delete
  ctx.effect(() => {
    return ctx.tools.register({
      name: 'rag_memory_delete',
      description: '按记忆 id（如 M0001）删除过时或错误的 RAG 记忆。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: '要删除的记忆 id，如 M0001',
          },
        },
        required: ['id'],
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            deleted: { type: 'boolean' },
            id: { type: 'string' },
            total: { type: 'integer' },
          },
          required: ['deleted', 'id', 'total'],
        },
        render: (_args, val) => [
          {
            type: 'text',
            text: val.deleted ? `已删除记忆 ${val.id}（剩余 ${val.total} 条）` : `未找到记忆 ${val.id}`,
          },
        ],
      },
      async execute(args) {
        const id = typeof args?.id === 'string' ? args.id.trim() : '';
        if (!id) throw new Error('id 不能为空');
        const store = loadStore(storePath, model);
        const before = store.items.length;
        store.items = store.items.filter((it) => it.id !== id);
        const deleted = store.items.length < before;
        if (deleted) saveStore(storePath, store);
        return { deleted, id, total: store.items.length };
      },
      presentCall: (args) => ({
        card: 'generic',
        title: '删除 RAG 记忆',
        kind: 'other',
        rawInput: args?.id || '',
      }),
    });
  }, 'conan-rag-memory.tool(rag_memory_delete)');
}
