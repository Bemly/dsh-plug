/**
 * 包入口守卫：发现安装目录缺文件时直接报出缺失项，
 * 避免宿主只打印一句难懂的 failed to import。
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const missing = [];
for (const rel of ['dist/index.js', 'client/qqbot-settings.js', 'settings-host.js', 'cordis.patch.yml']) {
  if (!existsSync(join(here, rel))) missing.push(rel);
}

if (missing.length > 0) {
  const isDistMissing = missing.includes('dist/index.js');
  console.error('');
  console.error('  ┌──────────────────────────────────────────────────────────────┐');
  console.error('  │  dsh-qqbot 安装不完整，无法启动                              │');
  console.error('  └──────────────────────────────────────────────────────────────┘');
  console.error('  缺少文件: ' + missing.join(', '));
  console.error('  安装目录: ' + here);
  console.error('');
  if (isDistMissing) {
    console.error('  【处理办法】重新安装 npm 发布版或重新克隆完整仓库：');
    console.error('     pnpm add dsh-botqq');
    console.error('   Git 仓库已跟踪 dist/；若仍然缺失，说明安装源不完整或被裁剪。');
  }
  console.error('');
  throw new Error('dsh-qqbot: 安装不完整（缺少 ' + missing.join(', ') + '），请按上面的提示处理');
}

// 自检通过 → 正常导出
// ⚠️ 2026-09-28 修：原来这里多写了一句 `export { default } from './dist/index.js'`，
//   但 dist/index.js 并没有 default 导出 → 触发
//     SyntaxError: The requested module './dist/index.js' does not provide an export named 'default'
//   → 整个插件 import 失败（宿主只报一句难懂的 "failed to import"）。
//   这是个语法级错误：哪怕自检全过，插件也永远加载不起来。
export * from './dist/index.js';
