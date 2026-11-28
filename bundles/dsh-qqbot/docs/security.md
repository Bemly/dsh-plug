# 安全边界

> 对应版本：**2.6.4+**（2026-11-28 审计收口）。
> 这份文档只讲"插件自己守哪些门、守不住的部分由谁负责"，配置项含义见 [USER-GUIDE](./USER-GUIDE.md)。

## 1. 设置面板：只接受本机回环访问

本地设置桥（`settings-host.js`）的每个请求都要过四道判据，**任一不满足直接 403**（`refused: same-origin loopback only`）：

| 判据 | 具体要求 | 为什么 |
|---|---|---|
| TCP 对端 | `socket.remoteAddress` 必须是 `127.0.0.0/8` 或 `::1` | `Host` / `X-Forwarded-For` 都是请求方能随便写的，只有 TCP 对端地址伪造不了 |
| Host | 必须是回环地址、`localhost` 或显式白名单主机 | 防 DNS rebinding |
| Origin | 存在时必须与 Host 同源 | 防跨站页面驱动本地接口（CSRF） |
| Sec-Fetch-Site | 不能是 `cross-site` | 现代浏览器的额外信号 |

**这条边界带来的直接结果：从别的机器打开设置面板会 403。** 包括在 Mac 上访问 NAS 上 DSH 的 Web 端口——请求的对端是 Mac 的局域网 IP，不是回环。

### 想远程用设置面板怎么办

用 SSH 端口转发，让请求在 NAS 上"看起来来自本机"：

```bash
ssh -N -L 8080:127.0.0.1:<DSH端口> 你的NAS
# 然后在本机浏览器打开 http://127.0.0.1:8080/...
```

### `DSH_QQBOT_LOOPBACK_PROXY` 到底管什么

设 `DSH_QQBOT_LOOPBACK_PROXY=1`（或启动参数 `--qqbot-loopback-proxy`）**不会放开回环限制**，它只做一件事：**拒绝没有 `Origin` 头的请求**。

- 不设：本机命令行工具（curl / 脚本）不带 `Origin` 也能调，方便自动化。
- 设了：要求调用方必须带一个与 Host 同源的 `Origin`，即假定前面挂了反向代理、由代理补头。

> 反代部署的注意：反代必须保留真实 TCP 源地址为回环（同机反代），或干脆不要对公网暴露设置桥。**如果反代把外部请求转成回环请求并放行任意 `Host`，上面四道判据会被部署层架空**——这属于部署责任，不是插件能兜住的。

## 2. 文件读写：只在自己家的目录里

设置桥的 `fs.read` / `fs.write` / `raw-media` 不再接受任意路径，统一走 `resolveAllowedLocalPath()`：

1. 先 `realpath` 解析（读；写则解析到最深的已存在祖先），**符号链接逃逸会被拦下**；
2. 解析结果必须落在允许根内：

| 允许根 | 用途 |
|---|---|
| `os.tmpdir()` | 临时文件 |
| 机器人工作目录（cwd） | 会话工作区 |
| `dataRoot` / `cfg.cwd` | 账号数据目录 |
| `<以上>/.qqbot/dock-uploads` | 面板上传目录 |

扩展面板的 `ext-config?kind=&file=` 额外收紧：`kind` 必须是白名单值、`file` 只取 basename、只在内置目录与 `extension-packs/` 下解析、最后再 realpath 复核。

## 3. 模型能发什么文件

- 正文里的 `[MEDIA:file|路径]` 必须命中 `allowedMediaRoots`（工作区 + 数据目录等），越界直接不发。
- 宿主 `present()` 声明的交付物走独立通道，信任宿主自身的审批结果。

## 4. 群管写操作的主人白名单

踢人、禁言、入群审批、批量撤回、老版 `qq_group_admin kick` 都会先过 `groupAdminGate`：

- **只校验 QQ 入站 agent 发起的调用**；web/桌面回合用的是宿主自建 agent（同 sessionId、不同对象），操作者就是终端前的主人，放行。
- 白名单取 `groupAdmin.owners`（回退顶层 `owners`）。**留空 = 不校验**，与配置项文档一致，但会在诊断日志里提示一次。
- 拿不到发送者身份或解析异常 → **拒绝**，不会"当主人放行"。

## 5. 已知未覆盖

- **多实例隔离（部分）**：图片聚合已按 `dataRoot` 分桶（buffers / 发送指纹 / 落盘目录 / 索引），
  表情包闸门按 `dataDir` 分桶。仍然全局的两处：
  - **消息历史台账**（`msg-history`）：写进"最后初始化的那个实例"的 `.qqbot/msg-history`。
    文件名带 `scope_peerId`，而 QQ openid 是按 appid 分配的，实际串读概率低，但磁盘归属会混；
  - **扩展配置/入站状态**：按扩展文件 basename 分桶，两个扩展包里同名文件会共用一份配置。
    改成路径级 id 需要同时迁移面板扫描、启停状态与已存配置，属独立改动。
- **反代层**：见 §1 末尾，插件无法验证代理是否忠实转发。
- **扩展代码本身**：扩展以插件进程权限运行，装扩展等于装代码，请在可信来源内使用。
