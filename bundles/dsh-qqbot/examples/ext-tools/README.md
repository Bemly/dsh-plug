# 扩展工具示例（`examples/ext-tools/`）

这些文件是给 `{数据根}/.qqbot-extensions/tools/` 用的**扩展工具**示例。

**自 v1.8.0 起：插件启动时会自动把它们铺进你的扩展目录**（`{数据根}/.qqbot-extensions/tools/`）——
**只补不存在**的文件、绝不覆盖你改过的，因此也不会重复搬。当然你也可以手动复制。
（热更新：写/改完发 `/tools-reload`；改**已有同名**工具时插件会自动热替换，无需重启宿主。）

## qq_send.mjs — 查 QQ 聊天对象 + 发消息（演示「跨通道工具」）

`expose: 'all'` 的样板：声明之后它**对所有会话可见**（含 web / 终端等非 QQ 通道），
靠 `env.qq` 账号包在那边**直接操作 QQ**（这就是"隔着通道指挥 QQ"）。

| 环节 | 说明 |
|---|---|
| 安装 | 插件自动铺（或手动把 `qq_send.mjs` 复制到 `{数据根}/.qqbot-extensions/tools/`） |
| 注册名 | `<原名>__<人设id>`，例 `qq_send__whale-girl`（⚠️ **工具名只能用 `[a-zA-Z0-9_-]`**） |
| 查询 | `action:"list"` → 列出已知群 / 私聊（带最近活跃时间），可用 `query` 过滤 |
| 发送 | `action:"send"` + `target`（openid **或群名/昵称**）+ `text`；按名字命中多个**绝不猜**，只回候选 |
| 连发 | `texts:[多条]`（内容不同）或 `text`+`count`（同一条重复 N 次），默认每条间隔 600ms 防 QQ 吞消息 |
| 发送链路 | 插件侧**被动优先**：先取目标会话最近的 `msgId` 走被动回复（不吃主动配额），失败自动去掉 `msgId` 转主动 |
| 前提 | 它走 `env.qq` ⇒ 必须声明 `expose: 'all'`，且对应人设实例在线 |

## vote.mjs — 群投票（演示「按钮回调」）

| 步骤 | 说明 |
|---|---|
| 安装 | 复制 `vote.mjs` 到 `{数据根}/.qqbot-extensions/tools/` |
| 使用 | 让 AI 调一次 `vote` 工具（题目 + `\|` 分隔的选项），它会发一张带按钮的卡片 |
| 点击 | 点下去 = 一票；同一人重复点只记第一次；每次点击都有回执文本 |
| 数据 | `{数据根}/.qqbot-extensions/tools/data/vote.json`（插件升级/重装不丢） |

## bing_search.mjs — 用 Bing 搜网页（演示「纯工具 + 结果自检」）

不依赖 `env.qq`、不碰会话状态，只做一件事：把搜索做好。三个示例里它最好改 —— 想换别的搜索源，
照着它的三段结构（取结果 → 自检 → 收尾排版）替换就行；也不注册卡片、不需要重启宿主。

| 环节 | 说明 |
|---|---|
| 安装 | 插件自动铺（或手动把 `bing_search.mjs` 复制到 `{数据根}/.qqbot-extensions/tools/`） |
| 查询 | `query`（必填，越短越准）；`count` 条数（默认 8，上限 20）；`site` 限定站点；`mkt` 语言市场 |
| 调试开关 | `quote:true` 强制加引号完全匹配；`raw:true` 跳过查询词卫生（拿来对比排查） |
| 查询词卫生 | 自动剥掉「是什么 / 是什么意思 / 怎么用」这类长尾巴 —— 长词形查询常被搜索引擎切碎，剥掉后明显更准 |
| 相关性自检 | 多词混排先算一次命中率；不过关就回退：**加引号完全匹配 → 只搜最长核心词**，并把实际用了哪一档写在结果开头 |
| 结果格式 | 每条 = `[来源域名] 标题` + 链接 + 摘要（截 180 字）；同一域名最多 3 条，防刷屏 |
| 抓取通道 | 先走 Bing 的 RSS 端点（`?format=rss`，解析最稳、不需要 key），失败回退 HTML 抓取；国内可直连 `cn.bing.com` |
| 暴露范围 | 声明了 `expose: 'all'` ⇒ 全部会话可用（含 web / 终端）；只想在 QQ 会话可见就删掉那一行 |

## 跨会话四件套 — `session_create` / `session_send` / `session_watch` / `sessions_list`

演示「**让一个会话去开另一个会话、把话投过去、再把结果收回来**」。四个配合用；`lib/` 里是它们
按 mtime 版本化加载的内部模块（**子目录不参与工具扫描**，放那里最安全；插件铺设时也会连子目录一起搬）。

| 工具 | 作用 | 关键点 |
|---|---|---|
| `session_create` | 建**子会话**并把初始任务投进去 | 可指定工作区与人设 —— 工作区名、人设的**显示名或 id** 都认（忽略大小写、唯一子串也认） |
| `session_send` | 往**任意会话**投消息（发送工具） | 照抄本插件的**入站模式**：忙时插话（`inject`）/ 空闲唤醒（`followup`）；首行带来源会话 id |
| `session_watch` | 挂 / 摘「回合结束回灌」钩子 | 子会话跑完自动把末段正文送回来；`action:"list"` 看钩子名单 |
| `sessions_list` | 列工作区与会话（只读） | 工作区按**子串**过滤（注意「A」也会命中「AB」） |

**三条经验（都是踩出来的）**

1. **别自己拼消息对象** —— 往会话塞消息用宿主原语（`agent.inject` / `agent.followup`）；
   手拼 `user/message` 容易写坏会话（本项目实测触发过 `agent/inbox/spliced requires message objects`，
   只能靠离线修数据恢复）。
2. **投递前先 resume** —— 非 live 的会话直接 `append` 会被**静默丢弃**（不报错，最难查的一种）。
3. **可见性靠 `expose` 控** —— `expose:'all'` 会被挂到插件根、**所有会话都能看到**（含 web / 终端）；
   不写该字段（或写别的值）则**只在 QQ 会话注册**，子会话看不到。建议：建会话/挂钩子这类
   **父会话专用**件不给子会话看（免得无限套娃），只把「投递/回执」那一个开放给子会话。

## 写自己的「按钮回调」工具，只要记住三件事

1. **发卡前登记卡片**（不登记 = 按钮点了没人认）：
   ```js
   env.registerInteractionCard({
     cardId, buttonIds: ['o0', 'o1'],
     expireAt: Date.now() + 86400_000,   // 可选，缺省 7 天
   });
   ```
2. **按钮 data 用 `ext:` 前缀**，三段式且与登记值完全一致：
   ```js
   { action: { type: 1, permission: { type: 2 }, data: `ext:${你的工具名}:${cardId}:${buttonId}` } }
   ```
   `type: 1` 才是回调按钮（0=跳转、2=指令都不产生回调事件）。
3. **导出 `onInteraction(ctx, info)`**：
   ```js
   export default {
     name: 'mytool', run(args, env) {…},
     async onInteraction(ctx, info) {
       // info: { cardId, buttonId, buttonLabel, clickedBefore, event }
       // ctx.performer: { openid, name, isOwner }   ← 点击者身份
       // ctx 与 run() 的 env 是同一套能力（emit/store/api/appendWake…）
       return '已处理 ✅';   // 非空字符串 = 发给点击者的回执
     },
   };
   ```

## 边界（插件侧保证的）

- 不是 `ext:` 前缀、或查不到登记记录 / 已过期 → 插件**不消费**该事件（交回原有兜底，最后只 ack）；
- 钩子抛错不会影响其它链路，点击者会收到一句 `⚠️ 处理失败：…`；
- 按钮回调的 ack 由插件统一做（不用管 `PUT /interactions/{id}`）；
- 注册表是纯旁路：**写失败也不影响发卡**，只是这张卡的按钮点了没反应。
