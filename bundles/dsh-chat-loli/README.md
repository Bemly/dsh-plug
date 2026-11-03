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
