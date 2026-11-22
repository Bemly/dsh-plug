# magpie-plain-archive

magpie 的网关钩子插件（gateway request hook）。在**遮盖之前**取请求原文、
在**还原之后**取回复，另存一份本地明文归档；发往供应商的那一份照常脱敏。

三个出口的差异：

| 出口 | 正文里的密钥 | 其余正文 |
| --- | --- | --- |
| 供应商 | `{{KIND_xxxxxxxx}}` 占位符 | 按脱敏设置 |
| magpie 内置会话记录 | `[REDACTED:KIND]`（不可逆） | 明文 |
| **本插件归档** | **明文** | **明文** |

## 安装

```sh
magpie plugin add magpie-plain-archive
```

## 归档位置

环境变量 `MAGPIE_PLAIN_DIR` 优先；否则 npm 安装时落在
`~/magpie-plain-archive/`，按路径安装时落在插件旁的 `archive/`。
每天一个 `<UTC 日期>.jsonl`，目录 0700、文件 0600。

**警告：归档含密钥明文。** 不要把它指向任何会被共享或同步的目录
（WebDAV、S3、云备份）。

## 可靠性边界

- 并发请求跑满 magpie 的钩子上限时，本插件不被调用，该条静默丢失；
- 钩子有 2~10 秒总预算，落盘超预算会被中断，同样丢失该条；
- 本插件不修改请求正文，也不拦截请求。

## 开发

源码与提交规则见仓库目录 `magpie/`（含 `AGENTS.md`：每次修改先脱敏再提交）。
