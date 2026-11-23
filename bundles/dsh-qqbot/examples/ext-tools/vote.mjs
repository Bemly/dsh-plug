import { join } from 'node:path';
import { readdirSync, readFileSync } from 'node:fs';

/**
 * vote.mjs — 「群投票」扩展工具 v3（2026-10-08）
 *
 * v3（主人当天的第三轮反馈）：
 *   ① **中途回执极简** —— 投一票只回「「C. 还行」+1 票」，不再甩整张票数表；
 *      完整结算**只在结束时**给（结束按钮 / action=end）；
 *   ② **允许多选** —— 同一个人可以点多个选项（想全投也行）；
 *   ③ **同一按钮只能投一次** —— 重复点同一个按钮回「你已经投过这一项了」；
 *   ④ 卡片**最后一行加「✋ 结束投票」按钮** —— 任何群友点一下就能结算（结算会发到群里并通知 AI）；
 *      因此选项上限调整为 **20 个**（4 行 × 5 列，第 5 行留给结束按钮）。
 *
 * v2（保留）：多投票并存（V1/V2…）、中途加选项（action=add，补发新卡、旧卡仍可用）、
 *             定时结束（minutes）、status 查票数、结束时 appendWake 通知 AI。
 *
 * 安装：复制到 `{数据根}/.qqbot-extensions/tools/vote.mjs`，然后 `tools_reload`（或重启宿主）。
 *
 * 用法（AI 侧）：
 *   vote {action:'start',  topic:'今晚吃什么', options:'火锅|烧烤|白饭'}
 *   vote {action:'add',    voteId:'V1', options:'泡面'}
 *   vote {action:'status', voteId:'V1'}
 *   vote {action:'end',    voteId:'V1'}
 *   vote {action:'start',  topic:'周末去哪', options:'爬山|宅家', minutes:30}
 *
 * 底层依赖（插件侧，见维护手册 §11.32）：env.registerInteractionCard 登记卡片；
 * 按钮 action.type=1、data=`ext:vote:<投票号>:<下标或 e>`；导出 onInteraction 收点击。
 */

const MAX_OPTIONS = 20;                       // 4 行 × 5 列（第 5 行留给「结束投票」）
const PER_ROW = 5;
const LETTERS = 'ABCDEFGHIJKLMNOPQRST';       // 20 个字母
const END_BTN = 'e';                          // 结束按钮的 buttonId
const TOOL = 'vote';
const SEP = /[|｜,，]/;

/**
 * ★ 2026-10-16 主人要求：「结束投票」按钮**只有主人能点**，别人点了不生效。
 * 之前任何群友点一下就结算（主人开的那次被秒结束）。
 * 白名单写在这里；要加人往数组里加 openid 即可。
 */
const END_ALLOWED_OPENIDS = [
  'B901EA3CE83714B5719E96A5938F6C37',         // 做早饭（群主/主人）
  'E9020753E73AD84C10A79B6006E96C63',         // 做早饭（旧号，一并放行）
];
/** 点击者是否有权结束。空值一律拒绝（fail-closed）。 */
function canEnd(openid) {
  const id = String(openid ?? '').trim();
  return id !== '' && END_ALLOWED_OPENIDS.includes(id);
}

/**
 * ★ 2026-10-16 主人要求：投票记录要带**真实用户名**（谁投了什么、谁点的结束）。
 *
 * 取名字的优先级（先官方、后兜底），跟插件自己的 botplay/memberName 同源：
 *   ① `ctx.user.name` —— 插件官方契约（docs/extension-contract.md）：
 *      身份三件套 `env.user.openid / .name / .isOwner`，按钮回调侧同样可读。
 *   ② **群成员台账** `{dataRoot}/表情包/group-members.jsonl` ——
 *      这就是插件 `Botplay.memberName()` 查昵称时读的那份台账（见 dist/features/botplay.js:1016
 *      「台账(host 侧与 dock 禁言同源: dataDir=表情包目录, 同 group-members.jsonl)」）。
 *      每行 `{ts, gid, mid, name}`：mid=openid、name=**真实 QQ 昵称**（不是 openid）。
 *      后写的行覆盖先写的 ⇒ 自然取到最新昵称。
 *   ③ 回落 `msg-index` 的 openid→昵称表（`{dataRoot}/.qqbot/msg-index/<scope>_<peerId>/refs.json`
 *      里 `entries[].s`=openid、`n`=昵称）——台账里还没出现的人（从没说过话）用它兜。
 *   ④ 再不行才显示 openid 前 6 位；全程不抛错（名字只是锦上添花，别拖垮投票）。
 */
function dataRootOf(env) {
  return env?.dataRoot || env?.caps?.dataRoot || process.cwd();
}
/** 台账路径：{dataRoot}/表情包/group-members.jsonl */
function ledgerPath(env) {
  return join(dataRootOf(env), '表情包', 'group-members.jsonl');
}
/** msg-index 目录：{dataRoot}/.qqbot/msg-index */
function nameIndexPath(env) {
  return join(dataRootOf(env), '.qqbot', 'msg-index');
}
/** 读群成员台账（openid → 真实昵称）。任何异常都返回空表，绝不抛。 */
function loadMemberLedger(env) {
  const map = new Map();
  let raw;
  try {
    raw = readFileSync(ledgerPath(env), 'utf8');
  } catch {
    return map; // 台账不存在 = 还没攒到成员，正常
  }
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try {
      const o = JSON.parse(s);
      const mid = String(o?.mid ?? '').trim();
      const name = String(o?.name ?? '').trim();
      if (mid && name) map.set(mid, name);
    } catch { /* 单行坏了跳过 */ }
  }
  return map;
}
/** 读一遍 msg-index，拼 openid → 昵称。任何异常都返回空表。 */
function loadNameMap(env) {
  const map = new Map();
  const base = nameIndexPath(env);
  let scopes;
  try {
    scopes = readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
  } catch {
    return map; // 目录不存在 = 没有历史，正常
  }
  for (const d of scopes) {
    try {
      const raw = readFileSync(join(base, d.name, 'refs.json'), 'utf8');
      const j = JSON.parse(raw);
      for (const e of j?.entries ?? []) {
        const s = String(e?.s ?? '').trim();
        const n = String(e?.n ?? '').trim();
        if (s && n) map.set(s, n);
      }
    } catch { /* 单个会话文件坏了不影响其它 */ }
  }
  return map;
}
/** 一次把两张表都读出来（按钮回调里只调一次，别每个人名读一次盘）。 */
function loadNames(env) {
  return { ledger: loadMemberLedger(env), index: loadNameMap(env) };
}

/** 进程内 API 查询缓存：`${gid}|${openid}` → 真名（免得同一人反复打官方接口） */
const API_NAME_CACHE = new Map();

/**
 * ★ 2026-10-16 主人（小号）指路：**只要有 openid 就能从 QQ 官方接口拿昵称**。
 *
 * 官方接口（插件 `dist/api/group-admin.js:213` 用的就是这条）：
 *   GET https://api.bot.qq.com/v2/groups/{group_openid}/members/{member_openid}
 *   返回 data.username = **真实 QQ 昵称**
 * 扩展契约（docs/extension-contract.md §2）把这条路直接开给了扩展：
 *   `await env.api(path)` —— 「官方 API，自带 token 与 2h 缓存；返回 {ok,data} 或 {ok:false,err}」。
 * 所以不需要 appSecret、不需要自己换 token。
 *
 * 拿不到 group openid（单聊）或接口没权限时返回空串，由上层继续往下兜。
 */
async function fetchNameViaApi(env, openid) {
  const gid = String(env?.peer?.peerId ?? '').trim();
  const scope = String(env?.peer?.scope ?? '').trim();
  const id = String(openid ?? '').trim();
  if (!id || !gid || (scope && scope !== 'group')) return '';
  if (typeof env?.api !== 'function') return '';
  const key = `${gid}|${id}`;
  if (API_NAME_CACHE.has(key)) return API_NAME_CACHE.get(key);
  let nm = '';
  try {
    const r = await env.api(`/v2/groups/${encodeURIComponent(gid)}/members/${encodeURIComponent(id)}`);
    if (r?.ok) nm = String(r.data?.username ?? '').trim();
    else env.log?.(`[vote] 官方接口查昵称未命中 ${id.slice(0, 6)}… code=${r?.err?.code ?? '?'}`);
  } catch (e) {
    env.log?.(`[vote] 官方接口查昵称异常(不影响投票): ${e?.message ?? e}`);
  }
  API_NAME_CACHE.set(key, nm);
  if (API_NAME_CACHE.size > 500) API_NAME_CACHE.clear();
  return nm;
}

/**
 * 取点击者真实昵称，优先级：
 *   ① 插件官方给的 `ctx.user.pureName / .name`
 *   ② ★ QQ 官方接口 `/v2/groups/{gid}/members/{openid}` → username（只要 openid 就能查到真名）
 *   ③ 群成员台账 `表情包/group-members.jsonl`（本地、瞬时、覆盖说过话的人）
 *   ④ msg-index 的 openid→昵称表
 *   ⑤ 实在没有才显示 openid 前 6 位
 * 全程不抛错：名字拿不到也绝不能拖垮投票。
 */
async function resolveName(env, ctx, openid, names) {
  const official =
    String(ctx?.user?.pureName ?? '').trim() ||
    String(ctx?.user?.name ?? '').trim();
  if (official) return official;
  const id = String(openid ?? '').trim();
  if (!id) return '（未知）';
  const viaApi = await fetchNameViaApi(env, id);
  if (viaApi) return viaApi;
  const hit = names?.ledger?.get(id) || names?.index?.get(id);
  if (hit) return hit;
  // ⑤ 最后兜底：**用 @ 代替名字**
  //    只点按钮、从没在群里说过话的人不会进成员台账，官方接口又没权限 ⇒ 本地查不到。
  //    但 QQ 自己认得 openid：把 `<@openid>` 放进回执/结算里，客户端会把昵称渲染出来，
  //    于是照样「看得到是谁」，而不是一串 openid 前六位。
  try {
    if (typeof env?.at === 'function') return env.at(id);
  } catch { /* at 失败就退回前缀 */ }
  return `${id.slice(0, 6)}…`;
}

function loadAll(env) {
  const d = env?.store && typeof env.store.load === 'function' ? env.store.load() : undefined;
  const raw = d && typeof d === 'object' && !Array.isArray(d) ? d : {};
  // ── v1 → v2/v3 数据迁移 ────────────────────────────────────────────
  //   v1：{ "<cardId>": { topic, options, votes:{openid:idx}, counts:[] } }
  //   v2+：{ seq, votes: { V1: { id, topic, options, votes } } }
  //   旧 cardId 也挂成别名键 ⇒ 群里那张旧卡片照样能点。
  if (!raw.votes) {
    const migrated = { seq: 0, votes: {} };
    for (const [cardId, old] of Object.entries(raw)) {
      if (!old || typeof old !== 'object' || !Array.isArray(old.options)) continue;
      migrated.seq += 1;
      const id = `V${migrated.seq}`;
      const rec = {
        id,
        topic: String(old.topic ?? '（旧投票）'),
        options: old.options,
        votes: old.votes && typeof old.votes === 'object' ? old.votes : {},
        createdAt: Number(old.createdAt) || Date.now(),
        note: `由 v1 卡片 ${cardId} 迁移`,
      };
      migrated.votes[id] = rec;
      migrated.votes[cardId] = rec;
    }
    return migrated;
  }
  return raw;
}
function saveAll(env, d) {
  try { env.store.save(d); } catch { /* 落盘失败不影响本次回复 */ }
}

/** 某个人的选择 —— 一律按数组读（兼容 v1/v2 的单个数字） */
function choicesOf(v, openid) {
  const c = v.votes?.[openid];
  if (c === undefined) return [];
  return Array.isArray(c) ? c.slice() : [c];
}
/** 某人是否投过某个选项 */
function hasChosen(v, openid, idx) {
  return choicesOf(v, openid).includes(idx);
}

/** 卡片正文：题目 + 选项字母表 + 状态（选项全文在这儿，按钮上只有字母） */
function cardBody(v, extra) {
  const lines = [
    `🗳 **${v.topic}**`,
    `投票号：\`${v.id}\`${v.endsAt ? `　截止：${new Date(v.endsAt).toLocaleString('zh-CN', { hour12: false })}` : ''}`,
    '',
  ];
  v.options.forEach((o, i) => lines.push(`**${LETTERS[i] ?? '?'}**. ${o}`));
  lines.push('');
  if (v.closed) lines.push(`⛔ 已结束（共 ${Object.keys(v.votes).length} 人参与）`);
  else lines.push('可多选：想投几个就点几个；每个按钮每人只能点一次。（「✋ 结束投票」只有主人能点）');
  if (extra) lines.push('', extra);
  return lines.join('\n');
}

/** 选项按钮（每行 5 个）+ 最后一行的「结束投票」 */
function keyboardOf(voteId, options) {
  const rows = [];
  const n = Math.min(options.length, MAX_OPTIONS);
  for (let r = 0; r * PER_ROW < n; r++) {
    const buttons = [];
    for (let c = 0; c < PER_ROW; c++) {
      const i = r * PER_ROW + c;
      if (i >= n) break;
      buttons.push({
        id: `b${i}`,
        render_data: { label: LETTERS[i], visited_label: `${LETTERS[i]}✓`, style: 1 },
        action: {
          type: 1,
          permission: { type: 2 },
          data: `ext:${TOOL}:${voteId}:${i}`,
          unsupport_tips: '请升级QQ客户端后重试',
        },
      });
    }
    rows.push({ buttons });
  }
  // 最后一行放「结束投票」（放在第二个位置，避免误触第一个按钮）
  rows.push({
    buttons: [
      {
        id: END_BTN,
        render_data: { label: '✋ 结束投票', visited_label: '✋ 结束投票', style: 4 },
        action: {
          type: 1,
          permission: { type: 2 },
          data: `ext:${TOOL}:${voteId}:${END_BTN}`,
          unsupport_tips: '请升级QQ客户端后重试',
        },
      },
    ],
  });
  return { content: { rows } };
}

/** 完整结算块（只在"结束时"用；中途回执不许用它） */
function tallyBlock(v) {
  const nameOf = (id) => v.names?.[id] || `${String(id).slice(0, 6)}…`;
  const entries = Object.entries(v.votes ?? {});
  const lines = [`参与人数：**${entries.length}**（可多选）`];
  v.options.forEach((o, i) => {
    const voters = entries
      .filter(([, c]) => (Array.isArray(c) ? c : [c]).includes(i))
      .map(([id]) => nameOf(id));
    lines.push(`· ${LETTERS[i]}. ${o} —— **${voters.length}** 票${voters.length ? `：${voters.join('、')}` : ''}`);
  });
  if (entries.length) {
    lines.push('', '**投票明细**');
    for (const [id, c] of entries) {
      const arr = (Array.isArray(c) ? c : [c])
        .filter((x) => Number.isInteger(x) && v.options[x] !== undefined)
        .map((x) => `${LETTERS[x]}`);
      lines.push(`· ${nameOf(id)} → ${arr.join('、') || '（无）'}`);
    }
  }
  if (v.endedBy) lines.push('', `✋ 由 **${nameOf(v.endedBy)}** 结束`);
  return lines.join('\n');
}

/** 取投票 + 顺手做"到点自动结束"判定（键先原样、再大写，兼容旧卡片别名） */
function pick(data, voteId) {
  const key = String(voteId ?? '').trim();
  const v = data?.votes?.[key] ?? data?.votes?.[key.toUpperCase()];
  if (!v) return null;
  if (!v.closed && v.endsAt && Date.now() >= v.endsAt) v.closed = true;
  return v;
}

async function sendCard(env, v, extra) {
  return env.markdownCard(cardBody(v, extra), keyboardOf(v.id, v.options));
}

/**
 * 结束收尾（结束按钮 / action=end 共用）。
 *
 * ★ 2026-10-16 主人要求（两轮澄清后的口径）：
 *   · 「结束投票不报消息」= 不再往**群里**发那张结算表（POLL_GROUP_BROADCAST=false）
 *   · 但「结束统计的回执本身是要的」= 点结束的人仍收到一句回执（由 onInteraction 的返回值发）
 *   · appendWake 通知 AI 也一并关掉（AI 自己用 status 就能查）
 * 想恢复"结束就往群里公示统计"：把下面 POLL_GROUP_BROADCAST 改回 true。
 */
const POLL_GROUP_BROADCAST = false;
/** 结束是否唤醒 AI 通报
 *  ★ 2026-10-16 主人反馈「按了结束投票，AI 没收到结果」→ 改回 true：
 *    结束（含私聊里点卡片结束按钮 / action=end）都把结算表 appendWake 进会话。
 *    群公示仍由上面的 POLL_GROUP_BROADCAST 单独控制。 */
const POLL_WAKE_AI = true;

async function finish(env, v, byWhom, byName) {
  const first = !v.closed;
  v.closed = true;
  v.endedAt = Date.now();
  // ★ 记录"谁点的结束"（openid + 昵称），结算表里会写出来
  if (byWhom) v.endedBy = byWhom;
  if (byWhom && byName) v.names = { ...(v.names ?? {}), [byWhom]: byName };
  const block = tallyBlock(v);

  // 群公示（默认关）：只影响"往群里发那张表"，不影响给点击者的回执
  if (POLL_GROUP_BROADCAST) {
    try {
      await env.markdown([
        `🗳 **投票结束：${v.topic}**（${v.id}）`,
        byWhom ? `由 ${byWhom} 点下了结束按钮。` : '',
        '',
        block,
      ].filter(Boolean).join('\n'));
    } catch { /* 公示失败不影响结算 */ }
  }

  // 通知 AI（默认关）
  if (POLL_WAKE_AI) {
    try {
      if (typeof env.appendWake === 'function') {
        await env.appendWake(`[投票结束] ${v.id}「${v.topic}」已结算：\n${block}`);
      }
    } catch { /* 通知失败不影响结算 */ }
  }

  return { first, block, woke: false };
}

export default {
  name: TOOL,
  description: '群投票（可多选）：start=发起 / add=中途加选项 / status=看票数 / end=结束结算；卡片最后一行自带「结束投票」按钮；支持多投票并存、最多 20 个选项、可设定时结束；结束时结果会通知 AI。',
  inputSchema: {
    action: { type: 'string', required: true, description: 'start=发起投票；add=加选项；status=查票数；end=结束并结算' },
    topic: { type: 'string', description: 'start 必填：投票题目' },
    options: { type: 'string', description: 'start/add 必填：选项，用 | 分隔（每条建议 ≤12 字，合计最多 20 条）' },
    voteId: { type: 'string', description: 'add/status/end 必填：投票号（start 时返回，如 V1）' },
    minutes: { type: 'number', description: '可选（仅 start）：多少分钟后自动结束；不填 = 手动/点结束按钮' },
  },

  async run(args, env) {
    const action = String(args?.action ?? 'start').trim().toLowerCase();
    const all = loadAll(env);
    all.votes = all.votes && typeof all.votes === 'object' ? all.votes : {};
    all.seq = Number(all.seq) || 0;

    // ── 发起 ─────────────────────────────────────────────
    if (action === 'start') {
      const topic = String(args?.topic ?? '').trim();
      const options = String(args?.options ?? '').split(SEP).map((s) => s.trim()).filter(Boolean);
      if (!topic) return { ok: false, msg: '缺 topic（投票题目）' };
      if (options.length < 2) return { ok: false, msg: '至少 2 个选项（用 | 分隔）' };
      if (options.length > MAX_OPTIONS) return { ok: false, msg: `选项太多：最多 ${MAX_OPTIONS} 个（卡片 4 行 × 5 列，第 5 行留给结束按钮）` };

      all.seq += 1;
      const id = `V${all.seq}`;
      const minutes = Number(args?.minutes);
      const v = {
        id,
        topic,
        options,
        votes: {},
        createdAt: Date.now(),
        ...(Number.isFinite(minutes) && minutes > 0 ? { endsAt: Date.now() + minutes * 60_000 } : {}),
      };
      all.votes[id] = v;
      saveAll(env, all);

      const ok = typeof env.registerInteractionCard === 'function'
        ? env.registerInteractionCard({
          cardId: id,
          // ★ 结束按钮也要登记，否则点了没人认
          buttonIds: [...options.slice(0, MAX_OPTIONS).map((_, i) => String(i)), END_BTN],
          expireAt: Date.now() + (v.endsAt ? Math.max(24 * 3600_000, v.endsAt - Date.now() + 86400_000) : 3 * 86400_000),
        })
        : false;
      const sent = await sendCard(env, v);
      return {
        ok: !!sent,
        msg: sent
          ? `投票已发起：${id}「${topic}」，${options.length} 个选项${v.endsAt ? `，${minutes} 分钟后自动结束` : '（结束时点卡片上的「✋ 结束投票」，或 action=end）'}${ok ? '' : '；⚠️ 卡片登记失败，按钮可能点不动'}`
          : '发卡失败（确认在 QQ 会话里）',
      };
    }

    // ── 中途加选项 ───────────────────────────────────────
    if (action === 'add') {
      const v = pick(all, args?.voteId);
      if (!v) return { ok: false, msg: `没找到投票 ${args?.voteId}` };
      if (v.closed) return { ok: false, msg: `投票 ${v.id} 已经结束了，不能再加选项` };
      const added = String(args?.options ?? '').split(SEP).map((s) => s.trim()).filter(Boolean);
      if (added.length === 0) return { ok: false, msg: '要加什么选项？（options 用 | 分隔）' };
      if (v.options.length + added.length > MAX_OPTIONS) {
        return { ok: false, msg: `加不下：还余 ${MAX_OPTIONS - v.options.length} 个位（含结束按钮共 5 行）` };
      }
      const startIdx = v.options.length;
      v.options.push(...added);
      saveAll(env, all);
      if (typeof env.registerInteractionCard === 'function') {
        env.registerInteractionCard({
          cardId: v.id,
          buttonIds: [...v.options.map((_, i) => String(i)), END_BTN],
          expireAt: Date.now() + 3 * 86400_000,
        });
      }
      const newOnes = added.map((a, k) => `**${LETTERS[startIdx + k]}**. ${a}`).join('、');
      const sent = await sendCard(env, v, `🆕 新增选项：${newOnes}（旧卡片上的按钮同样有效）`);
      return { ok: !!sent, msg: `已给 ${v.id} 加上：${added.join('、')}（现共 ${v.options.length} 个选项）` };
    }

    // ── 查票数 ───────────────────────────────────────────
    if (action === 'status') {
      const v = pick(all, args?.voteId);
      if (!v) return { ok: false, msg: `没找到投票 ${args?.voteId}` };
      saveAll(env, all);
      return { ok: true, msg: `${v.closed ? '【已结束】' : '【进行中】'}${v.id}「${v.topic}」\n${tallyBlock(v)}` };
    }

    // ── 结束并结算（AI 手动）────────────────────────────
    if (action === 'end') {
      const v = pick(all, args?.voteId);
      if (!v) return { ok: false, msg: `没找到投票 ${args?.voteId}` };
      const { first, block } = await finish(env, v, '');
      saveAll(env, all);
      return { ok: true, msg: `${first ? '已结束并结算' : '该投票此前已结束，重新结算'}：${v.id}「${v.topic}」\n\n${block}` };
    }

    return { ok: false, msg: `未知 action：${action}（可用：start / add / status / end）` };
  },

  async onInteraction(ctx, info) {
    const openid = String(ctx?.performer?.openid ?? '');
    if (!openid) return '拿不到你的身份，稍后再试~';

    const all = loadAll(ctx);
    const v = pick(all, info.cardId);
    if (!v) return '这次投票不存在或已被清理。';

    // ★ 2026-10-16：取点击者真实昵称
    //   官方 ctx.user.name → QQ 官方接口(只要 openid 就能查真名) → 群成员台账 → msg-index → openid 前缀
    const names = loadNames(ctx);
    const name = await resolveName(ctx, ctx, openid, names);
    const who = `${name}(${openid.slice(0, 6)}…)`;

    // ★ 2026-10-16 主人要求：投票一旦结束，任何人再点**都不回执**（静默吞掉）。
    //   契约：onInteraction 返回空串 = 不发回执（见 ext-tool-interaction.js: `if (text) sendReceipt(...)`）。
    if (v.closed) {
      ctx.log?.(`[vote] ${v.id} 已结束，忽略 ${who} 的点击（静默）`);
      return '';
    }

    // ── 结束按钮 ─────────────────────────────────────────
    if (String(info.buttonId) === END_BTN) {
      // ★ 2026-10-16 主人要求：只有主人的 openid 能结束；别人点了不结算
      if (!canEnd(openid)) {
        ctx.log?.(`[vote] ${v.id} 结束按钮被非主人点击：${who}（已拒绝）`);
        return '这个按钮只有主人能点哦～想结算的话叫一声早饭哥哥。';
      }
      const { woke, block } = await finish(ctx, v, openid, name);
      saveAll(ctx, all);
      ctx.log?.(`[vote] ${v.id} 由 ${who} 点结束按钮 woke=${woke}`);
      // ★ 2026-10-16 主人澄清：「结束统计的回执本身是要的」——
      //   所以这里把结算表**作为回执**发给点击者（只有点的人看得到，不刷群）。
      return `✅ 已结束，结算如下：\n\n${block}`;
    }

    const idx = Number(String(info.buttonId ?? ''));
    if (!Number.isInteger(idx) || idx < 0 || idx >= v.options.length) return '这个选项不认识…';

    // 同一按钮只能投一次（但**可以**继续投别的选项 = 多选）
    if (hasChosen(v, openid, idx)) {
      return `你已经投过「${LETTERS[idx]}. ${v.options[idx]}」了（不过还能投别的选项）`;
    }
    const mine = choicesOf(v, openid);
    mine.push(idx);
    v.votes[openid] = mine;
    // ★ 记下这个人叫什么（结算表里要写"谁投了什么"）
    v.names = { ...(v.names ?? {}), [openid]: name };
    saveAll(ctx, all);

    const cnt = Object.values(v.votes).filter((c) => (Array.isArray(c) ? c : [c]).includes(idx)).length;
    ctx.log?.(`[vote] ${v.id} by=${who} → ${LETTERS[idx]}（该项第 ${cnt} 票）`);
    // ★ 中途回执只报这一票（主人要求：别甩整张表，完整结算只在结束时给）
    return `✅ ${name} 「${LETTERS[idx]}. ${v.options[idx]}」+1 票（当前 ${cnt} 票）`;
  },
};
