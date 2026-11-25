# agy-cli 自定义合并栈（公开备份）

本目录是 `@magpie-community/opencode-agy-cli-auth` 的**自定义合并备份**，不是官方发布版，也不用于直接 `npm publish`（`package.json` 已设 `private: true`）。

## 来源

- 上游仓库：https://github.com/magpie-community/plugins
- 基线：`main@41a34f9`，官方 agy-cli `0.1.128`
- 本地合并提交：`c8598c0`（未提交到上游）
- 合并后版本：`0.1.129`
- 0.1.128 基线另含官方 #1540（effort）、#1541（503 no-capacity）、#1542（账号模型别名）、#1544（usage 版本探测）、#1545（AgentSummary 隔离）等修复。

## 已合并的社区 PR

| PR | 内容 |
| --- | --- |
| #1296 | `UNAUTHENTICATED 401` / `Authentication expired` 换新 agy 进程重试一次，仍失败则返回真实 401 |
| #1465 | agy 内部静默超时从 5 分钟提高到 15 分钟 |
| #1467 | `agent executor error` 不再伪装成 HTTP 200 正常回复 |
| #1468 | agy 自带工具被拒后出现空回复时，自动再问一次 |
| #1513 | 相同 `tool_result` 重试时重放最后一个 `tool_use`，避免 409/掉会话 |
| #1533（上游 0.1.122） | 清理 Magpie 脱敏占位提示，避免会话掉线或误判 steer；已包含在 0.1.128 基线 |
| #1294 | 防止 prompt 中 `/plan`、`/learn`、`/grill-me` 等被 agy 误当内置命令 |
| #1283 | agy 1.5.10+ 重放预算从 112 KiB 提高到 184 KiB |
| #1524（上游 0.1.128） | DSH 长历史裁剪时保留 `<available_skills>`、工作区指令和会话状态；已包含在 0.1.128 基线 |
| #1493（适配） | 参考上游 image-slim 兼容思路，新增 DSH/qq-bot 聚合图占位符识别；图片消失只在该元数据消息里放行，真实图片变化仍拒绝 |

手工解决过三处语义冲突：

1. #1296 的认证错误处理与 #1467 的 executor 错误标记合并为同一套错误分类。
2. #1296 的 `retryFresh` 与 #1513 的 `toolResultStep` 同时保留在 `makeAnthropicStream` / `streamResponse` 参数里。
3. #1283 的 history archive 与 #1524 的 `sessionStateIndices` 合并到同一个 replay clipping 分支。

## 验证记录

- `node --check index.mjs`、`node --check cloak.mjs` 通过。
- 核心回归：173/175 通过；另外 2 条是测试环境里存在真实 agy 可执行文件导致的 PATH 污染，与本合并栈无关。
- 全套 Node 可运行测试：512/521 通过；剩余 9 条仍是 Bun 专用导入、真实 agy 路径和目录探测环境问题，与补丁无关。
- DSH 图片占位适配新增 5 个回归用例，全部通过；并用一对真实 cache-losing 请求回放，判定为同一历史，主文本完全一致。
- 图片无关比较不是无条件删图：实际图片必须是预期图片的子序列；图片消失只允许出现在 dsh-qqbot 的聚合图元数据消息里；普通用户图片丢失、不同图片、新增图片都会拒绝。
- 全套测试中还有 Bun 专用测试和真实 agy 路径相关测试，Node 直接跑会失败；不能把这些环境失败当成补丁回归。
- 本目录只包含 npm 包运行时文件与文档，**不包含测试夹具、登录凭据、运行期会话和归档数据**。

## 脱敏红线（每次提交/推送前必须执行）

这是公开仓库，推上去即等于公开。每次修改都要确认：

1. 无真实 API key、OAuth access/refresh token、cookie、密码、网关密钥。
2. 无用户邮箱、真实账号名、内网地址、主机专属绝对路径。
3. 无 `antigravity-oauth-token`、`plugin-auth.json`、`logins.json`、会话文件、归档 JSONL。
4. 无测试探针里的真实对话内容、session id、联系人姓名。
5. `usage.mjs` 里的 Google installed-app OAuth client id/secret 是上游公开常量，不是用户凭据；不要替换成任何真实 token。

提交前至少跑：

```sh
git diff --cached | grep -nE 'sk-[A-Za-z0-9]{8,}|npm_[A-Za-z0-9]{20,}|ghp_[A-Za-z0-9]{20,}|/(Users|vol[0-9])/|192\.168\.|@appdata|antigravity-oauth-token|refresh_token\s*[:=]\s*["'"'][^"'"']+'
```

这条 grep 会命中它自己那一行，属预期；判据是**除它之外没有别的命中**。

## 更新方式

1. 从上游最新 `main` 重新拉基线，不要在这份旧合并栈上无限叠补丁。
2. 检查本文件列出的 PR 是否已经合并；已合并的用官方版本，不再重复应用。
3. 对仍开放的 PR 做语义合并，先跑语法和核心回归，再部署。
4. Magpie 的插件更新循环可能用官方 dist 覆盖本地自定义包；覆盖后以官方版本为准，需要时按本清单重新合并。
