# 入站中间件（`{数据根}/.qqbot-extensions/inbound/`）

> 这一套扩展能**影响每一条入站消息的命运**：让它别进来、把它的文本换掉、让它一定要叫醒她、或者反过来"这条不算 @ 她"。
> v1.9.0+。
> **这一套里"会自动铺到你目录"的只有 `no-wake-on-child-quote.mjs` 一个**（插件首次启动铺一份，只补不存在、绝不覆盖你改过的）。
> 其余示例（尤其 `class-advisor.mjs` —— 它会**真删消息、真封人**）**不自动铺**，想看想用自己拷过去。
> 理由：示例是给人**看和抄**的，不该在你没读过它之前就自己跑起来。

---

## 一、两个挂点：链上位置决定你能做什么

```
… → messageFilter → accessPolicy → quoteRef
   → ★① 早挂点 onInbound ★            ← 记群历史之前！
   → 引用图预取 → 群历史缓冲（store）→ 表情包/台账
   → mentionGate（@ 门控）
   → ★② 晚挂点 onDecide / export default ★
   → contentSanitizer → debounce（延迟聚合）→ 命令 → 群冷却 → 并发合并 → envelope → AI
```

| | **① 早：`onInbound`** | **② 晚：`onDecide` / `export default`** |
|---|---|---|
| 链上位置 | `quoteRef` 之后、**记群历史之前** | `mentionGate` 之后、`contentSanitizer` 之前 |
| 读得到 | `ctx.message` / `ctx.state.quote` / `ctx.platform.mentioned` | 上面全部 **＋ `ctx.state.mention`**（@ 判定） |
| 做得了 | **消灭**、**改写**、**强制入站**、查/写禁言名单 | **覆盖 @ 判定**、改写、强制入站、查/写禁言名单 |
| 做不到 | `ctx.decide`（`ctx.state.mention` 还没写出来，调了会被拒 + 告警） | `ctx.annihilate`（群历史已经记过了，调了会被拒 + 告警） |

一个文件可以**同时导出两个挂点**（互不影响）；只导出 `export default` 就是最早那份契约，**语义等同 `onDecide`**，老扩展不用改。

```js
// {数据根}/.qqbot-extensions/inbound/my-rule.mjs
export async function onInbound(ctx, next) {   // ① 早
  return next();
}
export default async function onDecide(ctx, next) {   // ② 晚（= 原来的写法）
  return next();
}
export function dispose() { /* 可选：插件卸载/重建网关时清理 */ }
```

四种写法都认（挑一种就行）：

```js
export default async (ctx, next) => next();          // 裸函数默认导出（= 晚挂点）
export async function onDecide(ctx, next) { … }      // 具名晚挂点
export async function onInbound(ctx, next) { … }     // 具名早挂点
export const onInbound = async (ctx, next) => next();// 箭头式也行
export default { name: 'x', onInbound, onDecide, dispose() {} };   // 对象默认导出
```

> ⚠️ 一个扩展文件里，晚挂点只认一个：**具名 `onDecide` ＞ 裸函数 `export default` ＞ 对象里的 `onDecide`/`middleware` ＞ 具名 `middleware`**。

## 二、为什么"改写 / 消灭"必须写在**早挂点**（这是最容易踩的一处）

链上第 4 步是**群历史缓冲**：它把每条消息的正文写进 store（AI 的 `[历史]` 段就是从这来的），而它读的是 `ctx.message.content`。
所以：

* **改写**写在早挂点 → 进 store 的就是改后文本（AI 看到的、历史里存的都是和谐版）；
  写在晚挂点 → **store 里已经是原文了**，只有"当前这条"是改后的（要连历史一起改，只能在早挂点）。
* **消灭**（`ctx.annihilate()`，等价于"不调 `next()`"）写在早挂点 → 链停在这里，**群历史、@ 门控、价值评分、群冷却全都不跑**，这条消息等于没来过；
  写在晚挂点 → 历史已经记了、门控已经过了，就算拦住派发，它也已经躺在历史里了。
* **@ 判定覆盖**（`ctx.decide`）只能写在晚挂点 —— 早挂点跑的时候 `mentionGate` 还没执行。

## 三、动作 API 完整签名表（用户看到的就是这些）

### 消息维

| 调用 | 作用 | 用在哪 |
|---|---|---|
| `ctx.annihilate({ reason })` | **消灭**这条：不进群历史、不进上下文、不占群冷却。内部 = 让引擎不再 `next()` | 早挂点（晚挂点会被拒 + 告警） |
| `ctx.rewrite({ text, reason })` | **替换文本**（改的是 `ctx.message.content`） | 早挂点（历史也是改后文本）；晚挂点只改"当前这条" |
| `ctx.forceWake({ reason })` | **强制入站**：跳过 @ 门控、价值评分、群冷却等一切"值不值得回"的判断；**不伪造 @**（不会多出假的 `(@you)`） | 两个挂点都能调；要连"没 @ 也放行"必须用早挂点 |
| `ctx.decide({ mention: 'ignore' \| 'force', reason })` | **覆盖 @ 判定**：`ignore` = 这条不按被 @ 处理；`force` = 按被 @ 处理（会被当"点名"） | 晚挂点（早挂点会被拒 + 告警） |

返回值：成功 `true`，被拒/参数不合法 `false`（并在日志里留一条 warn）。

### 用户维（名单，两块挂点都能用）

| 调用 | 作用 |
|---|---|
| `ctx.muteUser({ id?, minutes, reason? })` | 禁言：`id` 缺省 = **当前发送者**；`minutes > 0` = 这么多分钟，**`minutes <= 0` = 永久**。成功返回名单项 `{ id, until, reason, by, at }`，失败 `false` |
| `ctx.unmuteUser({ id? })` | 解禁（可撤销通道）；返回是否真的解掉了一条 |
| `ctx.isMuted(id?)` | 查一条（缺省 = 当前发送者）：命中返回 `{ id, until, reason, by, at, permanent, remainingMs, remainingMinutes }`，没命中 `null` |
| `ctx.mutedUsers()` | 整份名单（已做过期清理，带剩余时间，按到期时间升序，永久排最后） |

### 通用取值 / 工具

| 字段 | 说明 |
|---|---|
| `ctx.text` | 当前消息文本（**可写**：赋值 = 直接改 `ctx.message.content`，但不会落审计，建议用 `ctx.rewrite`） |
| `ctx.scope` | `'group' \| 'c2c'` |
| `ctx.sender` / `ctx.senderName` / `ctx.isOwner` | 发送者 openid / 昵称 / 是否主人（`config.groupAdmin.owners`） |
| `ctx.groupId` | 群 openid（私聊是 `''`） |
| `ctx.mentions` | SDK 的 mentions 数组原样 |
| `ctx.quoted` | 被引原文：`{ text, id, fromSelf }`。`id` = 被引那条的发送者 openid（"回复某人再下令"用它）；`fromSelf` = 是不是她自己说的（**启发式**，靠"她最近一条发言"的文本比对，可能不准）。也可以写成 `ctx.quoted()` 拿一份快照 |
| `ctx.platform` | `{ mentioned }`：**平台**认为这条 @ 了她吗（判据与 SDK `mentionGate` 一致：`rawEventType` / `mentions[].is_you` / 正文里的 `<@appId>`）。早挂点读不到 `ctx.state.mention`，要判 @ 就用它。也可以写成 `ctx.platform()` |
| `ctx.logger` | 插件 logger（`info/warn/error/debug`） |
| `ctx.dataRoot` | 数据根路径（放自己的文件用） |
| `ctx.kv.get(key)` / `ctx.kv.set(key, value)` | **每个扩展自己的持久化**（与禁言名单同一个文件）；`set(key, undefined)` = 删掉这个键 |

> 所有动作**内部都有 try/catch，任何情况下都不会抛到链上**；出错只 warn 并返回 `false`。
> `ctx` 上这些属性是**不可枚举**的（不会跟着 `{...ctx}` 被复制走、也不会被 JSON 序列化抓走）。

## 四、禁言名单存哪、怎么过期

```
{数据根}/.qqbot-extensions/inbound/.state/<你的扩展文件名>.json
{
  "mutes": [ { "id": "群友openid", "until": 1760000000000, "reason": "广告", "by": "class-advisor", "at": 1759999000000 } ],
  "kv":    { "spam:<openid>": [1759999000000, 1759999010000] }
}
```

* `until` = 到期时间戳（ms）；**`until: 0` = 永久**（`minutes <= 0` 时写 0，永远不会被清理）。
* **惰性清理**：每次读名单都会剔掉已过期的项，并把清理结果写回文件。
* **跨重启有效**：名单在盘上，插件重启/网关重建都还在。
* **坏文件不崩**：JSON 坏了、形状不对、没权限 —— 一律当空（`mutes: []`、`kv: {}`），插件与消息链照常跑。
* `.state/` 是**子目录**，不会被当扩展装载（扫描只看 `inbound/` 根下的直接子文件）。
* 审计账本是**共用**的一个文件：`{数据根}/.qqbot-extensions/inbound/.state/audit.jsonl`。

## 五、四条保命件（插件侧强制，写错也兜得住）

1. **白名单最高优先** —— 主人（`config.groupAdmin.owners` 里的 openid）**永不可被静默/消灭**。
   扩展对主人调 `ctx.annihilate()` 或 `ctx.muteUser({ id: 主人 })` ⇒ **拒绝执行** + 一条 warn（消息照常放行），审计里记 `result: "refused-owner"`。
   > ⚠️ 光"拒绝动作"是不够的：最常见的写法是 `if (该消灭) { ctx.annihilate(); return; }` ——
   > 那个 `return`（不调 `next()`）本来会把链停住，等于"插件说拒绝了、消息还是被吞了"。
   > 所以引擎还有一条**兜底放行**：扩展既没调 `next()`、又没有一次成功的消灭时 ——
   > ① 消灭**被拒**过（主人/熔断/挂点不允许）⇒ 引擎替它放行；② 发送者是**主人** ⇒ 引擎替它放行。
   > 两种情况都会写一条 warn。⇒ **主人的消息永远不会被入站扩展吞掉**（要拦主人请自己去改插件）。
   > 其余情况（普通群友、扩展自己有意 `return`）保持老契约：链停在这里，消息不进后续任何环节。
2. **强唤醒优先于静默** —— `ctx.forceWake()` 不会被 `annihilate` 之外的东西抵消；
   **顺序由你自己排**：把"求助关键词 → forceWake"写在"禁言名单 → annihilate"**之前**，
   否则会出现"被禁言的人喊救命没人理"（`class-advisor.mjs` 就是照这个顺序写的）。
3. **熔断** —— 按**每个扩展**统计破坏性动作（消灭/静默）的密度：
   * 该扩展参与的最近 50 条里，破坏性动作 > 50% ⇒ 熔断；
   * 该扩展 10 秒内破坏性动作 ≥ 20 次 ⇒ 熔断。

   熔断后：**只停掉该扩展的破坏性动作**（`annihilate`/`muteUser` 返回 `false` + warn，消息照常放行，
   同样由上面的"兜底放行"保证真的放行），`rewrite`/`forceWake`/`decide` 不受影响；告警里带扩展名与原因。
   **复位**：改文件后 `/tools-reload`（或重启插件）即可 —— 每次装载都会清掉该扩展的熔断记录。
4. **审计 + 可撤销** —— 每次 `annihilate / rewrite / forceWake / decide / muteUser / unmuteUser`（含被拒的那种）
   都往 `audit.jsonl` 追加一行：`{ at, file, name, action, target, reason, text, result }`；
   `text` 是**截断后的**摘要（120 字），不会把整条消息塞进去；文件超过 512KB 自动轮转成 `audit.jsonl.1`（只留一代）。
   `muteUser` 随时可以用 `unmuteUser` 解掉。

## 六、从零写一个自己的规则（走查）

**目标**：群里有人发"@她 + 名字"时必须有回应；有人刷同样的句子三次以上就禁言 5 分钟；正文里的手机号要打码。

1. **建文件**：在 `{数据根}/.qqbot-extensions/inbound/` 下新建 `my-rule.mjs`（扩展名只认 `.js/.mjs/.cjs`；文件名就是排序与状态文件的名字）。
2. **先只写"放行"**，确认能装载：

   ```js
   export const name = 'my-rule';
   export async function onInbound(ctx, next) {
     ctx.logger.info?.('[my-rule] 看到一条：' + ctx.text.slice(0, 20));
     return next();
   }
   ```
   存盘 → 群里发一句 → `/tools-reload`（或重启插件）。启动日志里会出现
   `[ext-inbound] 已装载 N 个入站中间件: …, my-rule（其中 M 个含早挂点 onInbound）`；
   没有这行就看日志里的 `[ext-inbound] ✗ my-rule …`（装载失败会说原因）。
3. **加规则**（都在早挂点里，因为要影响历史/是否进站）：

   ```js
   export async function onInbound(ctx, next) {
     const text = String(ctx.text ?? '');

     // ① 求助/点名优先 —— 必须写在"静默"判断之前
     if (text.includes('救命') || /在吗|求助/.test(text)) {
       ctx.forceWake({ reason: '求助关键词' });   // 跳过 @门控/评分/冷却
       return next();
     }

     // ② 复读刷屏 → 禁言 5 分钟 + 消灭这条
     const key = 'say:' + ctx.sender;
     if (ctx.kv.get(key) === text) {
       ctx.muteUser({ minutes: 5, reason: '复读刷屏' });
       ctx.annihilate({ reason: '复读刷屏' });
       return;                                   // ★ 不调 next() = 不进历史、不进上下文
     }
     ctx.kv.set(key, text);

     // ③ 手机号打码（改写：历史里也是打码后的）
     const masked = text.replace(/(?<!\d)(1[3-9]\d)\d{4}(\d{4})(?!\d)/g, '$1****$2');
     if (masked !== text) ctx.rewrite({ text: masked, reason: '手机号打码' });

     return next();
   }
   ```
4. **验证**（每条都看一眼）：
   * 刷屏的那条**没有**出现在 `[历史]` 里（说明消灭真的生效）；
   * `{数据根}/.qqbot-extensions/inbound/.state/audit.jsonl` 里有一行 `{"action":"annihilate", …}`；
   * `{数据根}/.qqbot-extensions/inbound/.state/my-rule.mjs.json` 里有 `mutes` 项；
   * 用主人账号发同样的话 → **不该**被禁言（白名单），日志里有一条 warn。
5. **调参/关掉**：改文件 → `/tools-reload` 生效；把文件改名成 `my-rule.mjs.bak`（非 `.js/.mjs/.cjs` 不扫描）→ 立即失效。

## 七、本目录的示例

| 文件 | 会自动铺到你的目录吗 | 演示什么 |
|---|---|---|
| `no-wake-on-child-quote.mjs` | ✅ **会**（只铺这一个） | **两个挂点同时演示**。晚挂点：引用"子会话转发"的消息不算 @（`ctx.decide`）。早挂点：只读观测 + 两个默认关闭的开关（改写转发头 / 消灭纯转发空壳） |
| `class-advisor.mjs` | ❌ **不会**，要自己拷 | **辅导员**：① 按发送者禁言（名单+时长，含主人 `/禁言` `/解禁` 指令）② 敏感词/手机号改写 ③ 求助关键词强制到场（**写在黑名单之前**）④ 广告/刷屏直接消灭。**默认 `DRY_RUN = true` 只观察不动手**，看完日志再改 |

> 为什么 `class-advisor` 不自动铺：它会**真删消息、真封人**。插件不该替用户决定"我的群要不要开这套规则"，
> 更不该在用户数据目录里凭空多出一个会写状态的文件。想看、想用，自己拷过去（记得先留 `DRY_RUN = true`）。

## 八、`hooks/`、`tools/` 与它的区别

| | `hooks/` | **`inbound/`** | `tools/` |
|---|---|---|---|
| 跑几次 | **启动时一次** | **每条入站消息一次** | LLM 调一次 |
| 拿到什么 | `env`（`{ctx, logger, dataRoot, …}`） | `(ctx, next)`（与 `bot.use(mw)` 同签名） | 工具参数 |
| 干什么 | 起定时器 / 注册监听 / 恢复任务 | **处理这条消息**：消灭 / 改写 / 强制入站 / 管名单 | 查数据、发消息 |
| 写错了 | 启动少跑一段 | 那条消息处理受影响（引擎兜底：抛错只告警并继续 `next()`） | 那次调用失败 |

一句话：**hooks 管"起什么"，inbound 管"这条怎么处理"**。两者不通用。

## 九、排查速查

| 现象 | 先看这里 |
|---|---|
| 扩展没生效 | 文件名扩展名对不对（`.js/.mjs/.cjs`）、日志里有没有 `[ext-inbound] ✗ …`、是否忘了 `/tools-reload` |
| 消息被吞了 | 你自己的 `annihilate` / 没调 `next()`；审计里有 `annihilate` 行；熔断告警也在日志里 |
| `ctx.decide` 没反应 | 是不是写在早挂点了（会被拒 + warn：`decide 只在晚挂点 onDecide 有效`） |
| `ctx.annihilate` 没反应 | 是不是写在晚挂点了（会被拒 + warn：`annihilate 只在早挂点 onInbound 有效`）；或者对方是主人（`refused-owner`） |
| 低分消息还是回话了 | 日志里搜 `强制入站(入站扩展 forceWake…` —— 可能是你自己的扩展要求的；也可能是 `forceWake` 之后 debounce 把标记带下去了（正常） |
| 禁言没生效 | `isMuted()` 是不是写在"消灭"之前却被后面的分支覆盖了；名单文件在 `.state/<你的文件名>.json` |
| 熔断了 | 日志搜 `⚠ 熔断「…」`；复位 = 改文件 + `/tools-reload` |

---

## 附：`annihilate({ ownerAck: true })` —— 唯一能吞"主人消息"的通道（v1.10.5 新增）

**背景**：白名单写着「主人的消息永不可被入站扩展吞掉」，`ctx.annihilate()` 遇到主人发送者会**直接返回 false**
（审计 `refused-owner`），引擎还有第二道兜底（扩展没调 `next()` 时替它放行）。这两道一起保证了
"用户脚本坏了也吞不掉主人的话"。

**但有一类是主人自己的意图**：例如**二档路由隔绝** —— 群里那条 `[s:c0246642] 来我房间` 已经被扩展
投递到目标会话了，主人明确要求**不要再留在本会话上下文里**。这时扩展可以：

```js
const ok = ctx.annihilate({ reason: '二档路由隔绝：已投到目标会话', ownerAck: true });
if (!ok) return next();          // 没吞掉 ⇒ 交回原路径，别双投
// ★ 吞掉之后照样要 return next()：annihilate 置位会让 next() 变成空操作、链停在这里
return next();
```

**三条纪律**（写在 `ExtInboundCaps.annihilate` 的类型注释里）：

1. **只在"你确实已经把内容投递到别处"时传** —— 否则主人的话会凭空消失；
2. 用了它**一定落审计** `result: 'ok-owner-ack'`（外加一条 warn），事后可查"哪条主人的消息被谁吞了、为什么"；
3. 它只解开**这一条**的白名单 —— 挂点检查、熔断等其它保护一律照旧。

**向后兼容**：老版本插件不认识 `ownerAck`，会照旧按白名单拒绝 ⇒ 行为退回"主人的消息照常放行"，不会更糟。

**参考实现**：同目录 `route-isolate.mjs`。
