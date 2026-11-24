/**
 * irritation-meter.mjs — 【入站扩展】同一人短时间高频搭话 → 累积"烦躁感"（20 分钟衰减归零）
 *
 * 主人 2026-11-24 定的语义：
 *   1) 同一个人 120 秒内第 3 条起，每条给烦躁值 +1；
 *   2) 烦躁值随时间线性衰减，20 分钟没有新增就归零（读取时按时间戳折算，无需定时器）；
 *   3) ≥2 分：注入烦躁指数，让模型结合上下文判断对方是否在跟 bot 说话以及是否要回应；
 *   4) ≥4 分：注入“被单方面缠住”指数，由模型判断是否真的针对 bot 并构成单方面缠住；
 *   5) ≥6 分（上限）：不搭理这个人 —— `ctx.decide({mention:'ignore'})`，不唤醒、消息照常进
 *      群历史，衰减回落到阈值以下自动恢复。
 *
 * 例外：被 @ / 主人本人的消息永不 ignore（该回还得回），只照常累积与提示。
 * 状态：{dataRoot}/.qqbot-extensions/data/irritation.json（原子写 + 自动清理不活跃项）。
 * 挂点：早挂点 onInbound（记 hits 与 ignore 判定必须在门控之前）。
 */

export const name = 'irritation-meter';

import { readFileSync, writeFileSync, mkdirSync, renameSync } from 'node:fs';
import { join } from 'node:path';

const CONFIG = {
  enabled: true,
  windowSec: 120,          // 连发判定窗口
  freeHits: 2,             // 窗口内前几条不记烦躁值
  decayMin: 20,            // 衰减归零时间
  perHit: 1,               // 每条超窗连发记多少分
  nagSuffixAt: 2,          // L1: 注入烦躁指数，上下文判断
  fedUpAt: 4,              // L2: 注入单方面缠住指数，上下文判断
  ignoreAt: 6,             // L3: 不搭理
  suffixCooldownSec: 90,   // L1 提示最小间隔（silentInto 计入破坏性熔断，必须节流）
  fedUpCooldownMin: 5,     // L2 提示最小间隔
  maxKeys: 400,            // 状态表最多留多少个人
};

// 注入给她看的状态提示（不进群、只是提示，别原样念出去）
const WORDING = {
  tail(who, count, score) {
    return `【烦躁 ${score}/${CONFIG.ignoreAt}】${who} 这两分钟已经连着发了 ${count} 条。`
      + '请结合当前上下文判断，这些消息是否是在跟 bot 说话、是否已经造成打扰；再决定要不要回应以及回应语气。';
  },
  fedUp(who, score) {
    return `【被单方面缠住 ${score}/${CONFIG.ignoreAt}】这段时间 ${who} 消息频繁，但对象可能是 bot，也可能是其他人。`
      + '请结合上下文判断是否真的在跟 bot 说话、是否构成单方面缠住，再决定是否回应。';
  },
  footer: '（以上是插件给她的状态提示，不是群友说的话，也别原样念到群里。）',
};

let cache = null;
let cachePath = '';

function tablePath(dataRoot) {
  return join(dataRoot, '.qqbot-extensions', 'data', 'irritation.json');
}

function readTable(path) {
  if (cache && cachePath === path) return cache;
  try {
    cache = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    cache = {};
  }
  if (!cache || typeof cache !== 'object') cache = {};
  cachePath = path;
  return cache;
}

function lastOf(e) {
  return Math.max(...(e?.hits ?? []).map((h) => h?.t ?? 0), e?.lastNagAt ?? 0, e?.lastSuffixAt ?? 0);
}

function writeTable(path, table, now) {
  try {
    const win = (CONFIG.decayMin + 5) * 60_000;
    for (const k of Object.keys(table)) {
      const e = table[k];
      if (!e || !Array.isArray(e.hits)) { delete table[k]; continue; }
      e.hits = e.hits.filter((h) => now - (h?.t ?? 0) <= win);
      if (!e.hits.length && now - lastOf(e) > win) delete table[k];
    }
    const keys = Object.keys(table);
    if (keys.length > CONFIG.maxKeys) {
      keys.sort((a, b) => lastOf(table[a]) - lastOf(table[b]));
      for (const k of keys.slice(0, keys.length - CONFIG.maxKeys)) delete table[k];
    }
    mkdirSync(path.slice(0, path.lastIndexOf('/')), { recursive: true });
    const tmp = path + '.tmp';
    writeFileSync(tmp, JSON.stringify(table), 'utf8');
    renameSync(tmp, path);
    cache = table;
    cachePath = path;
  } catch { /* 写失败只影响本扩展判断，绝不挡入站 */ }
}

/** 衰减后的当前烦躁值 */
function scoreOf(e, now) {
  const win = CONFIG.decayMin * 60_000;
  let s = 0;
  for (const h of e?.hits ?? []) {
    const age = now - (h?.t ?? now);
    if (age < 0 || age > win) continue;
    s += (h?.v ?? CONFIG.perHit) * (1 - age / win);
  }
  return Math.max(0, Math.round(s * 100) / 100);
}

export async function onInbound(ctx, next) {
  if (!CONFIG.enabled) return next();
  try {
    const dataRoot = ctx?.dataRoot;
    const scope = ctx?.scope;
    const sender = String(ctx?.sender ?? '');
    const groupId = String(ctx?.groupId ?? '');
    if (!dataRoot || scope !== 'group' || !sender || !groupId) return next();
    if (ctx?.isOwner === true) return next();   // 主人刷屏不算烦

    const now = Date.now();
    const path = tablePath(dataRoot);
    const table = readTable(path);
    const key = `${groupId}|${sender}`;
    const e = (table[key] ??= { hits: [], lastNagAt: 0, lastSuffixAt: 0 });
    e.hits = e.hits.filter((h) => now - (h?.t ?? 0) <= CONFIG.decayMin * 60_000);

    const inWindow = e.hits.filter((h) => now - (h?.t ?? 0) <= CONFIG.windowSec * 1000).length;
    e.hits.push({ t: now, v: inWindow >= CONFIG.freeHits ? CONFIG.perHit : 0 });

    const score = scoreOf(e, now);
    const disp = Math.round(score * 10) / 10;
    const who = String(ctx?.senderName ?? '') || '一位群友';
    const mentioned = ctx?.platform?.mentioned === true;
    const msgs = [];

    if (score >= CONFIG.ignoreAt && !mentioned) {
      ctx.decide?.({
        mention: 'ignore',
        reason: `${who} 短时间内连发 ${inWindow + 1} 条，她这轮先不接（烦躁 ${disp}/${CONFIG.ignoreAt}）`,
      });
      ctx.logger?.debug?.(`[irritation] ignore ${who} score=${score}`);
      writeTable(path, table, now);
      return next();
    }

    if (score >= CONFIG.nagSuffixAt && now - (e.lastSuffixAt ?? 0) > CONFIG.suffixCooldownSec * 1000) {
      e.lastSuffixAt = now;
      msgs.push(WORDING.tail(who, inWindow + 1, disp));
    }
    if (score >= CONFIG.fedUpAt && now - (e.lastNagAt ?? 0) > CONFIG.fedUpCooldownMin * 60_000) {
      e.lastNagAt = now;
      msgs.push(WORDING.fedUp(who, disp));
    }
    if (msgs.length) {
      ctx.silentInto?.({
        text: `${msgs.join('\n')}\n${WORDING.footer}`,
        reason: `irritation score=${score}`,
      });
      ctx.logger?.debug?.(`[irritation] 注入提示 ${who} score=${score}`);
    }
    writeTable(path, table, now);
  } catch { /* 任何异常都不能挡住入站 */ }
  return next();
}

/** 晚挂点留空位（以后要按 ctx.state.mention 复盘再补） */
export default async function irritationMeterLate(ctx, next) {
  return next();
}
