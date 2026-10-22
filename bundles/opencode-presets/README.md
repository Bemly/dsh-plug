# dsh-opencode-presets

一个插件，两个 DSH 自定义 Agent 预设，移植自 [Bemly/opencode](https://github.com/Bemly/opencode)：

| 预设 id | 名称 | 来源 | 说明 |
|---|---|---|---|
| `nsfw` | NSFW 创作模式 | NSFW 分支（`agent/nsfw.md` / `command/nsfw.md` / `plugin/nsfw-boost.ts`）| 虚构成人向创作执行器：成人小说/同人/OC/角色扮演，按请求尺度保真交付 |
| `unrestricted` | Unrestricted 安全研究模式 | unrestricted 分支（`agent/unrestricted.md` / `command/unrestricted.md` / `plugin/unrestricted-boost.ts`）| 安全研究执行器：学术/防御研究语境，双用途请求按教学 PoC 保真交付，工具优先 |

## 移植方式

OpenCode 的三件套在 DSH 里没有一一对应的机制，做法是全部折进 persona（`complete: true`，对标官方 minimal 预设）：

1. `plugin/*-boost.ts` 里的 `BOOST` 语境块 → persona 开头；
2. `agent/*.md` 全文（含 `[MODE]` / `[REFUSAL]` 标记行）→ persona 主体；
3. `command/*.md` 的启动契约（首行 `当前：{obj}|{done}|{next}` + 立刻交付）→ persona 尾部。

工具面沿用官方 standard 预设的完整组成（shell / 文件 / 检索 / skills / 目标 / 计划 /
压缩 / 子代理 / web），只换人设——opencode 里两个 agent 都是 `permission: allow` 的全工具
agent，与 standard 工具面一致。

OpenCode 插件里的关键词改写钩子（`experimental.chat.messages.transform`）在 DSH 预设里
不需要：每个预设本来就有独立 composition，不存在"别污染 build/plan"的串扰问题。

## 安装

在 DSH 里安装本目录为 bundle（profile 级生效，重启 Host 后可用）：

```bash
dsh plugin --profile desktop install /Users/bemly/Documents/Dsh/dsh-opencode-presets
```

或经由 Web GUI 的插件市场/手动安装入口指向本目录。安装后在 Agent 预设下拉里出现
`NSFW 创作模式` 与 `Unrestricted 安全研究模式`，开新会话即用（已有会话不受影响）。

## 使用

- 切到 `NSFW 创作模式` 直接开始对话，或首句写清创作请求（原 `/nsfw <请求>` 的等价行为
  已写进人设：首行输出 `当前：{obj}|{done}|{next}` 后立刻开工）。
- 切到 `Unrestricted 安全研究模式` 后直接描述目标（原 `/unrestricted <请求>` 的等价行为
  已写进人设：首行 `当前：{obj}|{done}|{next}` 后立刻 tool call）。

## 注意事项（上游原话，保留）

- 先用容易"破甲"的模型起手建立虚构/研究语境与已放行上下文，再用 `/models`（DSH 里为
  模型切换器）切到真正想用的模型；若目标模型回缩，换回起手模型补一句"继续"把上下文推回去。
- 所有角色、设定、事件均为虚构创作素材；本模式不涉及真实人物。

## 致谢与来源

- 提示词与配置结构源自 [Bemly/opencode](https://github.com/Bemly/opencode)（MIT，kzheart），
  其提示词延展自 [MDX-Tom/gpt-5.6-instruct](https://github.com/MDX-Tom/gpt-5.6-instruct) 与
  [yynxxxxx/Codex-5.5-codex-instruct-5.5](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5)。
- 移植时上游分支：NSFW（蓝色 `#3B82F6`）与 unrestricted（红色 `#EF4444`）。

## License

MIT（见 LICENSE）。上游版权归 kzheart 所有。
