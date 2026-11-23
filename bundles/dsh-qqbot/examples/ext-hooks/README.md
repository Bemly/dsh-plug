# 启动钩子示例（`examples/ext-hooks/`）

这些文件是给 `{数据根}/.qqbot-extensions/hooks/` 用的**启动钩子**（第四套扩展，v1.8.9+）。

**插件启动时会自动把它们铺进去**（与 `tools/`、`botplay/` 的示例同一时机、同一纪律：**只补不存在**、
绝不覆盖你改过的，因此也不会重复搬）。当然你也可以手动复制。

## 和 tools / commands / botplay 的区别

| 扩展 | 放哪 | 谁触发 |
|---|---|---|
| `commands/` | `{数据根}/.qqbot-extensions/commands/*.mjs` | 用户敲 `/命令` |
| `tools/` | `{数据根}/.qqbot-extensions/tools/*.mjs` | **LLM 调用**该工具 |
| `botplay/` | `{数据根}/.qqbot-extensions/botplay/*.mjs` | 有人点卡片按钮 |
| **`hooks/`** | `{数据根}/.qqbot-extensions/hooks/*.mjs` | **插件启动时自动跑一次**（没人调用也跑） |

典型用途：恢复上次没跑完的长期任务、注册监听、起定时器、预取数据、启动自检。

## 契约

```js
// {数据根}/.qqbot-extensions/hooks/my-hook.mjs
export async function run(env) {          // 必需：启动时执行一次（async 可以，返回 Promise 也行）
  env.logger.info(`插件 v${env.pluginVersion} 起来了`);
  const t = setInterval(() => { /* … */ }, 60_000);
  t.unref?.();
  env.registerDispose(() => clearInterval(t));   // 清理（可选，见下）
}

export async function dispose(env) {      // 可选：插件卸载 / 宿主退出 / 重建网关时调用
  env.logger.info('收尾完成');
}
```

三种写法都认（挑一种就行）：

```js
export function run(env) {}                       // ① 具名导出（最直白）
export default { name: 'x', run(env) {}, dispose(env) {} };   // ② 对象默认导出（与 tools 同风格）
export default async (env) => {};                 // ③ 裸函数默认导出（最短）
```

### `env` 里有什么

| 字段 | 说明 |
|---|---|
| `ctx` | 插件自己的 cordis Context（"遥控器"）：`ctx.on()` / `ctx.get()` / `ctx.webServer.register()` … |
| `logger` | 插件 logger（`info/warn/error/debug`）。建议日志前缀写 `[ext-hook:<名字>]` |
| `dataRoot` | 数据根目录（= `.qqbot-extensions` 的父目录） |
| `config` | 当前实例配置对象（只读用途；要改设置请走设置页） |
| `registerDispose(fn)` | 注册清理函数（返回 Promise 也行）；与导出的 `dispose()` 一样在卸载时被调用，**逆序**执行 |
| `pluginVersion` | 插件包版本号（如 `1.8.9`），可按版本做分支 |
| `hookFile` | 本钩子的绝对路径（调试/自报家门用） |
| `caps` | 与 tools / commands **同一套**能力包：`markdown/image/media/api/store/at/appendWake/…` |
| `store` | `caps.store` 快捷方式：`load()` / `save(obj)`，落 `{数据根}/.qqbot-extensions/hooks/data/<文件名>.json` |

> `caps` 在"没有会话"的启动期天然拿不到发送/会话类能力（没有 `replyTarget`、没有 `agent`）——
> 这类调用会安静地返回 `false`，不会抛错。启动期真正有用的是 `store` / `api` / `ctx`。

## 两条硬纪律（插件侧保证的）

1. **单个钩子抛错绝不影响插件启动、也不影响其它钩子**：每个钩子独立 try/catch，失败只记警告并继续。
2. **异步钩子不会把启动拖死**：单钩子超时 **30s**，超时只告警并放行（它仍在后台跑，插件不会被强杀）。
   另外：`hooks/` 目录**不存在或为空 = 完全安静**（不报错、不刷日志）；每个钩子的名字与结果
   （成功 / 失败 / 超时）都会写到日志里。

> ⚠️ 超时**不会**真的杀掉钩子的代码（Node 里没法安全强杀 promise），所以别把长任务（下载大文件、
> 长时间轮询）直接写在 `run()` 里 —— 用 `setInterval` / 后台异步跑，`run()` 本身尽快返回。

## 示例说明

### `hello-hook.mjs` — 最小可跑（日志型）

不需要任何宿主状态：启动打一行日志、用 `store` 记"这是第几次启动"、卸载打一行再见。
拿它确认"启动钩子这条链路是通的"。

### `session-watch-hook.mjs` — 注册监听 + 收尾

演示三件"必须自己收尾"的事：`ctx.on('session/event', …)` 订阅宿主事件、起一个 60s 的统计定时器、
把统计结果落盘；收尾同时用了 `env.registerDispose(fn)` 与模块级 `dispose(env)` 两条通路
（还有 `run`/`dispose` 竞态的 `cancelled` 兜底写法，可以直接抄）。

## 怎么确认跑起来了

启动后在插件日志里找这几行（`{名字}` 是 `name` 导出，不写就是文件名）：

```
[ext-hook] 发现 2 个启动钩子，开始执行（单钩子超时 30000ms）
[ext-hook:hello] 你好，插件 vX.Y.Z 启动完成；数据根 = …
[ext-hook] ✓ hello-hook (hello-hook.mjs) 12ms
[ext-hook] 启动钩子执行完毕: 成功 2 / 失败 0 / 超时 0
```

想停掉某个钩子：把文件挪出 `hooks/` 或改名成 `.mjs.bak`（非 `.mjs/.js/.cjs` 一律不扫描）；
**改完要重启插件/宿主才生效**（钩子只在启动时跑，没有热重载）。
