/**
 * conan-rag-memory —— 基于本机 OpenVINO-OVMS + TencentBAC/Conan-embedding-v1 的分层 RAG 记忆插件。
 *
 * 记忆分层：
 * 1. 短期记忆（shortTerm）：插件监听 session/event 自动滚动保存最近 100 条消息（含本地文件路径），
 *    无需模型手动操作，自动调用本机 OVMS 向量化。
 * 2. 定时做梦（dream）：插件内置定时器，每天按本机时间触发两次（默认 12:30 与 23:30），
 *    独立调用 ctx.llm 通读新增短期记忆，将重要事实/偏好/约定提炼升格到长期记忆。
 * 3. 长期记忆（items）：由会话内模型通过 rag_memory_add / rag_memory_search / rag_memory_delete 自主管理，
 *    也接收定时做梦提炼的记忆（source: "dream"）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

export const name = 'conan-rag-memory';
export const inject = ['systemPrompt', 'tools', 'llm'];

export const DEFAULT_ENDPOINT = 'http://127.0.0.1:8765/v3/embeddings';
export const DEFAULT_MODEL = 'conan-embedding-v1';
export const DEFAULT_STORE_FILE = 'conan-rag-loli.json';
export const DEFAULT_VARIABLE = 'conan_rag_memory';
export const DEFAULT_SHORT_TERM_LIMIT = 100;
export const DEFAULT_DREAM_TIMES = ['12:30', '23:30'];

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

function createEmptyStore(model) {
  return {
    version: 2,
    model,
    nextSeq: 1,
    nextShortSeq: 1,
    items: [],
    shortTerm: [],
    dreamState: {
      lastSlots: {},
      lastDreamAt: null,
      lastDreamAttempt: null,
      lastDreamError: '',
      lastDreamSummary: '',
      lastProcessedShortSeq: 0,
      lastProvider: null,
      lastModel: null,
    },
  };
}

function loadStore(storePath, model) {
  if (!existsSync(storePath)) {
    return createEmptyStore(model);
  }
  try {
    const raw = JSON.parse(readFileSync(storePath, 'utf8'));
    if (raw && Array.isArray(raw.items)) {
      const shortTerm = Array.isArray(raw.shortTerm) ? raw.shortTerm : [];
      const dreamState = raw.dreamState && typeof raw.dreamState === 'object' ? raw.dreamState : {};
      return {
        version: 2,
        model: raw.model || model,
        nextSeq: typeof raw.nextSeq === 'number' ? raw.nextSeq : raw.items.length + 1,
        nextShortSeq:
          typeof raw.nextShortSeq === 'number'
            ? raw.nextShortSeq
            : shortTerm.length > 0
              ? Math.max(...shortTerm.map((x) => Number(x.seq) || 0)) + 1
              : 1,
        items: raw.items,
        shortTerm,
        dreamState: {
          lastSlots:
            dreamState.lastSlots && typeof dreamState.lastSlots === 'object'
              ? dreamState.lastSlots
              : {},
          lastDreamAt: dreamState.lastDreamAt || null,
          lastDreamAttempt: dreamState.lastDreamAttempt || null,
          lastDreamError: dreamState.lastDreamError || '',
          lastDreamSummary: dreamState.lastDreamSummary || '',
          lastProcessedShortSeq:
            typeof dreamState.lastProcessedShortSeq === 'number'
              ? dreamState.lastProcessedShortSeq
              : 0,
          lastProvider: dreamState.lastProvider || null,
          lastModel: dreamState.lastModel || null,
        },
      };
    }
  } catch {
    // 损坏时回退为空库，避免阻塞会话
  }
  return createEmptyStore(model);
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

function isSystemInjectedText(text) {
  if (!text) return true;
  if (
    text.includes('【@ 人的方法】') ||
    text.includes('Current runtime context') ||
    text.includes('<available_skills>') ||
    text.includes('<system-reminder>') ||
    /^Time sampled while preparing turn\b/.test(text)
  ) {
    return true;
  }
  return false;
}

function extractLocalPathsFromText(text) {
  const found = new Set();
  // Unix absolute paths (e.g. /vol1/..., /tmp/..., /home/...)
  const unixRe = /(?:^|[\s→:("'`])(\/(?:vol\d+|tmp|home|var|etc|Users|mnt|data|opt)[^\s"'`<>|)\]]+)/g;
  let m;
  while ((m = unixRe.exec(text)) !== null) {
    if (m[1]) found.add(m[1].replace(/[.,;:!?]+$/, ''));
  }
  // Windows absolute paths (e.g. D:\pics\cat.png)
  const winRe = /(?:^|[\s→:("'`])([A-Za-z]:\\[^\s"'`<>|)\]]+)/g;
  while ((m = winRe.exec(text)) !== null) {
    if (m[1]) found.add(m[1].replace(/[.,;:!?]+$/, ''));
  }
  return [...found];
}

function extractEventMessage(event) {
  if (!event || typeof event !== 'object') return null;

  let role = null;
  let blocks = null;
  let provider = null;
  let model = null;

  if (event.type === 'user/message') {
    role = 'user';
    blocks = event.data?.content;
  } else if (event.type === 'assistant/message') {
    role = 'assistant';
    blocks = event.data?.message?.content;
    provider = event.data?.message?.source?.provider || null;
    model = event.data?.message?.source?.model || null;
  } else {
    return null;
  }

  if (!Array.isArray(blocks) || blocks.length === 0) {
    return { role, text: '', files: [], provider, model };
  }

  const textParts = [];
  const files = new Set();

  for (const blk of blocks) {
    if (!blk || typeof blk !== 'object') continue;
    if (blk.type === 'text' && typeof blk.text === 'string') {
      const t = blk.text.trim();
      if (!t || isSystemInjectedText(t)) continue;
      textParts.push(t);
      for (const p of extractLocalPathsFromText(t)) files.add(p);
    } else {
      const candidatePath =
        blk.path || blk.filePath || blk.file_path || blk.source?.path || blk.source?.filePath;
      if (typeof candidatePath === 'string' && candidatePath.trim()) {
        files.add(candidatePath.trim());
      }
    }
  }

  const cleanText = textParts.join('\n').replace(/\s+/g, ' ').trim();
  const fileList = [...files];
  if (!cleanText && fileList.length === 0) {
    return { role, text: '', files: [], provider, model };
  }

  const clipped = cleanText.length > 600 ? `${cleanText.slice(0, 600)}…` : cleanText;
  const finalText =
    fileList.length > 0 && !clipped.includes(fileList[0])
      ? `${clipped}${clipped ? ' ' : ''}[文件: ${fileList.join(', ')}]`
      : clipped;

  return { role, text: finalText, files: fileList, provider, model };
}

function upsertLongTermItem(store, { text, tags = [], pinned = false, source = 'manual', embedding = null }) {
  const now = new Date().toISOString();

  // 相似度 >= 0.92 或完全同文本时视为更新去重
  let existing = store.items.find((x) => x.text === text);
  if (!existing && embedding) {
    let bestSim = -1;
    let bestItem = null;
    for (const it of store.items) {
      if (Array.isArray(it.embedding)) {
        const sim = cosineSimilarity(embedding, it.embedding);
        if (sim > bestSim) {
          bestSim = sim;
          bestItem = it;
        }
      }
    }
    if (bestSim >= 0.92 && bestItem) {
      existing = bestItem;
    }
  }

  if (existing) {
    existing.text = text;
    if (tags.length) existing.tags = [...new Set([...(existing.tags || []), ...tags])];
    if (pinned) existing.pinned = true;
    if (embedding) existing.embedding = embedding;
    if (source) existing.source = existing.source || source;
    existing.updatedAt = now;
    return { id: existing.id, updated: true };
  }

  const id = `mem_${store.nextSeq++}`;
  store.items.push({
    id,
    text,
    tags,
    pinned,
    source,
    embedding,
    createdAt: now,
    updatedAt: now,
  });
  return { id, updated: false };
}

function getLocalDateAndHHMM(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const mm = String(date.getMinutes()).padStart(2, '0');
  return {
    dateStr: `${y}-${m}-${d}`,
    hhmm: `${hh}:${mm}`,
  };
}

function parseDreamJson(rawText) {
  if (!rawText || typeof rawText !== 'string' || !rawText.trim()) {
    throw new Error('做梦模型未返回有效的 JSON 数组');
  }
  const trimmed = rawText.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1].trim() : trimmed;
  const start = candidate.indexOf('[');
  const end = candidate.lastIndexOf(']');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('做梦模型未返回有效的 JSON 数组');
  }
  let parsed;
  try {
    parsed = JSON.parse(candidate.slice(start, end + 1));
  } catch {
    throw new Error('做梦模型未返回有效的 JSON 数组');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('做梦模型未返回有效的 JSON 数组');
  }
  return parsed
    .filter((x) => x && typeof x.text === 'string' && x.text.trim().length > 0)
    .map((x) => ({
      text: x.text.trim(),
      tags: Array.isArray(x.tags) ? x.tags.map((t) => String(t).trim()).filter(Boolean) : ['梦境整理'],
      pinned: Boolean(x.pinned),
    }));
}

function formatSummary(
  store,
  { maxPinned = 10, maxRecent = 10, maxChars = 4000, shortTermLimit = DEFAULT_SHORT_TERM_LIMIT, dreamTimes = DEFAULT_DREAM_TIMES } = {}
) {
  const pinned = store.items.filter((x) => x.pinned).slice(-maxPinned);
  const pinnedIds = new Set(pinned.map((x) => x.id));
  const recent = store.items.filter((x) => !pinnedIds.has(x.id)).slice(-maxRecent);

  const lastDream = store.dreamState?.lastDreamAt
    ? store.dreamState.lastDreamAt.slice(0, 16).replace('T', ' ')
    : '尚未做梦';
  const lines = [
    `RAG 记忆状态：长期记忆 ${store.items.length} 条｜短期滚动记忆上限 ${shortTermLimit} 条（插件自动记录，含本地文件路径）｜每日做梦时间：${dreamTimes.join('、')}（上次：${lastDream}）`,
  ];
  if (store.dreamState?.lastDreamError) {
    lines.push(`最近做梦未完成：${store.dreamState.lastDreamError}`);
  }

  if (!store.items.length) {
    lines.push('（长期记忆库暂无记录；遇到重要事实请调 rag_memory_add，回忆旧事或查近期消息请调 rag_memory_search）');
  } else {
    if (pinned.length) {
      lines.push('【长期固定记忆】');
      for (const it of pinned) {
        const tagStr = it.tags?.length ? ` [${it.tags.join(',')}]` : '';
        lines.push(`- ${it.id}${tagStr}: ${it.text}`);
      }
    }
    if (recent.length) {
      lines.push('【最近长期记忆】');
      for (const it of recent) {
        const tagStr = it.tags?.length ? ` [${it.tags.join(',')}]` : '';
        lines.push(`- ${it.id}${tagStr}: ${it.text}`);
      }
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
  const shortTermLimit =
    typeof config.shortTermLimit === 'number' && config.shortTermLimit > 0
      ? Math.floor(config.shortTermLimit)
      : DEFAULT_SHORT_TERM_LIMIT;
  const dreamTimes =
    Array.isArray(config.dreamTimes) && config.dreamTimes.length > 0
      ? config.dreamTimes.map((t) => String(t).trim()).filter((t) => /^\d{2}:\d{2}$/.test(t))
      : DEFAULT_DREAM_TIMES;

  const storePath = resolveStorePath(storeFile);

  // 串行写队列，防止并发读写丢数据
  let writeChain = Promise.resolve();
  const enqueueWrite = (fn) => {
    const queued = writeChain.then(fn, fn);
    writeChain = queued;
    void queued.catch((err) => {
      console.warn(`[conan-rag-memory] write queue error: ${err?.message || err}`);
    });
    return queued;
  };

  let dreaming = false;

  const recordDreamAttempt = async (attemptedAt, slotKey, result, error = '') => {
    await enqueueWrite(() => {
      const latest = loadStore(storePath, model);
      latest.dreamState.lastDreamAttempt = attemptedAt;
      latest.dreamState.lastDreamError = error;
      if (slotKey && (!result.skipped || result.reason === 'no_new_short_term_messages')) {
        latest.dreamState.lastSlots[slotKey] = attemptedAt;
      }
      saveStore(storePath, latest);
    });
    return result;
  };

  async function runDream({ force = false, slotKey = null } = {}) {
    if (dreaming) {
      return { skipped: true, reason: 'already_dreaming', added: 0, updated: 0, inspected: 0 };
    }

    const attemptedAt = new Date().toISOString();
    let inspected = 0;
    dreaming = true;
    try {
      await writeChain;
      const store = loadStore(storePath, model);
      const lastSeq = store.dreamState.lastProcessedShortSeq || 0;
      const pending = force
        ? store.shortTerm.slice(-shortTermLimit)
        : store.shortTerm.filter((x) => (Number(x.seq) || 0) > lastSeq);
      inspected = pending.length;

      if (pending.length === 0) {
        return await recordDreamAttempt(attemptedAt, slotKey, {
          skipped: true,
          reason: 'no_new_short_term_messages',
          added: 0,
          updated: 0,
          inspected: 0,
        });
      }
      if (!ctx.llm || typeof ctx.llm.stream !== 'function') {
        return await recordDreamAttempt(attemptedAt, slotKey, {
          skipped: true,
          reason: 'llm_service_unavailable',
          added: 0,
          updated: 0,
          inspected,
        }, 'llm_service_unavailable');
      }

      const provider = config.dreamProvider || store.dreamState.lastProvider || undefined;
      const llmModel = config.dreamModel || store.dreamState.lastModel || undefined;
      if (!provider || !llmModel) {
        return await recordDreamAttempt(attemptedAt, slotKey, {
          skipped: true,
          reason: 'no_recent_llm_route_recorded',
          added: 0,
          updated: 0,
          inspected,
        }, 'no_recent_llm_route_recorded');
      }

      const existingLong = store.items
        .slice(-30)
        .map((x) => `- ${x.text}`)
        .join('\n');
      const shortTranscript = pending
        .map((x) => `[#${x.seq} ${x.createdAt?.slice(5, 16).replace('T', ' ') || ''} ${x.role}] ${x.text}`)
        .join('\n');

      const dreamSystemPrompt = [
        '你是“小肥鱼”的潜意识梦境记忆整理器。',
        '你的任务是阅读最近的短期对话记录，从中提炼出值得永久保存进长期 RAG 记忆库的高价值信息。',
        '保留标准：群友的身份/昵称/偏好/习惯、重要约定、重要事件、明确提到的本地文件用途、与主人的重要互动。',
        '过滤标准：水群废话、纯斗图、一次性玩笑、重复信息、已有长期记忆里已经写过的内容，一律不要输出。',
        '请只输出一个严格的 JSON 数组，不要输出任何额外解释。如果没有值得写入长期记忆的新内容，输出 []。',
        '每条元素格式：{"text":"简洁完整的一句话事实（如有重要文件可附本地路径）","tags":["标签1"],"pinned":false}',
      ].join('\n');

      const dreamUserPrompt = [
        '【已有长期记忆（避免重复）】',
        existingLong || '（无）',
        '',
        `【待整理的新增短期记忆（共 ${pending.length} 条）】`,
        shortTranscript,
      ].join('\n');

      const ctrl = new AbortController();
      const timeout = setTimeout(() => ctrl.abort(), 90_000);
      let rawOutput = '';
      try {
        const stream = ctx.llm.stream({
          provider,
          model: llmModel,
          system: dreamSystemPrompt,
          messages: [{ role: 'user', content: [{ type: 'text', text: dreamUserPrompt }] }],
          temperature: 0.2,
          purpose: 'rag-memory-dream',
          signal: ctrl.signal,
        });
        for await (const chunk of stream) {
          if (!chunk || typeof chunk !== 'object') continue;
          if (chunk.type === 'text-delta' && typeof chunk.text === 'string') {
            rawOutput += chunk.text;
          }
        }
      } finally {
        clearTimeout(timeout);
      }

      const extracted = parseDreamJson(rawOutput);
      const maxSeq = Math.max(...pending.map((x) => Number(x.seq) || 0));

      let added = 0;
      let updated = 0;
      const embeddedItems = [];
      for (const item of extracted) {
        let vec = null;
        try {
          vec = await embedText(endpoint, model, item.text);
        } catch (err) {
          console.warn(`[conan-rag-memory] dream embed failed: ${err?.message || err}`);
        }
        embeddedItems.push({ ...item, embedding: vec });
      }

      await enqueueWrite(() => {
        const latest = loadStore(storePath, model);
        for (const item of embeddedItems) {
          const res = upsertLongTermItem(latest, {
            text: item.text,
            tags: [...new Set([...(item.tags || []), '梦境整理'])],
            pinned: item.pinned,
            source: 'dream',
            embedding: item.embedding,
          });
          if (res.updated) updated++;
          else added++;
        }
        latest.dreamState.lastDreamAt = new Date().toISOString();
        latest.dreamState.lastDreamAttempt = attemptedAt;
        latest.dreamState.lastDreamError = '';
        latest.dreamState.lastProcessedShortSeq = Math.max(latest.dreamState.lastProcessedShortSeq || 0, maxSeq);
        latest.dreamState.lastDreamSummary = `整理 ${pending.length} 条短期记忆 -> 新增 ${added} 条，更新 ${updated} 条`;
        if (slotKey) {
          latest.dreamState.lastSlots[slotKey] = latest.dreamState.lastDreamAt;
        }
        saveStore(storePath, latest);
      });

      return { skipped: false, added, updated, inspected: pending.length };
    } catch (err) {
      const message = String(err?.message || err).slice(0, 300);
      await recordDreamAttempt(attemptedAt, slotKey, {
        skipped: true,
        reason: 'dream_failed',
        added: 0,
        updated: 0,
        inspected,
      }, message);
      throw err;
    } finally {
      dreaming = false;
    }
  }

  // 1. 注册系统提示变量（兼容 complete: true 人设）
  ctx.effect(() => {
    if (typeof ctx.systemPrompt?.variable === 'function') {
      return ctx.systemPrompt.variable(variableName, () => {
        const store = loadStore(storePath, model);
        return formatSummary(store, { maxPinned, maxRecent, maxChars, shortTermLimit, dreamTimes });
      });
    }
    return undefined;
  }, `conan-rag-memory.var(${variableName})`);

  // 2. 自动监听会话消息，滚动保存前 100 条短期记忆（含本地文件路径）
  ctx.effect(() => {
    return ctx.on('session/event', (_session, event) => {
      const extracted = extractEventMessage(event);
      if (!extracted) return;

      const { role, text, files, provider, model: llmModel } = extracted;
      if (!text && !provider && !llmModel) return;

      void enqueueWrite(async () => {
        let vec = null;
        if (text) {
          try {
            vec = await embedText(endpoint, model, text);
          } catch (err) {
            console.warn(`[conan-rag-memory] short-term embed failed: ${err?.message || err}`);
          }
        }
        const store = loadStore(storePath, model);
        if (provider && llmModel) {
          store.dreamState.lastProvider = provider;
          store.dreamState.lastModel = llmModel;
        }
        if (text) {
          const seq = store.nextShortSeq++;
          store.shortTerm.push({
            id: `st_${seq}`,
            seq,
            role,
            text,
            files,
            embedding: vec,
            createdAt: new Date().toISOString(),
          });
          if (store.shortTerm.length > shortTermLimit) {
            store.shortTerm = store.shortTerm.slice(-shortTermLimit);
          }
        }
        saveStore(storePath, store);
      }).catch(() => {});
    });
  }, 'conan-rag-memory.short-term-capture');

  // 3. 定时做梦调度器（每天中午与晚上各一次，按本机系统时间触发）
  ctx.effect(() => {
    const tick = async () => {
      await writeChain;
      const { dateStr, hhmm } = getLocalDateAndHHMM(new Date());
      const store = loadStore(storePath, model);
      const dueSlots = dreamTimes
        .filter((time) => time <= hhmm && !store.dreamState.lastSlots?.[`${dateStr}@${time}`])
        .sort();
      if (dueSlots.length === 0) return;
      const slotKey = `${dateStr}@${dueSlots[dueSlots.length - 1]}`;
      await runDream({ force: false, slotKey });
    };
    const timer = setInterval(() => {
      void tick().catch((err) => {
        console.warn(`[conan-rag-memory] scheduled dream failed: ${err?.message || err}`);
      });
    }, 30_000);
    if (typeof timer.unref === 'function') timer.unref();
    return () => clearInterval(timer);
  }, 'conan-rag-memory.dream-scheduler');

  // 4. 注册 rag_memory_add（长期记忆写入，由会话内模型自主操作）
  ctx.effect(() => {
    return ctx.tools.register({
      name: 'rag_memory_add',
      description:
        '把重要事实、群友偏好、约定或事件写入 Conan RAG 长期记忆库（短期消息由插件自动滚动保存，此工具仅用于重要长期记忆）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: {
            type: 'string',
            description: '要长期记住的重要内容（建议简洁完整的一两句话）',
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
            text: `${val.updated ? '已更新长期记忆' : '已写入长期记忆'} ${val.id}（${val.embedded ? '已向量化' : '仅文本保存，OVMS暂不可达'}，共 ${val.total} 条）`,
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

        let result = null;
        await enqueueWrite(() => {
          const store = loadStore(storePath, model);
          const { id, updated } = upsertLongTermItem(store, {
            text,
            tags,
            pinned,
            source: 'manual',
            embedding,
          });
          saveStore(storePath, store);
          result = { id, updated, embedded: Boolean(embedding), total: store.items.length };
        });
        return result;
      },
    });
  }, 'conan-rag-memory.tool(rag_memory_add)');

  // 5. 注册 rag_memory_search（支持检索长期记忆、短期记忆或全部）
  ctx.effect(() => {
    return ctx.tools.register({
      name: 'rag_memory_search',
      description:
        '按语义检索 Conan RAG 记忆库（默认同时检索长期记忆与最近 100 条短期记忆，可用 scope 筛选）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          query: {
            type: 'string',
            description: '要回忆的主题、人名、文件名或问题',
          },
          top_k: {
            type: 'integer',
            description: '最多返回条数（默认 6）',
          },
          scope: {
            type: 'string',
            enum: ['all', 'long', 'short'],
            description: '检索范围：all=全部（默认），long=仅长期记忆，short=仅短期滚动记忆',
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
            hits: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                  id: { type: 'string' },
                  layer: { type: 'string' },
                  score: { type: 'number' },
                  text: { type: 'string' },
                  tags: { type: 'array', items: { type: 'string' } },
                  pinned: { type: 'boolean' },
                  files: { type: 'array', items: { type: 'string' } },
                  createdAt: { type: 'string' },
                },
                required: ['id', 'layer', 'score', 'text', 'tags', 'pinned', 'files', 'createdAt'],
              },
            },
          },
          required: ['mode', 'hits'],
        },
        render: (_args, val) => {
          if (!val.hits.length) {
            return [{ type: 'text', text: 'RAG 记忆库中没有找到相关记忆。' }];
          }
          const lines = [`RAG 检索命中 ${val.hits.length} 条（模式：${val.mode}）：`];
          for (const h of val.hits) {
            const layerLabel = h.layer === 'short' ? '短期' : '长期';
            const tagStr = h.tags.length ? ` [${h.tags.join(',')}]` : '';
            const pinStr = h.pinned ? ' ★' : '';
            lines.push(`- (${h.score.toFixed(3)}) [${layerLabel}] ${h.id}${pinStr}${tagStr}: ${h.text}`);
          }
          return [{ type: 'text', text: lines.join('\n') }];
        },
      },
      async execute(args) {
        const query = typeof args?.query === 'string' ? args.query.trim() : '';
        if (!query) throw new Error('query 不能为空');
        const topK =
          typeof args?.top_k === 'number' && args.top_k > 0 ? Math.min(args.top_k, 20) : defaultTopK;
        const scope = args?.scope === 'long' || args?.scope === 'short' ? args.scope : 'all';

        const store = loadStore(storePath, model);
        const candidates = [];
        if (scope === 'all' || scope === 'long') {
          for (const it of store.items) {
            candidates.push({ layer: 'long', item: it });
          }
        }
        if (scope === 'all' || scope === 'short') {
          for (const it of store.shortTerm) {
            candidates.push({ layer: 'short', item: it });
          }
        }
        if (!candidates.length) {
          return { mode: 'empty', hits: [] };
        }

        let queryVec = null;
        try {
          queryVec = await embedText(endpoint, model, query);
        } catch (err) {
          console.warn(`[conan-rag-memory] embed failed on search, fallback to keyword: ${err?.message || err}`);
        }

        const mode = queryVec ? 'vector' : 'keyword';
        const scored = candidates
          .map(({ layer, item }) => {
            let score = 0;
            if (queryVec && Array.isArray(item.embedding)) {
              score = cosineSimilarity(queryVec, item.embedding);
            } else {
              score = keywordScore(query, item.text);
            }
            return { layer, item, score };
          })
          .filter((x) => (mode === 'vector' ? x.score > 0.25 : x.score > 0))
          .sort((a, b) => b.score - a.score)
          .slice(0, topK)
          .map(({ layer, item, score }) => ({
            id: item.id,
            layer,
            score: Number(score.toFixed(4)),
            text: item.text,
            tags: Array.isArray(item.tags) ? item.tags : item.role ? [item.role] : [],
            pinned: Boolean(item.pinned),
            files: Array.isArray(item.files) ? item.files : [],
            createdAt: item.createdAt || '',
          }));

        return { mode, hits: scored };
      },
    });
  }, 'conan-rag-memory.tool(rag_memory_search)');

  // 6. 注册 rag_memory_delete（删除长期记忆）
  ctx.effect(() => {
    return ctx.tools.register({
      name: 'rag_memory_delete',
      description: '按 id 删除一条过时或错误的长期记忆。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: {
            type: 'string',
            description: '要删除的长期记忆 id（如 mem_3）',
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
            remaining: { type: 'integer' },
          },
          required: ['deleted', 'id', 'remaining'],
        },
        render: (_args, val) => [
          {
            type: 'text',
            text: val.deleted
              ? `已删除长期记忆 ${val.id}（剩余 ${val.remaining} 条）。`
              : `未找到长期记忆 ${val.id}（当前共 ${val.remaining} 条）。`,
          },
        ],
      },
      async execute(args) {
        const id = typeof args?.id === 'string' ? args.id.trim() : '';
        if (!id) throw new Error('id 不能为空');
        let result = null;
        await enqueueWrite(() => {
          const store = loadStore(storePath, model);
          const before = store.items.length;
          store.items = store.items.filter((x) => x.id !== id);
          const deleted = store.items.length < before;
          if (deleted) saveStore(storePath, store);
          result = { deleted, id, remaining: store.items.length };
        });
        return result;
      },
    });
  }, 'conan-rag-memory.tool(rag_memory_delete)');

  // 7. 注册 rag_memory_dream（可选手动触发做梦整理，平时由插件每天中午/晚上自动触发）
  ctx.effect(() => {
    return ctx.tools.register({
      name: 'rag_memory_dream',
      description:
        '手动触发一次“做梦整理”，把短期滚动记忆中的重要信息提炼写入长期记忆（平时由插件每天中午 12:30 和晚上 23:30 自动执行，无需主动调用，除非主人明确要求立刻整理记忆）。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        properties: {
          force: {
            type: 'boolean',
            description: '是否强制重新整理全部短期记忆（默认 false，仅整理上次做梦后新增的）',
          },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            skipped: { type: 'boolean' },
            reason: { type: 'string' },
            inspected: { type: 'integer' },
            added: { type: 'integer' },
            updated: { type: 'integer' },
          },
          required: ['skipped', 'inspected', 'added', 'updated'],
        },
        render: (_args, val) => [
          {
            type: 'text',
            text: val.skipped
              ? `本次做梦跳过（${val.reason || '无新短期记忆'}）。`
              : `做梦整理完成：通读 ${val.inspected} 条短期记忆，新增长期记忆 ${val.added} 条，更新 ${val.updated} 条。`,
          },
        ],
      },
      async execute(args) {
        return runDream({ force: Boolean(args?.force) });
      },
    });
  }, 'conan-rag-memory.tool(rag_memory_dream)');
}
