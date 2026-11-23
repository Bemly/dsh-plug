/**
 * sticker_auto.mjs — 【扩展工具】「自动配表情包」开关 + **隔离设置**（2026-10-16 建，2026-10-17 加隔离）
 *
 * 配套：出站扩展 `outbound/sticker-semantic.mjs`（它读这里的两个文件决定要不要自动配图）。
 * 安装：两个文件分别放到
 *   `{数据根}/.qqbot-extensions/tools/sticker_auto.mjs`
 *   `{数据根}/.qqbot-extensions/outbound/sticker-semantic.mjs`
 * 然后 `tools_reload`（工具立即生效；出站扩展也一起热刷，见 /tools-reload 回执里的"出站扩展: N 个"）。
 *
 * ── 用法（AI 侧）──────────────────────────────────────────────────────────
 *   sticker_auto {action:'status'}                                  // 看总开关 + 隔离名单
 *   sticker_auto {action:'on'} / {action:'off'} / {action:'toggle'}  // 总开关（全局）
 *   sticker_auto {action:'scope-add', target:'group:<群openid>', label:'群名'}
 *   sticker_auto {action:'scope-remove', target:'group:<群openid>'}
 *   sticker_auto {action:'scope-list'}
 *   sticker_auto {action:'scope-mode', mode:'whitelist'|'all'}
 *   sticker_auto {action:'scope-clear'}
 *
 * ── 两个状态文件（出站扩展读的就是它们）──────────────────────────────────
 *   ① 总开关：`{数据根}/.qqbot-extensions/data/auto-sticker.json`
 *      → `{ "enabled": true|false, "updatedAt": 毫秒 }`；不存在 = 默认开（按示范扩展的 DEFAULT_ENABLED）。
 *   ② 隔离名单：`{数据根}/.qqbot-extensions/data/sticker-semantic-scope.json`
 *      → `{ "mode": "whitelist"|"all", "targets": [{key,label,addedAt}] }`
 *      ★ **不存在 = whitelist + 空名单 ⇒ 谁都不配图** —— 主人 2026-10-17 定：
 *        「自动发图应该只对单个目标生效（像智能恢复那样，指定一个群或私聊有效，隔离设置）」。
 *        要恢复"所有目标都生效"就 `scope-mode {mode:'all'}`。
 */
import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';

const TOOL = 'sticker_auto';

/** 总开关文件（与 outbound/sticker-semantic.mjs 约定的那份） */
function stateFile(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot-extensions', 'data', 'auto-sticker.json');
}

/** 隔离名单文件 */
function scopeFile(dataRoot) {
  return join(String(dataRoot || ''), '.qqbot-extensions', 'data', 'sticker-semantic-scope.json');
}

function readJson(f) {
  try {
    if (!existsSync(f)) return null;
    return JSON.parse(readFileSync(f, 'utf8'));
  } catch {
    return null;
  }
}

function writeJson(f, obj) {
  mkdirSync(dirname(f), { recursive: true });
  writeFileSync(f, JSON.stringify(obj, null, 2), 'utf8');
  return f;
}

function readState(dataRoot) {
  const j = readJson(stateFile(dataRoot));
  if (!j) return { exists: false, enabled: undefined };
  return { exists: true, enabled: typeof j?.enabled === 'boolean' ? j.enabled : undefined };
}

function writeState(dataRoot, enabled) {
  return writeJson(stateFile(dataRoot), { enabled: !!enabled, updatedAt: Date.now() });
}

/**
 * 归一化目标写法 → `group:<openid>` / `c2c:<openid>`（也允许裸 openid，扩展那边两种都认）。
 * 认的写法：`group:xxx` / `c2c:xxx` / `群:xxx` / `私聊:xxx` / `群 xxx` / `私聊 xxx` / 裸 id
 */
function normalizeTarget(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  s = s.replace(/^(群聊|群|私聊|好友)\s*[:：]?\s*/, (m) => (/私聊|好友/.test(m) ? 'c2c:' : 'group:'));
  const m = /^(group|c2c)\s*[:：]\s*(.+)$/i.exec(s);
  if (m) return `${m[1].toLowerCase()}:${m[2].trim()}`;
  return s; // 裸 openid：原样存，扩展匹配时会同时试 `scope:id` 和裸 id
}

/** 读隔离名单；文件不存在 ⇒ 空白名单（=谁都不发） */
function readScope(dataRoot) {
  const j = readJson(scopeFile(dataRoot));
  const exists = !!j;
  const mode = j?.mode === 'all' ? 'all' : 'whitelist';
  const list = (Array.isArray(j?.targets) ? j.targets : [])
    .map((t) => (typeof t === 'string' ? { key: t } : t))
    .map((t) => ({ key: String(t?.key || '').trim(), label: String(t?.label || '').trim(), addedAt: t?.addedAt }))
    .filter((t) => t.key);
  return { exists, mode, list };
}

function writeScope(dataRoot, mode, list) {
  return writeJson(scopeFile(dataRoot), {
    mode: mode === 'all' ? 'all' : 'whitelist',
    targets: list.map((t) => ({ key: t.key, label: t.label || '', addedAt: t.addedAt || Date.now() })),
    updatedAt: Date.now(),
  });
}

/** 名单渲染成几行文本 */
function listLines(scope) {
  if (!scope.list.length) return '（名单为空）';
  return scope.list.map((t, i) => `${i + 1}. ${t.key}${t.label ? `  ${t.label}` : ''}`).join('\n');
}

function scopeSummary(dataRoot, scope) {
  return (
    `隔离模式：${scope.mode === 'all' ? 'all（所有群/私聊都配图）' : 'whitelist（只对下面名单配图）'}` +
    (scope.exists ? '' : '  ← 还没有隔离文件，用的是默认「whitelist + 空名单」= 谁都不配图') +
    `\n生效名单（${scope.list.length} 个）：\n${listLines(scope)}` +
    `\n隔离文件：${scopeFile(dataRoot)}`
  );
}

export default {
  name: TOOL,
  description:
    '开关「自动配表情包」并管理生效范围（隔离设置）：on=开启 / off=关闭 / toggle=反转 / status=状态；' +
    'scope-add=把某个群或私聊加进生效名单 / scope-remove=移出 / scope-list=看名单 / ' +
    'scope-mode=切换 whitelist(只对名单生效，默认) 或 all(所有目标都生效) / scope-clear=清空名单。' +
    '默认是隔离的：没加进名单的群/私聊不会自动配图。状态存在数据根下两个扩展共用。',
  inputSchema: {
    action: {
      type: 'string',
      required: true,
      description:
        'on / off / toggle / status / scope-add / scope-remove / scope-list / scope-mode / scope-clear',
    },
    target: {
      type: 'string',
      description:
        'scope-add、scope-remove 用：目标写成 group:<群openid> 或 c2c:<用户openid>（也可只写裸 openid）',
    },
    label: { type: 'string', description: '可选备注（群名 / 昵称），只写进配置文件方便人看' },
    mode: { type: 'string', description: 'scope-mode 用：whitelist（只对名单生效，默认）/ all（所有目标）' },
  },

  async run(args, env) {
    const action = String(args?.action ?? 'status').trim().toLowerCase();
    const dataRoot = String(env?.dataRoot ?? '');
    if (!dataRoot) {
      return { ok: false, msg: '拿不到数据根（env.dataRoot 为空），无法读写开关文件' };
    }

    const cur = readState(dataRoot);
    const enabled = cur.exists ? !!cur.enabled : true; // 文件不存在 ⇒ 与示范扩展的默认值一致（默认开）
    const scope = readScope(dataRoot);

    // ── 只读：状态 ────────────────────────────────────────────────────────
    if (action === 'status') {
      return {
        ok: true,
        msg:
          `自动配表情包总开关：${enabled ? '已开启' : '已关闭'}` +
          (cur.exists ? '' : '（还没有状态文件，用的是默认值「开」）') +
          `\n${scopeSummary(dataRoot, scope)}`,
      };
    }

    // ── 隔离名单管理 ──────────────────────────────────────────────────────
    if (action === 'scope-list') {
      return { ok: true, msg: `自动配表情包 —— ${scopeSummary(dataRoot, scope)}` };
    }

    if (action === 'scope-mode') {
      const mode = String(args?.mode ?? '').trim().toLowerCase();
      if (mode !== 'whitelist' && mode !== 'all') {
        return { ok: false, msg: `scope-mode 只认 whitelist / all，收到：${mode || '(空)'}` };
      }
      try {
        writeScope(dataRoot, mode, scope.list);
      } catch (err) {
        return { ok: false, msg: `写隔离文件失败：${err instanceof Error ? err.message : String(err)}` };
      }
      return {
        ok: true,
        msg:
          mode === 'all'
            ? '已切到 all：之后所有群/私聊都会自动配图（名单保留但不再用于判定）'
            : `已切回 whitelist：只对名单里的 ${scope.list.length} 个目标配图`,
      };
    }

    if (action === 'scope-clear') {
      try {
        writeScope(dataRoot, scope.mode, []);
      } catch (err) {
        return { ok: false, msg: `写隔离文件失败：${err instanceof Error ? err.message : String(err)}` };
      }
      return { ok: true, msg: '隔离名单已清空（whitelist 模式下 = 谁都不再自动配图）' };
    }

    if (action === 'scope-add' || action === 'scope-remove') {
      const key = normalizeTarget(args?.target);
      if (!key) {
        return {
          ok: false,
          msg: "要指定 target，写成 group:<群openid> 或 c2c:<用户openid>（例：sticker_auto {action:'scope-add', target:'group:86976CE63D8FA0DA762429F01DC41545'}）",
        };
      }
      const hitIdx = scope.list.findIndex((t) => t.key === key);
      if (action === 'scope-add') {
        if (hitIdx >= 0) {
          if (args?.label) scope.list[hitIdx].label = String(args.label).trim();
        } else {
          scope.list.push({ key, label: String(args?.label || '').trim(), addedAt: Date.now() });
        }
      } else {
        if (hitIdx < 0) {
          return {
            ok: false,
            msg: `名单里没有 ${key}，没东西可删。\n当前名单（${scope.list.length} 个）：\n${listLines(scope)}`,
          };
        }
        scope.list.splice(hitIdx, 1);
      }
      try {
        writeScope(dataRoot, scope.mode, scope.list);
      } catch (err) {
        return { ok: false, msg: `写隔离文件失败：${err instanceof Error ? err.message : String(err)}` };
      }
      return {
        ok: true,
        msg:
          (action === 'scope-add'
            ? `已加入生效名单：${key}` + (args?.label ? `（${String(args.label).trim()}）` : '')
            : `已移出生效名单：${key}`) +
          `\n模式：${scope.mode === 'all' ? 'all（名单不参与判定）' : 'whitelist'}` +
          `\n当前名单（${scope.list.length} 个）：\n${listLines(scope)}` +
          (enabled ? '' : '\n注意：总开关是「已关闭」状态，光加名单不会配图，需要再 action=on。'),
      };
    }

    // ── 总开关 ────────────────────────────────────────────────────────────
    let next;
    if (action === 'on') next = true;
    else if (action === 'off') next = false;
    else if (action === 'toggle') next = !enabled;
    else {
      return {
        ok: false,
        msg: `不认识的 action：${action}（用 on / off / toggle / status / scope-add / scope-remove / scope-list / scope-mode / scope-clear）`,
      };
    }

    try {
      writeState(dataRoot, next);
    } catch (err) {
      return { ok: false, msg: `写开关失败：${err instanceof Error ? err.message : String(err)}` };
    }
    return {
      ok: true,
      msg:
        `自动配表情包总开关已${next ? '开启' : '关闭'}` +
        (next ? '（下一条回复起生效）' : '（她不再自动配图）') +
        (next ? `\n注意：只有名单里的目标才会配图（当前 ${scope.list.length} 个，模式 ${scope.mode}）。` : ''),
    };
  },
};
