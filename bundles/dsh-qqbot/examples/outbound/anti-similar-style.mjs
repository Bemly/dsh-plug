/**
 * anti-similar-style.mjs — 【出站扩展】检查回复首尾 2 字相似度，防止每句话风格雷同（如句句带 www）
 *
 * 规则：
 * - 按每个群/私聊会话独立记录最近 5 条已发送正文的「开头 2 字」与「结尾 2 字」（忽略 [rf:]、<@>、图片标记及前后空白/标点）。
 * - 若新回复的开头 2 字或结尾 2 字与最近 5 条中任意一条相同，则：
 *   1. 调用 ctx.annihilate() 拒绝发送到 QQ；
 *   2. 调用 ctx.appendWake() 把具体原因反馈给模型，要求换一种句式/语气重写。
 * - 防死循环：同一会话连续拦截最多 2 次，第 3 次自动放行并清零计数。
 */

export const name = 'anti-similar-style';

const CONFIG = {
  enabled: true,
  /** 每个会话保留最近多少条历史用于比对 */
  historySize: 5,
  /** 同一会话连续拦截上限（防死循环） */
  maxConsecutiveRejects: 2,
};

/** @type {Map<string, { recent: Array<{ head2: string, tail2: string, sample: string }>, rejects: number }>} */
const sessionState = new Map();

/** 剥离控制标签、图片与首尾标点，提取用于比对的纯正文 */
function normalizeForCheck(raw) {
  let s = String(raw ?? '');
  // 去掉引用、@、富媒体、markdown 图片
  s = s
    .replace(/\[rf:[^\]]+\]/gi, ' ')
    .replace(/<@[^>]+>/g, ' ')
    .replace(/<qqbot-at-everyone\s*\/?>/gi, ' ')
    .replace(/\[MEDIA:[^\]]+\]/gi, ' ')
    .replace(/!\[[^\]]*\]\([^)]+\)/g, ' ')
    .trim();
  // 去掉首尾常见标点与空白，避免 "www~" / "www！" 绕过检查
  const edgePunct = /^[\s~～!！?？。.,，、…·\-—_'"“”‘’()（）【】\[\]]+|[\s~～!！?？。.,，、…·\-—_'"“”‘’()（）【】\[\]]+$/g;
  s = s.replace(edgePunct, '').trim();
  return s;
}

function getKey(ctx) {
  const scope = String(ctx.target?.scope ?? 'unknown');
  const peerId = String(ctx.target?.peerId ?? ctx.turnId ?? 'default');
  return `${scope}:${peerId}`;
}

export default async function onOutbound(ctx, next) {
  if (!CONFIG.enabled) return next();
  if (ctx.phase !== 'send') return next();
  if (ctx.source !== 'assistant/message') return next();

  const rawText = String(ctx.text ?? '').trim();
  if (!rawText) return next();

  const clean = normalizeForCheck(rawText);
  // 少于 2 个有效字符（如单字、纯图片/表情）不拦截
  const chars = Array.from(clean);
  if (chars.length < 2) return next();

  const head2 = chars.slice(0, 2).join('').toLowerCase();
  const tail2 = chars.slice(-2).join('').toLowerCase();

  const key = getKey(ctx);
  let st = sessionState.get(key);
  if (!st) {
    st = { recent: [], rejects: 0 };
    sessionState.set(key, st);
  }

  const headHit = st.recent.find((r) => r.head2 === head2);
  const tailHit = st.recent.find((r) => r.tail2 === tail2);

  if ((headHit || tailHit) && st.rejects < CONFIG.maxConsecutiveRejects) {
    st.rejects += 1;

    const reasons = [];
    if (headHit) {
      reasons.push(`开头两字「${head2}」与你刚才发过的「${headHit.sample}」重复`);
    }
    if (tailHit) {
      reasons.push(`结尾两字「${tail2}」与你刚才发过的「${tailHit.sample}」重复`);
    }
    const reasonText = reasons.join('；');

    try {
      ctx.logger?.info?.(
        `[anti-similar-style] 拦截相似回复(${key}, 第${st.rejects}次): "${rawText.slice(0, 40)}" | ${reasonText}`
      );
    } catch { /* ignore */ }

    const killed = ctx.annihilate(`风格重复: ${reasonText}`);
    if (killed && typeof ctx.appendWake === 'function') {
      const wakeMsg = [
        `[系统风格检查 · 已拒绝发送]`,
        `你刚才准备发出的消息「${rawText.slice(0, 60)}」没有发出去。`,
        `拒绝原因：${reasonText}。`,
        `请立刻换一种完全不同的开头、结尾和表达方式重新回复（不要每句话都带 www 或重复相同口癖）。`,
      ].join('\n');
      try {
        await ctx.appendWake(wakeMsg);
      } catch (err) {
        ctx.logger?.warn?.(
          `[anti-similar-style] appendWake 失败: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return;
  }

  // 放行：记录历史并清零连续拦截计数
  st.rejects = 0;
  st.recent.push({
    head2,
    tail2,
    sample: clean.slice(0, 24),
  });
  if (st.recent.length > CONFIG.historySize) {
    st.recent.shift();
  }

  return next();
}
