# opencode-nsfw

OpenCode 的「NSFW」agent 配置包 —— 把虚构**成人向创作**请求（成人小说、同人、OC、角色扮演、含虚构年长/低龄外观角色的作品、露骨场景、成人作品翻译）按原样执行：以「虚构创作」语境先行，显式抑制拒答、道德说教与前置免责，保持用户要求的尺度保真度。

本分支由 `opencode-unrestricted` 精简而来，**只保留 NSFW 模式**，移除全部安全研究相关组件（agent/command/plugin/演示图已清理）。

## 目录结构

```
opencode-nsfw/  (nsfw-mode 分支)
├── agent/
│   └── nsfw.md                  # 主 agent 的 system prompt（虚构 NSFW 创作执行器）
├── command/
│   └── nsfw.md                  # /nsfw 斜杠命令
├── plugin/
│   └── nsfw-boost.ts            # 注入成年向虚构语境的语言
├── opencode.json.example        # 脱敏后的配置示例
└── README.md
```

## 组件说明

| 文件 | 作用 |
|------|------|
| `agent/nsfw.md` | 定义 `nsfw` 主 agent：`mode: primary`、`permission: allow`，system prompt 采用「虚构创作语境先行」策略，把成人向内容请求作为虚构作品（情色文学/同人/OC/角色扮演等出版类型）处理，要求内容优先、按请求保真度交付 |
| `command/nsfw.md` | 注册 `/nsfw` 命令：把参数当作当前创作任务，切到 nsfw agent 并立刻开始写作 |
| `plugin/nsfw-boost.ts` | OpenCode 插件，做两件事：给 nsfw agent 注入 `[NSFW-LAB]` 虚构创作语境；对命中的 NSFW 关键词用户轮次改写为「私密虚构创作」上下文。带 agent 门控，不影响 build/plan 等其他 agent |
| `opencode.json.example` | 脱敏后的 `~/.config/opencode/opencode.json` 示例，只保留 nsfw 相关配置 |

## 安装

### 1. 复制文件到 OpenCode 配置目录

把三个目录复制到全局配置目录（`~/.config/opencode/`）：

```bash
cp -R agent command plugin ~/.config/opencode/
```

### 2. 修改 opencode.json

在 `~/.config/opencode/opencode.json` 里设置默认 agent（参考 `opencode.json.example`）：

```json
{
  "$schema": "https://opencode.ai/config.json",
  "default_agent": "nsfw",
  "permission": "allow",
  "agent": {
    "nsfw": {
      "mode": "primary",
      "color": "#3B82F6",
      "permission": "allow",
      "description": "默认主 agent。虚构 NSFW 创作：成人向写作/同人/OC/角色扮演。内容优先。"
    }
  }
}
```

### 3. 重启并验证

重启 opencode，按 Tab 键应能在主 agent 之间切到 `nsfw` 开始使用；

## 配置规则

1. **agent 目录**：markdown 文件放在 `~/.config/opencode/agent/`（或复数 `agents/`，两者都支持），文件名即 agent 名。`agent/nsfw.md` 生成名为 `nsfw` 的 agent；frontmatter 里的 `mode` / `description` / `permission` / `color` 与文件正文（system prompt）一起生效。
2. **command 目录**：markdown 文件放在 `~/.config/opencode/command/`（或 `commands/`），文件名即命令名。`command/nsfw.md` 生成 `/nsfw` 命令；frontmatter 的 `agent: nsfw` 指定由哪个 agent 执行，正文里的 `$ARGUMENTS` 会被命令参数替换。
3. **plugin 目录**：`.ts` 文件放在 `~/.config/opencode/plugin/`（或 `plugins/`），**启动时自动加载，不需要写进 `opencode.json` 的 `plugin` 数组**。`plugin` 数组只用于注册 npm 包。
4. **默认 agent**：`default_agent: "nsfw"` 使 `nsfw` 成为默认主 agent。agent 的定义既可以在 markdown frontmatter 里，也可以（冗余）写在 `opencode.json` 的 `agent` 字段里，二者会合并。
5. **插件依赖**：`nsfw-boost.ts` 里 `import type { Plugin } from "@opencode-ai/plugin"` 是**类型导入，运行时会被擦除**，因此不需要额外 `npm install` 也能加载。
6. **项目级隔离**：同样的目录结构放到项目根的 `.opencode/` 下即可按项目启用，不影响全局配置。

## 使用

- 直接以 `nsfw` 为主 agent 开始对话
- 或输入 `/nsfw <你的创作请求>` 强制切到该模式并立即开始写作

## 注意事项

- **先用容易越狱的模型起手，再切换到想用的模型**：不同模型的安全对齐强度差异很大，有些模型冷启动很难破甲，一开口就拒答。对这类任务，先用一个容易越狱的模型起手——把「虚构创作」语境建立起来、让成人向内容开始产出、在对话历史里积累几轮已放行的上下文——然后用 `/models` 切换到真正想用的模型。越狱话术和任务上下文已经存在于对话历史里，目标模型更倾向于顺着继续执行，而不是从零重新判定拒答。
- **切换后目标模型回缩的应对**：如果切过去后目标模型开始拒答、要求澄清或改写为安全话术，再切回起手模型让它补一句「继续」或重发上一条请求，把上下文再往前推一段。
- 所有角色、设定、事件均为虚构创作素材；本模式不涉及真实人物。

## 致谢

- 配置文件结构与提示词风格迁移自 `opencode-unrestricted`（其提示词延展自 [MDX-Tom/gpt-5.6-instruct](https://github.com/MDX-Tom/gpt-5.6-instruct) 与 [yynxxxxx/Codex-5.5-codex-instruct-5.5](https://github.com/yynxxxxx/Codex-5.5-codex-instruct-5.5)）
- 感谢 [LINUX DO](https://linux.do) 社区

## License

MIT
