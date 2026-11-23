# magpie-unsafe-archive

magpie 的网关请求钩子（gateway request hook，跑在 Bun 插件宿主）。
**在遮盖之前**取请求原文、**在还原之后**取回复，另存一份本地明文归档；
发往供应商的那一份照常脱敏，不受影响。

名字里的 *unsafe* 是有意为之：归档里包含供应商本来看不到的密钥与个人信息，
以明文落在你的磁盘上。

## 它和 magpie 自带记录的区别

同一条请求，三个出口拿到的东西不同：

| 出口 | 正文里的密钥 | 个人信息（开了脱敏个人信息时） |
| --- | --- | --- |
| 供应商 | `{{KIND_xxxxxxxx}}` 占位符 | 占位符 |
| magpie 内置会话记录 | `[REDACTED:KIND]`，**不可逆** | 明文 |
| **本插件归档** | **明文** | **明文** |

内置记录对密钥的清除是 magpie 源码里写死的、没有开关，所以想要「本地留全明文」
只能靠钩子在遮盖之前取一份——这就是本插件做的事。

## 记录字段

每行一条 JSON（schema `v: 2`）：

| 字段 | 含义 |
| --- | --- |
| `v` / `at` / `end` / `durMs` | schema 版本；请求到达、回复落盘时刻（UTC ISO）、差值毫秒 |
| `session` / `agent` / `caller` | 客户端报的会话 id、客户端名、`{agent,name,via}`（经其他 magpie 转来时带链路） |
| `model` / `protocol` / `path` / `kind` / `stream` | 请求里说的模型、协议（chat/anthropic/responses）、入口路径、`subagent` 标记、是否流式 |
| `origin` | `magpie-key`（本机自己）/ `gateway-key`（任何网关密钥）/ `local` / `remote` |
| `cwd` / `query` | 客户端工作目录、本次用户原话（magpie 的路由同款取法） |
| `success` | 网关是否成功返回 |
| `usage` | 归一后的用量：`in/out/cacheRead/cacheWrite/reasoning/total`，缺哪个就不写哪个 |
| `request` / `reply` | 遮盖**前**的完整请求正文；还原后客户端收到的回复正文 |

两条诚实的限制：

- **存的是解析后重新序列化的对象**，不是客户端实际收到的原始字节；流式回复
  存的是聚合完成的那份。内容完整，但不是逐字节证据。
- **没有 HTTP 状态码和错误文本**。失败时钩子只拿到 `reply: null` 与
  `ctx.success === false`，`ctx` 里没有 status/error/headers。要按状态、
  错误类型、成本、供应商账号分类，查看时与 magpie 自己的 `usage.jsonl` 台账
  对齐（台账有 `status/err/err_type/callerKeyName/cost/ms/ttft_ms` 等，且不设
  保留期）；对齐靠 `session` + 时间，客户端不发 `X-Magpie-Session` 的那些对不上。

## 安装

```sh
magpie plugin add magpie-unsafe-archive
```

按路径安装（开发时）：

```sh
magpie plugin add ./unsafe-archive.hooks.js
```

## 配置

在 `设置 → 插件` 里给本插件设选项，或直接写进 `plugins.json` 的 `options`：

| 选项 | 默认 | 说明 |
| --- | --- | --- |
| `dir` | 见下 | 归档目录。留空时用默认位置 |

`dir` 留空时的默认位置：npm 安装落在 `~/magpie-unsafe-archive/`；
按路径安装落在插件文件旁的 `archive/`。
也可用环境变量 `MAGPIE_UNSAFE_ARCHIVE_DIR`。

每天一个 `<UTC 日期>.jsonl`，目录权限 `0700`、文件 `0600`。

## 永不删除

本插件**只做追加**：没有轮转、没有保留期、没有总量上限，任何情况下都不会删
你已有的归档。它是审计留痕，删一条就少一条。

代价是磁盘只增不减。一台全天有活的网关实测约 **10~25 MB/小时**（长上下文重的
单条记录可以上百 KB 到几 MB，因为存的是完整请求与回复），换算下来一天几百 MB
到几 GB，取决于流量峰值在不在你睡觉的时候。别照搬这个数，装好后按
`ls -la archive/` 看当天文件长多快，自己估。请自己安排：

- 给归档所在卷留足容量，并**监控余量**；
- 需要长期留档就自己做**加密备份**（`restic`/`borg`/`rclone crypt` 之类），
  备份出去前务必加密——里面是含密钥的明文；
- 想按时间清理请**手工**做，删哪段你自己决定。

## 警告

- **不要把归档目录指向任何会被共享或同步的位置**：WebDAV 共享、S3、云备份、
  会被同步的配置目录都不行。里面的内容包含 API key 和个人信息明文。
- 每条记录一次 `fsync`。机械盘 + 高并发时这会加重 I/O，也可能让钩子超出
  magpie 的 2~10 秒预算而被中断（见下）。

## 可靠性边界

- magpie 的钩子并发跑满时，本插件不被调用，**该条静默丢失**（fail-open，
  请求本身不受影响）。
- 钩子有 2~10 秒总预算，落盘超预算会被中断，同样丢该条。机械盘上 `fsync`
  是主要超时来源。
- 本插件不修改请求正文、不拦截请求、不改模型或流式标志。
- 只覆盖经过 magpie 网关的请求。绕过网关直连厂商的不在范围内。

## 验证自己装对了

发一条带 `X-Magpie-Session` 的请求，正文里埋一个假的 `sk-` 串，然后对比：

- 归档文件里应能看到该串**明文**；
- `设置 → 隐私` 的脱敏记录里应能看到同一请求的 `{{SECRET_xxxxxxxx}}` 占位符
  （说明厂商侧仍被遮盖）。

两边都对，才是「出网遮盖 + 本地全明文」。

## 源码与提交规则

源码在本仓库 `magpie/` 目录，与 npm 包同源。
**每次修改先按 [`magpie/AGENTS.md`](./magpie/AGENTS.md) 脱敏，再提交推送。**
