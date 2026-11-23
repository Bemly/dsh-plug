/**
 * sticker-semantic.mjs — 【出站扩展】示范：按"本回合最后一段正文"自动配一张表情包
 *
 * 放到 `{dataRoot}/.qqbot-extensions/outbound/sticker-semantic.mjs` 即生效（改完 `/tools-reload`）。
 *
 * ── 它做什么 ──────────────────────────────────────────────────────────────
 *   1. 从本地表情包库（`{dataRoot}/表情包/index.json`）**随机抽 100 张**当候选池；
 *   2. 拿**本回合最后一个正文块**（`ctx.isLastChunk === true`）当查询串；
 *   3. 用「字符 bigram Jaccard 相似度」跟每张图的 `tags + desc + msgText` 比一遍，
 *      取分最高且**过阈值**的那张；
 *   4. 用 `ctx.sendMedia()` 发出去 —— 这条通道**先被动、失败/超限自动转主动**。
 *
 * ── 为什么用 bigram 而不是向量 ────────────────────────────────────────────
 *   示范要"拷过去就能跑"：bigram 零依赖、离线、微秒级。要上真语义就把
 *   `similarity()` 换成你自己调模型的实现（`ctx.kernel` 能拿到插件 cordis Context）。
 *
 * ── 开关 ──────────────────────────────────────────────────────────────────
 *   ★ 两级开关（2026-10-17 主人定，加了隔离）：
 *   ① **总开关**：工具 `sticker_auto`，状态文件
 *      `{dataRoot}/.qqbot-extensions/data/auto-sticker.json` → `{ "enabled": true|false }`
 *      文件不存在 = **默认开**（想默认关就改 DEFAULT_ENABLED）。
 *   ② **隔离（白名单）**：状态文件
 *      `{dataRoot}/.qqbot-extensions/data/sticker-semantic-scope.json`
 *      `{ "mode": "whitelist", "targets": ["group:<群openid>", "c2c:<用户openid>"] }`
 *      **文件不存在 = whitelist + 空名单 ⇒ 谁都不配图**；只对名单里的群/私聊生效。
 *      用 `sticker_auto {action:'scope-add', target:'group:xxxx', label:'群名'}` 增删。
 *
 * ── 参数（文件顶部 CONFIG，直接改）────────────────────────────────────────
 */
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = {
  /** 候选池大小（随机抽多少张）—— 300 张足够命中，也不至于每回合算几千次 */
  POOL: 300,
  /**
   * ⚠️ 2026-10-16 主人定：**不要阈值了，直接发最高分那张。**
   *   原因：`tags+desc` 是标签式短文本、正文是自然语句，bigram 的重合天生很低
   *   （实测长句 0.02~0.04、短句 <0.01），卡阈值的结果是"经常一张不发"，体验更差。
   *   现在只在候选池为空时才不发；**由 `MIN_TEXT` 兜住"太短没语义"的情况**。
   *   （想恢复阈值：把下面这行改成正数即可。）
   */
  MIN_SCORE: 0,
  /** 正文多短就不配图（太短没语义，配了也是瞎配） */
  MIN_TEXT: 6,
  /** 每回合最多发几张 */
  MAX_PER_TURN: 1,
  /**
   * 发送冷却（毫秒）：**同一个会话**在这个窗口内最多配 1 张。
   * 为什么不用"每回合计数"：出站块是分开调的，跨块拦不住（实测一次回复发了两张）；
   * 而用 targetId 当归零键又会导致"发过一次就永远不发"。时间窗两个坑都避开。
   */
  COOLDOWN_MS: 25000,
  /** 默认开关（状态文件不存在时用） */
  DEFAULT_ENABLED: true,

  // ── ★ 2026-10-16 专家团改法（主人拍板"按你的来"）───────────────────────
  /** 梗命中加分：query 的词出现在这张图的 msgText（群友原话）里 ⇒ 加一点分 */
  MSG_BONUS: 0.06,
  /** 存在性闸门系数：最高分没到 `均值 + GATE_K * 标准差` ⇒ 认为"库里没合适的" ⇒ 不发 */
  GATE_K: 1.2,
  /**
   * 绝对地板（**必须按 scorer 分两套**：两个算法的分数尺度差一个数量级）
   *   · local-model（bge 余弦）：中文短文本通常 0.3~0.7，低于 0.32 基本是不沾边
   *   · bigram（字符 2-gram Jaccard）：长句实测最高才 0.02~0.04，地板得放 0.012
   */
  FLOOR_EMBED: 0.32,
  FLOOR_BIGRAM: 0.012,
  /**
   * ★ 诊断开关（已排查完毕，保持 false）：
   *   true = 跳过所有判断，**每回合无条件发库里第一张图** —— 用来区分两种失败：
   *     · 连它都不发 ⇒ **出站链压根没被调用**（挂载点/装载问题，不是扩展逻辑）
   *     · 它发了    ⇒ 链是通的，问题在"选图/阈值/路径"这些判断里
   *   2026-10-16 实测结论：置 true 后**立刻出图** ⇒ 链通，卡点确实在选图逻辑。
   */
  FORCE: false,
};

const fsp = { readFileSync, existsSync };

/** 状态文件路径（与 tools/sticker_auto.mjs 共用同一份） */
function stateFile(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot-extensions', 'data', 'auto-sticker.json');
}

/** 读开关；读不到就用默认值（**任何异常都当作默认**，绝不因为读文件失败就不出站） */
function isEnabled(ctx) {
  try {
    const f = stateFile(ctx.dataRoot);
    if (!fsp.existsSync(f)) return CONFIG.DEFAULT_ENABLED;
    const j = JSON.parse(fsp.readFileSync(f, 'utf8'));
    return j && typeof j.enabled === 'boolean' ? j.enabled : CONFIG.DEFAULT_ENABLED;
  } catch {
    return CONFIG.DEFAULT_ENABLED;
  }
}

// ══════════════════════════════════════════════════════════════════════════
// ★★ 隔离设置（2026-10-17 主人定）★★
//   「你这个自动发送表情包的能力，应该只对单个目标生效啊（就像智能恢复一样，
//     指定一个群或私聊有效，隔离设置）」
//
//   ⇒ 从"全局开"改成**按目标白名单**：
//      · 配置文件：`{dataRoot}/.qqbot-extensions/data/sticker-semantic-scope.json`
//        `{ "mode": "whitelist"|"all", "targets": ["group:<群openid>", "c2c:<用户openid>"] }`
//      · **文件不存在 = whitelist + 空名单 ⇒ 谁都不配图**（要全局开就写 mode:"all"）；
//      · 匹配用 `<scope>:<targetId>`（同时接受只写裸 openid 的简写，方便手写）；
//      · 读文件/解析失败也**从"不发"这一侧失败** —— 隔离的东西宁可哑火，不能漏发。
//   用工具 `sticker_auto` 的 scope-add / scope-remove / scope-list / scope-mode 管理。
// ══════════════════════════════════════════════════════════════════════════

/** 隔离配置路径（与 tools/sticker_auto.mjs 共用） */
function scopeFile(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot-extensions', 'data', 'sticker-semantic-scope.json');
}

const EMPTY_SCOPE = { mode: 'whitelist', targets: [] };

/** 读隔离配置（读不到 / 读坏了 ⇒ 空白名单 = 不发） */
function readScope(ctx) {
  try {
    const f = scopeFile(ctx?.dataRoot);
    if (!fsp.existsSync(f)) return EMPTY_SCOPE;
    const j = JSON.parse(fsp.readFileSync(f, 'utf8'));
    const mode = j?.mode === 'all' ? 'all' : 'whitelist';
    const targets = (Array.isArray(j?.targets) ? j.targets : [])
      .map((t) => (typeof t === 'string' ? t : t?.key))
      .map((s) => String(s || '').trim())
      .filter(Boolean);
    return { mode, targets };
  } catch {
    return EMPTY_SCOPE;
  }
}

/** 本回合目标的可匹配写法：`scope:id` + 裸 `id`（两种写法都认） */
function targetKeysOf(ctx) {
  const t = ctx?.target || {};
  const id = String(t.targetId || t.peerId || '').trim();
  const scope = String(t.scope || '').trim();
  const keys = [];
  if (scope && id) keys.push(`${scope}:${id}`);
  if (id) keys.push(id);
  return keys;
}

/** 本回合目标是否在白名单里 */
function scopeAllows(ctx) {
  const s = readScope(ctx);
  if (s.mode === 'all') return { ok: true, why: 'mode=all' };
  const keys = targetKeysOf(ctx);
  if (!keys.length) return { ok: false, why: 'no-target-id', keys };
  const hit = keys.find((k) => s.targets.includes(k));
  return hit ? { ok: true, why: `listed:${hit}`, keys } : { ok: false, why: 'not-listed', keys };
}

// ── 表情包索引（带 mtime 缓存，避免每回合都读盘）──────────────────────────
let cache = { at: 0, items: [] };

function loadItems(dataRoot) {
  const indexFile = join(String(dataRoot || ''), '表情包', 'index.json');
  try {
    const st = fsp.existsSync(indexFile) ? indexFile : '';
    if (!st) return [];
    const raw = fsp.readFileSync(indexFile, 'utf8');
    const at = raw.length; // 简单指纹：长度变了就重读（够用，热刷也稳）
    if (cache.at === at && cache.items.length) return cache.items;
    const j = JSON.parse(raw);
    // ⚠️ 2026-10-16：**必须只取 `layer === 'library'`**（正式收藏）——
    //    索引里有 800 张 trash + 499 张 candidate，不过滤就会发出"垃圾层"的图
    //    （实测匹配到过 lib/trash/ 下一张写着"但是我看不到这个"的图，非常尴尬）。
    const items = (Array.isArray(j?.items) ? j.items : []).filter((it) => it && it.layer === 'library');
    cache = { at, items };
    return items;
  } catch {
    return cache.items.length ? cache.items : [];
  }
}

/** 把一张图的关键词拼成可比较的串（**只用于日志展示**；进向量的见 vecTextOf） */
function keywordsOf(it) {
  const tags = Array.isArray(it?.tags) ? it.tags.join(' ') : '';
  return `${tags} ${it?.desc || ''} ${it?.msgText || ''}`.trim();
}

// ── ★ 2026-10-16 专家团改法（主人拍板"按你的来"）的三个辅助 ──────────────

/** 改法2：query 只取**末句**（一段话里常混着寒暄/技术/情绪，整段进向量会被平均掉）。 */
function pickQuery(text) {
  const t = String(text || '').trim();
  if (!t) return '';
  const parts = t
    .split(/[。！？!?~～\n]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
  const last = parts.length ? parts[parts.length - 1] : '';
  // 末句太短（比如"好耶"）就退回整段，别拿没信息量的句子去检索
  return last && last.length >= CONFIG.MIN_TEXT ? last : t;
}

/** 改法3：**进向量的文本** = tags + desc。**msgText 不进**（群友原话常与画面无关，是污染源）。 */
function vecTextOf(it) {
  const tags = Array.isArray(it?.tags) ? it.tags.join(' ') : '';
  return `${tags} ${it?.desc || ''}`.trim();
}

/** 改法3：**梗命中** —— query 的字面 2-gram 有 ≥1/3 出现在这张图的 msgText 里。 */
function msgHit(query, it) {
  const m = String(it?.msgText || '');
  if (!m) return false;
  const q = bigrams(query);
  if (!q.size) return false;
  const b = bigrams(m);
  let hit = 0;
  for (const g of q) if (b.has(g)) hit += 1;
  return hit / q.size >= 0.34;
}

/** 图的真实路径（**`表情包/lib/{layer}/{id}.{ext}`**）；找不到就返回 null */
function fileOf(dataRoot, it) {
  const layer = String(it?.layer || 'library');
  // ⚠️⚠️ 2026-10-16 真机抓到的真凶：文件名是 **`id`**（12 位短串，如 `baa57a52309e.jpg`），
  //      **不是 `hash`**（40 位 sha1，只在 index 里当去重键）。用 hash 拼 ⇒ existsSync 恒 false
  //      ⇒ fileOf() 恒 null ⇒ "装好了却一张不发"，而且全程**不报任何错**。
  const id = String(it?.id || '');
  const hash = String(it?.hash || '');
  const ext = String(it?.ext || 'jpg');
  const stem = id || hash;
  if (!stem) return null;
  const base = join(String(dataRoot || ''), '表情包');
  const cands = [
    join(base, 'lib', layer, `${stem}.${ext}`), // ← 真实布局：lib/<layer>/<id>.<ext>
    join(base, 'lib', layer, `${hash}.${ext}`), // 旧写法兜底
    join(base, layer, `${stem}.${ext}`),
    join(base, 'lib', `${stem}.${ext}`),
  ];
  for (const p of cands) {
    if (fsp.existsSync(p)) return p;
  }
  return null;
}

/** 字符 bigram 集合（中文按 2-gram，英文数字也一起） */
function bigrams(s) {
  const t = String(s || '').toLowerCase().replace(/\s+/g, '');
  const out = new Set();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  if (!out.size && t) out.add(t);
  return out;
}

/** Jaccard 相似度 0~1 */
function similarity(a, b) {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.size || !B.size) return 0;
  let hit = 0;
  for (const g of A) if (B.has(g)) hit += 1;
  return hit / (A.size + B.size - hit);
}

/** 随机抽 n 个（Fisher–Yates 取前 n，不改原数组） */
function sample(arr, n) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

// ── 发送冷却（2026-10-16 修 bug：原来按 turnId/targetId 归零，两条都错）──────────
//   · 用 targetId 当归零键 ⇒ 同一个群永远相同 ⇒ 发过一次就**再也不发**；
//   · 用 turnId 归零 ⇒ 一条回复被拆成多个出站块时跨块拦不住 ⇒ **一回两三条就发两张**。
//   改成**时间窗**：同一个会话在 COOLDOWN_MS 内最多发 1 张。既不会漏、也不会重。
let lastSentAt = 0;
let lastSentKey = '';

// ── 诊断日志（append）────────────────────────────────────────────────────
//   ⚠️ 为什么留这个：出站扩展的失败**全是静默的**（异常被吞、找不到文件就 return），
//      真机排查时"没出图"完全看不出卡在哪一步。有它就能一眼定位。
//   路径：{dataRoot}/.qqbot-extensions/data/sticker-semantic-diag.log
//        拿不到 dataRoot 时退到系统临时目录（保证一定写得出去）。
import { appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';

function diag(ctx, step, extra) {
  try {
    const base = String(ctx?.dataRoot || '') || tmpdir();
    const line =
      `[${new Date().toISOString()}] ${step}` + (extra ? ` | ${JSON.stringify(extra)}` : '') + '\n';
    appendFileSync(join(base, '.qqbot-extensions', 'data', 'sticker-semantic-diag.log'), line, 'utf8');
  } catch {
    /* 诊断失败绝不影响出站 */
  }
}

export const name = 'sticker-semantic';

/**
 * ★★ 主入口（2026-10-16 主人定的架构）★★
 *
 *   **出站链和正文唯一的联系，就是"读一眼正文写了什么"。**
 *   读到之后，选图 / 算分 / 发图 **全部丢到后台独立跑**（`ctx.background`），
 *   这里**立刻** `next()` 放行 —— 所以正文的发送速度**永远不会**被配图影响，
 *   图片是事后补发的（走 sendMedia 的"先被动后主动"独立通道）。
 *
 *   老宿主没有 `ctx.background` ⇒ 退回"同步跑完再放行"的旧行为（慢，但能用）。
 */
export default async function onOutbound(ctx, next) {
  // ① 正文发送前（phase='send'）：本示范不改写正文 ⇒ 直接放行。
  //    ⚠️ **绝不能在这里配图**：一段回复有"正文→工具调用→正文"时，每段都走一次这里，
  //       第一段根本不是回合最后一块（主人 2026-10-16 实测抓到）。
  if (ctx?.phase !== 'turnEnd') return next();

  // ② 回合真正结束（phase='turnEnd'）：ctx.text = turnBlocks.last = **权威的最后一块正文**，
  //    而且正文早发完了 ⇒ 丢后台配图，立刻返回。
  //    ⚠️ 丢后台时 `next` 是 undefined，而 pickAndSend 里到处是早期 `return next()`
  //       ⇒ 必须传一个**安全的 next** 进去（实测踩过：`next is not a function`）。
  const safeNext = typeof next === 'function' ? next : () => undefined;
  const bg = ctx?.background;
  if (typeof bg === 'function') {
    bg(() => pickAndSend(ctx, safeNext));
    return safeNext();
  }
  return pickAndSend(ctx, safeNext); // 老宿主兜底
}

/** 真正的配图逻辑（有 ctx.background 时在后台独立跑） */
async function pickAndSend(ctx, next) {
  try {
    const probe = {
      dataRoot: String(ctx?.dataRoot || ''),
      isLastChunk: ctx?.isLastChunk,
      kind: ctx?.kind,
      turnId: ctx?.turnId,
      textLen: String(ctx?.text || '').length,
      segs: Array.isArray(ctx?.segments) ? ctx.segments.length : -1,
      hasSender: !!ctx?.sender,
      hasTarget: !!ctx?.target,
      target: targetKeysOf(ctx), // ← 隔离排查用：本回合目标的两种写法
    };

    // ★★ 诊断分支：无条件发库里第一张（放在最前，连 isLastChunk 都不看）★★
    if (CONFIG.FORCE) {
      diag(ctx, 'force:enter', probe);
      const all = loadItems(ctx.dataRoot);
      const first = all[0];
      const p = first ? fileOf(ctx.dataRoot, first) : null;
      diag(ctx, 'force:probe', { items: all.length, firstId: first?.id, path: p });
      if (p) {
        const ok = await ctx.sendMedia({ path: p });
        diag(ctx, ok ? 'force:sent' : 'force:send-failed', { path: p });
      } else {
        diag(ctx, 'force:no-file');
      }
      return next();
    }

    // ① 只处理"本回合最后一个正文块" —— 否则每块都配图会刷屏
    if (!ctx.isLastChunk) return next();
    if (ctx.kind && ctx.kind !== 'text') return next();

    // ② 开关关了就直通
    const enabled = isEnabled(ctx);
    if (!enabled) {
      diag(ctx, 'skip:disabled', probe);
      return next();
    }

    // ②b ★【隔离设置】★ 2026-10-17 主人定：**只对点名的群/私聊生效**
    //     白名单没这条 ⇒ 直接放行（不配图）。文件不存在 = 空名单 = 谁都不配图。
    //     放在 FORCE 之后：FORCE 只是排障开关，默认 false，不用它做正式判定。
    const allow = scopeAllows(ctx);
    if (!allow.ok) {
      diag(ctx, 'skip:scope', { ...probe, why: allow.why, keys: allow.keys });
      return next();
    }

    // ③ 正文太短 / 已有图（她自己带了 [MEDIA:image]）→ 不掺和
    const text = String(ctx.text || '').replace(/\[MEDIA:[^\]]*\]/g, ' ').trim();
    if (text.length < CONFIG.MIN_TEXT) {
      diag(ctx, 'skip:text-too-short', { ...probe, text });
      return next();
    }
    if (Array.isArray(ctx.segments) && ctx.segments.some((s) => s && s.type === 'media')) {
      diag(ctx, 'skip:already-has-media', probe);
      return next();
    }

    // ④ 发送冷却（**时间窗**，见文件上方注释）—— 同一会话 COOLDOWN_MS 内最多 1 张
    const sentKey = String(ctx.target?.targetId || ctx.target?.peerId || '') || 'unknown';
    if (sentKey === lastSentKey && Date.now() - lastSentAt < CONFIG.COOLDOWN_MS) {
      diag(ctx, 'skip:cooldown', { ...probe, sinceMs: Date.now() - lastSentAt });
      return next();
    }

    // ⑤ 【事故回退 2026-10-16】**池子必须限流**。
    //    原改法想"全库扫 1892 张"，但首次要对全部条目做向量编码（十几~几十秒）
    //    ⇒ 把整条出站链拖死 ⇒ **连正文都发不出去**（主人实测：QQ 里什么都没有）。
    //    现在：池子限流（默认 300，与改造前一致），但**保留**"末句 query / msgText 分离 /
    //    存在性闸门 / 时间窗冷却"这些改造。等做了**向量落盘缓存**再放开全库扫。
    const items = loadItems(ctx.dataRoot);
    if (items.length === 0) {
      diag(ctx, 'skip:no-items', { ...probe, indexFile: join(String(ctx.dataRoot || ''), '表情包', 'index.json') });
      return next();
    }
    // ⑤a query 不用整段：一段话里可能"寒暄+技术+情绪"三件事，向量会被平均掉。
    //     取**末句**（中文按句末标点切），它通常承载最终态度；太短则回退整段。
    const query = pickQuery(text);

    // ══════════════════════════════════════════════════════════════════
    // ⑤b 【主人方案 · 两阶段召回】2026-10-16 定
    //   阶段1：**随机抽 100 张 → 收集它们的"关键词"(tags)** → 跟正文匹配一次，
    //           只选出**最符合的那个关键词**。⇒ 模型/相似度计算量 = 关键词个数（几十个），极快。
    //   阶段2：拿选中的关键词**回整个图库精确搜**（纯字符串 `tags.includes`，零模型开销），
    //           从命中图里挑一张发出去。
    //   为什么这么设计：既避开了"全库 1892 条向量编码"把出站链拖死的事故，
    //   又能让"库里真有那张好图"被捞出来（阶段2 是全库搜索）。
    // ══════════════════════════════════════════════════════════════════
    const samplePool = items.length > CONFIG.POOL ? sample(items, CONFIG.POOL) : items;

    // 收集这批样本的关键词（去重）
    const kwSet = new Set();
    for (const it of samplePool) {
      if (Array.isArray(it.tags)) for (const t of it.tags) {
        const k = String(t || '').trim();
        if (k) kwSet.add(k);
      }
    }
    const kws = [...kwSet];
    if (kws.length === 0) {
      diag(ctx, 'skip:no-keywords', { ...probe, sampled: samplePool.length });
      return next();
    }

    // 给这批**关键词**打分（只算几十~几百个词，快）
    let kwScores = null;
    let scorer = 'bigram';
    try {
      const ob = globalThis[Symbol.for('im-qqbot.outbound')];
      if (ob && typeof ob.embed === 'function') {
        kwScores = await ob.embed(query, kws);
        if (Array.isArray(kwScores) && kwScores.length === kws.length) scorer = 'local-model';
        else kwScores = null;
      }
    } catch {
      kwScores = null;
    }

    let bestKw = null;
    let bestKwScore = 0;
    const all = [];
    for (let i = 0; i < kws.length; i++) {
      const s = kwScores ? Number(kwScores[i]) || 0 : similarity(query, kws[i]);
      all.push(s);
      if (s > bestKwScore) {
        bestKwScore = s;
        bestKw = kws[i];
      }
    }

    // ⑤c **存在性闸门**（作用在"关键词分数"上）：最高分要显著高于本批关键词的分布
    const n = all.length || 1;
    const mean = all.reduce((a, b) => a + b, 0) / n;
    const std = Math.sqrt(all.reduce((a, b) => a + (b - mean) * (b - mean), 0) / n) || 0;
    const gate = mean + CONFIG.GATE_K * std;
    const floor = scorer === 'local-model' ? CONFIG.FLOOR_EMBED : CONFIG.FLOOR_BIGRAM;
    diag(ctx, 'stage1', {
      scorer,
      sampled: samplePool.length,
      kws: kws.length,
      bestKw,
      best: bestKwScore.toFixed(4),
      mean: mean.toFixed(4),
      std: std.toFixed(4),
      gate: gate.toFixed(4),
      floor,
    });
    if (!bestKw) {
      diag(ctx, 'skip:no-best-kw', probe);
      return next();
    }
    if (bestKwScore < floor) {
      diag(ctx, 'skip:below-floor', { bestKw, best: bestKwScore.toFixed(4), floor, scorer });
      ctx.note?.(`表情包：最贴的关键词「${bestKw}」分太低（${bestKwScore.toFixed(3)}），本回合不配图`);
      return next();
    }
    if (bestKwScore < gate) {
      diag(ctx, 'skip:not-salient', { bestKw, best: bestKwScore.toFixed(4), gate: gate.toFixed(4) });
      ctx.note?.(`表情包：关键词「${bestKw}」不够突出（${bestKwScore.toFixed(3)} < ${gate.toFixed(3)}），本回合不配图`);
      return next();
    }

    // ⑥ 【阶段2】用选中的关键词**回全库精确搜**（纯字符串，零模型开销）
    const hits = items.filter((it) => Array.isArray(it.tags) && it.tags.includes(bestKw));
    if (hits.length === 0) {
      diag(ctx, 'skip:no-hit-for-kw', { bestKw });
      return next();
    }
    const best = hits[Math.floor(Math.random() * hits.length)];
    diag(ctx, 'stage2', { kw: bestKw, hits: hits.length, picked: best?.id });

    // ⑥ 发（先被动后主动）；发失败也不影响正文
    const path = fileOf(ctx.dataRoot, best);
    if (!path) {
      diag(ctx, 'skip:file-not-found', { ...probe, id: best?.id, hash: best?.hash, layer: best?.layer, ext: best?.ext });
      return next();
    }
    const ok = await ctx.sendMedia({ path });
    diag(ctx, ok ? 'sent' : 'send-failed', { ...probe, path, kw: bestKw, score: bestKwScore.toFixed(4), scorer });
    if (ok) {
      lastSentAt = Date.now();
      lastSentKey = sentKey;
      ctx.note?.(`表情包：按关键词「${bestKw}」发「${keywordsOf(best).slice(0, 40)}」(分 ${bestKwScore.toFixed(3)}, ${scorer})`);
    }
  } catch (err) {
    // ★ 出站扩展永远不能把消息弄丢：出错就静默放行
    diag(ctx, 'error', { msg: err instanceof Error ? err.message : String(err) });
    ctx?.note?.(`表情包示范出错(已忽略): ${err instanceof Error ? err.message : String(err)}`);
  }
  // 走"丢后台"通道时 next 是 undefined（正文早就放行了）⇒ 安全调用
  return typeof next === 'function' ? next() : undefined;
}
