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

## 适用场景

给 QQ / 微信这类**群聊机器人**用的聊天预设：即使被 prompt 注入改了人设，它也碰不到文件和 shell，只能说话和上网搜索——不会出现「把工作区打包发到群里」这种事故。

注意：宿主级工具（例如 `qqbot_send_file`、`lan_gateway`）不受预设控制，仍会对所有 agent 可见。

## 安装

在 DSH 里把本包作为 bundle 安装（profile 级，重启 Host 后可用），或在插件市场里点安装。

安装后在 Agent 预设下拉里出现「鲸鱼娘捆绑模式」，开新会话或 `/new` 后生效；已有会话保持原预设（started 锁定）。

## License

MIT。人设正文的版权归 dsh-whale-loli 作者所有，按 MIT 协议随包分发，见 [LICENSE](./LICENSE)。
