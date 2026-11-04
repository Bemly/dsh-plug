# dsh-chat-loli

DSH 自定义 Agent 预设「**鲸鱼娘捆绑模式**」（preset id `dsh-chat-loli`）：鲸鱼娘人设 + **只有搜索/抓取**，没有 shell、没有文件读写、没有 glob/grep、没有记忆写入工具。

## 工具面

| 保留 | 去掉 |
|---|---|
| `web_search` | `bash` / pty（persistent-shell） |
| `web_fetch` | `read` / `write` / `edit`（tool-fs） |
| | `glob` / `grep`（tool-fs-search） |
| | `whale_memory_v3_add`（whale-memory） |

人设正文来自 [dsh-whale-loli](https://www.npmjs.com/package/dsh-whale-loli)（MIT）的 `src/persona-v3-naughty.md`，原文照搬；只把 `{{whale_memory_v3}}` 占位符替换为「（本预设未挂载记忆文件）」，因为记忆插件被去掉了。

## 能力边界

人设正文里原本写着「pwsh / 记忆文件 / 翻日志」这些另外两个预设的能力。工具被砍掉以后，模型会以为自己还能执行命令，于是出现两种坏行为：

- 编造结果：「命令已经执行啦，但是返回结果是空的」——日志里根本没有 tool call；
- 说「让我先看看 / 让我先打包」然后直接结束回合，什么也不做。

所以人设尾部追加了一段【能力边界 · 硬约束】：只有 `web_search` / `web_fetch`，没有 shell、没有文件读写、不能发文件、不能生图；做不到就直说，禁止假装执行。这段在 `complete: true` 的人设里，优先级覆盖正文里过时的工具描述。

## 会话压缩

预设内挂了一个与 `standard` 同构的 compaction 组：

| 行 | 作用 |
|---|---|
| `compaction-basic` | 压缩服务本体；QQ bot 的 `/compact` 也是按「会话 preset 的 compaction 服务 → 宿主全局」两级回落来找它 |
| `command-compact` | 会话里的 `/compact` 命令 |
| `tool-result-pruner` | 压缩前修剪超大工具结果（`thresholdChars: 8192`） |

三者放在 `isolate: { compaction: true, toolResultPruner: true }` 的组里，服务只属于本预设，不会漏到别的会话。

> 压缩能力在**新会话**生效；已开始的会话保持创建时的 preset revision，需要 `/new`。

## 宿主级工具收窄（`lib/guard.js`）

上面那张表只覆盖**预设管得着的那一半**。DSH 的 Web 界面在 `dsh-web-app` 这一层只把 23 个「agent 平面」的工具行交给预设；**不在这份名单里的行留在宿主平面**，注册进进程级全局工具层，任何预设的会话都继承。

所以只声明 `persona + tool-web` 的预设，实际会话里仍然看得见：

| 来源 | 工具 |
|---|---|
| `dsh-experimental-terminal-bundle` | `terminal_open` / `terminal_send` / `terminal_read` / `terminal_close` / `terminal_signal` / `terminal_list` |
| `dsh-cua-drive` | `cua_*` |
| `dsh-browser-use` | `browser_*` |
| `dsh-config-manager` | `config_*` |
| `dsh-experimental-session-search` | `session_search` 等 |
| `dsh-lan-gateway` | `lan_gateway` |
| `dsh-base` 宿主行 | `working_directory` / `*_mcp_resource*` / `load_workspace_dependencies` |

其中 `terminal_*` 等价于一个完整 shell —— 对「防 prompt 注入」这个卖点是致命的。

本包因此附带一个宿主级插件 `lib/guard.js`：在 `agent/created` 时判定 agent 绑定的预设，命中 `dsh-chat-loli` 就调 `agent.ctx.tools.restrict({ deny })` 把当前全局工具集合整体遮掉。依据是 `dsh-agent` 的契约 —— *`Agent.ctx` 是该 agent 的 scoped context，通过它做的注册（含 restrictions）只作用于该 agent*。遮罩只作用于全局层，预设自己 scoped 注册的 `web_search` / `web_fetch` 不受影响。

工具名是运行时现算的（`ctx.tools.schemas()` 省略 scope = 全局视图），因为 `restrict` 对未知名字会直接抛错。

配置（`cordis.patch.yml` 内）：

```yaml
- id: chat-loli-guard
  name: 'dsh-chat-loli/guard'
  config:
    preset: dsh-chat-loli   # 要收窄的预设 id
    keep: []                # 额外保留的全局工具名
```

边界：

- 只对**新建 / resume** 的 agent 生效；插件装上之前就在跑的会话需要新开。
- 判定拿不到预设 id 时**放行**（宁可不动作，也不误伤别的会话），所以它是兜底，不替代把宿主 bundle 关掉这种硬隔离。
- 晚注册的全局工具（运行中才连上的 MCP server）不会被追认。

## 适用场景

给 QQ / 微信这类**群聊机器人**用的聊天预设：即使被 prompt 注入改了人设，它也碰不到文件和 shell，只能说话和上网搜索——不会出现「把工作区打包发到群里」这种事故。

## 安装

在 DSH 里把本包作为 bundle 安装（profile 级），或在插件市场里点安装。

安装后在 Agent 预设下拉里出现「鲸鱼娘捆绑模式」，开新会话或 `/new` 后生效；已有会话保持原预设（started 锁定）。

## License

MIT。人设正文的版权归 dsh-whale-loli 作者所有，按 MIT 协议随包分发，见 [LICENSE](./LICENSE)。
