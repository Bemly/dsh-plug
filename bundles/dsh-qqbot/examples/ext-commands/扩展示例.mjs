/**
 * 扩展示例.mjs — `/扩展示例` 斜杠命令（2026-10-26 主人要求的验收示例）
 *
 * 演示点：一条命令同时读**两级配置**
 *   · 文本1 → profile 级（全局一份，影响所有机器人）  ui/demo-settings 里改
 *   · 文本2 → 数据根（每实例一份，只影响当前机器人）  ui/demo-dock 里改
 *
 * 放到 {dataRoot}/.qqbot-extensions/commands/ 后重启宿主生效（扩展命令需重启）。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

/** 读一个 json，坏文件当空对象 */
function readJson(p) {
  try {
    if (!existsSync(p)) return {};
    const j = JSON.parse(readFileSync(p, 'utf8'));
    return j && typeof j === 'object' ? j : {};
  } catch {
    return {};
  }
}

/** profile 根：优先环境变量，退到 ~/.dsh/profiles/<第一个> */
function profileRootOf() {
  const envDir = process.env.DSH_PROFILE_DIR || process.env.DSH_PROFILE_ROOT;
  if (envDir && existsSync(envDir)) return envDir;
  try {
    const base = join(homedir(), '.dsh', 'profiles');
    if (existsSync(base)) {
      const names = readdirSync(base).filter((n) => !n.startsWith('.'));
      if (names.length) return join(base, names[0]);
    }
  } catch { /* ignore */ }
  return join(homedir(), '.dsh', 'profiles', 'web');
}

export default {
  name: '扩展示例',
  description: '发一条（文本1）（文本2）—— 演示 profile/data 双源扩展配置',
  handler: async (ctx) => {
    // ★ 2026-10-27 修（主人实测：dock 里存了「哈哈我喜欢你」但命令读到默认值）：
    //   ctx.cwd 是**工作区**（D:\...\鲸鱼娘），配置却在**数据根**
    //   （D:\...\鲸鱼娘\dshqqbot\.qqbot-extensions\...）—— 差了 dshqqbot 一级，
    //   于是读到不存在的路径、回退成默认提示。优先用能力包给的 dataRoot。
    const caps = ctx?.caps ?? ctx;
    let dataRoot = String(caps?.dataRoot || ctx?.dataRoot || '').trim();
    if (!dataRoot) {
      const base = String(ctx?.cwd || process.cwd());
      const guess = join(base, 'dshqqbot');
      dataRoot = existsSync(guess) ? guess : base;
    }
    const extId = 'demo';

    // 文本1：**本实例优先 → 全局兜底**（2026-10-27 主人要求）
    //   理由：设置页里那张卡片能切「改全局 / 改当前账号」，用户给某个机器人单独配了
    //   文本1（如 3 号机配 666），那就该用他的；没配的机器人才用全局那份。
    const profileCfg = readJson(join(profileRootOf(), '.qqbot-extensions', '.state', 'ext-config', extId + '.json'));
    const dataCfg = readJson(join(dataRoot, '.qqbot-extensions', '.state', 'ext-config', extId + '.json'));

    const t1 = String(dataCfg.text1 || '').trim()
      || String(profileCfg.text1 || '').trim()
      || '(文本1：还没在「通用设置」里改过)';
    const t2 = String(dataCfg.text2 || '').trim() || '(文本2：还没在 dock 球里改过)';

    const out = `（${t1}）（${t2}）`;

    // ctx 是能力包平铺：text() 直接往当前会话发一条纯文本
    try {
      if (typeof ctx?.text === 'function') {
        await ctx.text(out);
        return { ok: true, msg: '已发送' };
      }
      if (typeof ctx?.markdown === 'function') {
        await ctx.markdown(out);
        return { ok: true, msg: '已发送（markdown）' };
      }
    } catch (e) {
      return { ok: false, msg: '发送失败: ' + (e instanceof Error ? e.message : String(e)) };
    }
    return { ok: false, msg: '当前 ctx 没有发送能力' };
  },
};
