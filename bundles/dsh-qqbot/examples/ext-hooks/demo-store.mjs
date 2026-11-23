/**
 * demo-store.mjs — 扩展示例的**自有存储**后端（2026-10-26）
 *
 * 演示点：扩展不一定要用 ext-config 那套固定 JSON —— 可以自己挑存储位置和格式，
 * 通过 env.registerRoute() 注册 HTTP 路由，让自己的 UI 卡片用 qqbotExt.api() 取。
 *
 * 这里用的存储：{dataRoot}/.qqbot/demo-store.json（自己挑的地方，跟插件数据放一起）
 * 想换 SQLite / 别的目录，只改本文件的读写实现即可 —— 卡片侧完全不用动。
 *
 * 注册的路由：
 *   GET  /store   → { ok, data: {...}, file }
 *   POST /store   → 浅合并写回，返回新内容
 *   GET  /ping    → 探活
 *
 * 卡片里（见 ui/demo-dock/card.js）：
 *   qqbotExt.api('/store').then(r => r.data)
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

export default async function (env) {
  const caps = env?.caps ?? env;
  if (!caps || typeof caps.registerRoute !== 'function') {
    env?.log?.('[demo-store] 这个版本的宿主没有 registerRoute，跳过了');
    return;
  }

  const extId = 'demo';
  // ★ 2026-10-27 修（主人实测：dock 在 3 号机里读到的还是鲸鱼娘那份文件）：
  //   hooks 是「插件启动时跑一次」，env.dataRoot 是**插件级**的（主实例那份），
  //   不是当前机器人实例的。所以数据根必须**随请求走** ——
  //   卡片通过 api() 把 dataRoot 带上来，dispatch 会把它放进 query 交给 handler。
  //   这里 env.dataRoot 只当兜底。
  const defaultRoot = String(env?.dataRoot || env?.cwd || process.cwd());
  const storeFileOf = (root) => join(root || defaultRoot, '.qqbot', 'demo-store.json');

  function readStoreAt(file) {
    try {
      if (!existsSync(file)) return {};
      const j = JSON.parse(readFileSync(file, 'utf8'));
      return j && typeof j === 'object' ? j : {};
    } catch {
      return {};
    }
  }
  function writeStoreAt(file, o) {
    try {
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, JSON.stringify(o, null, 2), 'utf8');
      return true;
    } catch {
      return false;
    }
  }
  const rootOf = (q) => String((q && q.dataRoot) || '').trim() || defaultRoot;
  const fileOf = (q) => storeFileOf(rootOf(q));

  // ── 注册路由（第 4 个参数是扩展 id，卡片用 api() 时会带上它）──
  const r1 = caps.registerRoute('GET', '/store', async ({ query } = {}) => ({
    ok: true, data: readStoreAt(fileOf(query)), file: fileOf(query), dataRoot: rootOf(query),
  }), extId);
  const r2 = caps.registerRoute('POST', '/store', async ({ query, body } = {}) => {
    const f = fileOf(query);
    const cur = readStoreAt(f);
    const next = Object.assign({}, cur, body && typeof body === 'object' ? body : {});
    return writeStoreAt(f, next)
      ? { ok: true, data: next, file: f, dataRoot: rootOf(query) }
      : { ok: false, reason: '写入失败：' + f };
  }, extId);
  const r3 = caps.registerRoute('GET', '/ping', async ({ query } = {}) => ({
    ok: true, data: { at: Date.now(), dataRoot: rootOf(query), file: fileOf(query) },
  }), extId);

  env?.log?.('[demo-store] 已注册 3 条路由 (' + [r1, r2, r3].join(',') + ')，默认存储: ' + storeFileOf(defaultRoot));
}
