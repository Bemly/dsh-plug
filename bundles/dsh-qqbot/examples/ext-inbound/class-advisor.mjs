/**
 * class-advisor.mjs — 「辅导员」示例：把群当班级管（2026-10-12）
 *
 * 抄这个文件就能改出自己的群规：它是**四个动作全都用上**的完整样例，
 * 每个动作都标了"为什么必须在这一步"。
 *
 * 放在 `{数据根}/.qqbot-extensions/inbound/class-advisor.mjs`
 * （插件启动时会自动铺一份，只补不覆盖）。
 *
 * ✅ **本示例默认「只观察、不动手」**：`DRY_RUN = true`（见下面「一、可调参数」）。
 *     装上之后它会正常跑，但**只往日志里写"我本来会做什么"**，不会消灭消息、不会禁言、不会改文本。
 *     你先看几天日志（`[class-advisor] DRY` 开头那些行），确认规则符合预期，再把 `DRY_RUN` 改成 `false`。
 *
 *     改成 false 之后就真的会动手，默认规则只有两类，都由关键词/频率触发：
 *       · 广告特征（加微信 / 兼职刷单日赚 / "点击链接" / 短链）→ 消灭 + 临时禁言 10 分钟；
 *       · 同一人 30 秒内连发 8 条 → 消灭 + 临时禁言 10 分钟（阈值见下面 SPAM_*）。
 *     **不确定就先别开**：保持 `DRY_RUN = true`，或把文件名改成 `class-advisor.mjs.bak`
 *     （非 .mjs 不扫描），或把 `AD_MUTE_MINUTES` 设成 0（只删不封）、把 `SPAM_MAX` 调大。
 *     每一次动作（含被白名单/熔断拒绝的）都会写进
 *     `{数据根}/.qqbot-extensions/inbound/.state/audit.jsonl`，随时可回看；
 *     主人（`config.groupAdmin.owners`）**永远不会**被它消灭或禁言（插件强制）。
 *
 * ══════════════════════════════════════════════════════════════════════════
 *  辅导员要的四件事，粒度与位置各不相同：
 *
 *  | 能力 | 粒度 | 本文件在哪做（为什么） |
 *  |---|---|---|
 *  | **禁言群友**（按发送者静默一段时间，跨重启仍有效） | 用户维 | 早挂点，**最前**（名单必须在"要不要回/@没@/冷却"之前生效） |
 *  | **替换/和谐入站文本** | 消息维 | 早挂点，`ctx.rewrite` —— **必须在记群历史之前**，否则库里存的是原文 |
 *  | **强制入站**（不管值不值得回、有没有@、冷却到没到） | 消息维 | 早挂点，`ctx.forceWake`（它同时压过 @门控 与价值评分/冷却） |
 *  | **直接不入站**（消灭：不进历史、不进上下文、不占冷却） | 消息维 | 早挂点，`ctx.annihilate` + **不调 next()** |
 *  | （附加）**@ 覆盖**：引用转发不算 @ | 消息维 | 晚挂点（`export default` / `onDecide`），见同目录 no-wake-on-child-quote.mjs |
 *
 *  ⚠️ **顺序即优先级**（这是本文件最要紧的一条）：
 *     ① 主人指令 → ② **求助关键词（必须写在黑名单判断之前！）** → ③ 广告/刷屏 → ④ 禁言名单 → ⑤ 敏感词改写
 *     把"求助"排在"名单"后面，就会出现"被禁言的人喊救命没人理"——
 *     强唤醒要压过静默，这是主人点名的保命件之一。
 * ══════════════════════════════════════════════════════════════════════════
 *
 * ── 你能用的东西（完整清单见同目录 README.md）──────────────────────────────
 *   ctx.text / ctx.scope / ctx.sender / ctx.senderName / ctx.isOwner / ctx.groupId / ctx.mentions
 *   ctx.quoted.text / .id / .fromSelf            被引原文、被引那条的发送者、是不是她自己说的
 *   ctx.platform.mentioned                        平台 @ 信号（早挂点读不到 ctx.state.mention）
 *   ctx.logger / ctx.dataRoot / ctx.kv.get|set    日志、数据根、每个扩展自己的持久化
 *   ctx.annihilate / ctx.rewrite / ctx.forceWake / ctx.decide
 *   ctx.muteUser / ctx.unmuteUser / ctx.isMuted / ctx.mutedUsers
 *
 * ── 四条保命件（插件侧强制，你写错也兜得住）───────────────────────────────
 *   · 白名单最高优先：主人（`config.groupAdmin.owners`）**永不可被静默/消灭**，
 *     调 `annihilate`/`muteUser` 会被拒 + 告警，消息照常放行；
 *   · 强唤醒优先于静默：`forceWake` 不被 `annihilate` 以外的东西抵消（顺序由你排，见上面 ⚠️）；
 *   · 熔断：本扩展短期内消灭/静默占比过高（>50%）或 10 秒内超过 20 次 ⇒
 *     停掉**本扩展的破坏性动作**（消息照常放行）+ 一条 warn；改文件后 `/tools-reload` 即复位；
 *   · 审计 + 可撤销：每次动作追加一行
 *     `{数据根}/.qqbot-extensions/inbound/.state/audit.jsonl`；
 *     `ctx.muteUser` 随时可以用 `ctx.unmuteUser({ id })` 解掉。
 *
 * ── 本文件**不会被自动铺到你的目录**（2026-10-12 主人定）────────────────────
 *   同目录的 `no-wake-on-child-quote.mjs` 属"装上就该有"的规则，插件首次启动会替你铺一份；
 *   本文件不铺 —— 因为它会**真动手删消息、封人**，不该替你决定。要试就自己拷：
 *     copy 本文件 → `{数据根}/.qqbot-extensions/inbound/class-advisor.mjs`
 *   （拷完 `/tools-reload` 或重启即生效；**记得先留 `DRY_RUN = true` 观察几天**。）
 *
 * ── 它会往你数据目录里写什么（就这两样，别的一样不碰）──────────────────────
 *   · `{数据根}/.qqbot-extensions/inbound/.state/<本文件名>.json`
 *     形状：`{ "mutes": [{ "id", "until", "reason", "by", "at" }], "kv": {} }`
 *     **只在真的禁言/解禁时才写**；`until = 0` 表示永久（`minutes <= 0`）；读名单时惰性清理过期项；
 *     文件坏了当空处理（插件不会因为一个坏 JSON 崩掉）。
 *   · `{数据根}/.qqbot-extensions/inbound/.state/audit.jsonl`
 *     每次真动作（含被白名单/熔断拒绝的）追加一行，摘要截断、512KB 轮转。
 *   ⚠️ **刷屏计数不写盘**（只在内存里存 30 秒窗口）—— 早先版本用 `ctx.kv` 落盘，
 *      而它对每一条消息都会被调到 ⇒ 每条群消息写一次文件。已改掉，这条路径不碰磁盘。
 *   ⚠️ **`DRY_RUN = true` 时上面两个文件都不会出现**（只打日志、不动手）。
 */

/** 日志展示名 */
export const name = 'class-advisor';

// ══════════════════════════════════════════════════════════════
// 一、可调参数（抄去改这里）
// ══════════════════════════════════════════════════════════════

/**
 * ★★ **安全默认：`true` = 只观察不动手**（本文件唯一的"总闸"）★★
 *
 *   true  —— 下面所有**自动规则**（广告/刷屏/禁言名单/敏感词和谐）都只往日志写一行
 *            `[class-advisor] DRY …`，说明"我本来会做什么"，**不消灭、不禁言、不改文本**。
 *           消息照常入站，等于一份"这个规则在我群里会怎么判"的体检报告。
 *   false —— 真的动手。
 *
 *   为什么默认 true：**装上不等于放权**。一个从网上抄来的规则文件不该在你没看过它判断之前
 *   就开始删消息、封人。
 *
 *   推荐节奏：先留 true 观察几天 → 翻日志确认它只在你想拦的那些消息上命中 → 改成 false。
 *
 *   ⚠️ 例外：**主人亲口下的指令不受总闸影响**（下面 ① 的 `/禁言`、`/解禁` 照常执行）——
 *      那是你明确下的令，不是这条规则自己判断的。
 */
let DRY_RUN = true;

/**
 * 运行时切换总闸（`setLive(true)` = 真的动手）；返回"这次之前是不是 live"。
 * 平时用不着 —— 直接改上面那行 `let DRY_RUN` 更直观；
 * 这个出口是给**测试**和"想临时开一下 / 临时关掉"的场景用的。
 */
export function setLive(live) {
  const wasLive = !DRY_RUN;
  DRY_RUN = !live;
  return wasLive;
}

/** 当前是不是"真的动手"（`false` = 只观察不动手） */
export function isLive() {
  return !DRY_RUN;
}

/**
 * **求助关键词** —— 命中就 `forceWake`：不管有没有 @ 她、分数多低、群冷却到没到，都要让她看到。
 * ⚠️ 判断必须放在**禁言名单之前**（见文件头"顺序即优先级"）。
 * 注：`forceWake` 属于"让消息更可能被看见"，不是破坏性动作，**不受 DRY_RUN 影响**（它只会多看见、不会漏看）。
 */
const HELP_KEYWORDS = ['求助', '救命', '急', '报错', '怎么解决', '谁来帮', '帮我看下', '大佬救命', '卡住了'];

/** 广告/刷屏特征（正则）。命中 → 消灭；连续刷屏的还会被临时禁言 */
const AD_PATTERNS = [
  /加\s*微\s*信/i,
  /(?:兼职|刷单|日赚|躺赚|带赚)/,
  /(?:点击|戳)\s*(?:链接|这里)/,
  /https?:\/\/\S*(?:t\.cn|dwz|url\.cn|sourl)/i,   // 短链（自己群里正常的网盘长链不受影响）
];

/** 刷屏判定：同一人 SPAM_WINDOW_MS 内发到 SPAM_MAX 条 → 算刷屏
 *  ⚠️ 阈值刻意保守（30 秒内 8 条）：正常连发几句不会被误伤；真的要灌水才会命中。
 *     觉得太严就调大 SPAM_MAX / 调小窗口，或者干脆把下面那段 `noteAndCheckSpam` 去掉。 */
const SPAM_WINDOW_MS = 30_000;
const SPAM_MAX = 8;

/** 广告初犯禁言多久（分钟）；`<= 0` = 永久。想"只删不封"就把这里设成 0 并删掉 muteUser 那两行 */
const AD_MUTE_MINUTES = 10;

/** 敏感词 → 和谐成 `***`（**改写在记群历史之前**，所以 AI 与历史里看到的都是和谐后的文本） */
const SENSITIVE_WORDS = ['傻逼', '妈的', '滚蛋'];   // ← 按自己群的情况改

/** 手机号打码（11 位，1 开头）—— 群里晒号很常见，顺手和谐掉 */
const PHONE_RE = /(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g;

// ══════════════════════════════════════════════════════════════
// 二、纯函数（可单测、可以单独抄走）
// ══════════════════════════════════════════════════════════════

/** 这条文本是不是在求助？ */
export function isHelpText(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return HELP_KEYWORDS.some((k) => t.includes(k));
}

/** 这条文本像不像广告？ */
export function isAdText(text) {
  const t = String(text ?? '');
  if (!t) return false;
  return AD_PATTERNS.some((re) => re.test(t));
}

/** 和谐敏感词与手机号；没有可和谐的返回 null（省一次 rewrite） */
export function maskText(text) {
  let out = String(text ?? '');
  const before = out;
  for (const w of SENSITIVE_WORDS) {
    if (!w) continue;
    out = out.split(w).join('*'.repeat(w.length));
  }
  out = out.replace(PHONE_RE, '$1****$2');
  return out === before ? null : out;
}

/**
 * 刷屏判定：**只存在内存里**（30 秒的窗口，重启清零完全没影响）。
 *
 * ⚠️ 2026-10-12 改（主人："别给我拉屎"）：原来这里用 `ctx.kv` **落盘**，而这个函数对
 *   **每一条**入站消息都会被调到 ⇒ **每来一条群消息就同步写一次状态文件**。
 *   那既没必要（窗口只有 30 秒，重启还留着它毫无意义），也是在用户数据目录里拉屎。
 *   改成进程内的 Map 之后，**这条路径彻底不碰磁盘**。
 */
const spamHits = new Map();   // senderId -> 最近发言时刻数组

export function noteAndCheckSpam(ctx) {
  const key = String(ctx.sender ?? '');
  const now = Date.now();
  const prev = spamHits.get(key) ?? [];
  const recent = prev.filter((t) => now - t < SPAM_WINDOW_MS);
  recent.push(now);
  spamHits.set(key, recent.slice(-SPAM_MAX));   // 只留最近 SPAM_MAX 个时刻
  // 顺带把"早就不说话了"的人清掉，别让 Map 无限涨（几百人规模也只是个小 Map）
  if (spamHits.size > 500) {
    for (const [k, v] of spamHits) {
      if (!v.some((t) => now - t < SPAM_WINDOW_MS)) spamHits.delete(k);
    }
  }
  return recent.length >= SPAM_MAX;
}

// ══════════════════════════════════════════════════════════════
// 三、早挂点：四件事全在这（记群历史之前）
// ══════════════════════════════════════════════════════════════

/**
 * `onInbound` —— 挂在 **quoteRef 之后、记群历史之前**。
 * 这里做的每一步都会**改变"群里到底存了什么/她到底看不看得到"**，所以要按优先级排好。
 */
export async function onInbound(ctx, next) {
  try {
    const text = String(ctx.text ?? '');

    // ── ① 主人指令（只有主人能下令；`ctx.isOwner` 就是 `config.groupAdmin.owners` 里有没有他）──
    //   用法：主人**回复**某个群友的消息，然后发 `/禁言 30`（分钟；0 或省略 = 永久）。
    //   ⚠️ 注意这里用 `rewrite` 而不是 `annihilate`：**主人的消息永远不被入站扩展吞掉**
    //      （白名单最高优先，引擎发现"消灭被拒"或"没放行主人的消息"会替它放行并告警）。
    //      指令消息改成一行留痕，既不污染上下文、又符合"主人消息必须放行"的规矩。
    const cmd = /^\/禁言\s*(\d+)?\s*$/.exec(text.trim());
    if (cmd && ctx.isOwner) {
      const target = ctx.quoted.id;           // 被回复那条的作者 openid（拿不到是空串）
      const minutes = cmd[1] === undefined ? 0 : Number(cmd[1]);
      if (!target) {
        ctx.logger.warn?.('[class-advisor] /禁言：要**回复**某个群友的消息再发这条指令（拿不到被回复人）');
      } else {
        const m = ctx.muteUser({ id: target, minutes, reason: '主人指令 /禁言' });
        ctx.logger.info?.(`[class-advisor] 主人禁言 ${target}：${m ? (m.until === 0 ? '永久' : minutes + ' 分钟') : '失败(见审计)'}`);
      }
      ctx.rewrite({ text: '（辅导员：禁言指令已处理）', reason: '主人指令' });
      return next();
    }
    // 解禁：`/解禁` + 回复某人
    if (/^\/解禁\s*$/.test(text.trim()) && ctx.isOwner) {
      const target = ctx.quoted.id;
      if (target) ctx.unmuteUser({ id: target });
      ctx.rewrite({ text: '（辅导员：解禁指令已处理）', reason: '主人指令' });
      return next();
    }

    // ── ② 求助优先（**必须写在黑名单判断之前**）──
    //   被禁言的人喊"救命"也要放行：强唤醒优先于静默。
    if (isHelpText(text)) {
      ctx.forceWake({ reason: '求助关键词' });
      ctx.logger.debug?.(`[class-advisor] 求助关键词命中 → 强制入站: "${text.slice(0, 30)}"`);
      return next();     // ★ 仍然往下走（forceWake 只是"必须进站"，不是"拦掉别人"）
    }

    // ── ③ 广告 / 刷屏 → 消灭（顺手临时禁言；白名单与熔断会兜住误伤）──
    if (isAdText(text) || noteAndCheckSpam(ctx)) {
      const why = isAdText(text) ? '广告特征' : `${SPAM_WINDOW_MS / 1000}s 内连发 ${SPAM_MAX} 条`;
      if (DRY_RUN) {
        // 只观察：说清"本来会做什么"，然后把消息放过去（绝不 return）
        ctx.logger.info?.(`[class-advisor] DRY 本来要【消灭${AD_MUTE_MINUTES !== 0 ? ` + 禁言 ${AD_MUTE_MINUTES} 分钟` : ''}】`
          + `（${why}）sender=${ctx.senderName || ctx.sender} text="${text.slice(0, 40)}"`);
      } else {
        if (AD_MUTE_MINUTES !== 0) {
          ctx.muteUser({ minutes: AD_MUTE_MINUTES, reason: `广告/刷屏：${why}` });
        }
        ctx.annihilate({ reason: `广告/刷屏：${why}` });
        return;          // ★ 不调 next() = 不进群历史、不进上下文、不占群冷却
      }
    }

    // ── ④ 禁言名单 → 静默（名单是持久的，重启仍在；`isMuted()` 缺省查当前发送者）──
    const muted = ctx.isMuted();
    if (muted) {
      const left = muted.permanent ? '永久' : `还剩 ${muted.remainingMinutes} 分钟`;
      if (DRY_RUN) {
        ctx.logger.info?.(`[class-advisor] DRY 本来要【静默】sender=${ctx.senderName || ctx.sender}`
          + `（禁言中 · ${left} · ${muted.reason ?? '未写原因'}）`);
      } else {
        ctx.annihilate({ reason: `禁言中（${left}）：${muted.reason ?? '未写原因'}` });
        return;          // ★ 同样是不调 next()
      }
    }

    // ── ⑤ 敏感词/手机号 → 改写（**必须在记群历史之前**：库里存的就是和谐后的文本）──
    const masked = maskText(text);
    if (masked !== null) {
      if (DRY_RUN) {
        ctx.logger.info?.(`[class-advisor] DRY 本来要【改写】"${text.slice(0, 40)}" → "${masked.slice(0, 40)}"`);
      } else {
        ctx.rewrite({ text: masked, reason: '敏感词/手机号和谐' });
        ctx.logger.debug?.(`[class-advisor] 已和谐入站文本（历史与上下文都用改后文本）`);
      }
    }
  } catch {
    /* 兜底：本扩展出任何问题都绝不影响主链（引擎也还有一层 try/catch） */
  }
  return next();
}

// ══════════════════════════════════════════════════════════════
// 四、可选：晚挂点（@ 覆盖）
// ══════════════════════════════════════════════════════════════
// 本文件**故意不导出**晚挂点：上面四件事全都必须发生在"记群历史之前"。
// 需要"引用转发不算 @"这类**改 @ 判定**的规则，请照抄同目录的
// no-wake-on-child-quote.mjs（它同时演示了两个挂点），或者在本文件里额外加：
//
// export default async function onDecide(ctx, next) {
//   if (ctx.state?.mention?.wasMentioned === true && ctx.quoted.fromSelf === false && /【子会话/.test(ctx.quoted.text)) {
//     ctx.decide({ mention: 'ignore', reason: '引用的是子会话转发' });
//   }
//   return next();
// }
