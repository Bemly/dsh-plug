/**
 * preset_resolve.mjs — 把「人设」输入解析成宿主的 preset **id**
 *
 * ── 为什么单独成库（2026-10-12）────────────────────────────────────────────
 * 解析规则还会变，而工具文件**一旦落名就不能再改**（宿主扫描后按 `name@tag`
 * 幂等跳过，改了不生效 ⇒ 只能再升一个版本号）。把易变逻辑放这里，用
 * `?v=<mtimeMs>` 版本化加载，改本文件即时生效，工具名不用动。
 *
 * ── 主人指定的匹配顺序（2026-10-12）──────────────────────────────────────
 *   收**任何字符**，依次尝试：
 *     ① 预设名（显示名）精确匹配  → 反查 id
 *     ② id 精确匹配
 *     ③ 两者的「忽略大小写」精确匹配
 *     ④ 唯一子串匹配（名或 id 包含输入）——唯一才用，多个则报歧义
 *   都失败 → 返回 error，并把可用清单带上（供调用方直接回给用户）。
 *
 * 输入的容忍度：去首尾空白；剥掉成对的「」『』【】《》""'' 方括号/引号。
 */
export const __LIB_VERSION__ = 'preset-resolve-v1-20261012-先名后id';

/** 归一化输入：trim + 剥掉包裹的引号/书名号 */
export function normPresetKey(s) {
  let t = String(s ?? '').trim();
  for (let i = 0; i < 3; i += 1) {
    const before = t;
    t = t.replace(/^[「『【《〈（(\["'“‘]+/, '').replace(/[」』】》〉）)\]"'”’]+$/, '').trim();
    if (t === before) break;
  }
  return t;
}

/** 取全部预设（id + 显示名）——权威来源是宿主服务 `ctx.agentPresets` */
export async function listPresets(root) {
  const get = (k) => { try { return root?.get?.(k); } catch { return undefined; } };
  const reg = get('agentPresets');
  if (!reg || typeof reg.list !== 'function') return [];
  let all = [];
  try { all = (await reg.list()) || []; } catch { return []; }
  if (!Array.isArray(all)) return [];
  return all
    .map((p) => ({ id: String(p?.id ?? '').trim(), name: String(p?.name ?? '').trim() }))
    .filter((p) => p.id);
}

/** 一行展示：id(显示名) */
export function presetLabel(p) {
  return p && p.id ? p.id + (p.name ? '(' + p.name + ')' : '') : String(p ?? '');
}

/**
 * 解析人设输入 → preset id。
 * @returns {{id:string, via:string, all:Array, error?:string}}
 *   via: 'name' | 'id' | 'name(i)' | 'id(i)' | 'substring' | ''（失败）
 */
export async function resolvePreset(root, want) {
  const raw = String(want ?? '');
  const all = await listPresets(root);
  // 拿不到注册表 → 原样放行（交给宿主报错，至少不阻断）
  if (!all.length) return { id: normPresetKey(raw), via: 'passthrough', all };
  const k = normPresetKey(raw);
  if (!k) return { id: '', via: '', all, error: '人设参数是空的' };
  const lk = k.toLowerCase();

  // ① 预设名（显示名）精确 → 反查 id   ★主人指定优先
  const n1 = all.find((p) => p.name === k);
  if (n1) return { id: n1.id, via: 'name', all };

  // ② id 精确
  const i1 = all.find((p) => p.id === k);
  if (i1) return { id: i1.id, via: 'id', all };

  // ③ 忽略大小写的精确（名 → id）
  const n2 = all.find((p) => p.name.toLowerCase() === lk);
  if (n2) return { id: n2.id, via: 'name(i)', all };
  const i2 = all.find((p) => p.id.toLowerCase() === lk);
  if (i2) return { id: i2.id, via: 'id(i)', all };

  // ④ 唯一子串（名或 id 包含输入）
  const subs = all.filter((p) => (p.name && p.name.toLowerCase().includes(lk)) || p.id.toLowerCase().includes(lk));
  if (subs.length === 1) return { id: subs[0].id, via: 'substring', all };
  if (subs.length > 1) {
    return { id: '', via: '', all, error: '「' + raw + '」匹配到多个人设，请说得更准: ' + subs.map(presetLabel).join('、') };
  }
  return { id: '', via: '', all, error: '没找到人设「' + raw + '」。可用: ' + all.map(presetLabel).join('、') };
}
