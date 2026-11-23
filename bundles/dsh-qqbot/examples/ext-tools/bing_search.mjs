/**
 * bing_search.mjs — 用 Bing 搜网页, 返回 标题 / 链接 / 摘要 / 来源域名
 *
 * 这是一个"纯工具型"扩展示例: 不依赖 env.qq、不碰会话状态, 只把一件事做好 —— 搜索。
 * 它顺手示范了三个**通用**技巧, 写别的检索类工具时可以直接抄:
 *
 *   ① 查询词卫生: 把 "<词>是什么 / 是什么意思 / 怎么用" 这类长尾巴剥掉再搜。
 *      长词形查询在搜索引擎里常被切碎(只抓住其中一两个字), 剥掉后结果会明显更准。
 *   ② 相关性自检 + 自动回退: 多词混排(如 "DeepSeek Harness 插件市场 dshmarket")很容易搜回一堆
 *      不沾边的东西。这里先算一次命中率, 不过关就依次回退 —— 加引号做完全匹配 → 只搜最长的那个
 *      核心词, 并把"这次实际用了哪一档"写在结果开头, 不让人误信。
 *   ③ 结果带来源域名 + 同域限流: 每条标出站点, 同一域名最多 3 条; 既能判断信息源, 也防刷屏。
 *
 * 装配: 放进 {数据根}/.qqbot-extensions/tools/ 后发 /tools-reload(等价于让 AI 调 tools_reload);
 *       插件会把工具注册进所有活会话, 之后新建的会话自动带上。
 * 网络: 先走 Bing 的 RSS 端点(?format=rss, 解析最稳、不需要 key), 失败再回退 HTML 抓取;
 *       国内可直连 cn.bing.com。
 * 暴露: 见下方 expose —— 声明 'all' 即对全部会话可见(含 web / 终端等非 QQ 通道); 删掉该行就只在 QQ 会话可见。
 */

const DEFAULT_COUNT = 8;
const MAX_COUNT = 20;
const TIMEOUT_MS = 12000;
const SNIPPET_CHARS = 180;
const PER_DOMAIN_MAX = 3;
/** 相关性门槛: 低于它才认为"这批结果跟查询不沾边", 触发回退 */
const REL_FLOOR = 0.34;

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/** 查询词尾巴(疑问/解释性后缀), 剥掉后再搜 */
const TAIL_RE =
  /(是什么意思啊?|是怎么个意思|什么意思啊?|是啥意思|是什么样子的?|是什么样的|是什么|是啥|是哪个|是哪种|怎么使用呀?|怎么使用|如何使用|该咋用|怎么用|用法|怎么样|如何|为什么|为啥|原因是什么|有哪些|有什么|的科普|科普一下|科普|的解释|的解释是|的解释吗|介绍一下|介绍下|介绍|的定义|解释)$/;

const PREFIX_RE =
  /^(请问一下|请问|帮我查一下|帮我查|帮忙查一下|帮忙查|查一下|查查|搜一下|搜搜|搜索一下|搜索|search)[\s:：,，]*/i;

const ENTITY_MAP = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', ensp: ' ', emsp: ' ',
  middot: '·', hellip: '…', mdash: '—', ndash: '–', ldquo: '“', rdquo: '”',
  lsquo: '‘', rsquo: '’', laquo: '«', raquo: '»', '#39': "'", '#x27': "'", '#x2F': '/',
};

function decodeEntities(input) {
  const s = String(input ?? '');
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-zA-Z#0-9]+);/g, (m, name) => (name in ENTITY_MAP ? ENTITY_MAP[name] : m));
}

function plain(input) {
  return decodeEntities(String(input ?? '').replace(/<!\[CDATA\[|\]\]>/g, '').replace(/<[^>]*>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
}

function clip(s, n) {
  const t = String(s ?? '').trim();
  return t.length > n ? t.slice(0, n) + '…' : t;
}

function domainOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

/** 解开 Bing 的跳转包装(www.bing.com/ck/a?...&u=a1<base64url>) */
function unwrapBingLink(url) {
  const u = String(url ?? '').trim();
  try {
    const parsed = new URL(u);
    if (!/(^|\.)bing\.com$/i.test(parsed.hostname)) return u;
    const b64 = parsed.searchParams.get('u');
    if (!b64 || !b64.startsWith('a1')) return u;
    const raw = b64.slice(2).replace(/-/g, '+').replace(/_/g, '/');
    const pad = raw + '='.repeat((4 - (raw.length % 4)) % 4);
    const decoded = Buffer.from(pad, 'base64').toString('utf8');
    return /^https?:\/\//i.test(decoded) ? decoded : u;
  } catch {
    return u;
  }
}

/** 查询词卫生: 剥前缀、去问号、循环剥疑问尾巴 —— 至少留 2 个字 */
function sanitizeQuery(raw) {
  let q = String(raw ?? '').trim();
  q = q.replace(PREFIX_RE, '').replace(/[?？。！!]+$/g, '').trim();
  let guard = 0;
  let changed = true;
  while (changed && guard++ < 8) {
    changed = false;
    const next = q.replace(TAIL_RE, '').trim();
    if (next !== q && next.length >= 2) {
      q = next;
      changed = true;
    }
  }
  q = q.replace(/[?？]+$/g, '').trim();
  return q;
}

/** 拆词: 空白/逗号/加号/竖线分隔; 只留长度 >= 2 的片段 */
function tokenize(q) {
  return String(q ?? '')
    .toLowerCase()
    .split(/[\s,，、+|｜/]+/)
    .map((t) => t.replace(/^["'“”]+|["'“”]+$/g, '').trim())
    .filter((t) => t.length >= 2);
}

/**
 * 相关性: 有多少条结果的标题/摘要里真的出现了查询片段。
 * 词多的时候不能"命中一个就算" —— "DeepSeek Harness 插件市场 dshmarket" 只命中
 * 一个 deepseek 就判合格的话, 回退逻辑永远不会触发, 用户拿到的还是官网首页那种泛结果。
 * 所以: 词 >= 3 个时要求至少命中 2 个, 且必须命中一个"强词"(长英文词 / 3 字以上中文)。
 */
function relevance(query, results) {
  const toks = tokenize(query);
  if (toks.length === 0) return results.length ? 1 : 0;
  if (results.length === 0) return 0;
  const strong = toks.filter((t) => t.length >= 5 || /[\u4e00-\u9fa5]{3,}/.test(t));
  const need = toks.length >= 3 ? 2 : 1;
  let hit = 0;
  for (const r of results) {
    const hay = `${r.title} ${r.snippet}`.toLowerCase();
    const matched = toks.filter((t) => hay.includes(t));
    const strongOk = strong.length === 0 || strong.some((t) => hay.includes(t));
    if (matched.length >= need && strongOk) hit++;
  }
  return hit / results.length;
}

function parseRss(xml) {
  const out = [];
  const items = xml.match(/<item>[\s\S]*?<\/item>/gi) || [];
  for (const item of items) {
    const title = plain((item.match(/<title[^>]*>([\s\S]*?)<\/title>/i) || [])[1] || '');
    const link = unwrapBingLink(
      decodeEntities(
        ((item.match(/<link>([\s\S]*?)<\/link>/i) || [])[1] || '').replace(/<!\[CDATA\[|\]\]>/g, '').trim()
      )
    );
    const snippet = plain((item.match(/<description[^>]*>([\s\S]*?)<\/description>/i) || [])[1] || '');
    if (title && /^https?:\/\//i.test(link)) out.push({ title, url: link, snippet });
  }
  return out;
}

function parseHtml(html) {
  const out = [];
  const blocks = html.match(/<li class="b_algo"[\s\S]*?<\/li>/gi) || [];
  for (const block of blocks) {
    const a = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!a) continue;
    const url = unwrapBingLink(decodeEntities(a[1]));
    const title = plain(a[2]);
    const p =
      block.match(/<p[^>]*>([\s\S]*?)<\/p>/i) ||
      block.match(/<div class="b_caption"[^>]*>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/i);
    const snippet = plain(p ? p[1] : '');
    if (title && /^https?:\/\//i.test(url)) out.push({ title, url, snippet });
  }
  return out;
}

async function fetchWithTimeout(url) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: ctl.signal,
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
    });
    const text = await res.text();
    return { status: res.status, text };
  } finally {
    clearTimeout(timer);
  }
}

/** 依次尝试 RSS / HTML 两个端点, 返回 { results, endpoint, errors } */
async function searchBing(query, count, mkt) {
  const q = encodeURIComponent(query);
  const tries = [
    { url: `https://cn.bing.com/search?q=${q}&format=rss&count=${count}&mkt=${mkt}`, kind: 'rss' },
    { url: `https://www.bing.com/search?q=${q}&format=rss&count=${count}&mkt=${mkt}`, kind: 'rss' },
    { url: `https://cn.bing.com/search?q=${q}&count=${count}&mkt=${mkt}&setlang=zh-CN`, kind: 'html' },
    { url: `https://www.bing.com/search?q=${q}&count=${count}&mkt=${mkt}`, kind: 'html' },
  ];
  const errors = [];
  for (const t of tries) {
    try {
      const { status, text } = await fetchWithTimeout(t.url);
      if (status !== 200 || !text) {
        errors.push(`${t.kind}:${status}`);
        continue;
      }
      const results = t.kind === 'rss' ? parseRss(text) : parseHtml(text);
      if (results.length > 0) return { results, endpoint: t.kind, errors };
      errors.push(`${t.kind}:0 条`);
    } catch (e) {
      errors.push(`${t.kind}:${e?.name === 'AbortError' ? '超时' : (e?.message ?? String(e))}`);
    }
  }
  return { results: [], endpoint: '', errors };
}

function dedupe(results) {
  const seenUrl = new Set();
  const perDomain = new Map();
  const out = [];
  for (const r of results) {
    const key = r.url.replace(/[#?].*$/, '').replace(/\/$/, '').toLowerCase();
    if (seenUrl.has(key)) continue;
    const dom = domainOf(r.url);
    const used = perDomain.get(dom) || 0;
    if (dom && used >= PER_DOMAIN_MAX) continue;
    seenUrl.add(key);
    perDomain.set(dom, used + 1);
    out.push({ ...r, domain: dom || '(未知来源)' });
  }
  return out;
}

/** 一轮搜索 + 打分 */
async function attempt(query, label, count, mkt) {
  const { results, endpoint, errors } = await searchBing(query, count, mkt);
  const list = dedupe(results).slice(0, count);
  return { label, query, list, endpoint, errors, rel: relevance(query, list) };
}

/**
 * 带自检的搜索:
 *   1) 卫生处理后的查询
 *   2) 相关性不过关 → 加引号完全匹配
 *   3) 还不过关 → 只搜最长的那个核心词
 * 取相关性最高的一轮结果返回。
 */
async function searchSmart(baseQuery, count, mkt) {
  const tried = [];
  let best = await attempt(baseQuery, '主查询', count, mkt);
  tried.push(best);
  if (best.list.length > 0 && best.rel >= REL_FLOOR) return { best, tried, fallback: false };

  const quoted = await attempt(`"${baseQuery}"`, '加引号', count, mkt);
  tried.push(quoted);
  if (quoted.list.length > 0 && quoted.rel > best.rel) best = quoted;
  if (best.list.length > 0 && best.rel >= REL_FLOOR) return { best, tried, fallback: true };

  const toks = tokenize(baseQuery).sort((a, b) => b.length - a.length);
  if (toks.length > 1) {
    const core = await attempt(toks[0], `核心词 ${toks[0]}`, count, mkt);
    tried.push(core);
    if (core.list.length > 0 && core.rel >= best.rel) best = core;
  }
  return { best, tried, fallback: true };
}

export default {
  name: 'bing_search',
  /**
   * 暴露范围(dsh-qqbot 1.8.0+)：'all' = 注册进全部会话, 不止 QQ 通道 ——
   * web、终端等非 QQ 会话也能拿到本工具; 不写/写 'qq' 就只在 QQ 会话可见。
   * (注册名会自动带人设归属, 如 bing_search__whale-girl)
   */
  expose: 'all',
  description:
    '用 Bing 搜网页, 返回标题+链接+摘要+来源域名。查询词已做卫生处理(自动剥掉"是什么/是什么意思"这类长尾巴再搜, 长词形查询不再被切碎); 多词混排导致结果跑偏时会自动回退(加引号/只搜核心词)并注明。查事实/梗/人物/新闻/资料时用它, 比模型记忆可靠。',
  inputSchema: {
    query: { type: 'string', required: true, description: '搜索词, 越短越准, 如 "性转马尔福"' },
    count: { type: 'integer', description: `返回条数, 默认 ${DEFAULT_COUNT}, 上限 ${MAX_COUNT}` },
    site: { type: 'string', description: '限定站点, 如 zh.moegirl.org.cn(会拼成 site:xxx 前缀)' },
    quote: { type: 'boolean', description: 'true=直接给查询词加英文双引号做完全匹配' },
    raw: { type: 'boolean', description: 'true=不做查询词卫生, 原样搜(排查对比用)' },
    mkt: { type: 'string', description: '市场/语言, 默认 zh-CN, 查英文资料可传 en-US' },
  },
  run: async (args) => {
    const a = args || {};
    const original = String(a.query ?? '').trim();
    if (!original) return { ok: false, msg: '缺少 query(要搜什么?)' };

    let used = a.raw ? original : sanitizeQuery(original);
    if (!used || used.length < 2) used = original;
    if (a.site) used = `site:${String(a.site).trim()} ${used}`;
    if (a.quote && !used.startsWith('"')) used = `"${used}"`;

    const n = Math.max(1, Math.min(MAX_COUNT, Math.round(Number(a.count) || DEFAULT_COUNT)));
    const mkt = String(a.mkt || 'zh-CN').trim() || 'zh-CN';

    const { best, fallback } = await searchSmart(used, n, mkt);

    if (!best.list.length) {
      return {
        ok: false,
        msg: `Bing 没有可用的结果(查询词: "${used}")。尝试记录: ${best.errors.join('; ') || '无'}\n换个更短的核心词再试一次。`,
      };
    }

    const notes = [];
    if (used !== original) notes.push(`卫生处理: "${original}" → "${used}"`);
    if (fallback) notes.push(`已自动回退, 实际用的是【${best.label}: ${best.query}】`);
    if (best.rel < REL_FLOOR) {
      notes.push(
        fallback
          ? `按核心词的相关性约 ${Math.round(best.rel * 100)}%(有些结果没直接提到该词), 自行判断够不够用`
          : `相关性偏低(${Math.round(best.rel * 100)}% 命中), 结果可能不沾边, 建议换更短的核心词`
      );
    }

    const lines = [
      `Bing 搜到 ${best.list.length} 条(${notes.length ? notes.join('；') : '主查询直出'}；${(best.endpoint || 'rss').toUpperCase()} 通道):`,
    ];
    best.list.forEach((r, i) => {
      lines.push(`${i + 1}. [${r.domain}] ${r.title}`);
      lines.push(`   ${r.url}`);
      if (r.snippet) lines.push(`   ${clip(r.snippet, SNIPPET_CHARS)}`);
    });
    return { ok: true, msg: lines.join('\n') };
  },
};
